"""
Role Evolution - PHASE 4: historical data protection / hard-delete safety (HD-B).

Run:  python manage.py test accounts.test_phase4_hard_delete --settings=core.test_settings

Only test-database fixtures are used. No Change Role, no UserRoleHistory
transition is created by Phase 4 code (a few tests insert ledger rows by hand
purely as the fixture for "this account has role history").
"""
from unittest import mock

from django.contrib import admin as dj_admin
from django.contrib.admin.models import ADDITION, LogEntry
from django.contrib.contenttypes.models import ContentType
from django.db.models.deletion import ProtectedError
from django.test import RequestFactory, TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.admin import CustomUserAdmin
from accounts.history_guard import HISTORY_BLOCK_MESSAGE, get_user_historical_references
from accounts.models import CustomUser, UserRoleHistory
from audit.models import AuditLog
from audit.utils import log_action
from database_management.models import ArchiveBatch, ArchivedViolation
from enforcers.models import EnforcerLocation, EnforcerSchedule
from notifications.models import Notification
from violations.models import Assessment, Violation, ViolationEvidence

URL = '/api/auth/users/{}/permanent/'


def mk(n, role='enforcer', **extra):
    return CustomUser.objects.create_user(
        email=f'p4-{role}{n}@tmeo.test', password='TmeoTest!2026',
        full_name=extra.pop('full_name', f'P4 {role.title()} {n}'),
        id_number=extra.pop('id_number', f'2026-{role[:3].upper()}-{n:04d}'),
        role=role, **extra,
    )


def violation(enforcer=None, ovr='OVR-P4-1', **extra):
    return Violation.objects.create(
        violator_name='DELA CRUZ, JUAN', ovr_number=ovr, date_issued=timezone.now(),
        location='Test St', enforcer=enforcer, **extra,
    )


def archived(**data):
    batch = ArchiveBatch.objects.create(status='success')
    return ArchivedViolation.objects.create(
        batch=batch, original_violation_id=1, violation_year=2025,
        date_issued=timezone.now(), settlement_status='settled',
        violator_name='X', data=data,
    )


class Base(TestCase):
    def setUp(self):
        self.admin = mk(1, 'admin')
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def delete(self, user):
        return self.client.delete(URL.format(user.pk))

    def assertBlocked(self, user):
        res = self.delete(user)
        self.assertEqual(res.status_code, 409, res.content)
        self.assertEqual(res.json()['error'], HISTORY_BLOCK_MESSAGE)
        self.assertTrue(CustomUser.objects.filter(pk=user.pk).exists())
        self.assertFalse(AuditLog.objects.filter(
            description__startswith='Permanently deleted').exists())
        return res

    def success_audits(self):
        return AuditLog.objects.filter(description__startswith='Permanently deleted')


class HistoricalReferencesBlockDelete(Base):
    """Required scenarios 1-9 (+ notification, imports, role changes made)."""

    def test_audit_only_history_blocks(self):
        u = mk(2, 'staff')
        log_action(u, 'LOGIN', 'Auth', 'logged in')
        self.assertEqual(get_user_historical_references(u)['categories'], ['audit_trail'])
        self.assertBlocked(u)

    def test_enforcer_violation_history_blocks(self):
        u = mk(2)
        violation(u)
        self.assertBlocked(u)

    def test_assessor_history_blocks(self):
        u = mk(2, 'staff')
        v = violation(self.admin)
        Assessment.objects.create(violation=v, assessed_by=u)
        self.assertIn('assessments', get_user_historical_references(u)['categories'])
        self.assertBlocked(u)

    def test_violation_level_assessor_blocks(self):
        u = mk(2, 'staff')
        violation(self.admin, assessed_by=u)
        self.assertIn('violations_assessed', get_user_historical_references(u)['categories'])
        self.assertBlocked(u)

    def test_payment_confirmer_history_blocks(self):
        u = mk(2, 'staff')
        v = violation(self.admin)
        Assessment.objects.create(violation=v, payment_confirmed_by=u)
        self.assertIn('payment_confirmations', get_user_historical_references(u)['categories'])
        self.assertBlocked(u)

    def test_imported_by_history_blocks(self):
        u = mk(2, 'admin')
        violation(None, imported_by=u)
        self.assertIn('violations_imported', get_user_historical_references(u)['categories'])
        self.assertBlocked(u)

    def test_evidence_actor_history_blocks(self):
        u = mk(2)
        ViolationEvidence.objects.create(captured_by=u, captured_at=timezone.now(), image='evidence/x.jpg')
        self.assertEqual(get_user_historical_references(u)['categories'], ['evidence'])
        self.assertBlocked(u)

    def test_schedule_only_history_blocks(self):
        u = mk(2)
        EnforcerSchedule.objects.create(
            enforcer=u, date=timezone.now().date(), shift_start='08:00',
            shift_end='17:00', assigned_area='Area', created_by=self.admin)
        self.assertEqual(get_user_historical_references(u)['categories'], ['schedules'])
        self.assertBlocked(u)

    def test_schedule_creator_history_blocks(self):
        staff = mk(2, 'staff')
        enf = mk(3)
        EnforcerSchedule.objects.create(
            enforcer=enf, date=timezone.now().date(), shift_start='08:00',
            shift_end='17:00', assigned_area='Area', created_by=staff)
        self.assertEqual(get_user_historical_references(staff)['categories'], ['schedules_created'])
        self.assertBlocked(staff)

    def test_notification_actor_history_blocks(self):
        u = mk(2)
        Notification.objects.create(
            recipient_role='admin', notif_type='new_violation', title='t', message='m',
            related_user=u)
        self.assertEqual(get_user_historical_references(u)['categories'], ['notifications'])
        self.assertBlocked(u)

    def test_archive_batch_creator_blocks(self):
        u = mk(2, 'admin')
        ArchiveBatch.objects.create(created_by=u, status='success')
        self.assertEqual(get_user_historical_references(u)['categories'], ['archive_batches'])
        self.assertBlocked(u)

    def test_role_history_participation_blocks_both_sides(self):
        subject, actor = mk(2), mk(3, 'admin')
        UserRoleHistory.objects.create(
            user=subject, changed_by=actor, old_role='enforcer', new_role='staff',
            old_id_number='2026-ENF-0002', new_id_number='2026-STF-0002')
        self.assertIn('role_history', get_user_historical_references(subject)['categories'])
        self.assertIn('role_changes_made', get_user_historical_references(actor)['categories'])
        self.assertBlocked(subject)
        self.assertBlocked(actor)
        self.assertEqual(UserRoleHistory.objects.count(), 1)       # ledger untouched

    def test_django_admin_site_activity_blocks(self):
        u = mk(2, 'admin')
        LogEntry.objects.create(
            user=u, content_type=ContentType.objects.get_for_model(CustomUser),
            object_id='1', object_repr='x', action_flag=ADDITION)
        self.assertEqual(get_user_historical_references(u)['categories'], ['admin_site_activity'])
        self.assertBlocked(u)

    def test_deactivated_account_with_history_stays_protected(self):
        u = mk(2)
        violation(u)
        res = self.client.patch(f'/api/auth/users/{u.pk}/', {'employment_status': 'terminated'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        u.refresh_from_db()
        self.assertFalse(u.is_active)
        self.assertEqual(Violation.objects.filter(enforcer=u).count(), 1)   # deactivation erased nothing
        self.assertBlocked(u)

    def test_blocked_response_leaks_no_internals(self):
        u = mk(2)
        violation(u)
        body = self.delete(u).content.decode().lower()
        for leak in ('traceback', 'violations_violation', 'tmeo_user_role_history', 'protectederror'):
            self.assertNotIn(leak, body)


class TransientAndDerivedAreNotHistory(Base):
    """Scenarios 11-12."""

    def test_transient_lock_alone_is_not_history_and_delete_succeeds(self):
        u = mk(2, 'staff')
        v = violation(self.admin)
        Violation.objects.filter(pk=v.pk).update(locked_by=u)
        self.assertFalse(get_user_historical_references(u)['has_history'])
        res = self.delete(u)
        self.assertEqual(res.status_code, 200, res.content)
        v.refresh_from_db()
        self.assertIsNone(v.locked_by_id)                           # SET_NULL, record intact

    def test_live_gps_state_alone_is_not_history_and_is_removed_with_user(self):
        u = mk(2)
        EnforcerLocation.objects.create(enforcer=u, latitude=13.9, longitude=121.6)
        self.assertFalse(get_user_historical_references(u)['has_history'])
        self.assertEqual(self.delete(u).status_code, 200)
        self.assertFalse(EnforcerLocation.objects.exists())


class ZeroHistoryDelete(Base):
    """Scenarios 10, 14, 15 and the retired-ID rule."""

    def test_zero_history_account_can_be_deleted_and_audit_is_the_admins(self):
        u = mk(2, 'staff')
        # Account creation is logged by the ADMIN with the new user only as text.
        log_action(self.admin, 'CREATE', 'Accounts', f'Created account: {u.email}',
                   target_type='User', target_id=u.pk,
                   details={'target_user': u.full_name})
        self.assertFalse(get_user_historical_references(u)['has_history'])
        res = self.delete(u)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(CustomUser.objects.filter(pk=u.pk).exists())
        log = self.success_audits().get()
        self.assertEqual(log.user_id, self.admin.pk)                # actor = deleting Admin
        self.assertEqual(log.target_id, str(u.pk))                  # target is text only
        self.assertEqual(log.details['deleted_user'], u.full_name)
        # the Admin's earlier CREATE row still exists, untouched
        self.assertTrue(AuditLog.objects.filter(action='CREATE', user=self.admin).exists())

    def test_blocked_attempt_writes_no_success_audit_but_a_failed_one(self):
        u = mk(2)
        violation(u)
        self.assertBlocked(u)
        failed = AuditLog.objects.filter(action='DELETE', status='FAILED')
        self.assertEqual(failed.count(), 1)
        self.assertEqual(failed.get().user_id, self.admin.pk)

    def test_self_delete_still_400(self):
        res = self.delete(self.admin)
        self.assertEqual(res.status_code, 400)
        self.assertTrue(CustomUser.objects.filter(pk=self.admin.pk).exists())

    def test_non_admin_still_403_and_missing_user_404(self):
        staff = mk(2, 'staff')
        self.client.force_authenticate(staff)
        self.assertEqual(self.delete(mk(3)).status_code, 403)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.delete(URL.format(999999)).status_code, 404)
        self.assertEqual(self.success_audits().count(), 0)

    def test_retired_id_stays_reserved_while_zero_history_id_may_be_reused(self):
        # Reserved by the ledger even though the account row still exists.
        a = mk(3)
        UserRoleHistory.objects.create(
            user=a, old_role='enforcer', new_role='staff',
            old_id_number='2026-ENF-0003', new_id_number='2026-STF-0003')
        self.assertTrue(CustomUser.objects.is_id_reserved('2026-ENF-0003'))
        # Documented/accepted (Part 21): a genuinely zero-history, ledger-free
        # account that held the top sequence may be re-issued after deletion.
        z = mk(4)
        self.assertEqual(self.delete(z).status_code, 200)
        self.assertEqual(CustomUser.objects.generate_id_number('enforcer', 2026), '2026-ENF-0004')


class DatabaseProtectIsFinalSafetyNet(Base):
    """Scenario 13."""

    def test_orm_delete_of_referenced_user_raises_protected_error(self):
        for factory in (
            lambda u: violation(u),
            lambda u: log_action(u, 'LOGIN', 'Auth', 'x'),
            lambda u: ArchiveBatch.objects.create(created_by=u, status='success'),
            lambda u: ViolationEvidence.objects.create(captured_by=u, captured_at=timezone.now(), image='evidence/x.jpg'),
            lambda u: Notification.objects.create(
                recipient_role='admin', notif_type='new_violation', title='t', message='m', related_user=u),
        ):
            u = mk(CustomUser.objects.count() + 10)
            factory(u)
            with self.assertRaises(ProtectedError):
                u.delete()

    def test_protected_error_is_a_controlled_409_not_a_500(self):
        u = mk(2)
        violation(u)
        # Simulate the application detector missing the relationship.
        with mock.patch('accounts.views.get_user_historical_references',
                        return_value={'has_history': False, 'categories': [], 'labels': []}):
            res = self.delete(u)
        self.assertEqual(res.status_code, 409, res.content)
        self.assertEqual(res.json()['error'], HISTORY_BLOCK_MESSAGE)
        self.assertTrue(CustomUser.objects.filter(pk=u.pk).exists())
        self.assertEqual(Violation.objects.filter(enforcer=u).count(), 1)
        self.assertEqual(self.success_audits().count(), 0)          # no false success audit


class ArchivedHistory(Base):
    """Part 19 A-D. Names are never an ownership key."""

    def test_A_stable_enforcer_user_id_blocks(self):
        u = mk(2)
        archived(enforcer_user_id=u.pk, enforcer_name='Whoever')
        self.assertEqual(get_user_historical_references(u)['categories'], ['archived_violations'])
        self.assertBlocked(u)

    def test_B_id_number_snapshot_blocks(self):
        u = mk(2)
        archived(enforcer_id_number_snapshot=u.id_number)
        self.assertBlocked(u)

    def test_B2_assessor_and_payment_confirmer_id_snapshots_block(self):
        a, b = mk(2, 'staff'), mk(3, 'staff')
        archived(assessment={'assessor_id_number_snapshot': a.id_number})
        archived(assessment={'payment_confirmer_id_number_snapshot': b.id_number})
        self.assertBlocked(a)
        self.assertBlocked(b)

    def test_B3_retired_id_from_role_history_blocks_via_stable_evidence(self):
        u = mk(2)
        # The user is guarded by the ledger anyway; check the archive path in isolation.
        from accounts.history_guard import _has_archived_history, _held_id_numbers
        UserRoleHistory.objects.create(
            user=u, old_role='enforcer', new_role='staff',
            old_id_number='2026-ENF-0002', new_id_number='2026-STF-0002')
        self.assertIn('2026-STF-0002', _held_id_numbers(u))
        archived(enforcer_id_number_snapshot='2026-STF-0002')
        self.assertTrue(_has_archived_history(u))

    def test_C_name_only_never_establishes_history(self):
        u = mk(2, full_name='Pedro Reyes')
        archived(enforcer_name='Pedro Reyes', enforcer_name_snapshot='Pedro Reyes',
                 assessed_by_name='Pedro Reyes',
                 assessment={'assessor_name_snapshot': 'Pedro Reyes',
                             'payment_confirmer_name_snapshot': 'Pedro Reyes'})
        self.assertFalse(get_user_historical_references(u)['has_history'])
        self.assertEqual(self.delete(u).status_code, 200)
        self.assertEqual(ArchivedViolation.objects.count(), 1)       # archive preserved untouched

    def test_D_identical_names_do_not_cross_block(self):
        owner = mk(2, full_name='Pedro Reyes')
        namesake = mk(3, full_name='Pedro Reyes')
        archived(enforcer_user_id=owner.pk, enforcer_name='Pedro Reyes',
                 enforcer_id_number_snapshot=owner.id_number)
        self.assertTrue(get_user_historical_references(owner)['has_history'])
        self.assertFalse(get_user_historical_references(namesake)['has_history'])
        self.assertBlocked(owner)
        self.assertEqual(self.delete(namesake).status_code, 200)

    def test_empty_id_snapshots_never_match_a_user_without_an_id(self):
        u = mk(2)
        CustomUser.objects.filter(pk=u.pk).update(id_number='')
        u.refresh_from_db()
        archived(enforcer_id_number_snapshot='', enforcer_user_id=None)
        self.assertFalse(get_user_historical_references(u)['has_history'])


class DjangoAdminCannotBypass(TestCase):

    def setUp(self):
        self.site_admin = CustomUser.objects.create_superuser(
            email='root@tmeo.test', password='x', full_name='Root', id_number='2026-ADM-0099', role='admin')
        self.ma = CustomUserAdmin(CustomUser, dj_admin.site)
        self.req = RequestFactory().get('/')
        self.req.user = self.site_admin

    def test_history_account_cannot_be_deleted_in_admin_and_orm_agrees(self):
        u = mk(2)
        violation(u)
        self.assertFalse(self.ma.has_delete_permission(self.req, u))
        with self.assertRaises(ProtectedError):
            u.delete()

    def test_zero_history_account_is_deletable_in_admin(self):
        self.assertTrue(self.ma.has_delete_permission(self.req, mk(2)))

    def test_admin_delete_page_refuses_history_account(self):
        u = mk(2)
        violation(u)
        self.client.force_login(self.site_admin)
        res = self.client.post(f'/admin/accounts/customuser/{u.pk}/delete/', {'post': 'yes'})
        self.assertIn(res.status_code, (302, 403))
        self.assertTrue(CustomUser.objects.filter(pk=u.pk).exists())