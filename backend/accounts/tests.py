from django.urls import reverse
from rest_framework import status
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from .models import CustomUser


class LogoutViewTests(APITestCase):
    """
    Regression tests for Bug #1: POST /api/auth/logout/ must not return
    HTTP 500 for an already-blacklisted or malformed refresh token.
    """

    def setUp(self):
        self.user = CustomUser.objects.create_user(
            email='enforcer.logout@example.com',
            password='TestPass123!',
            full_name='Logout Test User',
            id_number='2026-ENF-9001',
            role=CustomUser.Role.ENFORCER,
        )
        self.url = reverse('logout')

    def _authenticate_with_new_refresh_token(self):
        refresh = RefreshToken.for_user(self.user)
        access = str(refresh.access_token)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')
        return str(refresh)

    def test_successful_logout(self):
        """TEST A: Valid refresh token → logout succeeds."""
        refresh_str = self._authenticate_with_new_refresh_token()

        response = self.client.post(self.url, {'refresh': refresh_str}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['detail'], 'Successfully logged out.')

    def test_already_blacklisted_refresh_token_does_not_500(self):
        """TEST B: Re-using the same (already blacklisted) refresh token
        must return a controlled 400, never a 500."""
        refresh_str = self._authenticate_with_new_refresh_token()

        first = self.client.post(self.url, {'refresh': refresh_str}, format='json')
        self.assertEqual(first.status_code, status.HTTP_200_OK)

        # Access token is still valid within its own lifetime; retry the
        # logout call with the same, now-blacklisted, refresh token.
        second = self.client.post(self.url, {'refresh': refresh_str}, format='json')

        self.assertEqual(second.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('error', second.data)

    def test_malformed_refresh_token_returns_400(self):
        """TEST C: Malformed/invalid refresh token → controlled 4xx, not 500."""
        self._authenticate_with_new_refresh_token()

        response = self.client.post(
            self.url, {'refresh': 'not-a-valid-jwt-token'}, format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('error', response.data)

    def test_missing_refresh_token_returns_400(self):
        self._authenticate_with_new_refresh_token()

        response = self.client.post(self.url, {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_unauthenticated_logout_returns_401(self):
        """TEST D: Unauthenticated access to protected endpoint."""
        response = self.client.post(self.url, {'refresh': 'irrelevant'}, format='json')

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

class SelfProfileCannotEditAdministrativeFields(APITestCase):
    """
    Regression tests for Bug #008: PATCH /api/accounts/me/ (self-service
    profile update) must not let a user edit fields outside the
    low-risk contact/personal-info set. Two groups are blocked:
      - administrative fields (employment_status, badge_number,
        assigned_area) — admin-only, HR/duty-related.
      - identity/official-record fields (full_name, date_of_birth) —
        admin-only, tied to official records and id_number generation.
    Both groups must only be settable via UserDetailView, which is
    gated by request.user.is_admin.

    The frontend's ProfileEditForm already omits these fields from the
    self-service form, but the backend previously trusted the same
    UpdateUserSerializer for both /me/ and the admin endpoint, so a
    request crafted directly against the API could still smuggle them
    through self-service PATCH. MeView now uses a restricted
    SelfUpdateUserSerializer instead.
    """

    def setUp(self):
        self.enforcer = CustomUser.objects.create_user(
            email='enforcer.selfedit@example.com',
            password='TestPass123!',
            full_name='Self Edit Enforcer',
            id_number='2026-ENF-9002',
            role=CustomUser.Role.ENFORCER,
            employment_status=CustomUser.EmploymentStatus.ACTIVE,
            badge_number='BADGE-OLD',
            assigned_area='Old Area',
            date_of_birth='1990-01-01',
        )
        self.admin = CustomUser.objects.create_user(
            email='admin.selfedit@example.com',
            password='TestPass123!',
            full_name='Self Edit Admin',
            id_number='2026-ADM-9001',
            role=CustomUser.Role.ADMIN,
            is_staff=True,
        )
        self.me_url = reverse('me')

    def _authenticate_as(self, user):
        refresh = RefreshToken.for_user(user)
        access = str(refresh.access_token)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')

    def test_cannot_patch_own_employment_status(self):
        """TEST A: Enforcer sends employment_status in /me/ PATCH — must be ignored."""
        self._authenticate_as(self.enforcer)

        response = self.client.patch(
            self.me_url,
            {'employment_status': CustomUser.EmploymentStatus.RESIGNED, 'phone_number': '09170000001'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.enforcer.refresh_from_db()
        self.assertEqual(self.enforcer.employment_status, CustomUser.EmploymentStatus.ACTIVE)
        self.assertEqual(self.enforcer.phone_number, '09170000001')

    def test_cannot_patch_own_badge_number(self):
        """TEST B: Enforcer sends badge_number in /me/ PATCH — must be ignored."""
        self._authenticate_as(self.enforcer)

        response = self.client.patch(
            self.me_url,
            {'badge_number': 'BADGE-FAKE'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.enforcer.refresh_from_db()
        self.assertEqual(self.enforcer.badge_number, 'BADGE-OLD')

    def test_cannot_patch_own_assigned_area(self):
        """TEST C: Enforcer sends assigned_area in /me/ PATCH — must be ignored."""
        self._authenticate_as(self.enforcer)

        response = self.client.patch(
            self.me_url,
            {'assigned_area': 'Fake Area'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.enforcer.refresh_from_db()
        self.assertEqual(self.enforcer.assigned_area, 'Old Area')

    def test_cannot_patch_own_full_name(self):
        """TEST F: Enforcer sends full_name in /me/ PATCH — must be ignored."""
        self._authenticate_as(self.enforcer)

        response = self.client.patch(
            self.me_url,
            {'full_name': 'Fake New Name'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.enforcer.refresh_from_db()
        self.assertEqual(self.enforcer.full_name, 'Self Edit Enforcer')

    def test_cannot_patch_own_date_of_birth(self):
        """TEST G: Enforcer sends date_of_birth in /me/ PATCH — must be ignored."""
        self._authenticate_as(self.enforcer)

        response = self.client.patch(
            self.me_url,
            {'date_of_birth': '2000-12-31'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.enforcer.refresh_from_db()
        self.assertEqual(str(self.enforcer.date_of_birth), '1990-01-01')

    def test_can_still_patch_own_personal_fields(self):
        """TEST D: Legitimate self-service fields still work via /me/."""
        self._authenticate_as(self.enforcer)

        response = self.client.patch(
            self.me_url,
            {
                'phone_number': '09171234567',
                'address': 'New Address',
                'civil_status': CustomUser.CivilStatus.SINGLE,
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.enforcer.refresh_from_db()
        self.assertEqual(self.enforcer.phone_number, '09171234567')
        self.assertEqual(self.enforcer.address, 'New Address')
        self.assertEqual(self.enforcer.civil_status, CustomUser.CivilStatus.SINGLE)

    def test_admin_can_still_edit_another_users_employment_status(self):
        """TEST E: Admin editing ANOTHER user via UserDetailView is unaffected."""
        self._authenticate_as(self.admin)

        response = self.client.patch(
            reverse('user_detail', kwargs={'pk': self.enforcer.pk}),
            {'employment_status': CustomUser.EmploymentStatus.RESIGNED},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.enforcer.refresh_from_db()
        self.assertEqual(self.enforcer.employment_status, CustomUser.EmploymentStatus.RESIGNED)


class SeparateNameFieldsAndEditUserTests(APITestCase):
    """
    Master Requirement Tracker #3 — User Management: Edit User + separate
    name fields.

    Covers:
      - AdminCreateUserSerializer requiring last_name/first_name and
        composing full_name from the parts.
      - UpdateUserSerializer recomputing full_name only when a complete
        name is present after the patch (legacy-safety in both directions).
      - Permission gating on both create and edit (admin-only).
      - role cannot be escalated through the edit endpoint.
    """

    def setUp(self):
        self.admin = CustomUser.objects.create_user(
            email='admin.names@example.com',
            password='TestPass123!',
            full_name='Admin Names',
            id_number='2026-ADM-9101',
            role=CustomUser.Role.ADMIN,
            is_staff=True,
        )
        self.staff = CustomUser.objects.create_user(
            email='staff.names@example.com',
            password='TestPass123!',
            full_name='Staff Names',
            id_number='2026-STF-9101',
            role=CustomUser.Role.STAFF,
        )
        self.enforcer = CustomUser.objects.create_user(
            email='enforcer.names@example.com',
            password='TestPass123!',
            full_name='Enforcer Names',
            id_number='2026-ENF-9101',
            role=CustomUser.Role.ENFORCER,
        )
        # Legacy-style user: only full_name populated, name parts blank —
        # simulates a row that predates this feature and whose migration
        # backfill (best-effort) still left the parts incomplete.
        self.legacy_user = CustomUser.objects.create_user(
            email='legacy.names@example.com',
            password='TestPass123!',
            full_name='Legacy, Existing User',
            id_number='2026-ENF-9102',
            role=CustomUser.Role.ENFORCER,
        )
        self.user_list_url = reverse('user_list')

    def _authenticate_as(self, user):
        refresh = RefreshToken.for_user(user)
        access = str(refresh.access_token)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')

    def _create_payload(self, **overrides):
        payload = {
            'last_name': 'Dela Cruz',
            'first_name': 'Juan',
            'middle_name': 'Santos',
            'email': 'juan.delacruz@example.com',
            'phone_number': '09171234567',
            'address': '123 Rizal St, Lucena City',
            'date_of_birth': '1995-05-05',
            'civil_status': CustomUser.CivilStatus.SINGLE,
            'role': CustomUser.Role.ENFORCER,
            'hired_year': 2026,
            'employment_status': CustomUser.EmploymentStatus.ACTIVE,
            'password': 'TestPass123!',
        }
        payload.update(overrides)
        return payload

    # --- Create (AdminCreateUserSerializer) ---------------------------

    def test_admin_create_user_with_separate_names_builds_full_name(self):
        self._authenticate_as(self.admin)

        response = self.client.post(
            self.user_list_url, self._create_payload(), format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        created = CustomUser.objects.get(email='juan.delacruz@example.com')
        self.assertEqual(created.last_name, 'Dela Cruz')
        self.assertEqual(created.first_name, 'Juan')
        self.assertEqual(created.middle_name, 'Santos')
        self.assertEqual(created.full_name, 'Dela Cruz, Juan Santos')

    def test_create_user_requires_last_and_first_name(self):
        self._authenticate_as(self.admin)

        response = self.client.post(
            self.user_list_url,
            self._create_payload(last_name='', first_name=''),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('last_name', response.data)
        self.assertIn('first_name', response.data)

    def test_staff_cannot_create_users(self):
        self._authenticate_as(self.staff)

        response = self.client.post(
            self.user_list_url, self._create_payload(), format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    # --- Edit (UpdateUserSerializer via UserDetailView) ----------------

    def test_admin_edit_user_recomputes_full_name(self):
        self._authenticate_as(self.admin)

        response = self.client.patch(
            reverse('user_detail', kwargs={'pk': self.enforcer.pk}),
            {'last_name': 'Reyes', 'first_name': 'Maria', 'middle_name': 'Lopez'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.enforcer.refresh_from_db()
        self.assertEqual(self.enforcer.full_name, 'Reyes, Maria Lopez')

    def test_edit_rejects_blank_last_name_when_first_name_present(self):
        self._authenticate_as(self.admin)

        response = self.client.patch(
            reverse('user_detail', kwargs={'pk': self.enforcer.pk}),
            {'last_name': '', 'first_name': 'Maria'},
            format='json',
        )

        # Serializer allows blank (partial edits in progress) but must not
        # produce a corrupted full_name from an incomplete name.
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.enforcer.refresh_from_db()
        self.assertEqual(self.enforcer.full_name, 'Enforcer Names')

    def test_unrelated_field_edit_does_not_touch_full_name(self):
        """Editing e.g. employment_status alone must not blank/alter full_name
        for a legacy user whose name parts are still empty."""
        self._authenticate_as(self.admin)

        response = self.client.patch(
            reverse('user_detail', kwargs={'pk': self.legacy_user.pk}),
            {'employment_status': CustomUser.EmploymentStatus.ON_LEAVE},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.legacy_user.refresh_from_db()
        self.assertEqual(self.legacy_user.full_name, 'Legacy, Existing User')
        self.assertEqual(self.legacy_user.employment_status, CustomUser.EmploymentStatus.ON_LEAVE)

    def test_legacy_user_full_name_preserved_when_names_not_both_provided(self):
        """A legacy user (blank first/last name) edited with only one name
        part supplied must not have full_name overwritten with a partial
        name."""
        self._authenticate_as(self.admin)

        response = self.client.patch(
            reverse('user_detail', kwargs={'pk': self.legacy_user.pk}),
            {'first_name': 'Juan'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.legacy_user.refresh_from_db()
        self.assertEqual(self.legacy_user.first_name, 'Juan')
        self.assertEqual(self.legacy_user.full_name, 'Legacy, Existing User')

    def test_legacy_user_full_name_recomputed_once_both_names_provided(self):
        """The reverse direction: once both parts are supplied, full_name
        does get recomputed even for a previously-legacy row."""
        self._authenticate_as(self.admin)

        response = self.client.patch(
            reverse('user_detail', kwargs={'pk': self.legacy_user.pk}),
            {'first_name': 'Juan', 'last_name': 'Bautista'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.legacy_user.refresh_from_db()
        self.assertEqual(self.legacy_user.full_name, 'Bautista, Juan')

    def test_admin_edit_user_role_field_is_ignored(self):
        """role is not part of UpdateUserSerializer — sending it must not
        escalate the target user's role."""
        self._authenticate_as(self.admin)

        response = self.client.patch(
            reverse('user_detail', kwargs={'pk': self.enforcer.pk}),
            {'role': CustomUser.Role.ADMIN, 'phone_number': '09170001111'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.enforcer.refresh_from_db()
        self.assertEqual(self.enforcer.role, CustomUser.Role.ENFORCER)
        self.assertEqual(self.enforcer.phone_number, '09170001111')

    def test_staff_cannot_edit_users(self):
        self._authenticate_as(self.staff)

        response = self.client.patch(
            reverse('user_detail', kwargs={'pk': self.enforcer.pk}),
            {'first_name': 'Hacked'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_enforcer_cannot_edit_users(self):
        self._authenticate_as(self.enforcer)

        response = self.client.patch(
            reverse('user_detail', kwargs={'pk': self.staff.pk}),
            {'first_name': 'Hacked'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_unauthenticated_cannot_edit_users(self):
        response = self.client.patch(
            reverse('user_detail', kwargs={'pk': self.enforcer.pk}),
            {'first_name': 'Hacked'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_get_user_detail_exposes_name_parts(self):
        self._authenticate_as(self.admin)

        response = self.client.get(
            reverse('user_detail', kwargs={'pk': self.enforcer.pk})
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn('last_name', response.data)
        self.assertIn('first_name', response.data)
        self.assertIn('middle_name', response.data)