"""
Role Evolution — Phase 1: capture_identity(), snapshot provenance, snapshot
immutability across Violation / Assessment / AuditLog / Notification, and
legacy rows that carry no snapshot.

Run: python manage.py test accounts.test_identity --settings=core.test_settings
"""
import inspect

from django.utils import timezone

from accounts.identity import SnapshotSource, capture_identity, normalize_role, snapshot_fields
from accounts.models import CustomUser
from accounts.test_role_history import make_user, transition
from audit.models import AuditLog
from notifications.models import Notification
from violations.models import Assessment, Violation
from violations.tests import BaseRoleTestCase

Role = CustomUser.Role


class CaptureIdentityTests(BaseRoleTestCase):

    def test_enforcer(self):
        enf = make_user(3, Role.ENFORCER, badge_number='B-77')
        ident = capture_identity(enf)
        self.assertEqual(ident, {
            'user_id': enf.pk, 'name': 'User 3', 'role': 'enforcer',
            'id_number': '2026-ENF-0003', 'badge_number': 'B-77',
            'source': SnapshotSource.EVENT,
        })

    def test_staff_and_admin(self):
        self.assertEqual(capture_identity(self.staff)['role'], 'staff')
        self.assertEqual(capture_identity(self.admin)['role'], 'admin')
        self.assertEqual(capture_identity(self.staff)['id_number'], 'TEST-staff-1')
        self.assertEqual(capture_identity(self.admin)['name'], 'Admin 1')

    def test_badge_is_none_when_the_account_has_none(self):
        self.assertIsNone(capture_identity(self.staff)['badge_number'])

    def test_none_is_handled_and_marked_unknown(self):
        ident = capture_identity(None)
        self.assertEqual(ident['source'], SnapshotSource.UNKNOWN)
        for key in ('user_id', 'name', 'role', 'id_number', 'badge_number'):
            self.assertIsNone(ident[key])

    def test_unsaved_user_is_treated_as_no_account(self):
        self.assertEqual(capture_identity(CustomUser(full_name='X', role='staff'))['source'], SnapshotSource.UNKNOWN)

    def test_role_is_normalized_and_never_invented(self):
        self.assertEqual(normalize_role(' Staff '), 'staff')
        self.assertEqual(normalize_role('ADMIN'), 'admin')
        self.assertIsNone(normalize_role('superuser'))
        self.assertIsNone(normalize_role(''))
        self.assertIsNone(normalize_role(None))

    def test_does_not_accept_or_use_client_supplied_identity(self):
        params = list(inspect.signature(capture_identity).parameters)
        self.assertEqual(params, ['user'])                      # no request, no free-form values

        class FakeRequest:                                      # a spoofing client payload
            user = self.enforcer_a
            data = {'role': 'admin', 'id_number': '2026-ADM-0001', 'full_name': 'The Mayor'}

        ident = capture_identity(FakeRequest.user)
        self.assertEqual((ident['role'], ident['id_number'], ident['name']),
                         ('enforcer', 'TEST-enforcer-1', 'Enforcer 1'))

    def test_snapshot_fields_shape(self):
        enf = make_user(3, Role.ENFORCER, badge_number='B-77')
        self.assertEqual(snapshot_fields(enf, 'enforcer', badge=True), {
            'enforcer_name_snapshot': 'User 3',
            'enforcer_role_snapshot': 'enforcer',
            'enforcer_id_number_snapshot': '2026-ENF-0003',
            'enforcer_snapshot_source': 'event',
            'enforcer_badge_snapshot': 'B-77',
        })
        self.assertNotIn('actor_badge_snapshot', snapshot_fields(enf, 'actor'))
        self.assertEqual(snapshot_fields(None, 'actor')['actor_snapshot_source'], 'unknown')

    def test_provenance_values(self):
        self.assertEqual(set(SnapshotSource.values), {'event', 'derived', 'assumed', 'unknown'})


class SnapshotImmutabilityTests(BaseRoleTestCase):
    """THE central requirement: later changes to the account must not rewrite history."""

    def _file_historical_records(self, juan):
        v = Violation.objects.create(
            violator_name='DELA CRUZ, JUAN', ovr_number='OVR-HIST-1', location='ML Tagarao',
            date_issued=timezone.now(), enforcer=juan,
            **snapshot_fields(juan, 'enforcer', badge=True),
        )
        a = Assessment.objects.create(violation=v, assessed_by=juan, **snapshot_fields(juan, 'assessor'))
        log = AuditLog.objects.create(
            user=juan, action='CREATE', module='violations', description='Filed OVR',
            **snapshot_fields(juan, 'actor'),
        )
        n = Notification.objects.create(
            recipient_role='admin', notif_type='new_violation', title='New OVR', message='m',
            related_user=juan, **snapshot_fields(juan, 'actor'),
        )
        return v, a, log, n

    def test_snapshots_survive_name_role_and_id_changes(self):
        juan = make_user(3, Role.ENFORCER, badge_number='B-77')
        juan.full_name = 'Juan Dela Cruz'
        juan.save()
        v, a, log, n = self._file_historical_records(juan)

        # Later: the same person, same pk, becomes Staff with a new ID and a new name.
        transition(juan, Role.STAFF)
        juan.full_name = 'Juan D. Cruz-Reyes'
        juan.badge_number = None
        juan.save()
        juan.refresh_from_db()
        self.assertEqual((juan.role, juan.id_number), ('staff', '2026-STF-0001'))

        v.refresh_from_db(); a.refresh_from_db(); log.refresh_from_db(); n.refresh_from_db()

        # Event-time identity is frozen…
        self.assertEqual(
            (v.enforcer_name_snapshot, v.enforcer_role_snapshot, v.enforcer_id_number_snapshot,
             v.enforcer_badge_snapshot, v.enforcer_snapshot_source),
            ('Juan Dela Cruz', 'enforcer', '2026-ENF-0003', 'B-77', 'event'))
        self.assertEqual(
            (a.assessor_name_snapshot, a.assessor_role_snapshot, a.assessor_id_number_snapshot),
            ('Juan Dela Cruz', 'enforcer', '2026-ENF-0003'))
        self.assertEqual(
            (log.actor_name_snapshot, log.actor_role_snapshot, log.actor_id_number_snapshot),
            ('Juan Dela Cruz', 'enforcer', '2026-ENF-0003'))
        self.assertEqual(
            (n.actor_name_snapshot, n.actor_role_snapshot, n.actor_id_number_snapshot),
            ('Juan Dela Cruz', 'enforcer', '2026-ENF-0003'))

        # …while the stable FK still resolves to the SAME person, who is now Staff.
        self.assertEqual(v.enforcer_id, juan.pk)
        self.assertEqual(v.enforcer.role, 'staff')
        self.assertEqual(v.enforcer.id_number, '2026-STF-0001')

    def test_saving_a_record_again_does_not_refresh_its_snapshot(self):
        juan = make_user(3, Role.ENFORCER)
        v, *_ = self._file_historical_records(juan)
        transition(juan, Role.STAFF)
        v.remarks = 'edited later by someone'
        v.save()
        v.refresh_from_db()
        self.assertEqual(v.enforcer_role_snapshot, 'enforcer')
        self.assertEqual(v.enforcer_id_number_snapshot, '2026-ENF-0003')


class LegacyRowTests(BaseRoleTestCase):
    """Rows created before snapshots existed: no crash, nothing fabricated."""

    def test_legacy_rows_default_to_unknown_with_no_identity(self):
        v = self.other_ovr                                   # created WITHOUT snapshots
        self.assertEqual(v.enforcer_snapshot_source, SnapshotSource.UNKNOWN)
        for f in ('enforcer_name_snapshot', 'enforcer_role_snapshot',
                  'enforcer_id_number_snapshot', 'enforcer_badge_snapshot'):
            self.assertIsNone(getattr(v, f))
        a = Assessment.objects.create(violation=v, assessed_by=self.staff)
        self.assertEqual(a.assessor_snapshot_source, SnapshotSource.UNKNOWN)
        self.assertIsNone(a.assessor_role_snapshot)
        log = AuditLog.objects.create(user=self.staff, action='LOGIN', module='auth', description='x')
        self.assertEqual(log.actor_snapshot_source, SnapshotSource.UNKNOWN)
        self.assertIsNone(log.actor_id_number_snapshot)
        # Phase 2: Notification.save() now captures the actor, so a LEGACY row
        # (pre-snapshot) is simulated with bulk_create, which bypasses save().
        n, = Notification.objects.bulk_create([Notification(
            recipient_role='admin', notif_type='new_violation',
            title='t', message='m', related_user=self.enforcer_b)])
        n.refresh_from_db()
        self.assertEqual(n.actor_snapshot_source, SnapshotSource.UNKNOWN)

    def test_a_legacy_row_is_not_given_current_identity_just_by_being_saved(self):
        v = self.other_ovr
        transition(self.enforcer_b, Role.STAFF)
        v.remarks = 'touch'
        v.save()
        v.refresh_from_db()
        self.assertIsNone(v.enforcer_role_snapshot)
        self.assertEqual(v.enforcer_snapshot_source, 'unknown')

    def test_existing_endpoints_still_work_with_legacy_rows(self):
        Assessment.objects.create(violation=self.other_ovr, assessed_by=self.staff)
        AuditLog.objects.create(user=self.admin, action='LOGIN', module='auth', description='x')
        Notification.objects.create(recipient_role='admin', notif_type='new_violation',
                                    title='t', message='m', related_user=self.enforcer_b)
        client = self.as_user(self.admin)
        for url in (f'/api/violations/{self.other_ovr.id}/', '/api/violations/',
                    '/api/audit/logs/', '/api/notifications/'):
            res = client.get(url)
            self.assertEqual(res.status_code, 200, f'{url} -> {res.status_code}')

    def test_snapshot_columns_are_not_leaked_into_existing_api_payloads(self):
        res = self.as_user(self.admin).get(f'/api/violations/{self.other_ovr.id}/')
        self.assertFalse([k for k in res.data if k.endswith('_snapshot') or k.endswith('_snapshot_source')])