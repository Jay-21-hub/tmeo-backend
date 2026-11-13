from unittest import mock

from accounts.models import CustomUser
from accounts.services import change_user_role
from accounts.test_phase5_role_change import Base, mk


class BadgeOnRoleChange(Base):

    def test_staff_without_badge_gets_one_when_becoming_enforcer(self):
        self.assertFalse(self.staff.badge_number)
        res = self.change(self.staff, 'enforcer')
        self.assertEqual(res.status_code, 200, res.content)
        self.staff.refresh_from_db()
        self.assertEqual(self.staff.badge_number, 'TE-0001')

    def test_existing_badge_is_kept(self):
        CustomUser.objects.filter(pk=self.staff.pk).update(badge_number='TE-0005')
        self.change(self.staff, 'enforcer')
        self.staff.refresh_from_db()
        self.assertEqual(self.staff.badge_number, 'TE-0005')

    def test_leaving_enforcer_keeps_badge_and_returning_reuses_the_same_one(self):
        CustomUser.objects.filter(pk=self.enf.pk).update(badge_number='TE-0003')
        self.assertEqual(self.change(self.enf, 'staff').status_code, 200)
        self.enf.refresh_from_db()
        self.assertEqual(self.enf.badge_number, 'TE-0003')
        self.assertEqual(self.change(self.enf, 'enforcer').status_code, 200)
        self.enf.refresh_from_db()
        self.assertEqual(self.enf.badge_number, 'TE-0003')

    def test_becoming_staff_does_not_assign_a_badge(self):
        self.assertEqual(self.change(self.enf, 'staff').status_code, 200)
        self.enf.refresh_from_db()
        self.assertFalse(self.enf.badge_number)

    def test_two_promotions_get_distinct_badges(self):
        other = mk(2, 'staff')
        self.change(self.staff, 'enforcer')
        self.change(other, 'enforcer')
        self.staff.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual(sorted([self.staff.badge_number, other.badge_number]), ['TE-0001', 'TE-0002'])

    def test_failed_role_change_leaves_no_badge(self):
        with mock.patch('accounts.services.log_action', side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                change_user_role(target_pk=self.staff.pk, new_role='enforcer', actor=self.admin, reason='x')
        self.staff.refresh_from_db()
        self.assertEqual(self.staff.role, 'staff')
        self.assertFalse(self.staff.badge_number)
