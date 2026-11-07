"""
Checkpoint 2 - archive browsing + exports: Asia/Manila year/month and
consistent de-duplication.

Run on PostgreSQL:
    python manage.py test database_management.test_archive_period --settings=<postgres settings>

Rules under test (no stored data is ever repaired or rewritten):
  * YEAR / MONTH come from ``date_issued`` in Asia/Manila - never from the stored
    ``ArchivedViolation.violation_year`` column (UTC-era in older rows).
  * Browsing, the month list, the year list, the pre-export count, the XLSX
    export and the PDF payload all use the SAME filter + the SAME duplicate
    removal, so their counts can never disagree.
  * Existing API shape, permissions and export layouts are unchanged.
"""
import io
from datetime import datetime, timezone as dt_timezone

import openpyxl
from django.utils import timezone

from database_management.archive_utils import _snapshot_violation
from database_management.export_utils import (
    build_archived_export_workbook, build_archived_pdf_payload, get_archived_export_columns,
)
from database_management.historical import (
    archived_in_period, archived_years, deduped_archived, manila_period_bounds,
)
from database_management.models import ArchiveBatch, ArchivedViolation
from violations.models import Violation
from violations.tests import BaseRoleTestCase

UTC = dt_timezone.utc


def utc(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=UTC)


class PeriodBase(BaseRoleTestCase):

    def setUp(self):
        Violation.objects.all().delete()          # BaseRoleTestCase files one extra ticket
        self.batch = ArchiveBatch.objects.create(status='success')
        self._oid = 1000

    def arch(self, when, *, settlement='settled', name='JUAN DELA CRUZ', stored_year=None,
             oid=None, created=None, **data):
        """An archived-ONLY snapshot.  The stored violation_year defaults to the
        UTC year of the instant - exactly what older archive runs wrote."""
        if oid is None:
            self._oid += 1
            oid = self._oid
        created = created or when
        payload = {'created_at': created.isoformat(), 'location': 'Somewhere', 'items': [],
                   'status': 'Paid'}
        payload.update(data)
        return ArchivedViolation.objects.create(
            batch=self.batch, original_violation_id=oid,
            violation_year=when.year if stored_year is None else stored_year,
            date_issued=when, settlement_status=settlement, violator_name=name,
            license_number=f'L-{oid}', plate_number=f'PL{oid}', data=payload)

    def snapshot_of_active(self, when, ovr):
        """Active ticket + a snapshot of it (the 'duplicate' case)."""
        v = self._make_violation(self.enforcer_a, ovr, date_issued=when)
        row = ArchivedViolation.objects.create(
            batch=self.batch, original_violation_id=v.id, violation_year=when.year,
            date_issued=v.date_issued, settlement_status='settled', violator_name='A',
            license_number='L', plate_number='P', data=_snapshot_violation(v))
        return v, row

    def api(self, user, path, **params):
        return self.as_user(user).get(f'/api/database/archive/{path}', params)

    def records(self, **params):
        res = self.api(self.admin, 'records/', **params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def ids(self, **params):
        return [r['id'] for r in self.records(**params)['results']]


# --- helpers ------------------------------------------------------------------

class PeriodHelperTests(PeriodBase):

    def test_manila_period_bounds_are_half_open_and_manila_aligned(self):
        lo, hi = manila_period_bounds(2026)
        self.assertEqual((lo, hi), (utc(2025, 12, 31, 16), utc(2026, 12, 31, 16)))
        lo, hi = manila_period_bounds(2026, 12)
        self.assertEqual((lo, hi), (utc(2026, 11, 30, 16), utc(2026, 12, 31, 16)))
        lo, hi = manila_period_bounds(2026, 1)
        self.assertEqual((lo, hi), (utc(2025, 12, 31, 16), utc(2026, 1, 31, 16)))

    def test_year_end_instants(self):
        a = self.arch(utc(2025, 12, 31, 15, 59))     # 2025-12-31 23:59 Manila
        b = self.arch(utc(2025, 12, 31, 16, 0))      # 2026-01-01 00:00 Manila
        self.assertEqual(list(archived_in_period(ArchivedViolation.objects.all(), year=2025)), [a])
        self.assertEqual(list(archived_in_period(ArchivedViolation.objects.all(), year=2026)), [b])

    def test_no_filter_returns_everything_and_month_only_matches_any_year(self):
        self.arch(utc(2024, 3, 10, 2)); self.arch(utc(2025, 3, 10, 2)); self.arch(utc(2025, 4, 10, 2))
        qs = ArchivedViolation.objects.all()
        self.assertEqual(archived_in_period(qs).count(), 3)
        self.assertEqual(archived_in_period(qs, month=3).count(), 2)


# --- years ------------------------------------------------------------------------

class YearsTests(PeriodBase):

    def test_years_are_manila_derived_and_ignore_the_stored_column(self):
        # stored 2025 (UTC-era), Manila 2026  -> year 2026 only
        self.arch(utc(2025, 12, 31, 20, 0), stored_year=2025)
        self.arch(utc(2023, 6, 1, 2, 0))
        res = self.api(self.admin, 'years/')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {'years': [2026, 2023]})

    def test_distinct_and_newest_first(self):
        for d in (utc(2022, 1, 5, 2), utc(2022, 7, 5, 2), utc(2024, 1, 5, 2), utc(2020, 1, 5, 2)):
            self.arch(d)
        self.assertEqual(self.api(self.admin, 'years/').json()['years'], [2024, 2022, 2020])

    def test_a_year_that_only_has_a_duplicate_is_not_listed(self):
        self.snapshot_of_active(utc(2019, 5, 5, 2), 'OVR-DUP')           # active wins -> snapshot excluded
        self.arch(utc(2023, 5, 5, 2))
        self.assertEqual(archived_years(), [2023])

    def test_empty_archive(self):
        self.assertEqual(self.api(self.admin, 'years/').json(), {'years': []})

    def test_permissions(self):
        self.assertEqual(self.api(self.staff, 'years/').status_code, 200)
        self.assertEqual(self.api(self.enforcer_a, 'years/').status_code, 403)
        self.client.force_authenticate(None)
        self.assertIn(self.client.get('/api/database/archive/years/').status_code, (401, 403))


# --- months ------------------------------------------------------------------------

class MonthsTests(PeriodBase):

    def months(self, year, user=None):
        res = self.api(user or self.admin, 'months/', year=year)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_grouped_by_manila_month_with_status_counts(self):
        self.arch(utc(2026, 1, 31, 16, 30), settlement='settled')         # Feb 1 00:30 Manila
        self.arch(utc(2026, 1, 31, 15, 30), settlement='unsettled')       # Jan 31 23:30 Manila
        self.arch(utc(2026, 2, 10, 2, 0), settlement='unsettled')
        got = {m['month']: m for m in self.months(2026)['months']}
        self.assertEqual(set(got), {1, 2})
        self.assertEqual((got[1]['total'], got[1]['settled'], got[1]['unsettled']), (1, 0, 1))
        self.assertEqual((got[2]['total'], got[2]['settled'], got[2]['unsettled']), (2, 1, 1))

    def test_year_is_manila_year_and_response_year_is_an_integer(self):
        self.arch(utc(2025, 12, 31, 20, 0), stored_year=2025)             # Manila Jan 1 2026
        d = self.months(2026)
        self.assertEqual(d['year'], 2026)
        self.assertEqual([m['month'] for m in d['months']], [1])
        self.assertEqual(self.months(2025)['months'], [])

    def test_zero_months_are_absent_and_sorted(self):
        self.arch(utc(2026, 9, 1, 2)); self.arch(utc(2026, 3, 1, 2))
        self.assertEqual([m['month'] for m in self.months(2026)['months']], [3, 9])

    def test_duplicates_excluded(self):
        self.snapshot_of_active(utc(2026, 4, 4, 2), 'OVR-D')
        self.arch(utc(2026, 4, 5, 2))
        self.assertEqual(self.months(2026)['months'][0]['total'], 1)

    def test_validation(self):
        for params in ({}, {'year': ''}, {'year': 'abc'}, {'year': '20.5'}, {'year': 1800}, {'year': 9999}):
            res = self.api(self.admin, 'months/', **params)
            self.assertEqual(res.status_code, 400, params)

    def test_staff_allowed_enforcer_refused(self):
        self.assertEqual(self.api(self.staff, 'months/', year=2026).status_code, 200)
        self.assertEqual(self.api(self.enforcer_a, 'months/', year=2026).status_code, 403)


# --- records -----------------------------------------------------------------------

class RecordsTests(PeriodBase):

    def test_year_filter_uses_manila_year_not_the_stored_column(self):
        r26 = self.arch(utc(2025, 12, 31, 20, 0), stored_year=2025)       # Manila 2026
        r25 = self.arch(utc(2025, 12, 31, 10, 0), stored_year=2026)       # Manila 2025 (stored lies)
        self.assertEqual(self.ids(year=2026), [r26.id])
        self.assertEqual(self.ids(year=2025), [r25.id])

    def test_api_reports_the_manila_year_and_the_stored_column_is_untouched(self):
        row = self.arch(utc(2025, 12, 31, 20, 0), stored_year=2025)
        item = self.records()['results'][0]
        self.assertEqual(item['violation_year'], 2026)
        row.refresh_from_db()
        self.assertEqual(row.violation_year, 2025)                        # NOT repaired

    def test_year_and_month_combined_and_month_alone(self):
        a = self.arch(utc(2026, 1, 31, 16, 30))                           # Feb 1 Manila
        self.arch(utc(2026, 1, 31, 15, 30))                               # Jan 31 Manila
        c = self.arch(utc(2025, 2, 10, 2, 0))
        self.assertEqual(self.ids(year=2026, month=2), [a.id])
        self.assertEqual(sorted(self.ids(month=2)), sorted([a.id, c.id]))

    def test_month_boundaries_inside_the_same_year(self):
        feb = self.arch(utc(2026, 2, 28, 16, 0))                          # Mar 1 00:00 Manila
        mar = self.ids(year=2026, month=3)
        self.assertEqual(mar, [feb.id])
        self.assertEqual(self.ids(year=2026, month=2), [])

    def test_validation_returns_400_not_a_database_error(self):
        for params in ({'year': 'abc'}, {'year': '2026.5'}, {'year': 1800}, {'year': 2300},
                       {'month': 0}, {'month': 13}, {'month': 'x'}, {'year': 2026, 'month': 99}):
            self.assertEqual(self.api(self.admin, 'records/', **params).status_code, 400, params)

    def test_blank_params_are_ignored(self):
        r = self.arch(utc(2026, 5, 5, 2))
        self.assertEqual(self.ids(year='', month=''), [r.id])

    def test_duplicates_removed(self):
        v, snap = self.snapshot_of_active(utc(2026, 5, 5, 2), 'OVR-A')   # active wins
        two = self.arch(utc(2024, 5, 5, 2), oid=555, created=utc(2024, 5, 5, 2))
        three = self.arch(utc(2024, 5, 5, 2), oid=555, created=utc(2024, 5, 5, 2))   # same identity
        ids = self.ids()
        self.assertNotIn(snap.id, ids)
        self.assertIn(two.id, ids); self.assertNotIn(three.id, ids)      # first (lowest pk) wins
        self.assertEqual(self.records()['count'], 1)

    def test_same_id_different_created_at_are_different_violations(self):
        a = self.arch(utc(2024, 5, 5, 2), oid=777, created=utc(2024, 5, 5, 2))
        b = self.arch(utc(2025, 5, 5, 2), oid=777, created=utc(2025, 5, 5, 2))
        self.assertEqual(sorted(self.ids()), sorted([a.id, b.id]))

    def test_newest_violation_first_with_stable_ties(self):
        old = self.arch(utc(2020, 1, 1, 2)); new = self.arch(utc(2026, 1, 1, 2))
        tie1 = self.arch(utc(2022, 1, 1, 2)); tie2 = self.arch(utc(2022, 1, 1, 2))
        self.assertEqual(self.ids(), [new.id, tie2.id, tie1.id, old.id])

    def test_settlement_and_search_combine_with_the_period(self):
        a = self.arch(utc(2026, 5, 5, 2), settlement='unsettled', name='MARIA CLARA')
        self.arch(utc(2026, 5, 6, 2), settlement='settled', name='MARIA CLARA')
        self.arch(utc(2025, 5, 6, 2), settlement='unsettled', name='MARIA CLARA')
        self.assertEqual(self.ids(year=2026, settlement_status='unsettled', search='maria'), [a.id])

    def test_pagination_count_equals_the_deduplicated_total(self):
        for i in range(7):
            self.arch(utc(2026, 1, 1 + i, 2))
        self.snapshot_of_active(utc(2026, 2, 2, 2), 'OVR-Z')
        d = self.records(page_size=3)
        self.assertEqual((d['count'], len(d['results'])), (7, 3))

    def test_response_shape_is_unchanged(self):
        self.arch(utc(2026, 1, 1, 2))
        d = self.records()
        self.assertEqual({'count', 'next', 'previous', 'results'} <= set(d), True)
        self.assertEqual(
            set(d['results'][0]),
            {'id', 'original_violation_id', 'violation_year', 'date_issued', 'settlement_status',
             'settled_at', 'violator_name', 'license_number', 'plate_number', 'data',
             'archived_at', 'batch', 'evidence'})

    def test_permissions(self):
        self.assertEqual(self.api(self.staff, 'records/').status_code, 200)
        self.assertEqual(self.api(self.enforcer_a, 'records/').status_code, 403)

    def test_query_count_is_flat_with_evidence_prefetch(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext
        for i in range(3):
            self.arch(utc(2026, 1, 1 + i, 2))
        with CaptureQueriesContext(connection) as small:
            self.api(self.admin, 'records/')
        for i in range(20):
            self.arch(utc(2025, 1, 1 + i, 2))
        with CaptureQueriesContext(connection) as big:
            self.api(self.admin, 'records/')
        self.assertEqual(len(small), len(big))


# --- export consistency -----------------------------------------------------------

class ExportConsistencyTests(PeriodBase):

    def dataset(self):
        self.arch(utc(2025, 12, 31, 20, 0), stored_year=2025)             # Manila 2026
        self.arch(utc(2026, 6, 1, 2, 0))
        self.arch(utc(2025, 12, 31, 10, 0), stored_year=2026)             # Manila 2025
        self.arch(utc(2024, 6, 1, 2, 0), oid=900, created=utc(2024, 6, 1, 2, 0))
        self.arch(utc(2024, 6, 1, 2, 0), oid=900, created=utc(2024, 6, 1, 2, 0))   # duplicate
        self.snapshot_of_active(utc(2026, 7, 7, 2), 'OVR-ACT')                       # duplicate of active

    def counts(self, year):
        params = {} if year is None else {'year': year}
        info = self.api(self.admin, 'export/fields/', **params)
        self.assertEqual(info.status_code, 200, info.content)
        wb, n = build_archived_export_workbook(year=year)
        ws = wb.active
        rows = sum(1 for _ in ws.iter_rows(min_row=2, values_only=True))
        payload = build_archived_pdf_payload(year=year)
        browse = self.records(**params)['count']
        xlsx = self.api(self.admin, 'export/', **params)
        self.assertEqual(xlsx.status_code, 200)
        sheet = openpyxl.load_workbook(io.BytesIO(xlsx.content)).active
        xlsx_rows = sum(1 for _ in sheet.iter_rows(min_row=2, values_only=True))
        pdf = self.api(self.admin, 'export/pdf-data/', **params)
        self.assertEqual(pdf.status_code, 200)
        return {
            'info': info.json()['archived_record_count'], 'builder': n, 'sheet_rows': rows,
            'payload': payload['record_count'], 'payload_records': len(payload['records']),
            'browse': browse, 'xlsx_endpoint_rows': xlsx_rows,
            'pdf_endpoint': pdf.json()['record_count'],
        }

    def assertAllEqual(self, got, expected):
        self.assertEqual(set(got.values()), {expected}, got)

    def test_every_surface_agrees_for_each_year_and_for_all(self):
        self.dataset()
        self.assertAllEqual(self.counts(2026), 2)          # Manila 2026: two archived-only (dup of active dropped)
        self.assertAllEqual(self.counts(2025), 1)
        self.assertAllEqual(self.counts(2024), 1)          # duplicate pair -> one
        self.assertAllEqual(self.counts(None), 4)

    def test_info_reports_manila_year_and_an_int_year(self):
        self.dataset()
        d = self.api(self.admin, 'export/fields/', year=2026).json()
        self.assertEqual((d['year'], d['archived_record_count']), (2026, 2))
        self.assertIsNone(self.api(self.admin, 'export/fields/').json()['year'])

    def test_invalid_year_is_a_400_on_all_three_export_endpoints(self):
        for path in ('export/fields/', 'export/', 'export/pdf-data/'):
            for bad in ('abc', '1800', '9999', '2026.5'):
                self.assertEqual(self.api(self.admin, path, year=bad).status_code, 400, (path, bad))

    def test_exports_are_admin_only(self):
        for path in ('export/fields/', 'export/', 'export/pdf-data/'):
            self.assertEqual(self.api(self.staff, path).status_code, 403, path)
            self.assertEqual(self.api(self.enforcer_a, path).status_code, 403, path)

    def test_newest_violation_first_in_the_export(self):
        self.arch(utc(2020, 1, 1, 2)); self.arch(utc(2026, 1, 1, 2))
        created = [r.get('created_at') for r in build_archived_pdf_payload()['records']]
        self.assertEqual(created[:2], ['2026-01-01 10:00:00', '2020-01-01 10:00:00'])   # Manila local
        wb, _ = build_archived_export_workbook()
        col = [c['key'] for c in build_archived_pdf_payload()['columns']].index('created_at') + 1
        self.assertEqual([wb.active.cell(row=r, column=col).value for r in (2, 3)], created[:2])

    def test_layouts_are_unchanged(self):
        """Same columns, same order, same payload keys as before Checkpoint 2."""
        self.arch(utc(2026, 1, 1, 2))
        columns = get_archived_export_columns()
        payload = build_archived_pdf_payload(year=2026)
        self.assertEqual(set(payload), {'columns', 'records', 'record_count'})
        self.assertEqual(payload['columns'], [{'key': k, 'label': l} for k, l in columns])
        wb, _ = build_archived_export_workbook(year=2026)
        ws = wb.active
        self.assertEqual([c.value for c in ws[1]], [label for _k, label in columns])
        self.assertEqual(ws.title, 'Archived 2026')
        self.assertEqual(build_archived_export_workbook()[0].active.title, 'Archived Records Export')

    def test_exports_are_read_only(self):
        self.dataset()
        before = (ArchivedViolation.objects.count(), Violation.objects.count(),
                  list(ArchivedViolation.objects.values_list('id', 'violation_year')))
        build_archived_export_workbook(year=2026); build_archived_pdf_payload(year=2026)
        self.api(self.admin, 'export/', year=2026); self.api(self.admin, 'export/fields/', year=2026)
        self.assertEqual(before, (ArchivedViolation.objects.count(), Violation.objects.count(),
                                  list(ArchivedViolation.objects.values_list('id', 'violation_year'))))

    def test_deduped_archived_helper_is_what_all_surfaces_use(self):
        self.dataset()
        self.assertEqual(deduped_archived().count(), 4)