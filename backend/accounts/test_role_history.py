"""
Role Evolution — Phase 1: UserRoleHistory ledger, ID non-reuse, ID format,
original hired_year, concurrency-safe allocation, Django Admin protections.

There is NO role-change feature yet. Where a test needs a "transition" it
writes the ledger row and edits the user by hand, purely to prove the
foundation behaves correctly when Phase 2 starts doing this for real.

Run: python manage.py test accounts.test_role_history --settings=core.test_settings
"""
import threading
from unittest import mock, skipUnless

from django.db import IntegrityError, connection, close_old_connections
from django.db.models.deletion import ProtectedError
from django.test import RequestFactory, TestCase, TransactionTestCase
from django.utils import timezone

from accounts.admin import CustomUserAdmin, CustomUserCreationForm, UserRoleHistoryAdmin
from accounts.models import CustomUser, UserRoleHistory
from accounts.serializers import AdminCreateUserSerializer
from django.contrib import admin as dj_admin

Role = CustomUser.Role


def make_user(n, role=Role.ENFORCER, year=2026, id_number=None, **extra):
    code = CustomUser.ROLE_CODES[role]
    return CustomUser.objects.create_user(
        email=f'u{n}-{role}-{year}@tmeo.test', password='TmeoTest!2026',
        full_name=f'User {n}', role=role, hired_year=year,
        id_number=id_number or f'{year}-{code}-{n:04d}', **extra,
    )


def transition(user, new_role, *, changed_by=None, new_id=None):
    """TEST HELPER (the real service is Phase 2): record + apply a transition."""
    new_id = new_id or CustomUser.objects.generate_id_number_for_user(user, new_role)
    row = UserRoleHistory.objects.create(
        user=user, old_role=user.role, new_role=new_role,
        old_id_number=user.id_number, new_id_number=new_id, changed_by=changed_by,
        reason='test',
    )
    user.role, user.id_number = new_role, new_id
    user.save()
    return row


class UserRoleHistoryModelTests(TestCase):

    def test_row_stores_the_full_transition(self):
        admin = make_user(1, Role.ADMIN)
        juan = make_user(3, Role.ENFORCER)
        before = timezone.now()
        row = transition(juan, Role.STAFF, changed_by=admin)
        row.refresh_from_db()
        self.assertEqual(row.user_id, juan.pk)
        self.assertEqual((row.old_role, row.new_role), ('enforcer', 'staff'))
        self.assertEqual(row.old_id_number, '2026-ENF-0003')
        self.assertEqual(row.new_id_number, '2026-STF-0001')
        self.assertEqual(row.changed_by_id, admin.pk)
        self.assertGreaterEqual(row.effective_at, before)
        self.assertIsNotNone(row.effective_at.tzinfo)           # timezone-aware
        self.assertEqual(row.reason, 'test')

    def test_stable_pk_is_the_same_person_across_the_transition(self):
        juan = make_user(3)
        pk = juan.pk
        transition(juan, Role.STAFF)
        juan.refresh_from_db()
        self.assertEqual(juan.pk, pk)
        self.assertEqual(juan.role_history.get().user_id, pk)

    def test_history_row_is_not_mutated_by_unrelated_changes(self):
        juan = make_user(3)
        row = transition(juan, Role.STAFF)
        snapshot = UserRoleHistory.objects.filter(pk=row.pk).values().get()
        juan.full_name = 'Juan Renamed'
        juan.phone_number = '0999'
        juan.duty_status = 'on_duty'
        juan.save()
        make_user(9, Role.ADMIN)                                  # unrelated user
        self.assertEqual(UserRoleHistory.objects.filter(pk=row.pk).values().get(), snapshot)

    def test_rows_are_append_only(self):
        row = transition(make_user(3), Role.STAFF)
        row.reason = 'edited'
        with self.assertRaises(RuntimeError):
            row.save()
        with self.assertRaises(RuntimeError):
            row.delete()
        self.assertEqual(UserRoleHistory.objects.get(pk=row.pk).reason, 'test')

    def test_an_id_cannot_be_retired_or_introduced_twice(self):
        a, b = make_user(1), make_user(2)
        transition(a, Role.STAFF, new_id='2026-STF-0001')
        with self.assertRaises(IntegrityError):
            UserRoleHistory.objects.create(
                user=b, old_role='enforcer', new_role='staff',
                old_id_number='2026-ENF-0002', new_id_number='2026-STF-0001',
            )

    def test_reading_or_updating_profile_data_creates_no_history(self):
        juan = make_user(3)
        list(CustomUser.objects.all())
        juan.full_name = 'Juan P. Dela Cruz'
        juan.address = 'Lucena'
        juan.save()
        self.assertEqual(UserRoleHistory.objects.count(), 0)

    def test_account_with_role_history_cannot_be_hard_deleted(self):
        """Phase 4 (HD-B): the ledger FK is PROTECT, so the account - and the
        ledger row that points at it - can never be orphaned or nulled."""
        juan = make_user(3)
        transition(juan, Role.STAFF)
        with self.assertRaises(ProtectedError):
            juan.delete()
        row = UserRoleHistory.objects.get()
        self.assertEqual(row.user_id, juan.pk)
        self.assertEqual(row.old_id_number, '2026-ENF-0003')       # reservation intact


class IdGenerationTests(TestCase):

    def test_format_is_preserved(self):
        for role, code in (('enforcer', 'ENF'), ('staff', 'STF'), ('admin', 'ADM')):
            self.assertEqual(CustomUser.objects.generate_id_number(role, 2026), f'2026-{code}-0001')
        self.assertEqual(CustomUser.objects.generate_id_number('something-else', 2026), '2026-USR-0001')

    def test_active_ids_are_excluded(self):
        make_user(1); make_user(2)
        self.assertEqual(CustomUser.objects.generate_id_number('enforcer', 2026), '2026-ENF-0003')

    def test_sequence_is_per_year_and_role(self):
        make_user(5, Role.ENFORCER, 2026)
        make_user(7, Role.STAFF, 2026)
        make_user(2, Role.ENFORCER, 2025)
        g = CustomUser.objects.generate_id_number
        self.assertEqual(g('enforcer', 2026), '2026-ENF-0006')
        self.assertEqual(g('staff', 2026), '2026-STF-0008')
        self.assertEqual(g('enforcer', 2025), '2025-ENF-0003')
        self.assertEqual(g('enforcer', 2024), '2024-ENF-0001')

    def test_retired_ids_are_reserved_even_after_the_account_moved_on(self):
        juan = make_user(3)                       # 2026-ENF-0003
        transition(juan, Role.STAFF)              # now 2026-STF-0001; ENF-0003 retired
        self.assertFalse(CustomUser.objects.filter(id_number='2026-ENF-0003').exists())
        self.assertEqual(CustomUser.objects.generate_id_number('enforcer', 2026), '2026-ENF-0004')

    def test_retired_id_is_not_reusable_when_it_was_the_highest(self):
        """Without the ledger the next ENF would collide with the retired 0003."""
        juan = make_user(3)
        transition(juan, Role.STAFF)
        other = CustomUser.objects.generate_id_number('enforcer', 2026)
        self.assertNotEqual(other, '2026-ENF-0003')

    def test_another_user_cannot_receive_a_retired_id(self):
        juan = make_user(3)
        transition(juan, Role.STAFF)
        maria = make_user(0, Role.ENFORCER, id_number=CustomUser.objects.generate_id_number('enforcer', 2026))
        self.assertEqual(maria.id_number, '2026-ENF-0004')
        self.assertTrue(CustomUser.objects.is_id_reserved('2026-ENF-0003'))

    def test_returning_to_an_old_role_gets_a_new_sequence(self):
        juan = make_user(3)
        transition(juan, Role.STAFF)                                  # ENF-0003 -> STF-0001
        row = transition(juan, Role.ENFORCER)                         # back to enforcer
        self.assertNotEqual(row.new_id_number, '2026-ENF-0003')
        self.assertEqual(row.new_id_number, '2026-ENF-0004')
        juan.refresh_from_db()
        self.assertEqual(juan.id_number, '2026-ENF-0004')
        # and the STF id he left is retired too
        self.assertTrue(CustomUser.objects.is_id_reserved('2026-STF-0001'))

    def test_retired_account_ids_are_not_reissued(self):
        """The original bug: the highest-numbered ID came back. Retired IDs are
        reserved by the ledger (and, since Phase 4, its account cannot be deleted)."""
        juan = make_user(3)
        transition(juan, Role.STAFF)
        self.assertEqual(CustomUser.objects.generate_id_number('enforcer', 2026), '2026-ENF-0004')
        self.assertEqual(CustomUser.objects.generate_id_number('staff', 2026), '2026-STF-0002')

    def test_original_hired_year_is_used_for_future_ids(self):
        juan = make_user(3, Role.ENFORCER, year=2024)               # hired 2024, "now" is a later year
        self.assertNotEqual(timezone.now().year, 2024)
        row = transition(juan, Role.STAFF)
        self.assertEqual(row.new_id_number, '2024-STF-0001')
        transition(juan, Role.ADMIN)
        juan.refresh_from_db()
        self.assertEqual(juan.id_number, '2024-ADM-0001')
        self.assertEqual(juan.hired_year, 2024)

    def test_generator_for_user_uses_hired_year_not_current_year(self):
        juan = make_user(1, Role.ENFORCER, year=2023)
        self.assertEqual(CustomUser.objects.generate_id_number_for_user(juan, Role.STAFF), '2023-STF-0001')

    def test_existing_ids_are_never_changed_by_generation(self):
        juan = make_user(3)
        CustomUser.objects.generate_id_number('enforcer', 2026)
        juan.refresh_from_db()
        self.assertEqual(juan.id_number, '2026-ENF-0003')
        self.assertEqual(UserRoleHistory.objects.count(), 0)


def _create_payload(n, role='enforcer', year=2026):
    return dict(
        email=f'new{n}@tmeo.test', password='TmeoTest!2026', last_name=f'Last{n}', first_name='First',
        address='Lucena City', date_of_birth='1990-01-01', civil_status='single',
        role=role, hired_year=year,
    )


class AccountCreationAllocationTests(TestCase):

    def _create(self, n, **kw):
        ser = AdminCreateUserSerializer(data=_create_payload(n, **kw))
        self.assertTrue(ser.is_valid(), ser.errors)
        return ser.save()

    def test_creation_uses_the_generator_and_keeps_the_format(self):
        u1, u2 = self._create(1), self._create(2)
        self.assertEqual((u1.id_number, u2.id_number), ('2026-ENF-0001', '2026-ENF-0002'))

    def test_creation_skips_retired_ids(self):
        juan = make_user(3)
        transition(juan, Role.STAFF)
        self.assertEqual(self._create(1).id_number, '2026-ENF-0004')

    def test_collision_is_retried_with_a_fresh_number(self):
        make_user(1)                                              # 2026-ENF-0001 exists
        real = type(CustomUser.objects).generate_id_number
        calls = []

        def racy(self_, role, year):
            calls.append(1)
            return '2026-ENF-0001' if len(calls) == 1 else real(self_, role, year)

        with mock.patch.object(type(CustomUser.objects), 'generate_id_number', racy):
            user = self._create(1)
        self.assertEqual(len(calls), 2)
        self.assertEqual(user.id_number, '2026-ENF-0002')

    def test_duplicate_email_is_still_rejected_by_validation(self):
        make_user(1)
        dup = _create_payload(1)
        dup['email'] = 'u1-enforcer-2026@tmeo.test'                # already used by make_user(1)
        ser = AdminCreateUserSerializer(data=dup)
        self.assertFalse(ser.is_valid())                           # validator catches it first


@skipUnless(connection.vendor == 'postgresql', 'advisory-lock concurrency test needs PostgreSQL')
class ConcurrentAllocationTests(TransactionTestCase):

    def test_parallel_creations_never_share_an_id(self):
        n_threads = 8
        results, errors = [], []
        barrier = threading.Barrier(n_threads)

        def worker(n):
            try:
                ser = AdminCreateUserSerializer(data=_create_payload(n))
                ser.is_valid(raise_exception=True)
                barrier.wait(timeout=10)
                results.append(ser.save().id_number)
            except Exception as exc:                                # noqa: BLE001
                errors.append(repr(exc))
            finally:
                close_old_connections()
                connection.close()

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(n_threads)]
        [t.start() for t in threads]
        [t.join(30) for t in threads]
        self.assertEqual(errors, [])
        self.assertEqual(len(results), n_threads)
        self.assertEqual(len(set(results)), n_threads)
        self.assertEqual(sorted(results), [f'2026-ENF-{i:04d}' for i in range(1, n_threads + 1)])


class DjangoAdminProtectionTests(TestCase):

    def setUp(self):
        self.model_admin = CustomUserAdmin(CustomUser, dj_admin.site)
        self.request = RequestFactory().get('/admin/')
        self.juan = make_user(3)

    def test_identity_fields_are_read_only_on_existing_accounts(self):
        ro = self.model_admin.get_readonly_fields(self.request, self.juan)
        for f in ('role', 'id_number', 'hired_year'):
            self.assertIn(f, ro)

    def test_creating_an_account_in_admin_still_allows_role_and_id(self):
        ro = self.model_admin.get_readonly_fields(self.request, None)
        for f in ('role', 'id_number'):
            self.assertNotIn(f, ro)
        self.assertIn('id_number', CustomUserCreationForm.Meta.fields)
        self.assertIn('role', CustomUserCreationForm.Meta.fields)

    def _form(self, id_number):
        return CustomUserCreationForm(data={
            'email': 'x@tmeo.test', 'full_name': 'X', 'last_name': 'X', 'first_name': 'X',
            'id_number': id_number, 'role': 'staff',
            'password1': 'TmeoTest!2026', 'password2': 'TmeoTest!2026',
        })

    def test_admin_add_rejects_assigned_and_retired_ids(self):
        transition(self.juan, Role.STAFF)                          # ENF-0003 retired, STF-0001 active
        self.assertFalse(self._form('2026-ENF-0003').is_valid())
        self.assertFalse(self._form('2026-STF-0001').is_valid())
        self.assertTrue(self._form('2026-STF-0050').is_valid())

    def test_role_history_is_read_only_in_admin(self):
        ma = UserRoleHistoryAdmin(UserRoleHistory, dj_admin.site)
        self.assertFalse(ma.has_add_permission(self.request))
        self.assertFalse(ma.has_change_permission(self.request))
        self.assertFalse(ma.has_delete_permission(self.request))