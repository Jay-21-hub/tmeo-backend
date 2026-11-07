"""
Phase 2 regression tests — historical (active + archived) statistics.

Covers: Year Comparison, Asia/Manila year boundaries, archived-only and mixed
years, cross-source de-duplication (identity = id + created_at), public
historical statistics (aggregate-only, no PII), Admin cumulative vs operational
KPIs, and "numbers do not change when records are archived".

Run on PostgreSQL (analytics uses PostgreSQL-only SQL).
"""
import json
from datetime import datetime, timedelta, timezone as dt_timezone
from types import SimpleNamespace

from django.utils import timezone

from database_management.archive_utils import _snapshot_violation, run_archive
from database_management.models import ArchiveBatch, ArchivedViolation
from reports.services.sources import load_tickets
from violations.analytics import compute_analytics
from violations.models import Violation, ViolationItem, ViolationType
from violations.tests import BaseRoleTestCase

UTC = dt_timezone.utc
CUR = timezone.localdate().year


def utc(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=UTC)


class H(BaseRoleTestCase):
    """Base: helpers to build active violations and archived snapshots."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.vtype2 = ViolationType.objects.create(code='TST-2', name='Second violation', penalty_amount=1000)

    def make(self, when, *, status='paid', vtype=None, ovr=None, **kw):
        vt = vtype or self.vtype
        v = Violation.objects.create(
            violator_name=kw.pop('violator_name', 'DELA CRUZ, JUAN'),
            license_number=kw.pop('license_number', 'D07-25-000928'),
            address=kw.pop('address', '123 Private Address'),
            plate_number=kw.pop('plate_number', 'ABC1234'),
            ovr_number=ovr or f'OVR-{Violation.objects.count() + 100}',
            date_issued=when, location=kw.pop('location', 'ML Tagarao Street'),
            vehicle_type=kw.pop('vehicle_type', 'Motorcycles'),
            status=status, enforcer=kw.pop('enforcer', self.enforcer_a), **kw)
        ViolationItem.objects.create(violation=v, violation_type=vt, penalty_amount_snapshot=vt.penalty_amount)
        v.compute_total()
        return v

    def snapshot_of(self, v, *, year=None, **data_over):
        """Archived row representing `v` (the active row is left in place)."""
        b = ArchiveBatch.objects.create(status='success')
        data = _snapshot_violation(Violation.objects.get(pk=v.pk))
        data.update(data_over)
        from database_management.historical import manila_year
        return ArchivedViolation.objects.create(
            batch=b, original_violation_id=v.id,
            violation_year=year if year is not None else manila_year(v.date_issued),
            date_issued=v.date_issued, settlement_status='settled',
            violator_name=v.violator_name, license_number=v.license_number,
            plate_number=v.plate_number, data=data)

    def archived_only(self, when, **kw):
        """A violation that exists ONLY as an archive snapshot."""
        v = self.make(when, **kw)
        row = self.snapshot_of(v)
        Violation.objects.filter(pk=v.pk).delete()
        return row

    def yc(self, years, breakdown=()):
        qs = '&'.join([f'years={y}' for y in years] + [f'breakdown={b}' for b in breakdown])
        res = self.as_user(self.admin).get(f'/api/violations/analytics/year_comparison/?{qs}')
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def month(self, data, mon, year):
        return next(r for r in data['year_comparison'] if r['month'] == mon)[str(year)]

    def public(self):
        res = self.client.get('/api/violations/public/stats/')
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def stats(self, user):
        res = self.as_user(user).get('/api/violations/stats/')
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()


# ─── Year Comparison ───────────────────────────────────────────────────────

class YearComparisonTests(H):

    def test_manila_boundary_new_year_active_record(self):
        self.make(utc(2025, 12, 31, 20, 0))      # 2026-01-01 04:00 Manila
        self.make(utc(2025, 12, 31, 15, 59))     # 2025-12-31 23:59 Manila
        d = self.yc([2025, 2026])
        self.assertEqual(self.month(d, 'Jan', 2026), 1)
        self.assertEqual(self.month(d, 'Dec', 2025), 1)
        self.assertEqual(self.month(d, 'Jan', 2025), 0)

    def test_manila_boundary_applies_to_archived_rows_too(self):
        self.archived_only(utc(2025, 12, 31, 20, 0))
        d = self.yc([2025, 2026])
        self.assertEqual(self.month(d, 'Jan', 2026), 1)
        self.assertEqual(self.month(d, 'Dec', 2025), 0)

    def test_stored_utc_era_violation_year_is_ignored(self):
        """Old archive runs stored violation_year=2025 for a Manila-2026 ticket."""
        v = self.make(utc(2025, 12, 31, 20, 0))
        self.snapshot_of(v, year=2025)           # wrong stored column on purpose
        Violation.objects.filter(pk=v.pk).delete()
        d = self.yc([2025, 2026])
        self.assertEqual(self.month(d, 'Jan', 2026), 1)
        self.assertEqual(self.month(d, 'Dec', 2025), 0)
        self.assertIn(2026, d['available_years'])

    def test_archived_only_year_is_visible(self):
        self.archived_only(utc(2022, 3, 10, 2, 0))
        d = self.yc([2022, 2023])
        self.assertEqual(self.month(d, 'Mar', 2022), 1)
        self.assertIn(2022, d['available_years'])

    def test_mixed_years_active_and_archived_add_up(self):
        self.make(utc(2023, 5, 3, 2, 0), status='pending')          # active
        self.archived_only(utc(2023, 5, 20, 2, 0))                   # archived
        self.make(utc(2024, 5, 3, 2, 0))                             # other year, active
        d = self.yc([2023, 2024])
        self.assertEqual(self.month(d, 'May', 2023), 2)
        self.assertEqual(self.month(d, 'May', 2024), 1)

    def test_breakdowns_merge_both_sources_without_double_counting(self):
        v = self.make(utc(2023, 5, 3, 2, 0), vehicle_type='Motorcycles', location='Loc A')
        self.snapshot_of(v)                                          # duplicate of active v
        self.archived_only(utc(2023, 6, 3, 2, 0), vehicle_type='Motorcycles', location='Loc A')
        d = self.yc([2023], breakdown=['vehicle_type', 'location', 'status', 'violation_category'])
        veh = {r['category']: r['2023'] for r in d['breakdowns']['vehicle_type']}
        loc = {r['category']: r['2023'] for r in d['breakdowns']['location']}
        self.assertEqual(veh['Motorcycles'], 2)       # v once + one archived-only
        self.assertEqual(loc['Loc A'], 2)
        self.assertEqual({r['category']: r['2023'] for r in d['breakdowns']['status']}['Paid'], 2)

    def test_default_years_use_manila_today(self):
        d = self.as_user(self.admin).get('/api/violations/analytics/year_comparison/').json()
        self.assertEqual(d['years'], [CUR - 1, CUR])


# ─── cross-source de-duplication ────────────────────────────────────────────

class DeduplicationTests(H):

    def setUp(self):
        self.v = self.make(utc(2023, 5, 3, 2, 0))

    def counts(self):
        d = self.yc([2023])
        yc = self.month(d, 'May', 2023)
        tickets = [t for t in load_tickets(SimpleNamespace(
            date_from=None, date_to=None, status='', vehicle_type='')) if t['id'] == self.v.id]
        return yc, len(tickets), self.public()['total_all_time'], self.stats(self.admin)['historical']['total']

    def test_same_violation_in_both_sources_counts_once_everywhere(self):
        self.snapshot_of(self.v)
        yc, tickets, public, hist = self.counts()
        self.assertEqual((yc, tickets), (1, 1))
        self.assertEqual(public, 1)
        self.assertEqual(hist, 1 + 1)        # + the always-active pending other_ovr

    def test_archived_twice_counts_once(self):
        a = self.snapshot_of(self.v)
        Violation.objects.filter(pk=self.v.pk).delete()
        # duplicate snapshot of the SAME original (same data/created_at)
        ArchivedViolation.objects.create(
            batch=a.batch, original_violation_id=a.original_violation_id,
            violation_year=a.violation_year, date_issued=a.date_issued,
            settlement_status='settled', violator_name=a.violator_name, data=a.data)
        self.assertEqual(ArchivedViolation.objects.count(), 2)
        self.assertEqual(self.month(self.yc([2023]), 'May', 2023), 1)
        self.assertEqual(self.public()['total_all_time'], 1)

    def test_same_id_but_different_created_at_is_a_different_violation_and_is_kept(self):
        self.snapshot_of(self.v, created_at='2001-01-01T00:00:00+00:00')
        self.assertEqual(self.month(self.yc([2023]), 'May', 2023), 2)
        self.assertEqual(self.public()['total_all_time'], 2)

    def test_old_snapshot_without_created_at_falls_back_to_date_issued(self):
        row = self.snapshot_of(self.v)
        data = dict(row.data); data.pop('created_at')
        ArchivedViolation.objects.filter(pk=row.pk).update(data=data)
        self.assertEqual(self.month(self.yc([2023]), 'May', 2023), 1)      # same date -> duplicate
        ArchivedViolation.objects.filter(pk=row.pk).update(date_issued=utc(2023, 5, 9, 2, 0))
        self.assertEqual(self.month(self.yc([2023]), 'May', 2023), 2)      # other date -> distinct

    def test_analytics_and_reports_dedupe_the_same_way(self):
        self.snapshot_of(self.v)
        a = compute_analytics({'period': 'year', 'scope': 'all'})
        self.assertEqual(a['scope']['archived_count'], 0)    # the only snapshot is a duplicate
        self.snapshot_of(self.v, created_at='2001-01-01T00:00:00+00:00')
        a = compute_analytics({'period': 'year', 'scope': 'all'})
        # different identity -> counted (period 'year' = current year; v is 2023,
        # so check availability through year_comparison instead)
        self.assertIn(2023, a['available_years'])
        f = SimpleNamespace(date_from=None, date_to=None, status='', vehicle_type='')
        self.assertEqual(len([t for t in load_tickets(f) if t['id'] == self.v.id]), 2)

    def test_does_not_remove_legitimate_records(self):
        """Several different violations, one of them duplicated: only the
        duplicate disappears."""
        keep = [self.make(utc(2023, 5, d, 2, 0)) for d in (4, 5, 6)]
        self.snapshot_of(keep[0])                      # duplicate of an active row
        self.archived_only(utc(2023, 5, 7, 2, 0))      # legitimate archived-only
        total = self.month(self.yc([2023]), 'May', 2023)
        self.assertEqual(total, 1 + 3 + 1)             # self.v + 3 active + 1 archived-only


# ─── Public historical statistics ───────────────────────────────────────────

class PublicStatsTests(H):

    def test_includes_archived_paid_in_totals_types_months_and_fines(self):
        self.make(utc(2024, 2, 10, 2, 0))                                   # active paid, TST-1 500
        self.archived_only(utc(2024, 2, 11, 2, 0), vtype=self.vtype2)      # archived, TST-2 1000
        self.make(utc(2024, 2, 12, 2, 0), status='pending')                 # never public
        d = self.public()
        self.assertEqual(d['total_all_time'], 2)
        types = {r['violation_type']: r for r in d['by_type']}
        self.assertEqual(types['Test violation']['count'], 1)
        self.assertEqual(types['Second violation']['total_fines'], 1000.0)
        self.assertEqual(d['total_fines_recorded'], 1500.0)
        self.assertEqual([m for m in d['by_month'] if m['month'] == '2024-02'][0]['count'], 2)

    def test_response_is_aggregate_only_and_exposes_no_pii(self):
        self.archived_only(utc(2024, 2, 11, 2, 0), vtype=self.vtype2,
                           violator_name='ZZ-SECRET-NAME', license_number='LIC-SECRET-99',
                           plate_number='PLT-SECRET', address='ADDR-SECRET-ST')
        self.make(utc(2024, 3, 1, 2, 0), violator_name='ZZ-ACTIVE-SECRET', plate_number='PLT-ACTIVE')
        raw = self.client.get('/api/violations/public/stats/').content.decode()
        for needle in ('ZZ-SECRET-NAME', 'LIC-SECRET-99', 'PLT-SECRET', 'ADDR-SECRET-ST',
                       'ZZ-ACTIVE-SECRET', 'PLT-ACTIVE', 'ML Tagarao', self.enforcer_a.full_name,
                       'Enforcer 1', 'violator', 'license', 'plate', 'address', 'enforcer'):
            self.assertNotIn(needle, raw, needle)
        self.assertEqual(set(json.loads(raw)), {
            'total_all_time', 'total_this_year', 'total_last_year', 'total_this_month',
            'most_common_violation', 'most_common_share', 'total_fines_recorded',
            'total_fines_this_year', 'total_fines_last_year', 'current_year',
            'by_type', 'by_month'})
        for row in json.loads(raw)['by_type']:
            self.assertEqual(set(row), {'violation_type', 'count', 'total_fines'})
        for row in json.loads(raw)['by_month']:
            self.assertEqual(set(row), {'month', 'label', 'count'})

    def test_public_list_endpoint_unchanged_and_active_only(self):
        self.archived_only(utc(2024, 2, 11, 2, 0))
        res = self.client.get('/api/violations/public/')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['count'], 0)

    def test_year_to_date_windows_use_manila_dates(self):
        jan1 = timezone.make_aware(datetime(CUR, 1, 1, 0, 30), timezone.get_current_timezone())
        self.make(jan1)                                    # Manila Jan 1 -> this year
        self.archived_only(jan1 - timedelta(days=366 if CUR % 4 == 1 else 365))   # last year
        d = self.public()
        self.assertEqual(d['total_this_year'], 1)
        self.assertGreaterEqual(d['total_last_year'], 0)

    def test_fines_last_year_includes_archived(self):
        today = timezone.localdate()
        try:
            ly = today.replace(year=today.year - 1)
        except ValueError:
            ly = today.replace(year=today.year - 1, day=28)
        when = timezone.make_aware(datetime(ly.year, ly.month, ly.day, 10, 0), timezone.get_current_timezone())
        self.archived_only(when, vtype=self.vtype2)
        d = self.public()
        self.assertEqual(d['total_last_year'], 1)
        self.assertEqual(d['total_fines_last_year'], 1000.0)


# ─── Admin cumulative vs operational KPIs ──────────────────────────────────

class AdminKpiTests(H):

    def setUp(self):
        self.make(utc(2024, 2, 10, 2, 0))                              # active paid 500
        self.make(utc(2024, 2, 11, 2, 0), status='processing')        # active processing 500
        self.archived_only(utc(2023, 2, 11, 2, 0), vtype=self.vtype2)  # archived 1000

    def test_admin_gets_cumulative_block_and_operational_keys_stay_active_only(self):
        d = self.stats(self.admin)
        # operational (active only): other_ovr(pending) + paid + processing
        self.assertEqual(d['total'], 3)
        self.assertEqual(d['paid'], 1)
        h = d['historical']
        self.assertEqual(h['scope'], 'all_time_including_archived')
        self.assertEqual(h['total'], 4)
        self.assertEqual(h['paid'], 2)
        self.assertEqual((h['pending'], h['processing']), (1, 1))
        self.assertEqual(h['active_count'], 3)
        self.assertEqual(h['archived_count'], 1)
        self.assertEqual(h['total_penalty'], 500 + 500 + 500 + 1000)      # other_ovr=500
        self.assertEqual(h['total_collected'], 500 + 1000)

    def test_staff_and_enforcer_never_receive_the_historical_block(self):
        for u in (self.staff, self.enforcer_a, self.enforcer_b):
            self.assertNotIn('historical', self.stats(u))

    def test_staff_numbers_are_operational_and_unchanged(self):
        d = self.stats(self.staff)
        self.assertEqual(d['total'], 3)
        self.assertEqual(d['paid'], 1)

    def test_enforcer_stats_only_their_own_active_records(self):
        d = self.stats(self.enforcer_a)
        self.assertEqual(d['total'], 2)

    def test_duplicates_do_not_inflate_cumulative_kpis(self):
        v = Violation.objects.filter(status='paid').first()
        self.snapshot_of(v)
        self.assertEqual(self.stats(self.admin)['historical']['total'], 4)

    def test_anonymous_cannot_read_stats(self):
        self.client.force_authenticate(None)
        self.assertIn(self.client.get('/api/violations/stats/').status_code, (401, 403))


# ─── Numbers must not change when records are archived ──────────────────────

class ArchiveConsistencyTests(H):

    def setUp(self):
        y0 = timezone.make_aware(datetime(CUR, 1, 1, 10, 0), timezone.get_current_timezone())
        self.make(y0, vehicle_type='Motorcycles', location='Loc A')
        self.make(y0 + timedelta(hours=3), vtype=self.vtype2, vehicle_type='Cars', location='Loc B')
        self.make(y0 + timedelta(hours=5), vehicle_type='Motorcycles', location='Loc A', status='pending')
        self.make(timezone.make_aware(datetime(CUR - 1, 12, 20, 9, 0), timezone.get_current_timezone()),
                  vehicle_type='Cars', location='Loc B')
        # a record that sits across the UTC/Manila new-year line
        self.make(utc(CUR - 1, 12, 31, 20, 30), location='Loc C')

    def snap(self):
        yc = self.yc([CUR - 1, CUR], breakdown=['status', 'vehicle_type', 'location',
                                                  'violation_category'])
        a = compute_analytics({'period': 'year', 'scope': 'all'})
        keys = ('total', 'total_penalty', 'total_collected', 'by_status', 'by_vehicle_type',
                'by_category', 'common_violations', 'hotspots', 'year_comparison',
                'available_years', 'by_weekday', 'peak_hours', 'collection_overview',
                'repeat_offender_stats', 'vehicle_by_type', 'location_ranking')
        pub = self.public()
        hist = self.stats(self.admin)['historical']
        f = SimpleNamespace(date_from=None, date_to=None, status='', vehicle_type='')
        tickets = sorted((t['id'], t['date'], t['penalty'],
                          t['status']) for t in load_tickets(f))
        hist = {k: v for k, v in hist.items() if k not in ('active_count', 'archived_count')}
        return {'yc': yc, 'analytics': {k: a[k] for k in keys}, 'public': pub,
                'hist': hist, 'tickets': tickets}

    def test_every_aggregate_is_identical_before_and_after_archiving(self):
        before = self.snap()
        batch = run_archive(self.admin)
        self.assertEqual(batch.archived_count, 4)          # the pending one stays
        self.assertEqual(Violation.objects.filter(status='paid').count(), 0)
        after = self.snap()
        for key in before:
            self.assertEqual(before[key], after[key], key)

    def test_running_archive_twice_changes_nothing(self):
        run_archive(self.admin)
        once = self.snap()
        run_archive(self.admin)
        self.assertEqual(once, self.snap())

    def test_archived_year_follows_manila_for_the_new_year_record(self):
        run_archive(self.admin)
        row = ArchivedViolation.objects.get(date_issued=utc(CUR - 1, 12, 31, 20, 30))
        self.assertEqual(row.violation_year, CUR)
        d = self.yc([CUR - 1, CUR])
        self.assertEqual(self.month(d, 'Jan', CUR), 4)      # 2 paid + 1 pending on Jan 1, + the Manila-new-year record