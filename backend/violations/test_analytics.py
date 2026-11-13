"""
Tests for violations/analytics.py (GET /api/violations/analytics/).

Seeds ACTIVE and ARCHIVED records with known values and asserts the
aggregation returns exactly the hand-computed numbers.
Run with:  python manage.py test violations.test_analytics
"""
import datetime
from unittest import mock

from django.utils import timezone
from rest_framework.test import APITestCase

from accounts.models import CustomUser
from database_management.models import ArchiveBatch, ArchivedViolation
from violations.models import Violation, ViolationItem, ViolationType

TODAY = datetime.date(2026, 3, 20)          # frozen "today" (Friday)
URL = '/api/violations/analytics/'


def at(month, day, hour, minute=0):
    return timezone.make_aware(datetime.datetime(2026, month, day, hour, minute))


class AnalyticsAggregationTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = CustomUser.objects.create_user(
            email='admin@tmeo.test', password='x', full_name='Admin One',
            id_number='T-A1', role='admin')
        cls.enforcer = CustomUser.objects.create_user(
            email='enf@tmeo.test', password='x', full_name='Enforcer One',
            id_number='T-E1', role='enforcer')
        cls.no_helmet = ViolationType.objects.create(
            code='NH', name='No Helmet', penalty_amount=500, category='traffic')

        def active(ovr, status, vehicle, location, when, lic):
            v = Violation.objects.create(
                violator_name='V ' + ovr, license_number=lic, plate_number='P' + ovr,
                ovr_number=ovr, vehicle_type=vehicle, location=location,
                date_issued=when, status=status, enforcer=cls.enforcer)
            ViolationItem.objects.create(
                violation=v, violation_type=cls.no_helmet,
                penalty_amount_snapshot=cls.no_helmet.penalty_amount)
            v.compute_total()
            return v

        # Mon Jan 5 08:30 / Mon Jan 5 17:10 / Tue Jan 6 17:45 / Wed Jan 7 09:00 / Sun Mar 15 10:00
        active('A1', 'pending',    'Motorcycles', 'Perez Park',       at(1, 5, 8, 30),  'L1')
        active('A2', 'processing', 'Cars',        '  perez   PARK ', at(1, 5, 17, 10), 'L1')
        active('A3', 'paid',       'Motorcycles', '.',                at(1, 6, 17, 45), 'L2')
        active('A4', 'pending',    'Cars',        'Perez, Park',      at(1, 7, 9, 0),   '')
        active('A5', 'pending',    'Trucks & Heavy Vehicles',      '/',                at(3, 15, 10, 0), 'L4')

        batch = ArchiveBatch.objects.create(
            status=ArchiveBatch.Status.SUCCESS, archived_count=2, active_count_before=2)

        def archived(oid, vehicle, location, when, lic):
            ArchivedViolation.objects.create(
                batch=batch, original_violation_id=oid, violation_year=when.year,
                date_issued=when, settlement_status='settled', settled_at=when,
                violator_name='ARC', license_number=lic, plate_number='X',
                data={'status': 'Paid', 'vehicle_type': vehicle, 'location': location,
                      'enforcer_name': 'Enforcer One', 'penalty_amount': 500.0,
                      'assessed_by_name': 'MUST NOT LEAK',
                      'items': [{'code': 'NH', 'name': 'No Helmet',
                                 'category': 'traffic', 'penalty_amount': 500.0}]})

        archived(9001, 'Motorcycles', 'Perez Park',        at(1, 5, 8, 5),  'L1')
        archived(9002, 'Cars',        'Perez Park, Lucena', at(1, 8, 12, 0), 'L3')

    def get(self, **params):
        self.client.force_authenticate(self.admin)
        params.setdefault('period', 'year')
        with mock.patch('django.utils.timezone.localdate', return_value=TODAY):
            res = self.client.get(URL, params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    # ── scope ────────────────────────────────────────────────────────────
    def test_default_scope_combines_active_and_archived(self):
        d = self.get()
        self.assertEqual(d['total'], 7)
        self.assertEqual(d['scope']['active_count'], 5)
        self.assertEqual(d['scope']['archived_count'], 2)
        self.assertEqual(d['by_status'], {'pending': 3, 'processing': 1, 'paid': 3})
        self.assertEqual(d['total_penalty'], 3500.0)
        self.assertEqual(d['total_collected'], 1500.0)

    def test_scope_active_matches_legacy_behaviour(self):
        d = self.get(scope='active')
        self.assertEqual(d['total'], 5)
        self.assertEqual(d['scope']['archived_count'], 0)
        self.assertEqual(d['by_status']['paid'], 1)

    def test_archived_confidential_field_never_returned(self):
        self.client.force_authenticate(self.admin)
        with mock.patch('django.utils.timezone.localdate', return_value=TODAY):
            res = self.client.get(URL, {'period': 'year'})
        self.assertNotIn('MUST NOT LEAK', res.content.decode())

    # ── time analytics ───────────────────────────────────────────────────
    def test_peak_hours_weekday_and_heatmap(self):
        d = self.get()
        hours = {h['hour']: h['count'] for h in d['peak_hours']}
        self.assertEqual(len(d['peak_hours']), 24)
        self.assertEqual((hours[8], hours[9], hours[10], hours[12], hours[17]), (2, 1, 1, 1, 2))
        self.assertEqual(sum(hours.values()), 7)
        wd = {w['name']: w['count'] for w in d['by_weekday']}
        self.assertEqual([w['name'] for w in d['by_weekday']][0], 'Monday')
        self.assertEqual(wd['Monday'], 3)      # A1, A2, archived 9001
        self.assertEqual((wd['Tuesday'], wd['Wednesday'], wd['Thursday']), (1, 1, 1))
        self.assertEqual(wd['Sunday'], 1)
        cells = {(c['weekday'], c['hour']): c['count'] for c in d['day_hour_heatmap']['cells']}
        self.assertEqual(len(cells), 168)
        self.assertEqual(cells[(1, 8)], 2)
        self.assertEqual(cells[(1, 17)], 1)
        self.assertEqual(d['day_hour_heatmap']['max'], 2)

    def test_time_filters(self):
        self.assertEqual(self.get(hour='8')['total'], 2)
        self.assertEqual(self.get(weekday='1', hour='17')['total'], 1)
        self.assertEqual(self.get(weekday='7')['total'], 1)

    # ── vehicle types ────────────────────────────────────────────────────
    def test_vehicle_breakdown_and_filter(self):
        d = self.get()
        v = {i['vehicle_type']: i for i in d['vehicle_type_breakdown']['items']}
        self.assertEqual((v['Motorcycles']['count'], v['Cars']['count'], v['Trucks & Heavy Vehicles']['count']), (3, 3, 1))
        self.assertEqual(v['Motorcycles']['share'], round(3 / 7 * 100, 1))
        self.assertEqual(self.get(vehicle_type='Cars')['total'], 3)

    # ── locations ────────────────────────────────────────────────────────
    def test_location_normalisation_excludes_invalid_and_does_not_merge_ambiguous(self):
        d = self.get()
        items = {i['location']: i['count'] for i in d['location_ranking']['items']}
        self.assertEqual(items['Perez Park'], 3)                 # A1, A2 (case/space), archived
        self.assertEqual(items['Perez, Park'], 1)                 # NOT merged
        self.assertEqual(items['Perez Park, Lucena'], 1)          # NOT merged
        self.assertNotIn('.', items)
        self.assertNotIn('/', items)
        self.assertEqual(d['location_ranking']['excluded_invalid_count'], 2)
        self.assertEqual(d['hotspots'][0], {'location': 'Perez Park', 'count': 3,
                                            'total_penalty': 1500.0})
        self.assertEqual(self.get(location='perez park')['total'], 3)

    def test_hotspot_by_violation_type(self):
        d = self.get()
        row = d['hotspot_by_type']['rows'][0]
        self.assertEqual(row['label'], 'Perez Park')
        self.assertEqual(row['types'][0]['name'], 'No Helmet')
        self.assertEqual(row['types'][0]['count'], 3)

    def test_vehicle_by_violation_type(self):
        d = self.get()
        rows = {r['label']: r for r in d['vehicle_by_type']['rows']}
        self.assertEqual(rows['Motorcycles']['types'][0]['count'], 3)
        self.assertEqual(rows['Cars']['types'][0]['count'], 3)

    # ── aging (operational, active only) ────────────────────────────────
    def test_penalty_aging_uses_active_unpaid_only_and_ignores_period(self):
        d = self.get(period='today')
        b = {x['key']: x for x in d['penalty_aging']['buckets']}
        # unpaid on Mar 20: A1(74d) A2(74d) A4(72d) -> 61+ ; A5 (Mar 15 = 5d) -> 0-7
        self.assertEqual((b['0_7']['count'], b['8_30']['count'], b['31_60']['count'],
                          b['61_plus']['count']), (1, 0, 0, 3))
        self.assertEqual(d['penalty_aging']['total_count'], 4)
        self.assertEqual(d['penalty_aging']['total_amount'], 2000.0)
        self.assertEqual(b['61_plus']['amount'], 1500.0)

    # ── repeat offenders ────────────────────────────────────────────────
    def test_repeat_offender_rate_and_distribution(self):
        d = self.get()
        s = d['repeat_offender_stats']
        self.assertEqual(s['unique_violators'], 4)      # L1 L2 L3 L4 (blank excluded)
        self.assertEqual(s['repeat_violators'], 1)      # L1 = A1 + A2 + archived
        self.assertEqual(s['rate'], 25.0)
        dist = {x['bucket']: x['violators'] for x in s['distribution']}
        self.assertEqual(dist, {'2': 0, '3': 1, '4+': 0})
        self.assertEqual(d['repeat_offenders'][0]['license_number'], 'L1')
        self.assertEqual(d['repeat_offenders'][0]['count'], 3)

    # ── empty / unsupported ─────────────────────────────────────────────
    def test_empty_dataset_returns_zeroed_structures(self):
        d = self.get(period='today', location='Nowhere')
        self.assertEqual(d['total'], 0)
        self.assertEqual(len(d['peak_hours']), 24)
        self.assertEqual(d['repeat_offender_stats']['rate'], 0)
        self.assertEqual(d['hotspot_by_type']['rows'], [])

    def test_payment_duration_counts_only_paid_rows_with_both_dates(self):
        from violations.models import Assessment
        issued = at(3, 1, 9)
        paid = Violation.objects.create(
            violator_name='Paid Driver', license_number='PAY-1', plate_number='PAY1',
            ovr_number='PAY-1', vehicle_type='Cars', location='Perez Park',
            date_issued=issued, status='paid', enforcer=self.enforcer,
        )
        ViolationItem.objects.create(
            violation=paid, violation_type=self.no_helmet, penalty_amount_snapshot=500,
        )
        Assessment.objects.create(violation=paid, date_paid=datetime.date(2026, 3, 5), or_number='OR-PAY')
        unpaid = Violation.objects.create(
            violator_name='Unpaid Driver', license_number='PAY-2', plate_number='PAY2',
            ovr_number='PAY-2', vehicle_type='Cars', location='Perez Park',
            date_issued=issued, status='pending', enforcer=self.enforcer,
        )
        Assessment.objects.create(violation=unpaid, date_paid=datetime.date(2026, 3, 2))
        d = self.get(period='month')
        duration = d['payment_duration']
        self.assertEqual(duration['paid_count'], 1)
        self.assertEqual(duration['average_days'], 4.0)
        buckets = {b['key']: b['count'] for b in duration['buckets']}
        self.assertEqual(buckets['4_7'], 1)
        self.assertEqual(buckets['0_3'], 0)
        self.assertIn('total', d)
        self.assertIn('day_hour_heatmap', d)

    def test_resolution_time_documented_not_computed(self):
        d = self.get()
        self.assertEqual(d['unsupported_analytics'][0]['key'], 'resolution_time')
        self.assertNotIn('resolution_time', d)

    def test_legacy_keys_still_present(self):
        d = self.get()
        for k in ('total', 'total_penalty', 'total_collected', 'comparison', 'by_status',
                  'by_day', 'by_category', 'by_vehicle_type', 'most_common_vehicle_type',
                  'top_enforcers', 'hotspots', 'address_hotspots', 'common_violations',
                  'repeat_offenders', 'year_comparison', 'current_year', 'prev_year',
                  'available_years', 'period', 'collection_overview', 'map_points',
                  'filter_options', 'applied_filters'):
            self.assertIn(k, d)
        self.assertEqual(d['by_category'][0]['violation_type__name'], 'No Helmet')
        self.assertEqual(d['by_category'][0]['count'], 7)


from violations.test_analytics_window import bind_window_tests
bind_window_tests(AnalyticsAggregationTests)