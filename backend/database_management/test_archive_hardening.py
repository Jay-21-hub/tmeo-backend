"""
Archive hardening - Checkpoint 1 regression tests.

Covers: evidence preservation at archive time (nullable archived FK, PROTECT,
evidence_active_xor_archived_link CHECK), main ticket image path and
client_offline_id in snapshots, read-only archived evidence (409 / generic 403),
archived-record delete (409 when evidence is preserved, still disabled by
default), and late offline replay of an already-archived ticket.

Run:  python manage.py test database_management.test_archive_hardening --settings=<settings>
"""
from unittest import mock

from django.db import IntegrityError, transaction
from django.db.models import ProtectedError
from django.test import override_settings
from django.utils import timezone

from audit.models import AuditLog  # noqa: F401  (kept importable for future audit assertions)
from violations.models import Violation, ViolationEvidence
from violations.tests import BaseRoleTestCase
from violations.views import OFFLINE_SYNC_DENIED_MSG

from . import archive_utils
from .archive_utils import ArchiveReconciliationError, run_archive
from .models import ArchiveBatch, ArchivedViolation

CREATE_URL = '/api/violations/create/'
EVIDENCE_URL = '/api/violations/evidence/'
RECORDS_URL = '/api/database/archive/records/'


def evidence_url(pk):
    return f'{EVIDENCE_URL}{pk}/'


def record_url(pk):
    return f'{RECORDS_URL}{pk}/'


class H(BaseRoleTestCase):
    """Fixtures: own tickets (no extra fixtures beyond BaseRoleTestCase's
    pending `other_ovr`, which archiving must leave alone)."""

    def paid(self, enforcer=None, ovr='OVR-H-1', **fields):
        v = self._make_violation(enforcer or self.enforcer_a, ovr, status='paid')
        for k, val in fields.items():
            setattr(v, k, val)
        if fields:
            v.save()
        return v

    def ev(self, owner=None, violation=None, archived=None, name='evidence/e1.jpg'):
        return ViolationEvidence.objects.create(
            violation=violation, archived_violation=archived, image=name,
            captured_at=timezone.now(), captured_by=owner or self.enforcer_a,
        )

    def archived_of(self, v):
        return ArchivedViolation.objects.get(original_violation_id=v.id)

    def payload(self, offline_id, **extra):
        data = {
            'violator_name': 'DELA CRUZ, JUAN', 'ovr_number': 'OVR-REPLAY-1',
            'location': 'ML Tagarao Street', 'date_issued': timezone.now().isoformat(),
            'violation_type_ids': [str(self.vtype.id)], 'status': 'pending',
            'source': 'enforcer_ovr', 'client_offline_id': offline_id,
        }
        data.update(extra)
        return data


# --------------------------------------------------------------------------
class EvidenceConstraintTests(H):
    def test_check_rejects_both_links(self):
        v = self.paid()
        a = ArchivedViolation.objects.create(
            batch=ArchiveBatch.objects.create(status='success'), original_violation_id=999,
            violation_year=2026, date_issued=timezone.now(), settlement_status='settled',
            violator_name='X', data={})
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.ev(violation=v, archived=a)

    def test_check_allows_active_only(self):
        e = self.ev(violation=self.paid())
        self.assertIsNone(e.archived_violation_id)

    def test_check_allows_archived_only(self):
        self.paid()
        run_archive(self.admin)
        a = ArchivedViolation.objects.get()
        e = self.ev(archived=a)
        self.assertIsNone(e.violation_id)

    def test_check_allows_standalone(self):
        e = self.ev()
        self.assertIsNone(e.violation_id)
        self.assertIsNone(e.archived_violation_id)

    def test_single_update_swap_is_accepted(self):
        v = self.paid()
        e = self.ev(violation=v)
        run_archive(self.admin)  # relinks e
        e.refresh_from_db()
        self.assertIsNotNone(e.archived_violation_id)
        self.assertIsNone(e.violation_id)

    def test_protect_blocks_deleting_archived_record_that_owns_evidence(self):
        v = self.paid()
        self.ev(violation=v)
        run_archive(self.admin)
        with self.assertRaises(ProtectedError):
            self.archived_of(v).delete()
        self.assertTrue(ViolationEvidence.objects.filter(archived_violation__isnull=False).exists())


# --------------------------------------------------------------------------
class ArchivePreservesEvidenceTests(H):
    def test_archive_relinks_evidence_and_keeps_the_row(self):
        v = self.paid()
        e = self.ev(violation=v)
        run_archive(self.admin)
        e.refresh_from_db()
        self.assertEqual(e.archived_violation_id, self.archived_of(v).pk)
        self.assertIsNone(e.violation_id)
        self.assertFalse(Violation.objects.filter(pk=v.pk).exists())

    def test_all_evidence_of_a_ticket_is_relinked(self):
        v = self.paid()
        ids = sorted(self.ev(violation=v, name=f'evidence/e{i}.jpg').id for i in range(3))
        run_archive(self.admin)
        got = sorted(ViolationEvidence.objects.filter(
            archived_violation=self.archived_of(v)).values_list('id', flat=True))
        self.assertEqual(got, ids)

    def test_evidence_of_in_progress_ticket_stays_on_the_active_ticket(self):
        active = self.other_ovr          # pending: never archived
        e = self.ev(violation=active)
        self.paid()
        run_archive(self.admin)
        e.refresh_from_db()
        self.assertEqual(e.violation_id, active.id)
        self.assertIsNone(e.archived_violation_id)

    def test_standalone_evidence_is_untouched(self):
        e = self.ev()
        self.paid()
        run_archive(self.admin)
        e.refresh_from_db()
        self.assertIsNone(e.violation_id)
        self.assertIsNone(e.archived_violation_id)

    def test_snapshot_records_evidence_ids(self):
        v = self.paid()
        ids = sorted(self.ev(violation=v, name=f'evidence/s{i}.jpg').id for i in range(2))
        run_archive(self.admin)
        self.assertEqual(self.archived_of(v).data['evidence_ids'], ids)

    def test_ticket_without_evidence_has_empty_evidence_ids(self):
        v = self.paid()
        run_archive(self.admin)
        self.assertEqual(self.archived_of(v).data['evidence_ids'], [])

    def test_snapshot_preserves_main_ticket_image_path(self):
        v = self.paid(image='violations/ticket_photo.jpg')
        run_archive(self.admin)
        self.assertEqual(self.archived_of(v).data['image'], 'violations/ticket_photo.jpg')

    def test_snapshot_image_is_null_without_a_photo(self):
        v = self.paid()
        run_archive(self.admin)
        self.assertIsNone(self.archived_of(v).data['image'])

    def test_snapshot_preserves_client_offline_id(self):
        v = self.paid(client_offline_id='off-xyz-1')
        run_archive(self.admin)
        self.assertEqual(self.archived_of(v).data['client_offline_id'], 'off-xyz-1')

    def test_snapshot_offline_id_is_null_for_online_tickets(self):
        v = self.paid()
        run_archive(self.admin)
        self.assertIsNone(self.archived_of(v).data['client_offline_id'])

    def test_relink_failure_rolls_everything_back(self):
        v = self.paid()
        e = self.ev(violation=v)
        # relink silently does nothing -> verification must catch it
        with mock.patch.object(archive_utils, '_relink_evidence', return_value={}):
            with self.assertRaises(ArchiveReconciliationError):
                run_archive(self.admin)
        e.refresh_from_db()
        self.assertEqual(e.violation_id, v.id)
        self.assertIsNone(e.archived_violation_id)
        self.assertTrue(Violation.objects.filter(pk=v.pk).exists())
        self.assertEqual(ArchivedViolation.objects.count(), 0)

    def test_post_delete_verification_failure_rolls_everything_back(self):
        v = self.paid()
        e = self.ev(violation=v)
        real = archive_utils._verify_relinked_evidence

        def verify(batch, eligible, expected, after_delete=False):
            return ['simulated post-delete failure'] if after_delete else real(
                batch, eligible, expected, after_delete)

        with mock.patch.object(archive_utils, '_verify_relinked_evidence', side_effect=verify):
            with self.assertRaises(ArchiveReconciliationError):
                run_archive(self.admin)
        e.refresh_from_db()
        self.assertEqual(e.violation_id, v.id)
        self.assertTrue(Violation.objects.filter(pk=v.pk).exists())
        self.assertEqual(ArchivedViolation.objects.count(), 0)

    def test_second_archive_run_leaves_relinked_evidence_alone(self):
        v = self.paid()
        e = self.ev(violation=v)
        run_archive(self.admin)
        e.refresh_from_db()
        first = e.archived_violation_id
        run_archive(self.admin)
        e.refresh_from_db()
        self.assertEqual(e.archived_violation_id, first)
        self.assertEqual(ArchivedViolation.objects.count(), 1)

    def test_no_evidence_row_is_lost_by_archiving(self):
        v1, v2 = self.paid(ovr='OVR-H-A'), self.paid(ovr='OVR-H-B')
        self.ev(violation=v1); self.ev(violation=v2); self.ev()
        before = ViolationEvidence.objects.count()
        run_archive(self.admin)
        self.assertEqual(ViolationEvidence.objects.count(), before)


# --------------------------------------------------------------------------
class ArchivedEvidenceReadOnlyTests(H):
    def setUp(self):
        self.v = self.paid()
        self.e = self.ev(violation=self.v)
        self.target = self._make_violation(self.enforcer_a, 'OVR-H-TARGET')
        run_archive(self.admin)
        self.e.refresh_from_db()

    def patch(self, user, evidence=None):
        return self.as_user(user).patch(
            evidence_url((evidence or self.e).pk), {'violation': self.target.id}, format='json')

    def test_admin_patch_is_409(self):
        self.assertEqual(self.patch(self.admin).status_code, 409)

    def test_staff_patch_is_409(self):
        self.assertEqual(self.patch(self.staff).status_code, 409)

    def test_owner_enforcer_patch_is_409(self):
        self.assertEqual(self.patch(self.enforcer_a).status_code, 409)

    def test_409_does_not_change_the_evidence(self):
        self.patch(self.admin)
        self.e.refresh_from_db()
        self.assertIsNone(self.e.violation_id)
        self.assertIsNotNone(self.e.archived_violation_id)

    def test_non_owner_enforcer_gets_403_not_409(self):
        self.assertEqual(self.patch(self.enforcer_b).status_code, 403)

    def test_non_owner_403_is_identical_for_active_and_archived_evidence(self):
        active_ev = self.ev(owner=self.enforcer_a)
        a = self.patch(self.enforcer_b, active_ev)
        b = self.patch(self.enforcer_b, self.e)
        self.assertEqual((a.status_code, a.data), (b.status_code, b.data))

    def test_archived_evidence_not_in_unassociated_list(self):
        res = self.as_user(self.admin).get(EVIDENCE_URL, {'unassociated': '1'})
        self.assertNotIn(self.e.id, [r['id'] for r in res.data])

    def test_archived_evidence_not_in_enforcer_list(self):
        res = self.as_user(self.enforcer_a).get(EVIDENCE_URL)
        self.assertNotIn(self.e.id, [r['id'] for r in res.data])

    def test_archived_evidence_not_in_admin_list(self):
        res = self.as_user(self.admin).get(EVIDENCE_URL)
        self.assertNotIn(self.e.id, [r['id'] for r in res.data])

    def test_normal_associate_still_works_for_active_evidence(self):
        free = self.ev(owner=self.enforcer_a)
        res = self.as_user(self.enforcer_a).patch(
            evidence_url(free.pk), {'violation': self.target.id}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        free.refresh_from_db()
        self.assertEqual(free.violation_id, self.target.id)

    def test_db_constraint_race_becomes_409_not_500(self):
        free = self.ev(owner=self.enforcer_a)
        with mock.patch.object(ViolationEvidence, 'save', side_effect=IntegrityError('xor')):
            res = self.as_user(self.admin).patch(
                evidence_url(free.pk), {'violation': self.target.id}, format='json')
        self.assertEqual(res.status_code, 409)


# --------------------------------------------------------------------------
class ArchiveRecordsAndDeleteTests(H):
    def setUp(self):
        self.v = self.paid(image='violations/p.jpg')
        self.e = self.ev(violation=self.v, name='evidence/archived_photo.jpg')
        run_archive(self.admin)
        self.rec = self.archived_of(self.v)

    def _record(self, user):
        res = self.as_user(user).get(RECORDS_URL)
        self.assertEqual(res.status_code, 200, getattr(res, 'data', None))
        rows = [r for r in res.data['results'] if r['id'] == self.rec.pk]
        self.assertEqual(len(rows), 1)
        return rows[0]

    def test_admin_sees_archived_evidence_with_image_url(self):
        ev = self._record(self.admin)['evidence']
        self.assertEqual([x['id'] for x in ev], [self.e.id])
        self.assertIn('archived_photo.jpg', ev[0]['image_url'])

    def test_staff_sees_archived_evidence_too(self):
        self.assertEqual(len(self._record(self.staff)['evidence']), 1)

    def test_enforcer_cannot_read_archive_records(self):
        self.assertEqual(self.as_user(self.enforcer_a).get(RECORDS_URL).status_code, 403)

    def test_assessor_confidentiality_is_unchanged(self):
        data = self._record(self.admin)['data']
        self.assertNotIn('assessed_by_name', data)

    def test_archived_delete_is_403_by_default(self):
        self.assertFalse(__import__('django.conf', fromlist=['settings']).settings.ARCHIVE_DELETE_ENABLED)
        self.assertEqual(self.as_user(self.admin).delete(record_url(self.rec.pk)).status_code, 403)
        self.assertTrue(ArchivedViolation.objects.filter(pk=self.rec.pk).exists())

    @override_settings(ARCHIVE_DELETE_ENABLED=True)
    def test_archived_delete_with_evidence_is_409_and_nothing_is_lost(self):
        res = self.as_user(self.admin).delete(record_url(self.rec.pk))
        self.assertEqual(res.status_code, 409)
        self.assertTrue(ArchivedViolation.objects.filter(pk=self.rec.pk).exists())
        self.e.refresh_from_db()
        self.assertEqual(self.e.archived_violation_id, self.rec.pk)

    @override_settings(ARCHIVE_DELETE_ENABLED=True)
    def test_archived_delete_without_evidence_still_works(self):
        v2 = self.paid(ovr='OVR-H-NOEV')
        run_archive(self.admin)
        rec2 = self.archived_of(v2)
        self.assertEqual(self.as_user(self.admin).delete(record_url(rec2.pk)).status_code, 204)
        self.assertFalse(ArchivedViolation.objects.filter(pk=rec2.pk).exists())


# --------------------------------------------------------------------------
class ArchivedOfflineReplayTests(H):
    def archive_offline_ticket(self, offline_id='off-late-1', owner=None):
        v = self.paid(enforcer=owner or self.enforcer_a, ovr='OVR-OFF-1', client_offline_id=offline_id)
        run_archive(self.admin)
        return v

    def test_owner_late_replay_is_200_already_archived(self):
        self.archive_offline_ticket()
        before = Violation.objects.count()
        res = self.as_user(self.enforcer_a).post(CREATE_URL, self.payload('off-late-1'), format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data, {'id': None, 'already_archived': True,
                                    'client_offline_id': 'off-late-1'})
        self.assertEqual(Violation.objects.count(), before)

    def test_replay_never_creates_a_duplicate_ticket(self):
        self.archive_offline_ticket()
        for _ in range(3):
            self.as_user(self.enforcer_a).post(CREATE_URL, self.payload('off-late-1'), format='json')
        self.assertFalse(Violation.objects.filter(client_offline_id='off-late-1').exists())
        self.assertEqual(ArchivedViolation.objects.count(), 1)

    def test_non_owner_enforcer_gets_the_generic_403(self):
        self.archive_offline_ticket()
        res = self.as_user(self.enforcer_b).post(CREATE_URL, self.payload('off-late-1'), format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data['detail'], OFFLINE_SYNC_DENIED_MSG)
        self.assertNotIn('already_archived', res.data)

    def test_archived_403_is_identical_to_active_403_so_there_is_no_oracle(self):
        self.archive_offline_ticket('off-arch')
        live = self._make_violation(self.enforcer_a, 'OVR-LIVE')
        live.client_offline_id = 'off-live'; live.save()
        a = self.as_user(self.enforcer_b).post(CREATE_URL, self.payload('off-arch'), format='json')
        b = self.as_user(self.enforcer_b).post(CREATE_URL, self.payload('off-live'), format='json')
        self.assertEqual((a.status_code, a.data), (b.status_code, b.data))

    def test_staff_replay_is_refused_by_the_role_check_first(self):
        self.archive_offline_ticket()
        res = self.as_user(self.staff).post(CREATE_URL, self.payload('off-late-1'), format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data['detail'], OFFLINE_SYNC_DENIED_MSG)

    def test_archived_snapshot_without_owner_fails_closed(self):
        self.archive_offline_ticket()
        rec = ArchivedViolation.objects.get()
        data = dict(rec.data); data['enforcer_user_id'] = None
        ArchivedViolation.objects.filter(pk=rec.pk).update(data=data)
        res = self.as_user(self.enforcer_a).post(CREATE_URL, self.payload('off-late-1'), format='json')
        self.assertEqual(res.status_code, 403)

    def test_legacy_snapshot_without_offline_id_is_not_detected_documented_limit(self):
        self.archive_offline_ticket()
        rec = ArchivedViolation.objects.get()
        data = {k: v for k, v in rec.data.items() if k != 'client_offline_id'}
        ArchivedViolation.objects.filter(pk=rec.pk).update(data=data)
        res = self.as_user(self.enforcer_a).post(CREATE_URL, self.payload('off-late-1'), format='json')
        self.assertEqual(res.status_code, 201, res.data)

    def test_active_replay_still_returns_the_existing_ticket(self):
        first = self.as_user(self.enforcer_a).post(CREATE_URL, self.payload('off-act'), format='json')
        again = self.as_user(self.enforcer_a).post(CREATE_URL, self.payload('off-act'), format='json')
        self.assertEqual((first.status_code, again.status_code), (201, 200))
        self.assertEqual(again.data['id'], first.data['id'])
        self.assertNotIn('already_archived', again.data)

    def test_unknown_offline_id_still_creates_normally(self):
        res = self.as_user(self.enforcer_a).post(CREATE_URL, self.payload('off-new'), format='json')
        self.assertEqual(res.status_code, 201, res.data)