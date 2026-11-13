from rest_framework.test import APITestCase

from accounts.models import CustomUser


class InactiveAccountAndDutyStatusTests(APITestCase):
    def setUp(self):
        self.admin = CustomUser.objects.create_user(
            email='admin.lock@example.com', password='TestPass123!',
            full_name='Admin Lock', id_number='ADM-LOCK', role=CustomUser.Role.ADMIN,
        )
        self.staff = CustomUser.objects.create_user(
            email='staff.lock@example.com', password='TestPass123!',
            full_name='Staff Lock', id_number='STF-LOCK', role=CustomUser.Role.STAFF,
            is_active=False, employment_status=CustomUser.EmploymentStatus.ACTIVE,
        )
        self.on_leave = CustomUser.objects.create_user(
            email='leave.lock@example.com', password='TestPass123!',
            full_name='Leave Lock', id_number='LEV-LOCK', role=CustomUser.Role.STAFF,
            employment_status=CustomUser.EmploymentStatus.ON_LEAVE,
        )
        self.enforcer = CustomUser.objects.create_user(
            email='enf.lock@example.com', password='TestPass123!',
            full_name='Enforcer Lock', id_number='ENF-LOCK', role=CustomUser.Role.ENFORCER,
        )
        self.client.force_authenticate(self.admin)

    def test_inactive_account_rejects_profile_edits(self):
        res = self.client.patch(
            f'/api/auth/users/{self.staff.id}/',
            {'phone_number': '09170000000'},
            format='json',
        )
        self.assertEqual(res.status_code, 400)
        self.staff.refresh_from_db()
        self.assertNotEqual(self.staff.phone_number, '09170000000')

    def test_inactive_account_can_be_reactivated(self):
        res = self.client.patch(
            f'/api/auth/users/{self.staff.id}/',
            {'employment_status': 'active'},
            format='json',
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.staff.refresh_from_db()
        self.assertTrue(self.staff.is_active)
        self.assertEqual(self.staff.employment_status, 'active')

    def test_non_active_employment_rejects_other_edits(self):
        res = self.client.patch(
            f'/api/auth/users/{self.on_leave.id}/',
            {'first_name': 'Changed'},
            format='json',
        )
        self.assertEqual(res.status_code, 400)
        self.on_leave.refresh_from_db()
        self.assertNotEqual(self.on_leave.first_name, 'Changed')

    def test_change_role_keeps_409_for_an_inactive_account(self):
        res = self.client.post(
            f'/api/auth/users/{self.staff.id}/change-role/',
            {'new_role': 'enforcer', 'reason': 'Reassignment'},
            format='json',
        )
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()['code'], 'account_inactive')
        self.assertEqual(
            res.json()['error'],
            'Only an active account can change role. Reactivate the account first.',
        )
        self.staff.refresh_from_db()
        self.assertEqual(self.staff.role, 'staff')

    def test_duty_status_cannot_be_written(self):
        res = self.client.patch(
            f'/api/auth/users/{self.enforcer.id}/',
            {'duty_status': 'on_duty'},
            format='json',
        )
        self.assertEqual(res.status_code, 400)
        self.enforcer.refresh_from_db()
        self.assertNotEqual(self.enforcer.duty_status, 'on_duty')
