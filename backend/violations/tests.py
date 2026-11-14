"""
Authorization regression tests for the violations app.

Every test here corresponds to a real hole that existed in the Phase 1
audit and was closed in Phase 1.5. They exist so a future refactor that
re-opens one fails loudly instead of silently shipping.

Run with:  python manage.py test violations
"""
import io
from datetime import timedelta

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from accounts.models import CustomUser
from violations.models import (
    Violation, ViolationType, ViolationItem, ViolationEvidence,
)


def _jpeg_bytes():
    from PIL import Image
    buf = io.BytesIO()
    Image.new('RGB', (8, 8)).save(buf, 'JPEG')
    return buf.getvalue()


class BaseRoleTestCase(APITestCase):
    """Two enforcers, one staff, one admin, and one OVR filed by enforcer_b."""

    @classmethod
    def setUpTestData(cls):
        def make(role, n, **extra):
            return CustomUser.objects.create_user(
                email=f'{role}{n}@tmeo.test', password='TmeoTest!2026',
                full_name=f'{role.title()} {n}', id_number=f'TEST-{role}-{n}',
                role=role, **extra,
            )

        cls.enforcer_a = make('enforcer', 1, assigned_area='Barangay 5')
        cls.enforcer_b = make('enforcer', 2)
        cls.staff = make('staff', 1)
        cls.admin = make('admin', 1)

        cls.vtype = ViolationType.objects.create(
            code='TST-1', name='Test violation', penalty_amount=500,
        )
        cls.other_ovr = cls._make_violation(cls.enforcer_b, 'OVR-B-001')

    @classmethod
    def _make_violation(cls, enforcer, ovr_number, status='pending', date_issued=None,
                         violator_name='DELA CRUZ, JUAN', license_number='D07-25-000928'):
        violation = Violation.objects.create(
            violator_name=violator_name,
            license_number=license_number,
            address='123 Private Address',
            plate_number='ABC1234',
            ovr_number=ovr_number,
            date_issued=date_issued or timezone.now(),
            location='ML Tagarao Street',
            status=status,
            enforcer=enforcer,
        )
        ViolationItem.objects.create(
            violation=violation, violation_type=cls.vtype,
            penalty_amount_snapshot=cls.vtype.penalty_amount,
        )
        violation.compute_total()
        return violation

    def as_user(self, user):
        self.client.force_authenticate(user)
        return self.client


class EnforcerCannotReachOtherEnforcersRecords(BaseRoleTestCase):

    def test_cannot_retrieve_another_enforcers_ovr(self):
        res = self.as_user(self.enforcer_a).get(f'/api/violations/{self.other_ovr.id}/')
        self.assertEqual(res.status_code, 404)

    def test_cannot_change_status_of_another_enforcers_ovr(self):
        res = self.as_user(self.enforcer_a).patch(
            f'/api/violations/{self.other_ovr.id}/', {'status': 'paid'}, format='json',
        )
        self.assertEqual(res.status_code, 403)
        self.other_ovr.refresh_from_db()
        self.assertEqual(self.other_ovr.status, 'pending')

    def test_cannot_change_status_of_their_own_ovr_either(self):
        """The pending -> ... -> paid lifecycle belongs to Staff, not the field."""
        own = self._make_violation(self.enforcer_a, 'OVR-A-010')
        res = self.as_user(self.enforcer_a).patch(
            f'/api/violations/{own.id}/', {'status': 'processing'}, format='json',
        )
        self.assertEqual(res.status_code, 403)
        own.refresh_from_db()
        self.assertEqual(own.status, 'pending')

    def test_cannot_delete_another_enforcers_ovr(self):
        res = self.as_user(self.enforcer_a).delete(f'/api/violations/{self.other_ovr.id}/')
        self.assertEqual(res.status_code, 404)
        self.assertTrue(Violation.objects.filter(pk=self.other_ovr.pk).exists())

    def test_list_only_returns_own_records(self):
        self._make_violation(self.enforcer_a, 'OVR-A-011')
        res = self.as_user(self.enforcer_a).get('/api/violations/')
        self.assertEqual(res.status_code, 200)
        returned = {row['id'] for row in res.json()['results']}
        self.assertNotIn(self.other_ovr.id, returned)


class EnforcerCannotReachStaffEndpoints(BaseRoleTestCase):

    STAFF_ONLY_ENDPOINTS = [
        '/api/violations/pending/',
        '/api/violations/staff-dashboard/',
        '/api/violations/analytics/',
        '/api/violations/analytics/year_comparison/?breakdown=enforcer',
        '/api/violations/violator-history-full/?violator_name=X&license_number=Y',
        '/api/reports/top-enforcers/',
        '/api/reports/collection/',
        '/api/reports/generate/?type=daily',
        '/api/reports/trends/',
        '/api/reports/hotspots/',
        '/api/reports/violation-by-type/',
    ]

    def test_enforcer_is_denied(self):
        client = self.as_user(self.enforcer_a)
        for url in self.STAFF_ONLY_ENDPOINTS:
            with self.subTest(url=url):
                self.assertEqual(client.get(url).status_code, 403)

    def test_related_records_endpoint_is_denied(self):
        res = self.as_user(self.enforcer_a).get(f'/api/violations/{self.other_ovr.id}/related/')
        self.assertEqual(res.status_code, 403)

    def test_staff_still_allowed(self):
        client = self.as_user(self.staff)
        for url in ['/api/violations/pending/', '/api/violations/staff-dashboard/',
                    '/api/violations/analytics/']:
            with self.subTest(url=url):
                self.assertEqual(client.get(url).status_code, 200)


class ManualOvrNumberCannotBeBypassed(BaseRoleTestCase):

    def _payload(self, **overrides):
        payload = {
            'violator_name': 'DELA CRUZ, JUAN',
            'plate_number': 'XYZ9876',
            'vehicle_type': 'car',
            'date_issued': timezone.now().isoformat(),
            'location': 'Quezon Avenue',
            'violation_type_ids': [str(self.vtype.id)],
            'ovr_number': 'OVR-A-100',
        }
        payload.update(overrides)
        return payload

    def test_enforcer_must_supply_ovr_number(self):
        res = self.as_user(self.enforcer_a).post(
            '/api/violations/create/', self._payload(ovr_number=''), format='json',
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn('ovr_number', res.json())

    def test_enforcer_cannot_bypass_via_staff_walk_in_source(self):
        res = self.as_user(self.enforcer_a).post(
            '/api/violations/create/',
            self._payload(ovr_number='', source='staff_walk_in'), format='json',
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn('ovr_number', res.json())

    def test_enforcer_source_is_always_enforcer_ovr(self):
        res = self.as_user(self.enforcer_a).post(
            '/api/violations/create/', self._payload(source='staff_walk_in'), format='json',
        )
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()['source'], Violation.Source.ENFORCER_OVR)

    def test_staff_may_still_create_walk_in_records(self):
        res = self.as_user(self.staff).post('/api/violations/create/', {
            'source': 'staff_walk_in',
            'violator_name': 'WALK IN COMPLAINANT',
            'date_issued': timezone.now().isoformat(),
            'violation_type_ids': [str(self.vtype.id)],
        }, format='json')
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()['source'], Violation.Source.STAFF_WALK_IN)
        self.assertEqual(res.json()['ovr_number'], '')


class AssessedByReachesMyReports(BaseRoleTestCase):
    """MyReports.jsx (Enforcer's own Report Details) reads assessed_by_name
    off the same list endpoint (/api/violations/?enforcer=<id>) it already
    uses for the report list. Covers the full pipeline: Staff assesses via
    /assess/ (which sets Violation.assessed_by, the FK the list serializer
    actually sources assessed_by_name from) -> Violation shows up in the
    filing Enforcer's own list with the assessing Staff member's name."""

    def test_assessed_by_name_reflects_the_assessing_staff_member(self):
        own = self._make_violation(self.enforcer_a, 'OVR-A-300')

        # Staff processes it (mirrors AssessmentForm.jsx's doMarkAsPaid for
        # an EXISTING violation: persist edits, /assess/, then Confirm
        # Payment — which replaced the old /mark-paid/).
        assess_res = self.as_user(self.staff).patch(
            f'/api/violations/{own.id}/assess/',
            {'status': 'processing'}, format='json',
        )
        self.assertEqual(assess_res.status_code, 200)

        paid_res = self.as_user(self.staff).post(
            f'/api/violations/{own.id}/confirm-payment/',
            {'or_number': 'OR-1001'},
            format='json',
        )
        self.assertEqual(paid_res.status_code, 200)

        # The filing Enforcer's own report list — exactly how MyReports.jsx
        # queries it (?enforcer=<their id>).
        list_res = self.as_user(self.enforcer_a).get(f'/api/violations/?enforcer={self.enforcer_a.id}')
        self.assertEqual(list_res.status_code, 200)
        row = next(r for r in list_res.json()['results'] if r['id'] == own.id)

        self.assertEqual(row['assessed_by_name'], self.staff.full_name)
        # Assessed By is the authenticated Staff; Received By stays blank.
        self.assertNotEqual(row['assessed_by_name'], 'Front Desk Clerk')
        self.assertEqual(row['or_number'], 'OR-1001')

    def test_assessed_by_name_absent_before_assessment(self):
        own = self._make_violation(self.enforcer_a, 'OVR-A-301')
        list_res = self.as_user(self.enforcer_a).get(f'/api/violations/?enforcer={self.enforcer_a.id}')
        row = next(r for r in list_res.json()['results'] if r['id'] == own.id)
        # DRF omits a dotted-source CharField entirely when the relation is
        # None (rather than emitting null) — either way this must never
        # resolve to a real name before Staff has actually assessed it.
        self.assertIsNone(row.get('assessed_by_name'))


class EvidenceAssociationOwnership(BaseRoleTestCase):

    def setUp(self):
        self.evidence = ViolationEvidence.objects.create(
            image=SimpleUploadedFile('e.jpg', _jpeg_bytes(), 'image/jpeg'),
            captured_at=timezone.now(), captured_by=self.enforcer_a,
        )

    def test_cannot_attach_to_another_enforcers_ovr(self):
        res = self.as_user(self.enforcer_a).patch(
            f'/api/violations/evidence/{self.evidence.id}/',
            {'violation': self.other_ovr.id}, format='json',
        )
        self.assertEqual(res.status_code, 400)
        self.evidence.refresh_from_db()
        self.assertIsNone(self.evidence.violation_id)

    def test_can_attach_to_own_ovr(self):
        own = self._make_violation(self.enforcer_a, 'OVR-A-200')
        res = self.as_user(self.enforcer_a).patch(
            f'/api/violations/evidence/{self.evidence.id}/',
            {'violation': own.id}, format='json',
        )
        self.assertEqual(res.status_code, 200)
        self.evidence.refresh_from_db()
        self.assertEqual(self.evidence.violation_id, own.id)

    def test_staff_may_attach_to_any_ovr(self):
        res = self.as_user(self.staff).patch(
            f'/api/violations/evidence/{self.evidence.id}/',
            {'violation': self.other_ovr.id}, format='json',
        )
        self.assertEqual(res.status_code, 200)


class ViolatorLookupScoping(BaseRoleTestCase):
    """Enforcers keep the identity match + repeat count, not other cases' rows."""

    def test_enforcer_gets_count_but_no_history_rows(self):
        res = self.as_user(self.enforcer_a).get(
            '/api/violations/violator-lookup/?license_number=D07-25-000928',
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body['found'])
        self.assertGreaterEqual(body['violation_count'], 1)
        self.assertEqual(body['history'], [])
        self.assertEqual(body['personal']['license_number'], 'D07-25-000928')
        self.assertIsNone(body['vehicle'])

    def test_staff_gets_full_history(self):
        res = self.as_user(self.staff).get(
            '/api/violations/violator-lookup/?license_number=D07-25-000928',
        )
        self.assertEqual(res.status_code, 200)
        self.assertGreaterEqual(len(res.json()['history']), 1)

    def test_plate_number_lookup_returns_vehicle_info_for_match(self):
        # ONLINE VIOLATOR & VEHICLE LOOKUP feature — Issue OVR's new Plate
        # Number lookup and Staff Assessment's Manual/Walk-in Plate Number
        # lookup both call this same endpoint with plate_number instead of
        # license_number. This locks in that vehicle_brand/vehicle_model are
        # actually present in `match` so the frontend has something to
        # autofill from.
        v = self._make_violation(self.enforcer_a, 'PLATE-001', license_number='X01-99-000111')
        v.plate_number = 'BHD 2382'
        v.vehicle_type = 'Car'
        v.vehicle_brand = 'Toyota'
        v.vehicle_model = 'Vios'
        v.save(update_fields=['plate_number', 'vehicle_type', 'vehicle_brand', 'vehicle_model'])

        res = self.as_user(self.enforcer_a).get(
            '/api/violations/violator-lookup/?plate_number=BHD%202382',
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body['found'])
        self.assertEqual(body['match']['vehicle_brand'], 'Toyota')
        self.assertEqual(body['match']['vehicle_model'], 'Vios')
        self.assertEqual(body['match']['vehicle_type'], 'Car')
        self.assertEqual(body['vehicle']['vehicle_brand'], 'Toyota')
        self.assertIsNone(body['personal'])
        # An enforcer's plate lookup still gets no per-ticket history rows —
        # same scoping rule as the license_number lookup above.
        self.assertEqual(body['history'], [])

    def test_plate_lookup_includes_the_driver_recorded_on_that_plate(self):
        v = self._make_violation(
            self.enforcer_a, 'PLATE-DRV', license_number='X01-99-000222',
            violator_name='REYES, ANA',
        )
        v.plate_number = 'DRV 1001'
        v.address = '12 Rizal Street'
        v.vehicle_type = 'Motorcycle'
        v.save(update_fields=['plate_number', 'address', 'vehicle_type'])
        res = self.as_user(self.staff).get(
            '/api/violations/violator-lookup/?plate_number=DRV%201001',
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body['vehicle']['violator_name'], 'REYES, ANA')
        self.assertEqual(body['vehicle']['address'], '12 Rizal Street')
        self.assertNotIn('license_number', body['vehicle'])
        self.assertIsNone(body['personal'])
        self.assertEqual(body['suggestions'], [])

    def test_name_search_requires_three_characters_and_caps_at_five(self):
        short = self.as_user(self.enforcer_a).get(
            '/api/violations/violator-lookup/?last_name=Ze',
        )
        self.assertEqual(short.status_code, 400)
        for i in range(6):
            self._make_violation(
                self.enforcer_a, f'NAME-{i}', license_number=f'N26-00-00000{i}',
                violator_name=f'Zedperson {i}, Ana',
            )
            Violation.objects.filter(ovr_number=f'NAME-{i}').update(address=f'Street {i}')
        self._make_violation(
            self.enforcer_a, 'NAME-OTHER', license_number='N26-00-000099',
            violator_name='Zedperson 0, Luis',
        )
        res = self.as_user(self.enforcer_a).get(
            '/api/violations/violator-lookup/?last_name=Zed&first_name=Ana',
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertLessEqual(len(body['suggestions']), 5)
        self.assertGreaterEqual(len(body['suggestions']), 1)
        self.assertTrue(all('Ana' in row['violator_name'] for row in body['suggestions']))
        self.assertTrue(all(set(row) == {'violator_name', 'address'} for row in body['suggestions']))
        self.assertEqual(body['history'], [])
        self.assertIsNone(body['match'])
        self.assertIsNone(body['personal'])

    def test_name_search_denies_anonymous_and_other_roles(self):
        self.client.force_authenticate(None)
        anon = self.client.get('/api/violations/violator-lookup/?last_name=Zed')
        self.assertEqual(anon.status_code, 401)
        outsider = CustomUser.objects.create_user(
            email='outsider-lookup@tmeo.test', password='TmeoTest!2026',
            full_name='Outsider', id_number='OUT-LOOKUP', role='staff',
        )
        CustomUser.objects.filter(pk=outsider.pk).update(role='citizen')
        outsider.refresh_from_db()
        denied = self.as_user(outsider).get('/api/violations/violator-lookup/?last_name=Zed')
        self.assertEqual(denied.status_code, 403)

    def test_name_search_denies_anonymous(self):
        self.client.force_authenticate(None)
        res = self.client.get('/api/violations/violator-lookup/?last_name=Zed')
        self.assertEqual(res.status_code, 401)

    def test_plate_lookup_denies_anonymous(self):
        self.client.force_authenticate(None)
        res = self.client.get('/api/violations/violator-lookup/?plate_number=DRV%201001')
        self.assertEqual(res.status_code, 401)

    def test_name_search_denies_unknown_role(self):
        outsider = CustomUser.objects.create_user(
            email='outsider-name@tmeo.test', password='TmeoTest!2026',
            full_name='Outsider Name', id_number='OUT-NAME', role='staff',
        )
        CustomUser.objects.filter(pk=outsider.pk).update(role='citizen')
        outsider.refresh_from_db()
        res = self.as_user(outsider).get('/api/violations/violator-lookup/?last_name=Zed')
        self.assertEqual(res.status_code, 403)

    def test_plate_lookup_denies_unknown_role(self):
        outsider = CustomUser.objects.create_user(
            email='outsider-plate@tmeo.test', password='TmeoTest!2026',
            full_name='Outsider Plate', id_number='OUT-PLATE', role='staff',
        )
        CustomUser.objects.filter(pk=outsider.pk).update(role='citizen')
        outsider.refresh_from_db()
        res = self.as_user(outsider).get('/api/violations/violator-lookup/?plate_number=DRV%201001')
        self.assertEqual(res.status_code, 403)

    def test_name_search_denies_inactive_account(self):
        self.staff.is_active = False
        self.staff.save(update_fields=['is_active'])
        res = self.as_user(self.staff).get('/api/violations/violator-lookup/?last_name=Zed')
        self.assertEqual(res.status_code, 403)

    def test_plate_lookup_denies_inactive_account(self):
        self.staff.is_active = False
        self.staff.save(update_fields=['is_active'])
        res = self.as_user(self.staff).get('/api/violations/violator-lookup/?plate_number=DRV%201001')
        self.assertEqual(res.status_code, 403)

    def test_name_search_denies_separated_account(self):
        self.staff.employment_status = CustomUser.EmploymentStatus.RESIGNED
        self.staff.save(update_fields=['employment_status'])
        res = self.as_user(self.staff).get('/api/violations/violator-lookup/?last_name=Zed')
        self.assertEqual(res.status_code, 403)

    def test_plate_lookup_denies_separated_account(self):
        self.staff.employment_status = CustomUser.EmploymentStatus.RESIGNED
        self.staff.save(update_fields=['employment_status'])
        res = self.as_user(self.staff).get('/api/violations/violator-lookup/?plate_number=DRV%201001')
        self.assertEqual(res.status_code, 403)

    def test_plate_number_lookup_no_match_is_not_an_error(self):
        res = self.as_user(self.enforcer_a).get(
            '/api/violations/violator-lookup/?plate_number=ZZZ9999NOTHING',
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertFalse(body['found'])
        self.assertIsNone(body['match'])


class PublicEndpointExposure(BaseRoleTestCase):

    def test_public_feed_is_anonymous_and_privacy_safe(self):
        Violation.objects.filter(pk=self.other_ovr.pk).update(status='paid')
        self.client.force_authenticate(None)
        res = self.client.get('/api/violations/public/')
        self.assertEqual(res.status_code, 200)
        row = res.json()['results'][0]
        # One violation type + its fine. No pk and no timestamps.
        self.assertEqual(set(row), {'name', 'category', 'description', 'fine'})

    def test_public_feed_lists_each_violation_on_a_ticket(self):
        Violation.objects.filter(pk=self.other_ovr.pk).update(status='paid')
        extra = ViolationType.objects.create(
            code='NL-PUB', name='No License', penalty_amount=1500, description='Driving without a license',
        )
        ViolationItem.objects.create(
            violation=self.other_ovr, violation_type=extra, penalty_amount_snapshot=1500,
        )
        self.client.force_authenticate(None)
        res = self.client.get('/api/violations/public/')
        self.assertEqual(res.status_code, 200)
        names = [row['name'] for row in res.json()['results']]
        self.assertIn('No License', names)
        self.assertEqual(len(names), res.json()['count'])
        filtered = self.client.get('/api/violations/public/', {'violation_type': 'No License'})
        self.assertEqual(filtered.status_code, 200)
        body = filtered.json()
        self.assertEqual(body['count'], 1)
        self.assertEqual(body['results'][0]['name'], 'No License')
        self.assertEqual(body['results'][0]['fine'], 1500.0)

    def test_public_feed_ignores_date_filters(self):
        # The feed no longer shows dates, so it must not let callers recover them
        # by filtering on date ranges either.
        Violation.objects.filter(pk=self.other_ovr.pk).update(status='paid')
        self._make_violation(
            self.enforcer_b, 'OVR-B-OLD', status='paid',
            date_issued=timezone.now() - timedelta(days=400),
        )
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get('/api/violations/public/').json()['count'], 2)
        for params in (
            {'date_from': '2999-01-01'},
            {'date_to': '2000-01-01'},
            {'date': '2000-01-01'},
        ):
            with self.subTest(params=params):
                res = self.client.get('/api/violations/public/', params)
                self.assertEqual(res.status_code, 200)
                self.assertEqual(res.json()['count'], 2)

    def test_internal_endpoints_require_auth(self):
        self.client.force_authenticate(None)
        for url in ['/api/violations/', '/api/violations/types/']:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 401)


class StaffQueuesDoNotQueryPerRow(BaseRoleTestCase):
    """
    StaffDashboardView.pending_queue and PendingViolationListView both list each
    violation's items. Calling .select_related() on a prefetched manager discards
    the prefetch, so the query count used to grow with the number of tickets.
    """
    _seq = 0

    def _add_pending(self, n):
        for _ in range(n):
            StaffQueuesDoNotQueryPerRow._seq += 1
            k = StaffQueuesDoNotQueryPerRow._seq
            v = self._make_violation(self.enforcer_b, f'OVR-NP-{k}')
            extra = ViolationType.objects.create(code=f'NP-{k}', name=f'NP type {k}', penalty_amount=100)
            ViolationItem.objects.create(violation=v, violation_type=extra, penalty_amount_snapshot=100)

    def _count_queries(self, url):
        self.client.force_authenticate(self.staff)
        with CaptureQueriesContext(connection) as ctx:
            res = self.client.get(url)
        self.assertEqual(res.status_code, 200)
        return len(ctx)

    def test_item_queries_do_not_grow_with_row_count(self):
        for url in ('/api/violations/staff-dashboard/', '/api/violations/pending/'):
            with self.subTest(url=url):
                self._add_pending(1)
                few = self._count_queries(url)
                self._add_pending(4)
                many = self._count_queries(url)
                self.assertEqual(few, many, f'{url}: {few} queries for few rows vs {many} for many')


class EnforcerStatsAreScopedAndLocalDated(BaseRoleTestCase):
    """The enforcer home screen reads this endpoint — counts must be the
    enforcer's own full dataset, and 'today' must be the Manila date."""

    def test_counts_cover_only_own_records(self):
        self._make_violation(self.enforcer_a, 'OVR-A-300')
        res = self.as_user(self.enforcer_a).get('/api/violations/stats/')
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body['total'], 1)
        self.assertEqual(body['today'], 1)
        for key in ('total', 'pending', 'processing', 'today'):
            self.assertIn(key, body)

    def test_today_uses_local_date(self):
        self._make_violation(self.enforcer_a, 'OVR-A-301')
        res = self.as_user(self.enforcer_a).get('/api/violations/stats/')
        self.assertEqual(res.json()['today'], 1, 'today must use timezone.localdate(), not the UTC date')


class IssueOvrWizardPayload(BaseRoleTestCase):
    """
    The redesigned Issue OVR form submits multipart/form-data. This pins the
    exact shape it sends so a serializer change can't silently break it:
    vehicle_use must be saved, and a Manila-offset date_issued must be stored
    as the same instant (it used to be sent as UTC and land 8 hours early).
    """

    def setUp(self):
        super().setUp()
        # A Manila-offset timestamp one minute ago — what the form sends.
        self.issued_at = (timezone.now() - timedelta(minutes=1)).astimezone(
            timezone.get_fixed_timezone(8)).replace(microsecond=0)

    def _form(self, **overrides):
        data = {
            'source': 'enforcer_ovr',
            'ovr_number': 'A 00070851',
            'violator_name': 'Dela Cruz, Juan S.',
            'license_number': 'D07-25-000928',
            'license_status': 'not_confiscated',
            'plate_number': 'NAB1234',
            'registration_number': '',
            'vehicle_type': 'Motorcycle',
            'vehicle_brand': 'Honda',
            'vehicle_model': 'Click 125',
            'vehicle_use': 'public',
            'address': 'Brgy. Ilayang Dupay',
            'location': 'ML Tagarao St, Barangay 5, Lucena City',
            'latitude': '13.941400',
            'longitude': '121.623600',
            'date_issued': self.issued_at.isoformat(),
            'remarks': '',
            'violation_type_ids': '[%d]' % self.vtype.id,
        }
        data.update(overrides)
        return data

    def test_wizard_payload_is_accepted_and_saved(self):
        res = self.as_user(self.enforcer_a).post(
            '/api/violations/create/', self._form(), format='multipart',
        )
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertEqual(body['vehicle_use'], 'public')
        self.assertEqual(body['ovr_number'], 'A 00070851')
        self.assertEqual(body['items'][0]['violation_type']['name'], self.vtype.name)

        saved = Violation.objects.get(pk=body['id'])
        self.assertEqual(saved.vehicle_use, 'public')
        self.assertEqual(saved.enforcer, self.enforcer_a)
        self.assertEqual(saved.date_issued, self.issued_at)          # same instant, offset preserved
        self.assertAlmostEqual(saved.latitude, 13.9414)

    def test_wizard_payload_without_gps_or_use_still_works(self):
        form = self._form(vehicle_use='')
        del form['latitude'], form['longitude']
        res = self.as_user(self.enforcer_a).post('/api/violations/create/', form, format='multipart')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertIsNone(Violation.objects.get(pk=res.json()['id']).latitude)

    def test_wizard_rejects_blank_ovr_number(self):
        res = self.as_user(self.enforcer_a).post(
            '/api/violations/create/', self._form(ovr_number=''), format='multipart',
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn('ovr_number', res.json())


class EnforcerDateIssuedGuard(IssueOvrWizardPayload):
    """
    Enforcer-submitted date_issued must not be in the future, nor older than
    the offline-sync window. Staff/Admin are not limited.
    """

    def _post(self, user, when):
        return self.as_user(user).post(
            '/api/violations/create/',
            self._form(date_issued=when.isoformat()), format='multipart',
        )

    def test_a_few_minutes_ahead_is_tolerated(self):
        res = self._post(self.enforcer_a, timezone.now() + timedelta(minutes=3))
        self.assertEqual(res.status_code, 201, res.content)

    def test_far_future_is_rejected(self):
        res = self._post(self.enforcer_a, timezone.now() + timedelta(hours=2))
        self.assertEqual(res.status_code, 400)
        self.assertIn('date_issued', res.json())
        self.assertFalse(Violation.objects.filter(ovr_number='A 00070851').exists())

    def test_offline_report_from_a_few_days_ago_is_accepted(self):
        res = self._post(self.enforcer_a, timezone.now() - timedelta(days=6, hours=23))
        self.assertEqual(res.status_code, 201, res.content)

    def test_report_older_than_the_window_is_rejected(self):
        res = self._post(self.enforcer_a, timezone.now() - timedelta(days=8))
        self.assertEqual(res.status_code, 400)
        self.assertIn('date_issued', res.json())

    def test_naive_timestamp_is_read_as_manila_time(self):
        # The old form sent a timezone-less value; it is still understood as Manila.
        naive = (timezone.now() - timedelta(minutes=2)).astimezone(
            timezone.get_fixed_timezone(8)).strftime('%Y-%m-%dT%H:%M')
        res = self.as_user(self.enforcer_a).post(
            '/api/violations/create/', self._form(date_issued=naive), format='multipart')
        self.assertEqual(res.status_code, 201, res.content)

    def test_staff_are_not_limited(self):
        res = self.as_user(self.staff).post(
            '/api/violations/create/',
            self._form(date_issued=(timezone.now() - timedelta(days=30)).isoformat(),
                       source='staff_walk_in', ovr_number=''),
            format='multipart',
        )
        self.assertEqual(res.status_code, 201, res.content)


class OfflineSyncIdempotency(IssueOvrWizardPayload):
    """
    Requirement #10 / #6: a queued offline OVR carries a client-generated
    `client_offline_id`. Resyncing the same queued record (app restart,
    dropped response, retry after timeout) must return the ORIGINAL record
    instead of creating a duplicate Violation row.
    """

    def test_first_sync_creates_a_new_record(self):
        res = self.as_user(self.enforcer_a).post(
            '/api/violations/create/',
            self._form(client_offline_id='offline_1234567890'), format='multipart',
        )
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(
            Violation.objects.filter(client_offline_id='offline_1234567890').count(), 1,
        )

    def test_resync_of_same_offline_id_returns_existing_record_not_a_duplicate(self):
        first = self.as_user(self.enforcer_a).post(
            '/api/violations/create/',
            self._form(client_offline_id='offline_dup_001'), format='multipart',
        )
        self.assertEqual(first.status_code, 201, first.content)
        first_id = first.json()['id']

        second = self.as_user(self.enforcer_a).post(
            '/api/violations/create/',
            self._form(client_offline_id='offline_dup_001'), format='multipart',
        )
        self.assertEqual(second.status_code, 200, second.content)
        self.assertEqual(second.json()['id'], first_id)
        self.assertEqual(
            Violation.objects.filter(client_offline_id='offline_dup_001').count(), 1,
        )

    def test_replay_works_even_with_a_different_authenticated_request(self):
        # Same physical enforcer device re-sending after a token refresh —
        # still the same offline id, still must not duplicate.
        first = self.as_user(self.enforcer_a).post(
            '/api/violations/create/',
            self._form(client_offline_id='offline_replay_002'), format='multipart',
        )
        self.assertEqual(first.status_code, 201, first.content)

        second = self.as_user(self.enforcer_a).post(
            '/api/violations/create/',
            self._form(client_offline_id='offline_replay_002', location='Different St'),
            format='multipart',
        )
        # Replay returns the ORIGINAL record — the resend's other field
        # values are ignored, exactly like the first successful save.
        self.assertEqual(second.status_code, 200, second.content)
        self.assertEqual(second.json()['location'], 'ML Tagarao St, Barangay 5, Lucena City')

    def test_normal_online_submissions_without_offline_id_never_collide(self):
        res1 = self.as_user(self.enforcer_a).post(
            '/api/violations/create/', self._form(ovr_number='A 00070852'), format='multipart',
        )
        res2 = self.as_user(self.enforcer_a).post(
            '/api/violations/create/', self._form(ovr_number='A 00070853'), format='multipart',
        )
        self.assertEqual(res1.status_code, 201, res1.content)
        self.assertEqual(res2.status_code, 201, res2.content)
        self.assertNotEqual(res1.json()['id'], res2.json()['id'])

    def test_client_offline_id_cannot_be_changed_by_a_later_patch(self):
        res = self.as_user(self.enforcer_a).post(
            '/api/violations/create/',
            self._form(client_offline_id='offline_writeonce_003'), format='multipart',
        )
        violation_id = res.json()['id']
        self.as_user(self.enforcer_a).patch(
            f'/api/violations/{violation_id}/',
            {'client_offline_id': 'offline_tampered'}, format='json',
        )
        self.assertEqual(
            Violation.objects.get(pk=violation_id).client_offline_id, 'offline_writeonce_003',
        )

    def test_blank_offline_id_is_stored_as_null_not_empty_string(self):
        res = self.as_user(self.enforcer_a).post(
            '/api/violations/create/', self._form(client_offline_id=''), format='multipart',
        )
        self.assertEqual(res.status_code, 201, res.content)
        self.assertIsNone(Violation.objects.get(pk=res.json()['id']).client_offline_id)

    def test_two_different_blank_offline_id_submissions_dont_collide_on_uniqueness(self):
        res1 = self.as_user(self.enforcer_a).post(
            '/api/violations/create/', self._form(ovr_number='A 00070860'), format='multipart',
        )
        res2 = self.as_user(self.enforcer_a).post(
            '/api/violations/create/', self._form(ovr_number='A 00070861'), format='multipart',
        )
        self.assertEqual(res1.status_code, 201, res1.content)
        self.assertEqual(res2.status_code, 201, res2.content)


class DashboardEndpoints(BaseRoleTestCase):
    """
    The desktop dashboards read /stats/ and /staff-dashboard/. The new keys
    are additive — these tests pin their meaning so the numbers on screen
    can be trusted (and prove enforcers don't get headcounts).
    """

    def _issue(self, enforcer, ovr, days_ago=0, status='pending'):
        v = Violation.objects.create(
            violator_name='X, Y', ovr_number=ovr, location='Riverside Quarter',
            date_issued=timezone.now() - timedelta(days=days_ago), status=status, enforcer=enforcer,
        )
        ViolationItem.objects.create(violation=v, violation_type=self.vtype, penalty_amount_snapshot=500)
        v.compute_total()
        return v

    def test_admin_stats_daily_week_and_types(self):
        self._issue(self.enforcer_a, 'D-1', days_ago=0, status='paid')
        self._issue(self.enforcer_a, 'D-2', days_ago=2, status='pending')
        self._issue(self.enforcer_b, 'D-3', days_ago=10, status='pending')      # previous week
        body = self.as_user(self.admin).get('/api/violations/stats/').json()

        self.assertEqual(len(body['daily_data']), 7)
        self.assertEqual(sum(d['total'] for d in body['daily_data']), body['week_total'])
        # other_ovr (setUp, today) + D-1 + D-2 are inside the last 7 days
        self.assertEqual(body['week_total'], 3)
        self.assertEqual(body['prev_week_total'], 1)
        self.assertEqual(sum(d['paid'] for d in body['daily_data']), 1)
        self.assertEqual(body['daily_data'][-1]['paid'], 1)                      # the paid one was issued today
        self.assertEqual(body['type_data'], [{'name': 'Test violation', 'count': 4}])
        self.assertEqual(body['processing'], 0)

    def test_headcounts_for_admin_and_staff_only(self):
        # "On duty" is server-computed from today's schedule + local time (the
        # persisted duty_status is only a mirror), so put enforcer_b on a shift
        # that covers the whole local day instead of writing the field directly.
        from datetime import time as _time
        from enforcers.models import EnforcerSchedule
        EnforcerSchedule.objects.create(
            enforcer=self.enforcer_b, date=timezone.localdate(),
            shift_start=_time(0, 0), shift_end=_time(23, 59, 59), assigned_area='Domoit',
        )
        for user in (self.admin, self.staff):
            body = self.as_user(user).get('/api/violations/stats/').json()
            self.assertEqual(body['active_enforcers'], 2)
            self.assertEqual(body['on_duty_enforcers'], 1)
        mine = self.as_user(self.enforcer_a).get('/api/violations/stats/').json()
        self.assertNotIn('active_enforcers', mine)
        self.assertNotIn('on_duty_enforcers', mine)

    def test_headcount_ignores_stale_on_duty_without_a_schedule(self):
        # A leftover persisted on_duty (no schedule today) must not be counted.
        self.enforcer_b.duty_status = 'on_duty'
        self.enforcer_b.save()
        body = self.as_user(self.admin).get('/api/violations/stats/').json()
        self.assertEqual(body['on_duty_enforcers'], 0)

    def test_enforcer_stats_stay_scoped_to_their_own_records(self):
        self._issue(self.enforcer_a, 'D-4')
        mine = self.as_user(self.enforcer_a).get('/api/violations/stats/').json()
        self.assertEqual(mine['total'], 1)                                        # not enforcer_b's OVR
        self.assertEqual(mine['week_total'], 1)
        self.assertEqual(sum(t['count'] for t in mine['type_data']), 1)

    def test_staff_dashboard_new_fields(self):
        self._issue(self.enforcer_a, 'D-5', status='paid')
        body = self.as_user(self.staff).get('/api/violations/staff-dashboard/').json()
        self.assertEqual(body['paid_count'], 1)
        self.assertEqual(body['pending_queue'][0]['enforcer_name'], self.enforcer_b.full_name)
        self.assertTrue(body['recent_actions'])
        self.assertEqual(
            set(body['recent_actions'][0]),
            {'id', 'ovr_number', 'status', 'enforcer_name', 'assessed_by_name', 'locked_by_name', 'updated_at'},
        )

    def test_enforcer_cannot_read_staff_dashboard(self):
        res = self.as_user(self.enforcer_a).get('/api/violations/staff-dashboard/')
        self.assertEqual(res.status_code, 403)


class RepeatViolatorIsYearScoped(BaseRoleTestCase):
    """
    #004 — repeat-violator status must never combine violations from
    different calendar years, even though both rows can legitimately still
    be sitting in the active table at the same time (archiving is a manual,
    on-demand action, not an automatic year-boundary sweep).
    """

    THIS_YEAR = timezone.now().year
    LAST_YEAR = THIS_YEAR - 2  # skip two archive cycles' worth, not just one

    # A license distinct from BaseRoleTestCase.other_ovr's ('D07-25-000928')
    # so these counts aren't polluted by the class-level fixture record.
    LICENSE = 'D26-99-000001'

    def _dt(self, year, month=6, day=15):
        return timezone.make_aware(timezone.datetime(year, month, day, 10, 0))

    def _make(self, ovr_number, year):
        return self._make_violation(
            self.enforcer_a, ovr_number, date_issued=self._dt(year), license_number=self.LICENSE,
        )

    def test_two_tickets_same_year_are_flagged_repeat(self):
        v1 = self._make('RY-001', self.THIS_YEAR)
        v2 = self._make('RY-002', self.THIS_YEAR)
        res = self.as_user(self.staff).get(f'/api/violations/?search={self.LICENSE}')
        statuses = {row['id']: row['repeat_status'] for row in res.json()['results']}
        self.assertEqual(statuses[v1.id], 'REPEAT VIOLATOR')
        self.assertEqual(statuses[v2.id], 'REPEAT VIOLATOR')

    def test_tickets_in_different_years_are_not_flagged_repeat(self):
        v_old = self._make('RY-003', self.LAST_YEAR)
        v_new = self._make('RY-004', self.THIS_YEAR)
        res = self.as_user(self.staff).get(f'/api/violations/?search={self.LICENSE}')
        statuses = {row['id']: row['repeat_status'] for row in res.json()['results']}
        self.assertEqual(statuses[v_old.id], 'FIRST VIOLATION')
        self.assertEqual(statuses[v_new.id], 'FIRST VIOLATION')

    def test_violator_lookup_count_ignores_prior_year_ticket(self):
        self._make('RY-005', self.LAST_YEAR)
        res = self.as_user(self.enforcer_a).get(
            f'/api/violations/violator-lookup/?license_number={self.LICENSE}'
        )
        body = res.json()
        self.assertTrue(body['found'])                # record exists...
        self.assertEqual(body['violation_count'], 0)   # ...but not in the current year
        self.assertFalse(body['is_repeat_offender'])

    def test_violator_lookup_count_only_counts_current_year_tickets(self):
        self._make('RY-006', self.LAST_YEAR)
        self._make('RY-007', self.THIS_YEAR)
        self._make('RY-008', self.THIS_YEAR)
        res = self.as_user(self.enforcer_a).get(
            f'/api/violations/violator-lookup/?license_number={self.LICENSE}'
        )
        body = res.json()
        self.assertEqual(body['violation_count'], 2)   # RY-007 + RY-008 only
        self.assertTrue(body['is_repeat_offender'])


class YearComparisonArchiveTests(BaseRoleTestCase):
    """
    REQUIREMENT #8 — Analytics Year Comparison must remain accurate for a
    year whose records have since been moved out of the active Violation
    table by REQUIREMENT #2 (Archive Management). These tests create
    ArchivedViolation rows directly (rather than running the real archive
    operation) since only the resulting stored shape matters here.
    """

    ARCHIVED_YEAR = 2023  # fully archived: no active Violation rows exist for it
    MIXED_YEAR = 2024     # one active + one archived record for the same year

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        from database_management.models import ArchiveBatch, ArchivedViolation

        cls.batch = ArchiveBatch.objects.create(
            status=ArchiveBatch.Status.SUCCESS, archived_count=2, active_count_before=2,
        )

        def make_archived(year, original_id, status='Paid', vehicle_type='Motorcycle',
                           location='ML Tagarao Street', enforcer_name='Enforcer 1',
                           category='traffic'):
            return ArchivedViolation.objects.create(
                batch=cls.batch,
                original_violation_id=original_id,
                violation_year=year,
                date_issued=timezone.make_aware(timezone.datetime(year, 3, 15)),
                settlement_status=ArchivedViolation.Settlement.SETTLED,
                settled_at=timezone.make_aware(timezone.datetime(year, 3, 20)),
                violator_name='DELA CRUZ, JUAN',
                license_number=f'ARCHIVED-{year}-{original_id}',
                plate_number='ARC1234',
                data={
                    'status': status,
                    'vehicle_type': vehicle_type,
                    'location': location,
                    'enforcer_name': enforcer_name,
                    'assessed_by_name': 'Should Never Leak Into Analytics',
                    'items': [{'code': 'TST-1', 'name': 'Test violation', 'category': category, 'penalty_amount': 500.0}],
                },
            )

        cls.archived_1 = make_archived(cls.ARCHIVED_YEAR, 9001)
        cls.archived_2 = make_archived(cls.ARCHIVED_YEAR, 9002)
        cls.archived_mixed = make_archived(cls.MIXED_YEAR, 9003)
        # one still-active record for MIXED_YEAR, same shape as archived ones
        cls._make_violation(
            cls.enforcer_a, 'OVR-MIXED-1', status='paid',
            date_issued=timezone.make_aware(timezone.datetime(cls.MIXED_YEAR, 6, 1)),
        )

    def test_year_comparison_includes_fully_archived_year(self):
        """TEST 3 (requirement doc): a historical year with only archived
        records must still report its real count, not zero."""
        res = self.as_user(self.admin).get(
            f'/api/violations/analytics/year_comparison/?years={self.ARCHIVED_YEAR}&years={self.MIXED_YEAR}'
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        march_row = next(row for row in body['year_comparison'] if row['month'] == 'Mar')
        self.assertEqual(march_row[str(self.ARCHIVED_YEAR)], 2)  # archived_1 + archived_2

    def test_year_comparison_merges_active_and_archived_same_year(self):
        """A year with one active record and one archived record must sum
        both, not report only whichever table still holds it."""
        res = self.as_user(self.admin).get(
            f'/api/violations/analytics/year_comparison/?years={self.MIXED_YEAR}'
        )
        body = res.json()
        march_row = next(row for row in body['year_comparison'] if row['month'] == 'Mar')
        june_row = next(row for row in body['year_comparison'] if row['month'] == 'Jun')
        self.assertEqual(march_row[str(self.MIXED_YEAR)], 1)  # archived_mixed
        self.assertEqual(june_row[str(self.MIXED_YEAR)], 1)   # active OVR-MIXED-1

    def test_available_years_includes_year_that_only_exists_in_archive(self):
        res = self.as_user(self.admin).get('/api/violations/analytics/year_comparison/?years=2024')
        self.assertIn(self.ARCHIVED_YEAR, res.json()['available_years'])

    def test_status_breakdown_merges_archived_counts(self):
        res = self.as_user(self.admin).get(
            f'/api/violations/analytics/year_comparison/?years={self.ARCHIVED_YEAR}&breakdown=status'
        )
        rows = res.json()['breakdowns']['status']
        paid_row = next(r for r in rows if r['category'] == 'Paid')
        self.assertEqual(paid_row[str(self.ARCHIVED_YEAR)], 2)

    def test_breakdown_never_exposes_assessed_by_name(self):
        """Archive Confidentiality (REQUIREMENT #12): assessed_by_name must
        never surface through analytics, however it's aggregated."""
        res = self.as_user(self.admin).get(
            f'/api/violations/analytics/year_comparison/?years={self.ARCHIVED_YEAR}'
            '&breakdown=status&breakdown=vehicle_type&breakdown=location&breakdown=enforcer&breakdown=violation_category'
        )
        self.assertNotIn('Should Never Leak Into Analytics', res.content.decode())

    def test_analytics_summary_available_years_includes_archived_year(self):
        res = self.as_user(self.admin).get('/api/violations/analytics/?period=year')
        self.assertIn(self.ARCHIVED_YEAR, res.json()['available_years'])

    def test_enforcer_cannot_reach_year_comparison(self):
        res = self.as_user(self.enforcer_a).get('/api/violations/analytics/year_comparison/')
        self.assertEqual(res.status_code, 403)

class OfflineIssuancesKPI(BaseRoleTestCase):
    """Regression tests for the Offline Issuances KPI on /api/violations/stats/.

    client_offline_id is set once, only by the dedicated offline workflow,
    and is write-once (see ViolationDetailSerializer.update()) — so this
    count must never depend on the local sync queue, must survive status
    changes, and must respect the same role scoping as every other figure
    on this endpoint.
    """

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.online_a = cls._make_violation(cls.enforcer_a, 'OVR-A-100')

        cls.offline_a = cls._make_violation(cls.enforcer_a, 'OVR-A-101')
        cls.offline_a.client_offline_id = 'offline-key-a-1'
        cls.offline_a.save()

        cls.offline_b = cls._make_violation(cls.enforcer_b, 'OVR-B-100')
        cls.offline_b.client_offline_id = 'offline-key-b-1'
        cls.offline_b.save()

    def test_online_violations_are_not_counted(self):
        # enforcer_a has exactly one offline record (offline_a); the plain
        # online one (online_a) must not inflate the count.
        res = self.as_user(self.enforcer_a).get('/api/violations/stats/')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['offline_issuances'], 1)

    def test_offline_originated_violations_are_counted(self):
        res = self.as_user(self.admin).get('/api/violations/stats/')
        # offline_a + offline_b = 2 org-wide offline issuances.
        self.assertEqual(res.json()['offline_issuances'], 2)

    def test_remains_counted_after_status_change(self):
        self.offline_a.status = 'processing'
        self.offline_a.save()
        self.offline_a.status = 'paid'
        self.offline_a.save()

        res = self.as_user(self.admin).get('/api/violations/stats/')
        self.assertEqual(res.json()['offline_issuances'], 2)

        res = self.as_user(self.enforcer_a).get('/api/violations/stats/')
        self.assertEqual(res.json()['offline_issuances'], 1)

    def test_enforcer_scoping(self):
        res_a = self.as_user(self.enforcer_a).get('/api/violations/stats/')
        self.assertEqual(res_a.json()['offline_issuances'], 1)

        res_b = self.as_user(self.enforcer_b).get('/api/violations/stats/')
        # enforcer_b: offline_b only (their share of other_ovr from
        # BaseRoleTestCase is not offline-originated).
        self.assertEqual(res_b.json()['offline_issuances'], 1)

    def test_admin_organization_wide_total(self):
        res = self.as_user(self.admin).get('/api/violations/stats/')
        self.assertEqual(res.json()['offline_issuances'], 2)

    def test_staff_organization_wide_total(self):
        res = self.as_user(self.staff).get('/api/violations/stats/')
        self.assertEqual(res.json()['offline_issuances'], 2)


class GpsCoordinateRange(IssueOvrWizardPayload):
    """Latitude -90..90 and longitude -180..180, inclusive. GPS stays optional."""

    def _create_violation(self, **overrides):
        n = getattr(self, '_seq', 0) + 1
        self._seq = n
        return self.as_user(self.enforcer_a).post(
            '/api/violations/create/',
            self._form(ovr_number=f'GPS-{n:04d}', **overrides),
            format='multipart',
        )

    def _post_evidence(self, **fields):
        payload = {
            'image': SimpleUploadedFile('cap.jpg', _jpeg_bytes(), 'image/jpeg'),
            'captured_at': timezone.now().isoformat(),
        }
        payload.update(fields)
        return self.as_user(self.enforcer_a).post(
            '/api/violations/evidence/', payload, format='multipart',
        )

    def test_boundary_coordinates_are_accepted_on_a_violation(self):
        for lat, lng in ((90, 180), (-90, -180)):
            with self.subTest(latitude=lat, longitude=lng):
                res = self._create_violation(latitude=str(lat), longitude=str(lng))
                self.assertEqual(res.status_code, 201, res.content)
                saved = Violation.objects.get(pk=res.json()['id'])
                self.assertEqual(saved.latitude, lat)
                self.assertEqual(saved.longitude, lng)

    def test_boundary_coordinates_are_accepted_on_evidence(self):
        for lat, lng in ((90, 180), (-90, -180)):
            with self.subTest(latitude=lat, longitude=lng):
                res = self._post_evidence(latitude=str(lat), longitude=str(lng))
                self.assertEqual(res.status_code, 201, res.content)
                saved = ViolationEvidence.objects.get(pk=res.json()['id'])
                self.assertEqual(saved.latitude, lat)
                self.assertEqual(saved.longitude, lng)

    def test_latitude_just_outside_the_range_is_rejected_on_a_violation(self):
        for lat in ('90.0001', '-90.0001'):
            with self.subTest(latitude=lat):
                res = self._create_violation(latitude=lat, longitude='121.6')
                self.assertEqual(res.status_code, 400)
                self.assertIn('latitude', res.json())
                self.assertNotIn('longitude', res.json())

    def test_latitude_just_outside_the_range_is_rejected_on_evidence(self):
        for lat in ('90.0001', '-90.0001'):
            with self.subTest(latitude=lat):
                res = self._post_evidence(latitude=lat, longitude='121.6')
                self.assertEqual(res.status_code, 400)
                self.assertIn('latitude', res.json())

    def test_longitude_just_outside_the_range_is_rejected_on_a_violation(self):
        for lng in ('180.0001', '-180.0001'):
            with self.subTest(longitude=lng):
                res = self._create_violation(latitude='13.9', longitude=lng)
                self.assertEqual(res.status_code, 400)
                self.assertIn('longitude', res.json())
                self.assertNotIn('latitude', res.json())

    def test_longitude_just_outside_the_range_is_rejected_on_evidence(self):
        for lng in ('180.0001', '-180.0001'):
            with self.subTest(longitude=lng):
                res = self._post_evidence(latitude='13.9', longitude=lng)
                self.assertEqual(res.status_code, 400)
                self.assertIn('longitude', res.json())

    def test_non_numeric_coordinates_are_a_400_on_a_violation(self):
        res = self._create_violation(latitude='not-a-number', longitude='121.6')
        self.assertEqual(res.status_code, 400)
        self.assertIn('latitude', res.json())

    def test_non_numeric_coordinates_are_a_400_on_evidence(self):
        res = self._post_evidence(latitude='13.9', longitude='east')
        self.assertEqual(res.status_code, 400)
        self.assertIn('longitude', res.json())

    def test_null_gps_is_still_accepted_on_a_violation(self):
        res = self.as_user(self.enforcer_a).post(
            '/api/violations/create/',
            self._form(ovr_number='GPS-NULL', latitude=None, longitude=None),
            format='json',
        )
        self.assertEqual(res.status_code, 201, res.content)
        saved = Violation.objects.get(pk=res.json()['id'])
        self.assertIsNone(saved.latitude)
        self.assertIsNone(saved.longitude)

    def test_omitted_gps_is_still_accepted_on_evidence(self):
        res = self._post_evidence()
        self.assertEqual(res.status_code, 201, res.content)
        saved = ViolationEvidence.objects.get(pk=res.json()['id'])
        self.assertIsNone(saved.latitude)
        self.assertIsNone(saved.longitude)

    def test_null_gps_is_still_accepted_on_evidence(self):
        from violations.serializers import ViolationEvidenceSerializer
        serializer = ViolationEvidenceSerializer(data={
            'image': SimpleUploadedFile('cap.jpg', _jpeg_bytes(), 'image/jpeg'),
            'captured_at': timezone.now().isoformat(),
            'latitude': None,
            'longitude': None,
        })
        self.assertTrue(serializer.is_valid(), serializer.errors)
        self.assertIsNone(serializer.validated_data['latitude'])
        self.assertIsNone(serializer.validated_data['longitude'])

    def test_violation_patch_validates_only_coordinates_that_are_sent(self):
        own = self._make_violation(self.enforcer_a, 'GPS-PATCH')
        own.latitude = 13.9
        own.longitude = 121.6
        own.save(update_fields=['latitude', 'longitude'])

        untouched = self.as_user(self.enforcer_a).patch(
            f'/api/violations/{own.id}/', {'remarks': 'desk note'}, format='json',
        )
        self.assertEqual(untouched.status_code, 200, untouched.content)
        own.refresh_from_db()
        self.assertAlmostEqual(own.latitude, 13.9)
        self.assertAlmostEqual(own.longitude, 121.6)

        rejected = self.as_user(self.enforcer_a).patch(
            f'/api/violations/{own.id}/', {'longitude': 180.0001}, format='json',
        )
        self.assertEqual(rejected.status_code, 400)
        self.assertIn('longitude', rejected.json())
        self.assertNotIn('latitude', rejected.json())
        own.refresh_from_db()
        self.assertAlmostEqual(own.longitude, 121.6)

        cleared = self.as_user(self.enforcer_a).patch(
            f'/api/violations/{own.id}/', {'latitude': None}, format='json',
        )
        self.assertEqual(cleared.status_code, 200, cleared.content)
        own.refresh_from_db()
        self.assertIsNone(own.latitude)
        self.assertAlmostEqual(own.longitude, 121.6)

    def test_evidence_partial_update_validates_only_coordinates_that_are_sent(self):
        from violations.serializers import ViolationEvidenceSerializer
        existing = ViolationEvidence.objects.create(
            image=SimpleUploadedFile('cap.jpg', _jpeg_bytes(), 'image/jpeg'),
            captured_at=timezone.now(),
            captured_by=self.enforcer_a,
            latitude=13.9,
            longitude=121.6,
        )
        kept = ViolationEvidenceSerializer(
            existing, data={'gps_accuracy': 4.5}, partial=True,
        )
        self.assertTrue(kept.is_valid(), kept.errors)

        rejected = ViolationEvidenceSerializer(
            existing, data={'latitude': 90.0001}, partial=True,
        )
        self.assertFalse(rejected.is_valid())
        self.assertIn('latitude', rejected.errors)
        self.assertNotIn('longitude', rejected.errors)
        existing.refresh_from_db()
        self.assertAlmostEqual(existing.latitude, 13.9)