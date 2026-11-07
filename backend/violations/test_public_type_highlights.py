"""
Public landing-page carousel endpoint: GET /api/violations/public/types/

Type-level data only (code, name, category, description, standard fine).
No dates, counts, violators, plates, locations or enforcers.
"""
from rest_framework.test import APIClient

from violations.models import Violation, ViolationItem, ViolationType
from violations.tests import BaseRoleTestCase

URL = '/api/violations/public/types/'
ALLOWED_KEYS = {'code', 'name', 'category', 'description', 'penalty_amount'}


class PublicTypeHighlightsTests(BaseRoleTestCase):

    def get(self):
        return APIClient().get(URL)  # unauthenticated on purpose

    def _paid(self, vtype, ovr):
        v = self._make_violation(self.enforcer_a, ovr, status='paid')
        v.items.all().delete()
        ViolationItem.objects.create(violation=v, violation_type=vtype, penalty_amount_snapshot=vtype.penalty_amount)
        return v

    def test_is_public_and_returns_only_type_level_fields(self):
        res = self.get()
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.data)
        for row in res.data:
            self.assertEqual(set(row), ALLOWED_KEYS)

    def test_no_pii_or_dates_anywhere_in_payload(self):
        self._paid(self.vtype, 'OVR-PII-1')
        body = self.get().content.decode()
        for needle in ('DELA CRUZ', 'D07-25', 'ABC1234', 'Tagarao', 'Private Address', '@tmeo.test', 'date', 'created'):
            self.assertNotIn(needle, body)

    def test_max_five_and_inactive_excluded(self):
        for i in range(8):
            ViolationType.objects.create(code=f'HX-{i}', name=f'Type {i}', penalty_amount=100)
        ViolationType.objects.create(code='AAA-OFF', name='Disabled type', penalty_amount=100, is_active=False)
        res = self.get()
        self.assertEqual(len(res.data), 5)
        self.assertNotIn('AAA-OFF', [r['code'] for r in res.data])

    def test_most_issued_paid_types_rank_first(self):
        a = ViolationType.objects.create(code='ZZ-A', name='Rarely issued', penalty_amount=100)
        b = ViolationType.objects.create(code='ZZ-B', name='Often issued', penalty_amount=200)
        for i in range(3):
            self._paid(b, f'OVR-B-{i}')
        self._paid(a, 'OVR-A-0')
        codes = [r['code'] for r in self.get().data]
        self.assertEqual(codes[0], 'ZZ-B')
        self.assertEqual(codes[1], 'ZZ-A')

    def test_unpaid_tickets_do_not_affect_ranking(self):
        a = ViolationType.objects.create(code='AA-FIRST', name='Alphabetically first', penalty_amount=100)
        b = ViolationType.objects.create(code='ZZ-LAST', name='Alphabetically last', penalty_amount=100)
        v = self._make_violation(self.enforcer_a, 'OVR-PEND-1', status='pending')
        v.items.all().delete()
        ViolationItem.objects.create(violation=v, violation_type=b, penalty_amount_snapshot=100)
        codes = [r['code'] for r in self.get().data]
        self.assertLess(codes.index('AA-FIRST'), codes.index('ZZ-LAST'))

    def test_returns_description_and_current_fine(self):
        ViolationType.objects.create(code='DESC-1', name='With description', penalty_amount=750, description='Shown to the public.')
        row = next(r for r in self.get().data if r['code'] == 'DESC-1')
        self.assertEqual(row['description'], 'Shown to the public.')
        self.assertEqual(row['penalty_amount'], 750.0)

    def test_write_methods_not_allowed(self):
        c = APIClient()
        for method in (c.post, c.put, c.patch, c.delete):
            self.assertEqual(method(URL, {}, format='json').status_code, 405)