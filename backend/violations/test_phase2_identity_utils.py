"""
Role Evolution - PHASE 2: event-time identity wiring + assessor / payment
confirmer separation.

Run:  python manage.py test violations.test_phase2_identity --settings=core.test_settings

"Later the user changes" is simulated with QuerySet.update(), which bypasses
every model guard — exactly what a future role transition would do to the live
account. No UserRoleHistory row is ever created here (Phase 2 has no role
change feature).
"""
import importlib

from django.apps import apps as django_apps
from django.utils import timezone

from accounts.identity import SnapshotSource
from accounts.models import CustomUser, UserRoleHistory
from audit.models import AuditLog
from audit.utils import log_action
from database_management.archive_utils import run_archive
from database_management.models import ArchivedViolation
from notifications.models import Notification
from violations.models import Assessment, Violation
from violations.tests import BaseRoleTestCase
from violations.views import OFFLINE_SYNC_DENIED_MSG

CREATE = '/api/violations/create/'


def mutate_identity(user, *, name='Renamed Person', role='staff', id_number='2099-NEW-0001'):
    """Change the LIVE account the way a future role change would."""
    CustomUser.objects.filter(pk=user.pk).update(full_name=name, role=role, id_number=id_number)
    user.refresh_from_db()


class Phase2Base(BaseRoleTestCase):

    def ovr_payload(self, **extra):
        data = {
            'violator_name': 'DELA CRUZ, JUAN',
            'ovr_number': 'OVR-P2-001',
            'location': 'ML Tagarao Street',
            'date_issued': timezone.now().isoformat(),
            'violation_type_ids': [str(self.vtype.id)],
            'status': 'pending',
            'source': 'enforcer_ovr',
        }
        data.update(extra)
        return data

    def processing_violation(self, assessor=None, ovr='OVR-P2-100'):
        v = self._make_violation(self.enforcer_a, ovr)
        res = self.as_user(assessor or self.staff).patch(
            f'/api/violations/{v.id}/assess/', {'status': 'processing'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        v.refresh_from_db()
        return v

    def confirm(self, v, user=None, **body):
        res = self.as_user(user or self.staff).post(
            f'/api/violations/{v.id}/confirm-payment/', body, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        return res

    def assert_snapshot(self, obj, prefix, user, *, badge=False):
        self.assertEqual(getattr(obj, f'{prefix}_name_snapshot'), user.full_name)
        self.assertEqual(getattr(obj, f'{prefix}_role_snapshot'), user.role)
        self.assertEqual(getattr(obj, f'{prefix}_id_number_snapshot'), user.id_number)
        self.assertEqual(getattr(obj, f'{prefix}_snapshot_source'), SnapshotSource.EVENT)
        if badge:
            self.assertEqual(getattr(obj, f'{prefix}_badge_snapshot'), user.badge_number or None)


# ─── AuditLog ────────────────────────────────────────────────────────────────

class AuditLogEventSnapshots(Phase2Base):

    def _log(self, user):
        log_action(user=user, action='UPDATE', module='Test', description='x')
        return AuditLog.objects.filter(module='Test').latest('id')

    def test_enforcer_actor_snapshot(self):
        self.assert_snapshot(self._log(self.enforcer_a), 'actor', self.enforcer_a)

    def test_staff_actor_snapshot(self):
        log = self._log(self.staff)
        self.assert_snapshot(log, 'actor', self.staff)
        self.assertEqual(log.actor_role_snapshot, 'staff')

    def test_admin_actor_snapshot(self):
        log = self._log(self.admin)
        self.assert_snapshot(log, 'actor', self.admin)
        self.assertEqual(log.actor_role_snapshot, 'admin')

    def test_no_actor_is_not_fabricated(self):
        log = self._log(None)
        self.assertIsNone(log.user)
        self.assertEqual(log.actor_snapshot_source, SnapshotSource.UNKNOWN)
        self.assertIsNone(log.actor_name_snapshot)
        self.assertIsNone(log.actor_role_snapshot)
        self.assertIsNone(log.actor_id_number_snapshot)

    def test_snapshot_survives_later_name_role_id_change(self):
        before = (self.enforcer_a.full_name, self.enforcer_a.role, self.enforcer_a.id_number)
        log = self._log(self.enforcer_a)
        mutate_identity(self.enforcer_a)
        log.refresh_from_db()
        self.assertEqual((log.actor_name_snapshot, log.actor_role_snapshot,
                          log.actor_id_number_snapshot), before)
        self.assertEqual(log.user_id, self.enforcer_a.id)         # live FK untouched

    def test_endpoint_audit_row_captures_the_authenticated_actor(self):
        res = self.as_user(self.enforcer_a).post(CREATE, self.ovr_payload(), format='json')
        self.assertEqual(res.status_code, 201, res.data)
        log = AuditLog.objects.filter(module='Violations', action='CREATE').latest('id')
        self.assert_snapshot(log, 'actor', self.enforcer_a)

    def test_every_audit_row_is_written_through_the_central_helper(self):
        """A second row by a different user gets that user's snapshot, not a stale one."""
        self._log(self.staff)
        self.assert_snapshot(self._log(self.admin), 'actor', self.admin)


# ─── Violation (Enforcer) ────────────────────────────────────────────────────

class ViolationEnforcerSnapshots(Phase2Base):

    def test_online_enforcer_ovr_captures_event_identity(self):
        res = self.as_user(self.enforcer_a).post(CREATE, self.ovr_payload(), format='json')
        self.assertEqual(res.status_code, 201, res.data)
        v = Violation.objects.get(pk=res.data['id'])
        self.assertEqual(v.enforcer_id, self.enforcer_a.id)
        self.assert_snapshot(v, 'enforcer', self.enforcer_a, badge=True)

    def test_badge_snapshot_is_captured_when_the_enforcer_has_one(self):
        CustomUser.objects.filter(pk=self.enforcer_a.pk).update(badge_number='B-77')
        self.enforcer_a.refresh_from_db()
        res = self.as_user(self.enforcer_a).post(CREATE, self.ovr_payload(), format='json')
        v = Violation.objects.get(pk=res.data['id'])
        self.assertEqual(v.enforcer_badge_snapshot, 'B-77')

    def test_client_cannot_supply_enforcer_identity(self):
        spoof = self.ovr_payload(
            enforcer=self.enforcer_b.id, enforcer_name='Forged Name', role='admin',
            id_number='FORGED-1', badge='FORGED',
            enforcer_name_snapshot='Forged Name', enforcer_role_snapshot='admin',
            enforcer_id_number_snapshot='FORGED-1', enforcer_badge_snapshot='FORGED',
            enforcer_snapshot_source='derived',
        )
        res = self.as_user(self.enforcer_a).post(CREATE, spoof, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        v = Violation.objects.get(pk=res.data['id'])
        self.assertEqual(v.enforcer_id, self.enforcer_a.id)
        self.assert_snapshot(v, 'enforcer', self.enforcer_a, badge=True)

    def test_offline_sync_captures_server_side_snapshot(self):
        res = self.as_user(self.enforcer_a).post(
            CREATE, self.ovr_payload(client_offline_id='p2_off_1'), format='json')
        self.assertEqual(res.status_code, 201, res.data)
        v = Violation.objects.get(client_offline_id='p2_off_1')
        self.assertEqual(v.enforcer_id, self.enforcer_a.id)
        self.assert_snapshot(v, 'enforcer', self.enforcer_a, badge=True)

    def test_offline_replay_returns_existing_and_does_not_rewrite_snapshot(self):
        payload = self.ovr_payload(client_offline_id='p2_off_2')
        self.as_user(self.enforcer_a).post(CREATE, payload, format='json')
        mutate_identity(self.enforcer_a, role='enforcer')            # same role, new name/ID
        again = self.as_user(self.enforcer_a).post(CREATE, payload, format='json')
        self.assertEqual(again.status_code, 200)
        v = Violation.objects.get(client_offline_id='p2_off_2')
        self.assertNotEqual(v.enforcer_name_snapshot, 'Renamed Person')
        self.assertEqual(v.enforcer_name_snapshot, 'Enforcer 1')

    def test_cross_user_replay_still_blocked_and_snapshot_unchanged(self):
        payload = self.ovr_payload(client_offline_id='p2_off_3')
        first = self.as_user(self.enforcer_a).post(CREATE, payload, format='json')
        res = self.as_user(self.enforcer_b).post(CREATE, payload, format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data['detail'], OFFLINE_SYNC_DENIED_MSG)
        v = Violation.objects.get(pk=first.data['id'])
        self.assert_snapshot(v, 'enforcer', self.enforcer_a, badge=True)

    def test_staff_offline_keyed_create_still_blocked_and_writes_nothing(self):
        res = self.as_user(self.staff).post(
            CREATE, self.ovr_payload(client_offline_id='p2_off_4'), format='json')
        self.assertEqual(res.status_code, 403)
        self.assertFalse(Violation.objects.filter(client_offline_id='p2_off_4').exists())

    def test_staff_walk_in_gets_no_enforcer_snapshot(self):
        data = self.ovr_payload(source='staff_walk_in')
        data.pop('ovr_number')
        res = self.as_user(self.staff).post(CREATE, data, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        v = Violation.objects.get(pk=res.data['id'])
        self.assertIsNone(v.enforcer_id)
        self.assertEqual(v.enforcer_snapshot_source, SnapshotSource.UNKNOWN)
        for f in ('enforcer_name_snapshot', 'enforcer_role_snapshot',
                  'enforcer_id_number_snapshot', 'enforcer_badge_snapshot'):
            self.assertIsNone(getattr(v, f), f)

    def test_snapshot_survives_later_name_role_id_change(self):
        res = self.as_user(self.enforcer_a).post(CREATE, self.ovr_payload(), format='json')
        before = ('Enforcer 1', 'enforcer', 'TEST-enforcer-1')
        mutate_identity(self.enforcer_a)
        v = Violation.objects.get(pk=res.data['id'])
        self.assertEqual((v.enforcer_name_snapshot, v.enforcer_role_snapshot,
                          v.enforcer_id_number_snapshot), before)
        self.assertEqual(v.enforcer_id, self.enforcer_a.id)

    def test_new_snapshots_survive_the_archive(self):
        res = self.as_user(self.enforcer_a).post(CREATE, self.ovr_payload(), format='json')
        v = Violation.objects.get(pk=res.data['id'])
        self.as_user(self.staff).patch(f'/api/violations/{v.id}/assess/',
                                       {'status': 'processing'}, format='json')
        self.confirm(v)
        batch = run_archive(self.admin)
        data = ArchivedViolation.objects.get(batch=batch, original_violation_id=v.id).data
        self.assertEqual(data['enforcer_name_snapshot'], 'Enforcer 1')
        self.assertEqual(data['enforcer_role_snapshot'], 'enforcer')
        self.assertEqual(data['enforcer_id_number_snapshot'], 'TEST-enforcer-1')
        self.assertEqual(data['enforcer_snapshot_source'], 'event')
        a = data['assessment']
        self.assertEqual(a['assessor_snapshot_source'], 'event')
        self.assertEqual(a['assessor_name_snapshot'], 'Staff 1')
        self.assertEqual(a['payment_confirmer_snapshot_source'], 'event')
        self.assertEqual(a['payment_confirmer_name_snapshot'], 'Staff 1')


# ─── Assessor vs payment confirmer ───────────────────────────────────────────

class AssessorAndPaymentConfirmer(Phase2Base):

    def test_case_a_staff_assesses(self):
        v = self.processing_violation(self.staff)
        a = v.assessment
        self.assertEqual(a.assessed_by_id, self.staff.id)
        self.assertIsNotNone(a.assessed_at)
        self.assert_snapshot(a, 'assessor', self.staff)
        self.assertEqual(v.assessed_by_id, self.staff.id)            # mirror
        # nothing about payment yet
        self.assertIsNone(a.payment_confirmed_by_id)
        self.assertEqual(a.payment_confirmer_snapshot_source, SnapshotSource.UNKNOWN)

    def test_case_b_staff_assesses_admin_confirms(self):
        v = self.processing_violation(self.staff)
        assessed_at = v.assessment.assessed_at
        self.confirm(v, self.admin)
        v.refresh_from_db()
        a = v.assessment
        self.assertEqual(v.status, 'paid')
        self.assertEqual(a.assessed_by_id, self.staff.id)             # NOT overwritten
        self.assertEqual(v.assessed_by_id, self.staff.id)             # NOT overwritten
        self.assertEqual(a.assessed_at, assessed_at)
        self.assert_snapshot(a, 'assessor', self.staff)
        self.assertEqual(a.payment_confirmed_by_id, self.admin.id)
        self.assertIsNotNone(a.payment_confirmed_at)
        self.assert_snapshot(a, 'payment_confirmer', self.admin)
        self.assertEqual(a.payment_confirmer_role_snapshot, 'admin')

    def test_case_c_same_person_does_both(self):
        v = self.processing_violation(self.staff)
        self.confirm(v, self.staff)
        a = Assessment.objects.get(violation=v)
        self.assertEqual(a.assessed_by_id, self.staff.id)
        self.assertEqual(a.payment_confirmed_by_id, self.staff.id)
        self.assert_snapshot(a, 'assessor', self.staff)
        self.assert_snapshot(a, 'payment_confirmer', self.staff)

    def test_case_d_assessor_snapshot_survives_later_change(self):
        v = self.processing_violation(self.staff)
        self.confirm(v, self.admin)
        mutate_identity(self.staff, name='Staff Promoted', role='admin', id_number='2099-ADM-0001')
        a = Assessment.objects.get(violation=v)
        self.assertEqual(a.assessor_name_snapshot, 'Staff 1')
        self.assertEqual(a.assessor_role_snapshot, 'staff')
        self.assertEqual(a.assessor_id_number_snapshot, 'TEST-staff-1')
        self.assertEqual(a.assessed_by_id, self.staff.id)

    def test_case_e_confirmer_snapshot_survives_later_change(self):
        v = self.processing_violation(self.staff)
        self.confirm(v, self.admin)
        mutate_identity(self.admin, name='Admin Demoted', role='staff', id_number='2099-STF-0009')
        a = Assessment.objects.get(violation=v)
        self.assertEqual(a.payment_confirmer_name_snapshot, 'Admin 1')
        self.assertEqual(a.payment_confirmer_role_snapshot, 'admin')
        self.assertEqual(a.payment_confirmer_id_number_snapshot, 'TEST-admin-1')
        self.assertEqual(a.payment_confirmed_by_id, self.admin.id)

    def test_payment_does_not_overwrite_even_when_a_third_user_confirms(self):
        other = CustomUser.objects.create_user(
            email='staff2@tmeo.test', password='TmeoTest!2026', full_name='Staff 2',
            id_number='TEST-staff-2', role='staff')
        v = self.processing_violation(self.staff)
        self.confirm(v, other)
        v.refresh_from_db()
        self.assertEqual(v.assessment.assessed_by_id, self.staff.id)
        self.assertEqual(v.assessed_by_id, self.staff.id)
        self.assertEqual(v.assessment.payment_confirmed_by_id, other.id)

    def test_reassessment_by_another_staff_updates_both_fk_and_snapshot_together(self):
        other = CustomUser.objects.create_user(
            email='staff3@tmeo.test', password='TmeoTest!2026', full_name='Staff 3',
            id_number='TEST-staff-3', role='staff')
        v = self.processing_violation(self.staff)
        self.as_user(other).patch(f'/api/violations/{v.id}/assess/',
                                  {'assessment_notes': 'rechecked'}, format='json')
        v.refresh_from_db()
        self.assertEqual(v.assessed_by_id, other.id)
        self.assertEqual(v.assessment.assessed_by_id, other.id)
        self.assert_snapshot(v.assessment, 'assessor', other)

    def test_client_cannot_choose_assessor_or_confirmer(self):
        v = self._make_violation(self.enforcer_a, 'OVR-P2-200')
        self.as_user(self.staff).patch(
            f'/api/violations/{v.id}/assess/',
            {'status': 'processing', 'assessed_by': self.admin.id,
             'assessor_name_snapshot': 'Forged', 'assessor_role_snapshot': 'admin'},
            format='json')
        v.refresh_from_db()
        self.assertEqual(v.assessment.assessed_by_id, self.staff.id)
        self.assert_snapshot(v.assessment, 'assessor', self.staff)
        self.confirm(v, self.staff,
                     payment_confirmed_by=self.admin.id, assessed_by=self.admin.id,
                     payment_confirmer_name_snapshot='Forged')
        a = Assessment.objects.get(violation=v)
        self.assertEqual(a.payment_confirmed_by_id, self.staff.id)
        self.assertEqual(a.assessed_by_id, self.staff.id)
        self.assert_snapshot(a, 'payment_confirmer', self.staff)

    def test_assessment_patch_endpoint_rejects_the_new_payment_fields(self):
        v = self.processing_violation()
        res = self.as_user(self.staff).patch(
            f'/api/violations/{v.id}/assessment/',
            {'payment_confirmed_by': self.admin.id, 'payment_confirmed_at': '2020-01-01T00:00:00Z'},
            format='json')
        self.assertEqual(res.status_code, 400)
        a = Assessment.objects.get(violation=v)
        self.assertIsNone(a.payment_confirmed_by_id)

    def test_enforcer_still_cannot_confirm_payment(self):
        v = self.processing_violation()
        res = self.as_user(self.enforcer_a).post(
            f'/api/violations/{v.id}/confirm-payment/', {}, format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(Violation.objects.get(pk=v.pk).status, 'processing')

    def test_failed_or_repeated_confirmation_does_not_change_the_confirmer(self):
        v = self.processing_violation()
        self.confirm(v, self.staff)
        res = self.as_user(self.admin).post(
            f'/api/violations/{v.id}/confirm-payment/', {}, format='json')
        self.assertEqual(res.status_code, 409)
        a = Assessment.objects.get(violation=v)
        self.assertEqual(a.payment_confirmed_by_id, self.staff.id)

    def test_in_flight_record_assessed_before_phase_2_keeps_its_real_assessor(self):
        """Processing row whose Assessment was never given an assessor (pre-Phase-2)."""
        v = self._make_violation(self.enforcer_a, 'OVR-P2-300', status='processing')
        Violation.objects.filter(pk=v.pk).update(assessed_by=self.staff, assessed_at=timezone.now())
        self.confirm(v, self.admin)
        a = Assessment.objects.get(violation=v)
        self.assertEqual(a.assessed_by_id, self.staff.id)
        self.assertEqual(a.payment_confirmed_by_id, self.admin.id)
        # no identity is invented for an assessment that had no event snapshot
        self.assertEqual(a.assessor_snapshot_source, SnapshotSource.UNKNOWN)
        self.assertIsNone(a.assessor_name_snapshot)

    def test_unassessed_processing_record_gets_no_fabricated_assessor(self):
        v = self._make_violation(self.enforcer_a, 'OVR-P2-301', status='processing')
        self.confirm(v, self.admin)
        a = Assessment.objects.get(violation=v)
        self.assertIsNone(a.assessed_by_id)
        self.assertEqual(a.assessor_snapshot_source, SnapshotSource.UNKNOWN)

    def test_existing_payment_behaviour_is_preserved(self):
        v = self.processing_violation()
        self.confirm(v, self.staff, or_number='OR-9')
        a = Assessment.objects.get(violation=v)
        self.assertEqual(a.amount_paid, 500)
        self.assertEqual(a.date_paid, timezone.localdate())
        self.assertEqual(a.or_number, 'OR-9')
        self.assertEqual(a.received_by, '')

    def test_read_payload_exposes_confirmer_additively(self):
        v = self.processing_violation(self.staff)
        self.confirm(v, self.admin)
        res = self.as_user(self.staff).get(f'/api/violations/{v.id}/assessment/')
        self.assertEqual(res.json()['assessed_by_name'], 'Staff 1')
        self.assertEqual(res.json()['payment_confirmed_by_name'], 'Admin 1')

    def test_payment_audit_row_snapshots_the_confirmer(self):
        v = self.processing_violation(self.staff)
        self.confirm(v, self.admin)
        log = AuditLog.objects.filter(module='Payment').latest('id')
        self.assert_snapshot(log, 'actor', self.admin)
        self.assertEqual(log.details['event'], 'PAYMENT_CONFIRMED')

    def test_dashboard_counts_payments_by_confirmer(self):
        v = self.processing_violation(self.staff)
        self.confirm(v, self.admin)
        staff_stats = self.as_user(self.staff).get('/api/violations/staff-dashboard/')
        admin_stats = self.as_user(self.admin).get('/api/violations/staff-dashboard/')
        self.assertEqual(staff_stats.status_code, 200)
        self.assertEqual(admin_stats.status_code, 200)
        self.assertEqual(staff_stats.json()['summary']['payments_recorded'], 0)
        self.assertEqual(admin_stats.json()['summary']['payments_recorded'], 1)

    def test_no_role_history_rows_and_no_role_change_side_effects(self):
        v = self.processing_violation()
        self.confirm(v, self.admin)
        self.assertEqual(UserRoleHistory.objects.count(), 0)
        self.staff.refresh_from_db()
        self.assertEqual((self.staff.role, self.staff.id_number), ('staff', 'TEST-staff-1'))


# ─── Notifications ───────────────────────────────────────────────────────────

class NotificationEventSnapshots(Phase2Base):

    def test_enforcer_generated_notification_snapshot(self):
        res = self.as_user(self.enforcer_a).post(CREATE, self.ovr_payload(), format='json')
        self.assertEqual(res.status_code, 201, res.data)
        notes = Notification.objects.filter(related_violation_id=str(res.data['id']),
                                            notif_type='new_violation')
        self.assertEqual(notes.count(), 2)                      # staff + admin
        for n in notes:
            self.assert_snapshot(n, 'actor', self.enforcer_a)

    def test_staff_generated_notification_snapshot(self):
        v = self._make_violation(self.enforcer_a, 'OVR-P2-400')
        self.as_user(self.staff).patch(f'/api/violations/{v.id}/assess/',
                                       {'status': 'processing'}, format='json')
        n = Notification.objects.get(related_violation_id=str(v.id), title='Violation Assessed')
        self.assert_snapshot(n, 'actor', self.staff)

    def test_staff_walk_in_notification_names_staff_not_enforcer(self):
        data = self.ovr_payload(source='staff_walk_in')
        data.pop('ovr_number')
        res = self.as_user(self.staff).post(CREATE, data, format='json')
        for n in Notification.objects.filter(related_violation_id=str(res.data['id'])):
            self.assert_snapshot(n, 'actor', self.staff)
            self.assertEqual(n.actor_role_snapshot, 'staff')

    def test_payment_notification_captures_the_actual_payment_actor(self):
        v = self.processing_violation(self.staff)
        self.confirm(v, self.admin)
        notes = Notification.objects.filter(related_violation_id=str(v.id), notif_type='violation_paid')
        self.assertEqual(notes.count(), 2)
        for n in notes:
            self.assert_snapshot(n, 'actor', self.admin)
            self.assertEqual(n.related_user_id, self.admin.id)

    def test_notification_snapshot_survives_later_change_and_mark_read(self):
        v = self.processing_violation(self.staff)
        self.confirm(v, self.admin)
        mutate_identity(self.admin)
        n = Notification.objects.filter(related_violation_id=str(v.id),
                                        notif_type='violation_paid').first()
        n.is_read = True
        n.save()                                                 # not a creation -> no recapture
        n.refresh_from_db()
        self.assertEqual(n.actor_name_snapshot, 'Admin 1')
        self.assertEqual(n.actor_role_snapshot, 'admin')
        self.assertEqual(n.actor_id_number_snapshot, 'TEST-admin-1')

    def test_notification_message_wording_is_unchanged(self):
        v = self.processing_violation(self.staff)
        self.confirm(v, self.admin)
        n = Notification.objects.filter(related_violation_id=str(v.id),
                                        notif_type='violation_paid').first()
        self.assertIn('Confirmed by Administrator Admin 1.', n.message)

    def test_no_duplicate_paid_notification(self):
        v = self.processing_violation(self.staff)
        self.confirm(v, self.staff)
        paid = lambda: Notification.objects.filter(
            related_violation_id=str(v.id), notif_type='violation_paid')
        self.assertEqual(paid().count(), 2)                      # one per recipient role
        self.assertEqual(sorted(paid().values_list('recipient_role', flat=True)), ['admin', 'staff'])
        v.refresh_from_db()
        v.remarks = 'unrelated re-save'
        v.save()                                                 # signal must stay silent
        self.as_user(self.staff).post(f'/api/violations/{v.id}/confirm-payment/', {}, format='json')
        self.assertEqual(paid().count(), 2)

    def test_notification_without_actor_stays_unknown(self):
        n = Notification.objects.create(recipient_role='admin', notif_type='pending_too_long',
                                        title='t', message='m')
        self.assertEqual(n.actor_snapshot_source, SnapshotSource.UNKNOWN)
        self.assertIsNone(n.actor_name_snapshot)


# ─── Legacy derivation migration (0031) ──────────────────────────────────────

class LegacyDerivation(Phase2Base):
    """Calls the migration's derive() against real rows (same fields)."""

    def setUp(self):
        mod = importlib.import_module('violations.migrations.0031_derive_legacy_payment_confirmer')
        self.derive = lambda: mod.derive(django_apps, None)

    def _legacy_paid(self, ovr, *, fk_user, pay_logs=1, assess_by=None, pay_by=None):
        """A paid row as it looked BEFORE Phase 2: FK = whoever confirmed payment."""
        v = self._make_violation(self.enforcer_a, ovr, status='paid')
        a = Assessment.objects.create(violation=v, assessed_by=fk_user, amount_paid=500,
                                      penalty=500, date_paid=timezone.localdate())
        if assess_by is not None:
            AuditLog.objects.create(
                user=assess_by, action='UPDATE', module='Assessment', target_type='Violation',
                target_id=str(v.id), description='assessed',
                details={'assessed_by': assess_by.full_name, 'role': assess_by.role})
        for _ in range(pay_logs):
            AuditLog.objects.create(
                user=pay_by, action='UPDATE', module='Payment', target_type='Violation',
                target_id=str(v.id), description='paid',
                details={'event': 'PAYMENT_CONFIRMED', 'assessed_by': pay_by.full_name,
                         'role': pay_by.role})
        return v, a

    def test_confirmer_is_derived_from_structured_audit_evidence(self):
        v, a = self._legacy_paid('L-1', fk_user=self.admin, assess_by=self.staff, pay_by=self.admin)
        self.derive()
        a.refresh_from_db()
        self.assertEqual(a.payment_confirmer_snapshot_source, 'derived')
        self.assertEqual(a.payment_confirmed_by_id, self.admin.id)
        self.assertEqual(a.payment_confirmer_name_snapshot, 'Admin 1')
        self.assertEqual(a.payment_confirmer_role_snapshot, 'admin')
        self.assertIsNone(a.payment_confirmer_id_number_snapshot)     # not in evidence
        self.assertIsNotNone(a.payment_confirmed_at)

    def test_overwritten_assessor_is_not_fabricated(self):
        """FK says Admin (confirmer overwrote), the assess log says Staff -> unprovable."""
        v, a = self._legacy_paid('L-2', fk_user=self.admin, assess_by=self.staff, pay_by=self.admin)
        self.derive()
        a.refresh_from_db()
        self.assertEqual(a.assessor_snapshot_source, 'unknown')
        self.assertIsNone(a.assessor_name_snapshot)
        self.assertEqual(a.assessed_by_id, self.admin.id)             # FK never rewritten

    def test_assessor_derived_only_when_evidence_agrees_with_the_fk(self):
        v, a = self._legacy_paid('L-3', fk_user=self.staff, assess_by=self.staff, pay_by=self.staff)
        self.derive()
        a.refresh_from_db()
        self.assertEqual(a.assessor_snapshot_source, 'derived')
        self.assertEqual(a.assessor_name_snapshot, 'Staff 1')
        self.assertEqual(a.assessor_role_snapshot, 'staff')

    def test_no_evidence_means_unknown(self):
        v = self._make_violation(self.enforcer_a, 'L-4', status='paid')
        a = Assessment.objects.create(violation=v, assessed_by=self.staff, amount_paid=500)
        self.derive()
        a.refresh_from_db()
        self.assertEqual(a.payment_confirmer_snapshot_source, 'unknown')
        self.assertIsNone(a.payment_confirmed_by_id)
        self.assertEqual(a.assessor_snapshot_source, 'unknown')

    def test_ambiguous_duplicate_payment_logs_are_left_alone(self):
        v, a = self._legacy_paid('L-5', fk_user=self.admin, pay_logs=2, pay_by=self.admin)
        self.derive()
        a.refresh_from_db()
        self.assertEqual(a.payment_confirmer_snapshot_source, 'unknown')
        self.assertIsNone(a.payment_confirmed_by_id)

    def test_nothing_is_ever_marked_event_and_accounts_are_untouched(self):
        self._legacy_paid('L-6', fk_user=self.staff, assess_by=self.staff, pay_by=self.staff)
        self.derive()
        self.assertFalse(Assessment.objects.filter(
            payment_confirmer_snapshot_source='event').exists())
        self.assertFalse(Assessment.objects.filter(assessor_snapshot_source='event').exists())
        self.assertEqual(UserRoleHistory.objects.count(), 0)
        self.staff.refresh_from_db()
        self.assertEqual(self.staff.id_number, 'TEST-staff-1')

    def test_derivation_is_idempotent(self):
        v, a = self._legacy_paid('L-7', fk_user=self.admin, assess_by=self.staff, pay_by=self.admin)
        self.derive(); a.refresh_from_db(); first = a.payment_confirmed_at
        self.derive(); a.refresh_from_db()
        self.assertEqual(a.payment_confirmed_at, first)