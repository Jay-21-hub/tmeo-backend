"""
Checkpoint 2 - Admin Dashboard HISTORICAL panels (active + archived).

Run on PostgreSQL (the shared analytics helpers use PostgreSQL-only SQL):
    python manage.py test violations.test_historical_dashboard --settings=<postgres settings>

Covers violations.historical_dashboard and its wiring into
GET /api/violations/stats/ (Admin only, additive keys inside ``historical``):
  * scope + labels (Cumulative / This month, "includes archived")
  * archived rows are counted; duplicates are counted ONCE
  * Asia/Manila month boundaries (UTC instants that fall in another Manila day)
  * enforcer identity: stable id, name fallback only when unambiguous,
    never ranking a ticket that has no enforcer
  * hist_period is optional, validated and backward compatible
  * permissions / existing top-level keys unchanged
  * the SQL aggregation equals the original Python path; query count does not
    grow with the size of the archive
"""
import datetime
from collections import Counter

from django.db import connection
from django.test.utils import CaptureQueriesContext

from accounts.identity import snapshot_fields
from accounts.models import CustomUser
from database_management.models import ArchivedViolation
from violations import historical_dashboard as hd
from violations import test_archive_consistency as tac
from violations.analytics import _item_cells, _source_querysets, _with_location_cols
from violations.models import Violation, ViolationItem, ViolationType

utc = tac.utc
TODAY = datetime.date(2026, 10, 10)            # fixed "today" (Asia/Manila date)


class HD(tac.H):
    """Clean slate: BaseRoleTestCase files one extra ticket (other_ovr)."""

    def setUp(self):
        Violation.objects.all().delete()

    def get_stats(self, user, **params):
        res = self.as_user(user).get('/api/violations/stats/', params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def hist(self, **params):
        return self.get_stats(self.admin, **params)['historical']

    def legacy_snapshot(self, v, name, **over):
        """Archived row written BEFORE Phase 3: no stable id, no event snapshot."""
        data = dict(enforcer_user_id=None, enforcer_name=name, enforcer_name_snapshot=None,
                    enforcer_badge_snapshot=None, enforcer_snapshot_source='assumed')
        data.update(over)
        return self.snapshot_of(v, **data)

    def archive_away(self, when, **kw):
        return self.archived_only(when, **kw)

    @staticmethod
    def as_map(rows, key='name', val='count'):
        return {r[key]: r[val] for r in rows}


# --- Violations by Type -------------------------------------------------------

class TypePanelTests(HD):

    def test_all_time_and_includes_archived(self):
        self.make(utc(2019, 1, 5, 2))                                  # active, old
        self.make(utc(2024, 6, 5, 2))                                  # active
        self.archive_away(utc(2021, 3, 3, 2), vtype=self.vtype2)       # archived only
        self.archive_away(utc(2021, 3, 4, 2), vtype=self.vtype2)
        got = self.as_map(hd.violations_by_type())
        self.assertEqual(got, {'Test violation': 2, 'Second violation': 2})

    def test_unit_is_violation_items_not_tickets(self):
        v = self.make(utc(2024, 1, 2, 2))
        ViolationItem.objects.create(violation=v, violation_type=self.vtype2,
                                     penalty_amount_snapshot=self.vtype2.penalty_amount)
        a = self.make(utc(2022, 1, 2, 2))
        ViolationItem.objects.create(violation=a, violation_type=self.vtype2,
                                     penalty_amount_snapshot=self.vtype2.penalty_amount)
        self.snapshot_of(a)
        Violation.objects.filter(pk=a.pk).delete()
        self.assertEqual(self.as_map(hd.violations_by_type()),
                         {'Test violation': 2, 'Second violation': 2})

    def test_top_five_then_other_and_deterministic_order(self):
        types = [ViolationType.objects.create(code=f'X{i}', name=f'Type {i}', penalty_amount=100)
                 for i in range(7)]
        for i, vt in enumerate(types):
            for _ in range(i + 1):                       # 1 .. 7 items
                self.make(utc(2024, 1, 1 + i, 2), vtype=vt)
        out = hd.violations_by_type()
        self.assertEqual([r['name'] for r in out],
                         ['Type 6', 'Type 5', 'Type 4', 'Type 3', 'Type 2', 'Other'])
        self.assertEqual(out[-1]['count'], 1 + 2)
        self.assertEqual(sum(r['count'] for r in out), sum(range(1, 8)))

    def test_ties_break_alphabetically(self):
        self.make(utc(2024, 1, 1, 2), vtype=self.vtype2)
        self.make(utc(2024, 1, 2, 2), vtype=self.vtype)
        self.assertEqual([r['name'] for r in hd.violations_by_type()],
                         ['Second violation', 'Test violation'])

    def test_duplicate_snapshot_of_an_active_ticket_counts_once(self):
        v = self.make(utc(2024, 1, 2, 2))
        self.snapshot_of(v)                              # same identity, still active
        self.assertEqual(self.as_map(hd.violations_by_type()), {'Test violation': 1})

    def test_two_snapshots_of_one_archived_ticket_count_once(self):
        v = self.make(utc(2022, 1, 2, 2))
        self.snapshot_of(v)
        self.snapshot_of(v)
        Violation.objects.filter(pk=v.pk).delete()
        self.assertEqual(self.as_map(hd.violations_by_type()), {'Test violation': 1})

    def test_malformed_archived_items_never_crash_and_blank_name_is_unknown(self):
        a = self.archive_away(utc(2022, 1, 2, 2))
        b = self.archive_away(utc(2022, 1, 3, 2))
        c = self.archive_away(utc(2022, 1, 4, 2))
        d = self.archive_away(utc(2022, 1, 5, 2))
        ArchivedViolation.objects.filter(pk=a.pk).update(
            data={**a.data, 'items': [{'code': 'Z', 'name': ''}, {'code': 'Y'}, 'junk', 7, None]})
        ArchivedViolation.objects.filter(pk=b.pk).update(data={**b.data, 'items': None})
        ArchivedViolation.objects.filter(pk=c.pk).update(data={**c.data, 'items': 'not a list'})
        data_d = dict(d.data); data_d.pop('items', None)
        ArchivedViolation.objects.filter(pk=d.pk).update(data=data_d)
        self.assertEqual(self.as_map(hd.violations_by_type()), {'Unknown': 2})

    def test_sql_aggregation_equals_the_original_python_path(self):
        self.make(utc(2024, 1, 2, 2))
        self.make(utc(2024, 2, 2, 2), vtype=self.vtype2)
        both = self.make(utc(2023, 2, 2, 2))
        ViolationItem.objects.create(violation=both, violation_type=self.vtype2,
                                     penalty_amount_snapshot=1000)
        self.snapshot_of(both)                           # duplicate -> must not double count
        self.archive_away(utc(2021, 5, 2, 2), vtype=self.vtype2)
        self.archive_away(utc(2020, 5, 2, 2))
        reference = Counter()
        for kind, base in _source_querysets('all'):
            for cell in _item_cells(kind, _with_location_cols(base)):
                reference[cell['name'] or 'Unknown'] += cell['count']
        self.assertEqual(self.as_map(hd.violations_by_type()), dict(reference))


# --- Top Locations ------------------------------------------------------------

class LocationPanelTests(HD):

    def test_all_time_active_plus_archived_unit_is_tickets(self):
        self.make(utc(2019, 1, 5, 2), location='Pagbilao Road')
        self.make(utc(2024, 1, 5, 2), location='Pagbilao Road')
        self.archive_away(utc(2021, 1, 5, 2), location='Pagbilao Road')
        self.archive_away(utc(2021, 1, 6, 2), location='Ibabang Dupay')
        multi = self.make(utc(2024, 3, 5, 2), location='Ibabang Dupay')
        ViolationItem.objects.create(violation=multi, violation_type=self.vtype2,
                                     penalty_amount_snapshot=1000)      # 2 items, still 1 ticket
        got = {r['area']: r['count'] for r in hd.top_locations()}
        self.assertEqual(got, {'Pagbilao Road': 3, 'Ibabang Dupay': 2})
        self.assertTrue(all(r['trend'] is None for r in hd.top_locations()))

    def test_spelling_case_and_whitespace_are_merged_most_common_spelling_wins(self):
        self.make(utc(2024, 1, 1, 2), location='  ML   Tagarao  Street ')
        self.make(utc(2024, 1, 2, 2), location='ML Tagarao Street')
        self.make(utc(2024, 1, 3, 2), location='ML Tagarao Street')
        self.archive_away(utc(2021, 1, 4, 2), location='ml tagarao street')
        rows = hd.top_locations()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0], {'area': 'ML Tagarao Street', 'count': 4, 'trend': None})

    def test_blank_and_punctuation_only_locations_are_ignored(self):
        self.make(utc(2024, 1, 1, 2), location='   ')
        self.make(utc(2024, 1, 2, 2), location='---')
        self.make(utc(2024, 1, 3, 2), location='Real Place')
        self.archive_away(utc(2021, 1, 4, 2), location='')
        self.assertEqual(hd.top_locations(), [{'area': 'Real Place', 'count': 1, 'trend': None}])

    def test_top_five_and_deterministic_ties(self):
        for i, name in enumerate(['G', 'F', 'E', 'D', 'C', 'B', 'A']):
            self.make(utc(2024, 1, 1 + i, 2), location=f'Place {name}')
        self.assertEqual([r['area'] for r in hd.top_locations()],
                         ['Place A', 'Place B', 'Place C', 'Place D', 'Place E'])

    def test_duplicates_counted_once(self):
        v = self.make(utc(2024, 1, 2, 2), location='Dup Street')
        self.snapshot_of(v)
        self.snapshot_of(v)
        self.assertEqual(hd.top_locations(), [{'area': 'Dup Street', 'count': 1, 'trend': None}])


# --- Top Enforcers (this month, Manila) ------------------------------------------

class EnforcerPanelTests(HD):

    def rank(self, period='month', today=TODAY):
        return hd.top_enforcers(period, today)

    def test_manila_month_boundaries(self):
        # 2026-09-30 16:30 UTC = 2026-10-01 00:30 Manila  -> IN October
        self.make(utc(2026, 9, 30, 16, 30), enforcer=self.enforcer_a)
        # 2026-09-30 15:59 UTC = 2026-09-30 23:59 Manila  -> September
        self.make(utc(2026, 9, 30, 15, 59), enforcer=self.enforcer_a)
        # 2026-10-10 16:59 UTC = 2026-10-11 00:59 Manila  -> after "today"
        self.make(utc(2026, 10, 10, 16, 59), enforcer=self.enforcer_a)
        # 2026-10-10 15:59 UTC = 2026-10-10 23:59 Manila  -> last included minute
        self.make(utc(2026, 10, 10, 15, 59), enforcer=self.enforcer_a)
        rows = self.rank()
        self.assertEqual([(r['id'], r['tickets']) for r in rows], [(self.enforcer_a.id, 2)])

    def test_archived_tickets_count_and_merge_with_the_active_person(self):
        self.make(utc(2026, 10, 2, 2), enforcer=self.enforcer_a)
        self.archive_away(utc(2026, 10, 3, 2), enforcer=self.enforcer_a)
        self.archive_away(utc(2026, 10, 4, 2), enforcer=self.enforcer_b)
        self.archive_away(utc(2025, 10, 4, 2), enforcer=self.enforcer_b)    # other month: no
        rows = self.rank()
        self.assertEqual([(r['id'], r['tickets']) for r in rows],
                         [(self.enforcer_a.id, 2), (self.enforcer_b.id, 1)])

    def test_duplicate_snapshot_does_not_inflate_a_person(self):
        v = self.make(utc(2026, 10, 2, 2), enforcer=self.enforcer_a)
        self.snapshot_of(v)
        self.snapshot_of(v)
        self.assertEqual([(r['id'], r['tickets']) for r in self.rank()], [(self.enforcer_a.id, 1)])

    def test_tickets_without_an_enforcer_are_never_ranked(self):
        self.make(utc(2026, 10, 2, 2), enforcer=None)
        self.archive_away(utc(2026, 10, 3, 2), enforcer=None)
        self.assertEqual(self.rank(), [])

    def test_ranking_order_rate_and_limit(self):
        extra = [CustomUser.objects.create_user(
            email=f'x{i}@tmeo.test', password='TmeoTest!2026', full_name=f'Extra {i}',
            id_number=f'X-{i}', role='enforcer') for i in range(5)]
        people = [self.enforcer_a, self.enforcer_b] + extra          # 7 people
        for rank, person in enumerate(people):
            for n in range(7 - rank):
                self.make(utc(2026, 10, 1 + (n % 9), 2), enforcer=person)
        rows = self.rank()
        self.assertEqual(len(rows), 5)
        self.assertEqual([r['tickets'] for r in rows], [7, 6, 5, 4, 3])
        self.assertEqual(rows[0]['rate'], 100)
        self.assertEqual(rows[1]['rate'], round(6 / 7 * 100))
        self.assertEqual(set(rows[0]), {'id', 'name', 'badge', 'tickets', 'rate'})

    def test_label_is_event_time_name_and_badge_is_snapshot_only(self):
        v = self.make(utc(2026, 10, 2, 2), enforcer=self.enforcer_a)
        for k, val in snapshot_fields(self.enforcer_a, 'enforcer', badge=True).items():
            setattr(v, k, val)
        v.enforcer_badge_snapshot = 'B-OLD'
        v.save()
        CustomUser.objects.filter(pk=self.enforcer_a.pk).update(full_name='Renamed Person', badge_number='LIVE-9')
        row = self.rank()[0]
        self.assertEqual(row['name'], 'Enforcer 1')                  # event-time, not "Renamed Person"
        self.assertEqual(row['badge'], 'B-OLD')                      # snapshot badge, never LIVE-9

    def test_no_snapshot_means_blank_badge_never_the_live_badge(self):
        self.make(utc(2026, 10, 2, 2), enforcer=self.enforcer_a)
        CustomUser.objects.filter(pk=self.enforcer_a.pk).update(badge_number='LIVE-9')
        self.assertEqual(self.rank()[0]['badge'], '')

    # ---- identity de-duplication (name-only legacy snapshots) ----------------

    def test_legacy_name_only_snapshot_joins_the_one_matching_person(self):
        self.make(utc(2026, 10, 2, 2), enforcer=self.enforcer_a)
        legacy = self.make(utc(2026, 10, 3, 2), enforcer=self.enforcer_a)
        self.legacy_snapshot(legacy, 'Enforcer 1')
        Violation.objects.filter(pk=legacy.pk).delete()
        rows = self.rank()
        self.assertEqual([(r['id'], r['tickets']) for r in rows], [(self.enforcer_a.id, 2)])

    def test_ambiguous_legacy_name_is_never_merged(self):
        twin = CustomUser.objects.create_user(
            email='twin@tmeo.test', password='TmeoTest!2026', full_name='Enforcer 1',
            id_number='TWIN-1', role='enforcer')
        self.make(utc(2026, 10, 2, 2), enforcer=self.enforcer_a)
        self.make(utc(2026, 10, 2, 3), enforcer=twin)
        legacy = self.make(utc(2026, 10, 3, 2), enforcer=self.enforcer_a)
        self.legacy_snapshot(legacy, 'Enforcer 1')
        Violation.objects.filter(pk=legacy.pk).delete()
        rows = self.rank()
        self.assertEqual(sorted(r['tickets'] for r in rows), [1, 1, 1])      # 3 separate rows
        self.assertEqual(sum(1 for r in rows if r['id'] is None), 1)

    def test_archived_only_person_is_not_ranked_twice(self):
        """Person with NO active tickets: a post-Phase-3 snapshot (has id) and a
        legacy snapshot (name only) must be ONE row, not two."""
        new = self.make(utc(2026, 10, 2, 2), enforcer=self.enforcer_b)
        self.snapshot_of(new)
        old = self.make(utc(2026, 10, 3, 2), enforcer=self.enforcer_b)
        self.legacy_snapshot(old, 'Enforcer 2')
        Violation.objects.filter(pk__in=[new.pk, old.pk]).delete()
        rows = self.rank()
        self.assertEqual([(r['id'], r['tickets']) for r in rows], [(self.enforcer_b.id, 2)])

    def test_legacy_snapshot_of_an_unknown_name_is_its_own_row_with_its_name(self):
        legacy = self.make(utc(2026, 10, 3, 2), enforcer=self.enforcer_a)
        self.legacy_snapshot(legacy, 'Ex-Employee Person')
        Violation.objects.filter(pk=legacy.pk).delete()
        CustomUser.objects.filter(pk=self.enforcer_a.pk).delete()
        rows = self.rank()
        self.assertEqual([(r['id'], r['name'], r['tickets']) for r in rows],
                         [(None, 'Ex-Employee Person', 1)])

    def test_year_and_all_periods(self):
        self.make(utc(2026, 10, 2, 2), enforcer=self.enforcer_a)
        self.make(utc(2026, 2, 2, 2), enforcer=self.enforcer_a)
        self.archive_away(utc(2019, 2, 2, 2), enforcer=self.enforcer_a)
        self.assertEqual(self.rank('month')[0]['tickets'], 1)
        self.assertEqual(self.rank('year')[0]['tickets'], 2)
        self.assertEqual(self.rank('all')[0]['tickets'], 3)


# --- API wiring, labels, hist_period, permissions ---------------------------------

class DashboardApiTests(HD):

    def setUp(self):
        super().setUp()
        self.now = datetime.datetime.now(datetime.timezone.utc)
        self.make(self.now, enforcer=self.enforcer_a, location='Hot Spot')           # this month
        self.archive_away(utc(2020, 6, 1, 2), enforcer=self.enforcer_b,
                          location='Hot Spot', vtype=self.vtype2)                    # old, archived

    def test_admin_gets_the_three_historical_panels_with_honest_labels(self):
        h = self.hist()
        self.assertEqual(self.as_map(h['type_data']), {'Test violation': 1, 'Second violation': 1})
        self.assertEqual(h['hotspots'], [{'area': 'Hot Spot', 'count': 2, 'trend': None}])
        self.assertEqual([r['id'] for r in h['top_enforcers']], [self.enforcer_a.id])   # this month only
        p = h['period']
        self.assertEqual(p['type_data'], {'scope': 'all_time', 'includes_archived': True,
                                          'label': 'Cumulative · includes archived'})
        self.assertEqual(p['hotspots'], p['type_data'])
        te = p['top_enforcers']
        self.assertEqual((te['scope'], te['includes_archived'], te['label'], te['timezone']),
                         ('month', True, 'This month · includes archived', 'Asia/Manila'))
        self.assertTrue(te['start'].endswith('-01'))
        self.assertLessEqual(te['start'], te['end'])

    def test_duplicates_are_counted_once_through_the_endpoint_in_every_panel(self):
        """Same ticket present as an active row AND two snapshots (restore from
        backup / interrupted archive): the shared de-dup set must reach all three
        panels, so nothing is inflated."""
        before = self.hist()
        v = Violation.objects.get(enforcer=self.enforcer_a)
        self.snapshot_of(v)
        self.snapshot_of(v)
        old = ArchivedViolation.objects.filter(data__enforcer_user_id=self.enforcer_b.id).first()
        self.snapshot_of(Violation.objects.create(
            violator_name='X', license_number='L', address='a', plate_number='P', ovr_number='DUP-OLD',
            date_issued=old.date_issued, location='Hot Spot', status='paid', enforcer=self.enforcer_b))
        Violation.objects.filter(ovr_number='DUP-OLD').delete()           # that one is a NEW archived ticket
        after = self.hist()
        # the new archived ticket has no offence items, so types must be EXACTLY unchanged
        self.assertEqual(after['type_data'], before['type_data'])
        self.assertEqual([(r['id'], r['tickets']) for r in after['top_enforcers']],
                         [(r['id'], r['tickets']) for r in before['top_enforcers']])
        # hotspot grew by exactly ONE (the genuinely new archived ticket), not by 3
        self.assertEqual(after['hotspots'][0]['count'], before['hotspots'][0]['count'] + 1)

    def test_existing_top_level_keys_stay_active_only(self):
        d = self.get_stats(self.admin)
        self.assertEqual({r['name']: r['count'] for r in d['type_data']}, {'Test violation': 1})
        self.assertEqual(d['hotspots'], [{'area': 'Hot Spot', 'count': 1, 'trend': None}])
        self.assertEqual(d['total'], 1)                                  # operational, active only

    def test_existing_historical_kpi_keys_are_unchanged(self):
        h = self.hist()
        for key in ('scope', 'total', 'paid', 'pending', 'processing', 'active_count',
                    'archived_count', 'total_penalty', 'total_collected'):
            self.assertIn(key, h)
        self.assertEqual(h['scope'], 'all_time_including_archived')
        self.assertEqual((h['active_count'], h['archived_count']), (1, 1))

    def test_hist_period_default_invalid_and_valid_values(self):
        self.assertEqual(self.hist()['period']['top_enforcers']['scope'], 'month')
        for bad in ('', 'week', 'MONTH', 'all; drop table', '../'):
            self.assertEqual(self.hist(hist_period=bad)['period']['top_enforcers']['scope'], 'month', bad)
        y = self.hist(hist_period='year')
        self.assertEqual(y['period']['top_enforcers']['label'], 'This year · includes archived')
        self.assertTrue(y['period']['top_enforcers']['start'].endswith('-01-01'))
        a = self.hist(hist_period='all')
        self.assertEqual(a['period']['top_enforcers']['label'], 'Cumulative · includes archived')
        self.assertEqual((a['period']['top_enforcers']['start'], a['period']['top_enforcers']['end']), (None, None))
        self.assertEqual(sorted(r['id'] for r in a['top_enforcers']),
                         sorted([self.enforcer_a.id, self.enforcer_b.id]))

    def test_hist_period_only_changes_the_enforcer_panel(self):
        base, other = self.hist(), self.hist(hist_period='all')
        for k in ('type_data', 'hotspots'):
            self.assertEqual(base[k], other[k])
        self.assertEqual(base['period']['type_data'], other['period']['type_data'])

    def test_staff_and_enforcers_get_no_historical_block_even_with_hist_period(self):
        for u in (self.staff, self.enforcer_a, self.enforcer_b):
            self.assertNotIn('historical', self.get_stats(u, hist_period='all'))

    def test_anonymous_is_refused(self):
        self.client.force_authenticate(None)
        self.assertIn(self.client.get('/api/violations/stats/').status_code, (401, 403))

    def test_request_is_read_only(self):
        before = (Violation.objects.count(), ArchivedViolation.objects.count(),
                  ViolationItem.objects.count())
        self.hist()
        self.hist(hist_period='all')
        self.assertEqual(before, (Violation.objects.count(), ArchivedViolation.objects.count(),
                                  ViolationItem.objects.count()))

    def test_query_count_does_not_grow_with_the_archive(self):
        def count():
            with CaptureQueriesContext(connection) as q:
                hd.historical_breakdowns('month', TODAY)
            return len(q)
        small = count()
        for i in range(25):
            self.archive_away(utc(2021, 1, 1 + (i % 28), 2), enforcer=self.enforcer_b)
        self.assertEqual(count(), small)