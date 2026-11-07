"""
Reports module tests.  Run:  python manage.py test reports --settings=core.test_settings
(--settings=core.test_settings swaps PostgreSQL for in-memory SQLite; the
production settings are untouched.)
"""
import datetime
from decimal import Decimal
from unittest import mock
from zoneinfo import ZoneInfo

from rest_framework.test import APITestCase

from accounts.models import CustomUser
from database_management.models import ArchiveBatch, ArchivedViolation
from violations.models import Violation, ViolationItem, ViolationType

MNL = ZoneInfo('Asia/Manila')
URL = '/api/reports/generate/'


def at(y, m, d, hh=10, mm=0):
    return datetime.datetime(y, m, d, hh, mm, tzinfo=MNL)


class ReportsBase(APITestCase):
    @classmethod
    def setUpTestData(cls):
        def user(role, n, **kw):
            return CustomUser.objects.create_user(
                email=f'{role}{n}@tmeo.test', password='x', full_name=f'{role.title()} {n}',
                id_number=f'R-{role}-{n}', role=role, **kw)
        cls.admin, cls.staff = user('admin', 1), user('staff', 1)
        cls.enf_a, cls.enf_b = user('enforcer', 1), user('enforcer', 2)
        cls.nh = ViolationType.objects.create(code='NH', name='No Helmet', penalty_amount=500, category='traffic')
        cls.dl = ViolationType.objects.create(code='DL', name='No License', penalty_amount=750, category='safety')
        cls.free = ViolationType.objects.create(code='FR', name='Warning Only', penalty_amount=0, category='other')
        cls.batch = ArchiveBatch.objects.create(status='success', archived_count=0, active_count_before=0)

    def viol(self, when, status='pending', types=None, enforcer='a', location='Quezon Ave',
             vehicle='Cars', source='enforcer_ovr', imported_by=None, plate=None, violator='V'):
        types = types or [self.nh]
        enf = {'a': self.enf_a, 'b': self.enf_b, None: None}[enforcer] if isinstance(enforcer, (str, type(None))) else enforcer
        v = Violation.objects.create(
            violator_name=violator, plate_number=plate or f'P{Violation.objects.count()}',
            location=location, vehicle_type=vehicle, date_issued=when, status=status,
            enforcer=enf, source=source, imported_by=imported_by, ovr_number='O')
        for t in types:
            ViolationItem.objects.create(violation=v, violation_type=t, penalty_amount_snapshot=t.penalty_amount)
        v.compute_total()
        return v

    def arch(self, oid, when, items=None, enforcer='Enforcer 1', location='Quezon Ave', vehicle='Cars',
             source='enforcer_ovr', penalty=500.0):
        items = items if items is not None else [{'code': 'NH', 'name': 'No Helmet', 'category': 'traffic', 'penalty_amount': 500.0}]
        return ArchivedViolation.objects.create(
            batch=self.batch, original_violation_id=oid, violation_year=when.year, date_issued=when,
            settlement_status='settled', violator_name='A', plate_number='ARC', license_number='',
            data={'status': 'Paid', 'penalty_amount': penalty, 'enforcer_name': enforcer, 'source': source,
                  'location': location, 'vehicle_type': vehicle, 'items': items})

    def get(self, rtype, user=None, **params):
        self.client.force_authenticate(user or self.admin)
        return self.client.get(URL, {'type': rtype, **params})

    def ok(self, rtype, **params):
        res = self.get(rtype, **params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()


class AccessAndValidationTests(ReportsBase):
    def test_enforcer_forbidden_unauthenticated_denied(self):
        self.assertEqual(self.get('status', user=self.enf_a).status_code, 403)
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(URL, {'type': 'status'}).status_code, 401)

    def test_admin_and_staff_allowed(self):
        self.assertEqual(self.get('status', user=self.admin).status_code, 200)
        self.assertEqual(self.get('status', user=self.staff).status_code, 200)

    def test_invalid_inputs_are_400_not_silent_empty(self):
        for params in ({'type': 'bogus'}, {'type': 'daily'},
                       {'type': 'status', 'date_from': '2026-13-01'},
                       {'type': 'status', 'date_from': '2026-05-02', 'date_to': '2026-05-01'},
                       {'type': 'monthly', 'status': 'bogus'},
                       {'type': 'by_type', 'category': 'bogus'}):
            with self.subTest(params=params):
                self.client.force_authenticate(self.admin)
                res = self.client.get(URL, params)
                self.assertEqual(res.status_code, 400)
                self.assertIn('error', res.json())

    def test_response_shape_and_applied_filters_echo(self):
        self.viol(at(2026, 5, 5))
        d = self.ok('status', date_from='2026-05-01', date_to='2026-05-31', status='paid', category='safety')
        self.assertEqual(set(d), {'meta', 'summary', 'rows'})
        # `status` report supports no extra filters → they are ignored AND not echoed
        self.assertEqual(d['meta']['filters_applied'], {'date_from': '2026-05-01', 'date_to': '2026-05-31'})
        self.assertEqual(d['meta']['supported_filters'], [])
        self.assertEqual(d['meta']['record_count'], len(d['rows']))
        self.assertTrue(d['meta']['generated_at'])
        self.assertEqual(d['meta']['generated_by'], 'Admin 1')
        self.assertTrue(all({'key', 'label', 'type', 'align'} <= set(c) for c in d['meta']['columns']))

    def test_legacy_enforcer_activity_id_still_works(self):
        self.assertEqual(self.ok('enforcer_activity')['meta']['report'], 'enforcer')


class DateAndUnionTests(ReportsBase):
    def test_date_boundaries_use_local_manila_calendar(self):
        self.viol(at(2026, 3, 31, 23, 30))   # UTC = 15:30 Mar 31
        self.viol(at(2026, 4, 1, 0, 10))     # UTC = 16:10 Mar 31 -> local April 1
        m = self.ok('monthly', date_from='2026-03-01', date_to='2026-04-30')
        self.assertEqual([(r['month'], r['total_violations']) for r in m['rows']], [('Mar 2026', 1), ('Apr 2026', 1)])
        one = self.ok('status', date_from='2026-04-01', date_to='2026-04-01')
        self.assertEqual(one['summary']['total_tickets'], 1)

    def test_active_and_archived_are_combined(self):
        self.viol(at(2026, 5, 5), status='pending')
        self.arch(9001, at(2026, 5, 6))
        d = self.ok('status', date_from='2026-05-01', date_to='2026-05-31')
        rows = {r['status']: r for r in d['rows']}
        self.assertEqual(rows['pending']['tickets'], 1)
        self.assertEqual(rows['paid']['tickets'], 1)
        self.assertEqual(rows['processing']['tickets'], 0)
        self.assertEqual(d['summary']['total_tickets'], 2)
        self.assertEqual(d['summary']['total_penalty'], '1000.00')

    def test_no_double_count_if_archived_original_still_active(self):
        v = self.viol(at(2026, 5, 5), status='paid')
        self.arch(v.id, at(2026, 5, 5))       # stale duplicate of an active row
        self.assertEqual(self.ok('status')['summary']['total_tickets'], 1)

    def test_status_filter_applies_to_archived_too(self):
        self.viol(at(2026, 5, 5), status='pending')
        self.arch(9001, at(2026, 5, 6))
        self.assertEqual(self.ok('monthly', status='pending')['summary']['total_violations'], 1)
        self.assertEqual(self.ok('monthly', status='paid')['summary']['total_violations'], 1)

    def test_monthly_fills_empty_months_with_true_zero(self):
        self.viol(at(2026, 1, 5)); self.viol(at(2026, 3, 5))
        d = self.ok('monthly', date_from='2026-01-01', date_to='2026-03-31')
        self.assertEqual([r['total_violations'] for r in d['rows']], [1, 0, 1])
        self.assertEqual(d['rows'][1]['total_fines'], '0.00')

    def test_empty_dataset(self):
        d = self.ok('by_type')
        self.assertEqual(d['rows'], [])
        self.assertEqual(d['summary']['total_tickets'], 0)


class ByTypeTests(ReportsBase):
    def test_ticket_count_vs_item_count(self):
        self.viol(at(2026, 5, 5), types=[self.nh, self.dl])
        self.viol(at(2026, 5, 6), types=[self.nh])
        d = self.ok('by_type')
        self.assertEqual(d['summary']['total_tickets'], 2)
        self.assertEqual(d['summary']['total_items'], 3)
        rows = {r['code']: r for r in d['rows']}
        self.assertEqual(rows['NH']['tickets'], 2)
        self.assertEqual(rows['NH']['fines'], '1000.00')      # item snapshots, not parent totals
        self.assertEqual(rows['DL']['fines'], '750.00')
        self.assertEqual(d['summary']['fines_known_total'], '1750.00')

    def test_legitimate_zero_penalty_is_real_zero_not_unavailable(self):
        self.viol(at(2026, 5, 5), types=[self.free])
        r = self.ok('by_type')['rows'][0]
        self.assertEqual(r['fines'], '0.00')
        self.assertEqual(r['fines_coverage'], 'complete')

    def test_imported_items_are_unavailable_never_zero(self):
        self.viol(at(2026, 5, 5), source='imported', enforcer=None, imported_by=self.admin,
                  types=[self.dl])            # snapshot stored as placeholder
        Violation.objects.update(penalty_amount=Decimal('900'))  # ticket-level total from sheet
        d = self.ok('by_type')
        r = d['rows'][0]
        self.assertIsNone(r['fines'])
        self.assertEqual(r['fines_coverage'], 'unavailable')
        self.assertEqual(r['fines_unknown_items'], 1)
        self.assertEqual(r['tickets'], 1)                     # counts stay accurate
        self.assertIsNone(d['summary']['fines_known_total'])
        self.assertEqual(d['summary']['fines_coverage'], 'unavailable')
        self.assertTrue(any('UNAVAILABLE' in n for n in d['meta']['notes']))
        # ticket-level money is still fully available elsewhere
        self.assertEqual(self.ok('status')['summary']['total_penalty'], '900.00')

    def test_mixed_real_and_imported_is_partial_and_totals_exclude_unknown(self):
        self.viol(at(2026, 5, 5), types=[self.nh])
        self.viol(at(2026, 5, 6), types=[self.nh], source='imported', enforcer=None, imported_by=self.admin)
        self.arch(9001, at(2026, 5, 7), source='imported', enforcer='',
                  items=[{'code': 'NH', 'name': 'No Helmet', 'category': 'traffic', 'penalty_amount': 0.0}])
        d = self.ok('by_type')
        r = d['rows'][0]
        self.assertEqual((r['tickets'], r['fines'], r['fines_unknown_items'], r['fines_coverage']),
                         (3, '500.00', 2, 'partial'))
        self.assertEqual(d['summary']['fines_coverage'], 'partial')

    def test_category_and_vehicle_filters(self):
        self.viol(at(2026, 5, 5), types=[self.nh, self.dl], vehicle='Cars')
        self.viol(at(2026, 5, 6), types=[self.nh], vehicle='Motorcycles')
        d = self.ok('by_type', category='safety')
        self.assertEqual([r['code'] for r in d['rows']], ['DL'])
        self.assertEqual(d['summary']['total_tickets'], 1)
        d = self.ok('by_type', vehicle_type='motorcycles')
        self.assertEqual(d['summary']['total_tickets'], 1)
        self.assertEqual(d['meta']['filters_applied'], {'vehicle_type': 'motorcycles'})


class EnforcerTests(ReportsBase):
    def test_walkin_and_imported_never_count_and_uploader_is_not_an_enforcer(self):
        self.viol(at(2026, 5, 5), enforcer='a')
        self.viol(at(2026, 5, 6), enforcer='a')
        self.viol(at(2026, 5, 7), enforcer='b')
        self.viol(at(2026, 5, 8), enforcer=None, source='staff_walk_in')
        for i in range(3):
            self.viol(at(2026, 5, 9 + i), enforcer=None, source='imported', imported_by=self.admin)
        self.arch(9001, at(2026, 5, 20), enforcer='Enforcer 1')
        self.arch(9002, at(2026, 5, 21), enforcer='', source='imported')
        d = self.ok('enforcer')
        by = {r['enforcer']: r for r in d['rows']}
        self.assertEqual(set(by), {'Enforcer 1', 'Enforcer 2'})        # no Admin 1, no '—'
        self.assertEqual(by['Enforcer 1']['tickets_issued'], 3)        # 2 active + 1 archived, merged
        self.assertEqual(by['Enforcer 2']['tickets_issued'], 1)
        self.assertEqual(d['summary']['tickets_without_enforcer'], 5)
        self.assertEqual(d['summary']['tickets_issued'], 4)
        self.assertTrue(any('not counted' in n for n in d['meta']['notes']))

    def test_imported_record_model_semantics(self):
        v = self.viol(at(2026, 5, 5), enforcer=None, source='imported', imported_by=self.admin)
        v.refresh_from_db()
        self.assertIsNone(v.enforcer)
        self.assertEqual(v.imported_by, self.admin)
        self.assertNotIn(v, self.enf_a.violations_filed.all())


class OutstandingTests(ReportsBase):
    def test_only_unpaid_active_with_aging_buckets(self):
        today = datetime.date(2026, 6, 30)
        self.viol(at(2026, 6, 28), status='pending')     # 2 d   -> 0-7
        self.viol(at(2026, 6, 10), status='processing')  # 20 d  -> 8-30
        self.viol(at(2026, 4, 1), status='pending')      # 90 d  -> 61+
        self.viol(at(2026, 6, 1), status='paid')         # excluded
        self.arch(9001, at(2026, 1, 1))                  # archived => never outstanding
        with mock.patch('reports.services.builders.timezone.localdate', return_value=today):
            d = self.ok('outstanding')
        self.assertEqual(d['summary']['tickets'], 3)
        self.assertEqual(d['summary']['total_outstanding'], '1500.00')
        ag = {a['key']: a for a in d['summary']['aging']}
        self.assertEqual((ag['0_7']['tickets'], ag['8_30']['tickets'], ag['31_60']['tickets'], ag['61_plus']['tickets']),
                         (1, 1, 0, 1))
        self.assertEqual([r['age_days'] for r in d['rows']], [90, 20, 2])   # oldest first
        self.assertIn('Active records only', d['meta']['scope'])

    def test_vehicle_filter(self):
        self.viol(at(2026, 6, 28), vehicle='Cars'); self.viol(at(2026, 6, 28), vehicle='Motorcycles')
        self.assertEqual(self.ok('outstanding', vehicle_type='cars')['summary']['tickets'], 1)


class LocationAndVehicleTests(ReportsBase):
    def test_perez_park_variants_resolve_to_one_canonical_location(self):
        self.viol(at(2026, 5, 5), location='Perez Park')
        self.viol(at(2026, 5, 6), location='Perez Park, Lucena')
        self.viol(at(2026, 5, 7), location='  perez   PARK ')
        self.arch(9001, at(2026, 5, 8), location='PEREZ PARK, LUCENA')
        d = self.ok('location')
        rows = {r['location']: r['tickets'] for r in d['rows']}
        self.assertEqual(rows, {'Perez Park': 4})

    def test_other_pairs_are_not_merged(self):
        self.viol(at(2026, 5, 5), location='Quezon Ave')
        self.viol(at(2026, 5, 6), location='Quezon Ave, Lucena')
        self.viol(at(2026, 5, 7), location='Perez, Park')
        rows = {r['location'] for r in self.ok('location')['rows']}
        self.assertEqual(rows, {'Quezon Ave', 'Quezon Ave, Lucena', 'Perez, Park'})

    def test_blank_location_is_unspecified_and_totals_reconcile(self):
        self.viol(at(2026, 5, 5), location=''); self.viol(at(2026, 5, 6), location=' - ')
        self.viol(at(2026, 5, 7), location='Quezon Ave')
        d = self.ok('location')
        self.assertEqual(d['rows'][-1]['location'], 'Unspecified')
        self.assertEqual(d['rows'][-1]['tickets'], 2)
        self.assertEqual(sum(r['tickets'] for r in d['rows']), d['summary']['total_tickets'])
        self.assertEqual(round(sum(r['percent'] for r in d['rows'])), 100)

    def test_vehicle_type_grouping(self):
        self.viol(at(2026, 5, 5), vehicle='Cars'); self.viol(at(2026, 5, 6), vehicle=' cars ')
        self.viol(at(2026, 5, 7), vehicle=''); self.arch(9001, at(2026, 5, 8), vehicle='CARS')
        rows = {r['vehicle_type']: r['tickets'] for r in self.ok('vehicle_type')['rows']}
        self.assertEqual(rows, {'Cars': 3, 'Unspecified': 1})