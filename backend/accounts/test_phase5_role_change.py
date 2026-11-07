"""
Role Evolution - PHASE 5: role change engine + server-side session invalidation.

SQLite : python manage.py test accounts.test_phase5_role_change --settings=core.test_settings
Postgres: python manage.py test accounts.test_phase5_role_change
(the concurrency class only runs on PostgreSQL).
"""
import threading
from datetime import timedelta
from unittest import mock, skipUnless

from django.core.cache import cache
from django.db import close_old_connections, connection
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.authentication import account_still_matches
from accounts.history_guard import get_user_historical_references
from accounts.identity import audit_actor_identity
from accounts.models import CustomUser, UserRoleHistory
from accounts.services import RoleChangeError, change_user_role
from audit.models import AuditLog
from audit.utils import log_action
from enforcers.models import EnforcerLocation, EnforcerSchedule
from violations.models import Violation

PW = 'TmeoTest!2026'
Role = CustomUser.Role


def mk(n, role, year=2024, **extra):
    return CustomUser.objects.create_user(
        email=f'p5-{role}{n}@tmeo.test', password=PW, full_name=extra.pop('full_name', f'P5 {role} {n}'),
        role=role, hired_year=year, id_number=f'{year}-{CustomUser.ROLE_CODES[role]}-{n:04d}', **extra,
    )


def url(pk):
    return f'/api/auth/users/{pk}/change-role/'


STAFF_ONLY = '/api/violations/pending/'          # admin/staff allowed, enforcer 403
ENFORCER_ONLY = '/api/auth/duty-status/'         # POST: enforcer only (403 for others)


class Base(TestCase):
    def setUp(self):
        cache.clear()                    # LoginView has its own per-IP throttle
        self.admin = mk(1, 'admin')
        self.staff = mk(1, 'staff')
        self.enf = mk(1, 'enforcer')
        self.api = APIClient()
        self.api.force_authenticate(self.admin)

    def change(self, user, new_role, reason='Reassignment', **extra):
        return self.api.post(url(user.pk), {'new_role': new_role, 'reason': reason, **extra}, format='json')

    def login(self, user_or_id, password=PW):
        id_number = getattr(user_or_id, 'id_number', user_or_id)
        c = APIClient()
        res = c.post('/api/auth/login/', {'id_number': id_number, 'password': password}, format='json')
        return c, res

    def bearer(self, access):
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')
        return c

    def success_logs(self):
        return AuditLog.objects.filter(module='User Management', description__startswith='Changed role')


class BasicTransition(Base):

    def test_staff_to_enforcer_keeps_pk_hired_year_and_updates_role_and_id(self):
        pk = self.staff.pk
        res = self.change(self.staff, 'enforcer')
        self.assertEqual(res.status_code, 200, res.content)
        u = CustomUser.objects.get(pk=pk)
        self.assertEqual((u.role, u.id_number, u.hired_year), ('enforcer', '2024-ENF-0002', 2024))
        body = res.json()
        self.assertEqual(body['user']['id'], pk)
        self.assertEqual(body['previous'], {'role': 'staff', 'id_number': '2024-STF-0001'})
        self.assertTrue(body['sessions_invalidated'])
        self.assertNotIn('access', str(body).lower())

    def test_enforcer_to_staff(self):
        res = self.change(self.enf, 'staff')
        self.assertEqual(res.status_code, 200, res.content)
        u = CustomUser.objects.get(pk=self.enf.pk)
        self.assertEqual((u.role, u.id_number), ('staff', '2024-STF-0002'))

    def test_new_id_uses_original_hired_year_not_current_year(self):
        old_timer = mk(5, 'staff', year=2019)
        self.change(old_timer, 'enforcer')
        old_timer.refresh_from_db()
        self.assertTrue(old_timer.id_number.startswith('2019-ENF-'))
        self.assertEqual(old_timer.hired_year, 2019)

    def test_other_account_fields_are_untouched(self):
        CustomUser.objects.filter(pk=self.staff.pk).update(
            assigned_area='Barangay 5', badge_number='B-77', phone_number='0917')
        before = CustomUser.objects.values().get(pk=self.staff.pk)
        self.change(self.staff, 'enforcer')
        after = CustomUser.objects.values().get(pk=self.staff.pk)
        changed = {k for k in before if before[k] != after[k]}
        self.assertEqual(changed, {'role', 'id_number'})            # (duty fields unchanged for staff)


class HistoryAndLedger(Base):

    def test_history_row_records_who_what_when_why(self):
        t0 = timezone.now()
        self.change(self.staff, 'enforcer', reason='Reassigned to field work')
        row = UserRoleHistory.objects.get()
        self.assertEqual(row.user_id, self.staff.pk)
        self.assertEqual(row.changed_by_id, self.admin.pk)
        self.assertEqual((row.old_role, row.new_role), ('staff', 'enforcer'))
        self.assertEqual((row.old_id_number, row.new_id_number), ('2024-STF-0001', '2024-ENF-0002'))
        self.assertEqual(row.reason, 'Reassigned to field work')
        self.assertGreaterEqual(row.effective_at, t0)

    def test_earlier_history_rows_are_never_modified(self):
        self.change(self.staff, 'enforcer')
        first = UserRoleHistory.objects.values().get()
        self.change(self.staff, 'staff')
        self.assertEqual(UserRoleHistory.objects.count(), 2)
        self.assertEqual(UserRoleHistory.objects.values().get(pk=first['id']), first)

    def test_retired_ids_are_never_reused_even_on_return_to_a_role(self):
        self.change(self.staff, 'enforcer')       # STF-0001 retired, ENF-0002
        self.change(self.staff, 'staff')          # ENF-0002 retired, STF-0002 (NOT 0001)
        self.staff.refresh_from_db()
        self.assertEqual(self.staff.id_number, '2024-STF-0002')
        self.assertTrue(CustomUser.objects.is_id_reserved('2024-STF-0001'))
        self.assertTrue(CustomUser.objects.is_id_reserved('2024-ENF-0002'))
        # a brand-new account in either role never receives a retired number
        self.assertEqual(CustomUser.objects.generate_id_number('staff', 2024), '2024-STF-0003')
        self.assertEqual(CustomUser.objects.generate_id_number('enforcer', 2024), '2024-ENF-0003')

    def test_two_people_moving_into_the_same_role_get_distinct_ids(self):
        other = mk(2, 'staff')
        self.change(self.staff, 'enforcer')
        self.change(other, 'enforcer')
        ids = set(CustomUser.objects.filter(role='enforcer').values_list('id_number', flat=True))
        self.assertEqual(len(ids), 3)

    def test_id_collision_is_retried_then_reported_as_409_with_nothing_changed(self):
        other = mk(2, 'staff')
        self.change(other, 'enforcer')
        taken = UserRoleHistory.objects.get().new_id_number
        with mock.patch.object(CustomUser.objects, 'generate_id_number_for_user',
                               side_effect=[taken, '2024-ENF-0099']):
            self.assertEqual(self.change(self.staff, 'enforcer').status_code, 200)
        self.staff.refresh_from_db()
        self.assertEqual(self.staff.id_number, '2024-ENF-0099')
        # always colliding
        third = mk(3, 'staff')
        with mock.patch.object(CustomUser.objects, 'generate_id_number_for_user', return_value=taken):
            res = self.change(third, 'enforcer')
        self.assertEqual(res.status_code, 409)
        third.refresh_from_db()
        self.assertEqual((third.role, third.id_number), ('staff', '2024-STF-0003'))
        self.assertEqual(UserRoleHistory.objects.filter(user=third).count(), 0)


class HistoricalSnapshotsStayImmutable(Base):

    def test_old_audit_rows_keep_staff_identity_and_new_ones_use_enforcer(self):
        old = log_action(self.staff, 'LOGIN', 'Auth', 'staff logged in')
        old_log = AuditLog.objects.get(description='staff logged in')
        before = audit_actor_identity(old_log)
        self.assertEqual((before['role'], before['id_number']), ('staff', '2024-STF-0001'))

        self.change(self.staff, 'enforcer')
        self.staff.refresh_from_db()
        log_action(self.staff, 'LOGIN', 'Auth', 'enforcer logged in')

        old_log.refresh_from_db()
        after = audit_actor_identity(old_log)
        self.assertEqual((after['role'], after['id_number']), ('staff', '2024-STF-0001'))
        new = audit_actor_identity(AuditLog.objects.get(description='enforcer logged in'))
        self.assertEqual((new['role'], new['id_number']), ('enforcer', self.staff.id_number))
        self.assertEqual(AuditLog.objects.get(description='enforcer logged in').user_id, self.staff.pk)

    def test_violation_enforcer_snapshot_is_not_rewritten(self):
        v = Violation.objects.create(
            violator_name='X', ovr_number='OVR-P5-1', date_issued=timezone.now(), location='L',
            enforcer=self.enf)
        snap = {f.name: getattr(v, f.name) for f in Violation._meta.fields if 'snapshot' in f.name}
        self.change(self.enf, 'staff')
        v.refresh_from_db()
        self.assertEqual({f.name: getattr(v, f.name) for f in Violation._meta.fields if 'snapshot' in f.name}, snap)
        self.assertEqual(v.enforcer_id, self.enf.pk)

    def test_the_transition_does_not_bulk_update_any_audit_row(self):
        log_action(self.staff, 'X', 'Auth', 'pre')
        pre_ids = set(AuditLog.objects.filter(description='pre').values_list('id', flat=True))
        before = list(AuditLog.objects.filter(id__in=pre_ids).values())
        self.change(self.staff, 'enforcer')
        self.assertEqual(list(AuditLog.objects.filter(id__in=pre_ids).values()), before)


class AuthInvalidation(Base):

    def test_old_tokens_die_server_side_and_user_must_sign_in_with_new_id(self):
        client, res = self.login(self.staff)
        self.assertEqual(res.status_code, 200, res.content)
        access, refresh = res.json()['access'], res.json()['refresh']
        self.assertEqual(self.bearer(access).get(STAFF_ONLY).status_code, 200)

        self.assertEqual(self.change(self.staff, 'enforcer').status_code, 200)
        old_id = '2024-STF-0001'

        # old access token: rejected outright (not merely re-authorized as enforcer)
        res = self.bearer(access).get(STAFF_ONLY)
        self.assertEqual(res.status_code, 401)
        self.assertEqual(self.bearer(access).get('/api/auth/me/').status_code, 401)
        # old refresh token: cannot mint new access tokens
        res = APIClient().post('/api/auth/token/refresh/', {'refresh': refresh}, format='json')
        self.assertEqual(res.status_code, 401)
        # outstanding refresh tokens were blacklisted
        self.assertFalse(OutstandingToken.objects.filter(user=self.staff).exclude(
            blacklistedtoken__isnull=False).exists())
        # re-authentication: old ID no longer exists, new ID works
        self.assertEqual(self.login(old_id)[1].status_code, 400)
        self.staff.refresh_from_db()
        c2, res2 = self.login(self.staff)
        self.assertEqual(res2.status_code, 200, res2.content)
        self.assertEqual(res2.json()['user']['role'], 'enforcer')

    def test_old_role_endpoint_denied_and_new_role_endpoint_allowed_after_relogin(self):
        self.change(self.staff, 'enforcer')
        self.staff.refresh_from_db()
        _, res = self.login(self.staff)
        c = self.bearer(res.json()['access'])
        self.assertEqual(c.get(STAFF_ONLY).status_code, 403)        # old-role endpoint
        self.assertNotEqual(c.post(ENFORCER_ONLY, {}, format='json').status_code, 403)   # new-role endpoint
        self.assertEqual(c.get('/api/auth/me/').json()['role'], 'enforcer')

    def test_the_reverse_direction_also_invalidates(self):
        _, res = self.login(self.enf)
        access = res.json()['access']
        self.assertNotEqual(self.bearer(access).get('/api/auth/me/').status_code, 401)
        self.change(self.enf, 'staff')
        self.assertEqual(self.bearer(access).get('/api/auth/me/').status_code, 401)

    def test_other_users_sessions_are_not_affected(self):
        _, res = self.login(self.enf)
        access = res.json()['access']
        self.change(self.staff, 'enforcer')
        self.assertEqual(self.bearer(access).get('/api/auth/me/').status_code, 200)

    def test_refresh_token_not_in_outstanding_table_is_still_refused_by_claims(self):
        _, res = self.login(self.staff)
        refresh = res.json()['refresh']
        OutstandingToken.objects.filter(user=self.staff).delete()
        self.change(self.staff, 'enforcer')
        r = APIClient().post('/api/auth/token/refresh/', {'refresh': refresh}, format='json')
        self.assertEqual(r.status_code, 401)

    def test_valid_session_still_refreshes_normally(self):
        _, res = self.login(self.staff)
        r = APIClient().post('/api/auth/token/refresh/', {'refresh': res.json()['refresh']}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.bearer(r.json()['access']).get('/api/auth/me/').status_code, 200)

    def test_claimless_tokens_are_valid_only_if_issued_after_the_latest_transition(self):
        now = int(timezone.now().timestamp())
        bare = RefreshToken.for_user(self.staff).access_token
        bare['iat'] = now - 300
        self.assertEqual(self.bearer(str(bare)).get('/api/auth/me/').status_code, 200)   # no transition yet
        self.change(self.staff, 'enforcer')
        # (update() bypasses the append-only guard; used only to place the fixture in time)
        UserRoleHistory.objects.filter(user=self.staff).update(effective_at=timezone.now() - timedelta(seconds=100))
        self.assertEqual(self.bearer(str(bare)).get('/api/auth/me/').status_code, 401)   # issued before
        later = RefreshToken.for_user(self.staff).access_token
        later['iat'] = now
        self.assertEqual(self.bearer(str(later)).get('/api/auth/me/').status_code, 200)  # issued after

    def test_sse_endpoints_reject_old_tokens_and_open_streams_end(self):
        _, res = self.login(self.staff)
        access = res.json()['access']
        self.change(self.staff, 'enforcer')
        for path in ('/api/notifications/sse/', '/api/violations/sse/'):
            self.assertEqual(APIClient().get(path, {'token': access}).status_code, 401, path)
        self.staff.refresh_from_db()
        self.assertTrue(account_still_matches(self.staff.pk, 'enforcer', self.staff.id_number))
        self.assertFalse(account_still_matches(self.staff.pk, 'staff', '2024-STF-0001'))

    def test_inactive_account_no_longer_matches_open_stream(self):
        CustomUser.objects.filter(pk=self.staff.pk).update(is_active=False)
        self.assertFalse(account_still_matches(self.staff.pk, 'staff', self.staff.id_number))


class PermissionsAndValidation(Base):

    def test_non_admins_and_anonymous_cannot_change_roles(self):
        for actor in (self.staff, self.enf):
            self.api.force_authenticate(actor)
            target = mk(actor.pk + 10, 'staff')
            self.assertEqual(self.change(target, 'enforcer').status_code, 403)
            target.refresh_from_db()
            self.assertEqual(target.role, 'staff')
        self.assertEqual(APIClient().post(url(self.staff.pk), {}, format='json').status_code, 401)
        self.assertEqual(UserRoleHistory.objects.count(), 0)
        self.assertEqual(self.success_logs().count(), 0)
        self.assertTrue(AuditLog.objects.filter(status='FAILED', module='User Management').exists())

    def test_nobody_can_change_their_own_role(self):
        self.api.force_authenticate(self.admin)
        self.assertEqual(self.change(self.admin, 'staff').status_code, 403)
        self.admin.refresh_from_db()
        self.assertEqual(self.admin.role, 'admin')

    def test_target_cannot_self_promote(self):
        self.api.force_authenticate(self.staff)
        self.assertEqual(self.change(self.staff, 'admin').status_code, 403)
        self.staff.refresh_from_db()
        self.assertEqual(self.staff.role, 'staff')

    def test_generic_user_update_cannot_change_role_id_or_hired_year(self):
        before = CustomUser.objects.values('role', 'id_number', 'hired_year').get(pk=self.staff.pk)
        res = self.api.patch(f'/api/auth/users/{self.staff.pk}/',
                             {'role': 'admin', 'id_number': 'HACK-1', 'hired_year': 1999,
                              'phone_number': '0999'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(CustomUser.objects.values('role', 'id_number', 'hired_year').get(pk=self.staff.pk), before)
        self.assertEqual(CustomUser.objects.get(pk=self.staff.pk).phone_number, '0999')

    def test_invalid_input_is_rejected(self):
        cases = [
            ({'new_role': 'janitor', 'reason': 'x'}, 400),
            ({'new_role': 'enforcer'}, 400),
            ({'new_role': 'enforcer', 'reason': '   '}, 400),
            ({'new_role': 'enforcer', 'reason': 'x' * 501}, 400),
            ({'new_role': 'enforcer', 'reason': 'x', 'id_number': '2024-ENF-9999'}, 400),
            ({'new_role': 'enforcer', 'reason': 'x', 'new_id_number': '2024-ENF-9999'}, 400),
            ({'new_role': 'enforcer', 'reason': 'x', 'hired_year': 2000}, 400),
            ({'new_role': 'enforcer', 'reason': 'x', 'expected_role': 'enforcer'}, 409),
            ({'new_role': 'staff', 'reason': 'x'}, 409),                  # already staff
        ]
        for payload, code in cases:
            with self.subTest(payload=payload):
                res = self.api.post(url(self.staff.pk), payload, format='json')
                self.assertEqual(res.status_code, code, res.content)
        self.staff.refresh_from_db()
        self.assertEqual((self.staff.role, self.staff.id_number), ('staff', '2024-STF-0001'))
        self.assertEqual(UserRoleHistory.objects.count(), 0)

    def test_unknown_user_is_404(self):
        self.assertEqual(self.api.post(url(999999), {'new_role': 'staff', 'reason': 'x'}, format='json').status_code, 404)

    def test_inactive_or_separated_accounts_cannot_change_role(self):
        CustomUser.objects.filter(pk=self.staff.pk).update(is_active=False)
        self.assertEqual(self.change(self.staff, 'enforcer').status_code, 409)
        CustomUser.objects.filter(pk=self.enf.pk).update(employment_status='resigned')
        self.assertEqual(self.change(self.enf, 'staff').status_code, 409)


class AdminSafetyPolicy(Base):

    def test_admin_accounts_cannot_be_demoted(self):
        other_admin = mk(2, 'admin')
        for new_role in ('staff', 'enforcer'):
            res = self.change(other_admin, new_role)
            self.assertEqual(res.status_code, 400, res.content)
            self.assertEqual(res.json()['code'], 'admin_transition_not_supported')
        other_admin.refresh_from_db()
        self.assertEqual(other_admin.role, 'admin')

    def test_nobody_can_be_promoted_to_admin(self):
        for u in (self.staff, self.enf):
            self.assertEqual(self.change(u, 'admin').status_code, 400)
            u.refresh_from_db()
            self.assertNotEqual(u.role, 'admin')
        self.assertEqual(CustomUser.objects.filter(role='admin').count(), 1)   # last admin can never be removed

    def test_deactivated_admin_cannot_perform_role_changes(self):
        CustomUser.objects.filter(pk=self.admin.pk).update(is_active=False)
        self.admin.refresh_from_db()
        with self.assertRaises(RoleChangeError) as cm:
            change_user_role(target_pk=self.staff.pk, new_role='enforcer', actor=self.admin, reason='x')
        self.assertEqual(cm.exception.http_status, 403)


class EnforcerRelationships(Base):

    def test_staff_to_enforcer_fabricates_no_schedule_gps_or_duty(self):
        CustomUser.objects.filter(pk=self.staff.pk).update(assigned_area='Zone 1')
        self.change(self.staff, 'enforcer')
        u = CustomUser.objects.get(pk=self.staff.pk)
        self.assertEqual(EnforcerSchedule.objects.filter(enforcer=u).count(), 0)
        self.assertFalse(EnforcerLocation.objects.filter(enforcer=u).exists())
        self.assertEqual(u.duty_status, 'off_duty')
        self.assertEqual(u.assigned_area, 'Zone 1')                 # profile data preserved, not an operational area

    def test_new_enforcer_without_schedule_gets_the_natural_no_schedule_state(self):
        self.change(self.staff, 'enforcer')
        self.staff.refresh_from_db()
        _, res = self.login(self.staff)
        c = self.bearer(res.json()['access'])
        r = c.get('/api/enforcers/today-status/')
        self.assertEqual(r.status_code, 200, r.content)

    def test_enforcer_to_staff_keeps_historical_schedules_and_resets_live_state(self):
        EnforcerSchedule.objects.create(
            enforcer=self.enf, date=timezone.localdate() - timedelta(days=3), shift_start='08:00',
            shift_end='17:00', assigned_area='Area', created_by=self.admin)
        EnforcerLocation.objects.create(enforcer=self.enf, latitude=13.9, longitude=121.6)
        CustomUser.objects.filter(pk=self.enf.pk).update(duty_status='on_duty')
        self.assertEqual(self.change(self.enf, 'staff').status_code, 200)
        u = CustomUser.objects.get(pk=self.enf.pk)
        self.assertEqual(u.duty_status, 'off_duty')
        self.assertEqual(EnforcerSchedule.objects.filter(enforcer=u).count(), 1)     # history kept
        loc = EnforcerLocation.objects.get(enforcer=u)
        self.assertEqual(loc.status, 'inactive')                                     # row kept, marker off

    def test_enforcer_with_current_or_future_schedule_cannot_become_staff(self):
        EnforcerSchedule.objects.create(
            enforcer=self.enf, date=timezone.localdate(), shift_start='08:00', shift_end='17:00',
            assigned_area='Area', created_by=self.admin)
        res = self.change(self.enf, 'staff')
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()['code'], 'schedules_exist')
        self.enf.refresh_from_db()
        self.assertEqual((self.enf.role, self.enf.id_number), ('enforcer', '2024-ENF-0001'))
        self.assertEqual(UserRoleHistory.objects.count(), 0)
        self.assertEqual(EnforcerSchedule.objects.count(), 1)

    def test_staff_assessment_lock_is_released_but_violation_is_kept(self):
        v = Violation.objects.create(
            violator_name='X', ovr_number='OVR-P5-2', date_issued=timezone.now(), location='L',
            enforcer=self.enf)
        Violation.objects.filter(pk=v.pk).update(locked_by=self.staff)
        self.change(self.staff, 'enforcer')
        v.refresh_from_db()
        self.assertIsNone(v.locked_by_id)
        self.assertEqual(v.enforcer_id, self.enf.pk)


class Phase4Integration(Base):

    def test_role_changed_user_is_protected_from_permanent_delete(self):
        self.change(self.staff, 'enforcer')
        refs = get_user_historical_references(self.staff)
        self.assertIn('role_history', refs['categories'])
        res = self.api.delete(f'/api/auth/users/{self.staff.pk}/permanent/')
        self.assertEqual(res.status_code, 409)
        self.assertTrue(CustomUser.objects.filter(pk=self.staff.pk).exists())

    def test_the_acting_admin_becomes_history_protected_too(self):
        self.change(self.staff, 'enforcer')
        self.assertIn('role_changes_made', get_user_historical_references(self.admin)['categories'])

    def test_zero_history_user_is_still_deletable(self):
        z = mk(9, 'staff')
        self.assertEqual(self.api.delete(f'/api/auth/users/{z.pk}/permanent/').status_code, 200)

    def test_archive_matching_still_ignores_names(self):
        from accounts.test_phase4_hard_delete import archived
        self.change(self.staff, 'enforcer')
        namesake = mk(7, 'staff', full_name=self.staff.full_name)
        archived(enforcer_name=self.staff.full_name)
        self.assertFalse(get_user_historical_references(namesake)['has_history'])


class TransactionSafety(Base):

    def _state(self):
        return (
            list(CustomUser.objects.values('id', 'role', 'id_number', 'duty_status').order_by('id')),
            UserRoleHistory.objects.count(), self.success_logs().count(),
            BlacklistedToken.objects.count(),
        )

    def test_failure_while_blacklisting_rolls_everything_back(self):
        self.login(self.staff)
        before = self._state()
        with mock.patch('accounts.services._blacklist_outstanding_tokens', side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                change_user_role(target_pk=self.staff.pk, new_role='enforcer', actor=self.admin, reason='x')
        self.assertEqual(self._state(), before)

    def test_failure_while_auditing_rolls_everything_back(self):
        self.login(self.staff)
        before = self._state()
        with mock.patch('accounts.services.log_action', side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                change_user_role(target_pk=self.staff.pk, new_role='enforcer', actor=self.admin, reason='x')
        self.assertEqual(self._state(), before)

    def test_failure_after_history_insert_leaves_no_ledger_row(self):
        before = self._state()
        with mock.patch.object(CustomUser, 'save', side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                change_user_role(target_pk=self.staff.pk, new_role='enforcer', actor=self.admin, reason='x')
        self.assertEqual(self._state(), before)

    def test_old_tokens_stay_valid_if_the_transition_failed(self):
        _, res = self.login(self.staff)
        access = res.json()['access']
        with mock.patch('accounts.services.log_action', side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                change_user_role(target_pk=self.staff.pk, new_role='enforcer', actor=self.admin, reason='x')
        self.assertEqual(self.bearer(access).get('/api/auth/me/').status_code, 200)

    def test_exactly_one_success_audit_with_the_transition_and_no_secrets(self):
        self.login(self.staff)
        self.change(self.staff, 'enforcer', reason='Field work')
        log = self.success_logs().get()
        self.assertEqual(log.user_id, self.admin.pk)
        self.assertEqual(log.target_id, str(self.staff.pk))
        d = log.details
        self.assertEqual((d['old_role'], d['new_role']), ('staff', 'enforcer'))
        self.assertEqual((d['old_id_number'], d['new_id_number']), ('2024-STF-0001', '2024-ENF-0002'))
        self.assertEqual(d['reason'], 'Field work')
        blob = str(log.details) + str(log.changes) + log.description
        for secret in ('password', 'refresh', 'access', 'token'):
            self.assertNotIn(secret, blob.lower().replace('sessions_invalidated', ''))
        self.assertEqual(audit_actor_identity(log)['role'], 'admin')

    def test_refused_attempts_never_write_a_success_audit(self):
        self.change(self.staff, 'admin')
        self.change(self.staff, 'staff')
        self.assertEqual(self.success_logs().count(), 0)


@skipUnless(connection.vendor == 'postgresql', 'row-lock / advisory-lock concurrency needs PostgreSQL')
class ConcurrentTransitions(TransactionTestCase):

    def _run(self, jobs):
        results, errors = [], []
        barrier = threading.Barrier(len(jobs))

        def worker(job):
            try:
                barrier.wait(timeout=10)
                results.append(job())
            except RoleChangeError as exc:
                results.append(('error', exc.http_status, exc.code))
            except Exception as exc:                                # noqa: BLE001
                errors.append(repr(exc))
            finally:
                close_old_connections()
                connection.close()

        threads = [threading.Thread(target=worker, args=(j,)) for j in jobs]
        [t.start() for t in threads]
        [t.join(40) for t in threads]
        self.assertEqual(errors, [])
        return results

    def test_two_admins_changing_the_same_user_apply_exactly_once(self):
        a1, a2 = mk(1, 'admin'), mk(2, 'admin')
        target = mk(1, 'staff')

        def job(admin):
            return lambda: change_user_role(target_pk=target.pk, new_role='enforcer', actor=admin, reason='x')

        results = self._run([job(a1), job(a2)])
        ok = [r for r in results if not isinstance(r, tuple)]
        err = [r for r in results if isinstance(r, tuple)]
        self.assertEqual(len(ok), 1, results)
        self.assertEqual(err[0][1:], (409, 'role_unchanged'))
        self.assertEqual(UserRoleHistory.objects.filter(user=target).count(), 1)
        self.assertEqual(AuditLog.objects.filter(description__startswith='Changed role').count(), 1)

    def test_parallel_transitions_into_the_same_role_never_share_an_id(self):
        admin = mk(1, 'admin')
        targets = [mk(i, 'staff') for i in range(1, 7)]
        jobs = [(lambda t=t: change_user_role(target_pk=t.pk, new_role='enforcer', actor=admin, reason='x'))
                for t in targets]
        results = self._run(jobs)
        self.assertEqual(len([r for r in results if not isinstance(r, tuple)]), 6, results)
        ids = list(CustomUser.objects.filter(role='enforcer').values_list('id_number', flat=True))
        self.assertEqual(len(ids), 6)
        self.assertEqual(len(set(ids)), 6)
        self.assertEqual(UserRoleHistory.objects.count(), 6)
        self.assertEqual(len(set(UserRoleHistory.objects.values_list('new_id_number', flat=True))), 6)