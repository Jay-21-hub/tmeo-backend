from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import CustomUser


class BadgeNumberTests(TestCase):
    def setUp(self):
        self.admin = CustomUser.objects.create_user(
            email='admin@test.local', password='pass12345',
            id_number='2026-ADM-9001', full_name='Admin, Test', role='admin',
        )
        self.api = APIClient()
        self.api.force_authenticate(self.admin)

    def _create(self, email, role='enforcer', **extra):
        payload = {
            'last_name': 'Cruz', 'first_name': 'Juan', 'email': email,
            'address': 'Lucena City', 'date_of_birth': '1990-01-01',
            'civil_status': 'single', 'role': role,
            'hired_year': timezone.now().year, 'password': 'secret1234',
        }
        payload.update(extra)
        return self.api.post('/api/auth/users/', payload, format='json')

    def test_enforcers_get_sequential_badges_and_client_value_is_ignored(self):
        r1 = self._create('e1@test.local', badge_number='999')
        r2 = self._create('e2@test.local')
        self.assertEqual(r1.status_code, 201)
        self.assertEqual(r1.data['badge_number'], 'TE-0001')
        self.assertEqual(r2.data['badge_number'], 'TE-0002')

    def test_staff_gets_no_badge(self):
        r = self._create('s1@test.local', role='staff', badge_number='TE-0050')
        self.assertEqual(r.status_code, 201)
        self.assertFalse(r.data['badge_number'])

    def test_sequence_continues_after_highest_and_ignores_legacy_values(self):
        CustomUser.objects.create_user(
            email='old1@test.local', password='x12345678', id_number='2024-ENF-0001',
            full_name='Old, One', role='enforcer', badge_number='123',
        )
        CustomUser.objects.create_user(
            email='old2@test.local', password='x12345678', id_number='2024-ENF-0002',
            full_name='Old, Two', role='enforcer', badge_number='TE-0007',
        )
        r = self._create('e3@test.local')
        self.assertEqual(r.data['badge_number'], 'TE-0008')

    def test_edit_cannot_change_existing_badge(self):
        created = self._create('e4@test.local')
        uid = created.data['id']
        r = self.api.patch(f'/api/auth/users/{uid}/', {'badge_number': 'HACK-1', 'assigned_area': 'Area 1'}, format='json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data['badge_number'], 'TE-0001')

    def test_edit_assigns_badge_to_enforcer_without_one(self):
        u = CustomUser.objects.create_user(
            email='nobadge@test.local', password='x12345678', id_number='2024-ENF-0009',
            full_name='No, Badge', role='enforcer',
        )
        r = self.api.patch(f'/api/auth/users/{u.pk}/', {'assigned_area': 'Area 2'}, format='json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data['badge_number'], 'TE-0001')
