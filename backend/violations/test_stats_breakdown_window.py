"""
Date window on the admin historical panels of GET /api/violations/stats/.

With no range/date params, hist_period (default month) is unchanged.
With range=all or date_from/date_to, By Type, Top Locations, and Top
Enforcers use that window, and hist_period does not override it.
By Type stays item counts. Locations stay on clean_location / location_key.

Run on PostgreSQL:
    python manage.py test violations.test_stats_breakdown_window --settings=core.test_settings_pg
"""
from violations.test_archive_consistency import H, utc


class BreakdownWindowTests(H):

    def fetch(self, **params):
        return self.as_user(self.admin).get('/api/violations/stats/', params)

    def ok(self, **params):
        res = self.fetch(**params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()['historical']

    def test_outside_ticket_is_absent_from_totals_and_all_three_panels(self):
        self.make(utc(2024, 5, 2, 2), location='Inside Road', enforcer=self.enforcer_a)
        self.make(utc(2024, 6, 2, 2), location='Outside Road', enforcer=self.enforcer_b,
                  vtype=self.vtype2)
        h = self.ok(date_from='2024-05-01', date_to='2024-05-31')
        self.assertEqual(h['total'], 1)
        self.assertEqual({r['name']: r['count'] for r in h['type_data']}, {'Test violation': 1})
        self.assertEqual([r['area'] for r in h['hotspots']], ['Inside Road'])
        self.assertEqual([r['id'] for r in h['top_enforcers']], [self.enforcer_a.id])
        self.assertEqual(h['period']['type_data']['unit'], 'violation_items')
        self.assertEqual(h['period']['top_enforcers']['scope'], 'date_range')

    def test_manila_midnight_puts_each_ticket_on_its_own_day(self):
        self.make(utc(2026, 3, 15, 15, 30), location='Evening Spot')   # 23:30 Manila Mar 15
        self.make(utc(2026, 3, 15, 16, 30), location='After Midnight', vtype=self.vtype2)  # 00:30 Mar 16
        fifteenth = self.ok(date_from='2026-03-15', date_to='2026-03-15')
        self.assertEqual(fifteenth['total'], 1)
        self.assertEqual([r['area'] for r in fifteenth['hotspots']], ['Evening Spot'])
        self.assertEqual({r['name'] for r in fifteenth['type_data']}, {'Test violation'})
        sixteenth = self.ok(date_from='2026-03-16', date_to='2026-03-16')
        self.assertEqual(sixteenth['total'], 1)
        self.assertEqual([r['area'] for r in sixteenth['hotspots']], ['After Midnight'])

    def test_no_params_keep_hist_period_month_for_enforcers_only(self):
        self.make(utc(2019, 4, 2, 2), location='Old Place', enforcer=self.enforcer_a)
        plain = self.ok()
        widened = self.ok(hist_period='all')
        self.assertEqual(plain['period']['top_enforcers']['scope'], 'month')
        self.assertEqual(plain['period']['type_data']['scope'], 'all_time')
        self.assertEqual(plain['type_data'], widened['type_data'])
        self.assertEqual(plain['hotspots'], widened['hotspots'])
        self.assertEqual(widened['period']['top_enforcers']['scope'], 'all')
        old_ids = {r['id'] for r in plain['top_enforcers']}
        all_ids = {r['id'] for r in widened['top_enforcers']}
        self.assertNotIn(self.enforcer_a.id, old_ids)
        self.assertIn(self.enforcer_a.id, all_ids)

    def test_range_all_includes_archived_and_beats_hist_period_month(self):
        self.archived_only(utc(2019, 4, 2, 2), location='Old Place', enforcer=self.enforcer_a,
                           vtype=self.vtype2)
        h = self.ok(**{'range': 'all', 'hist_period': 'month'})
        self.assertGreaterEqual(h['archived_count'], 1)
        self.assertIn('Second violation', {r['name'] for r in h['type_data']})
        self.assertIn('Old Place', {r['area'] for r in h['hotspots']})
        self.assertIn(self.enforcer_a.id, {r['id'] for r in h['top_enforcers']})
        self.assertEqual(h['period']['top_enforcers']['scope'], 'all')

    def test_date_window_beats_hist_period(self):
        self.make(utc(2019, 4, 2, 2), location='Old Place', enforcer=self.enforcer_a)
        h = self.ok(date_from='2019-04-01', date_to='2019-04-30', hist_period='month')
        self.assertEqual(h['total'], 1)
        self.assertEqual([r['area'] for r in h['hotspots']], ['Old Place'])
        self.assertEqual(h['period']['top_enforcers']['scope'], 'date_range')
        self.assertNotEqual(h['period']['top_enforcers']['scope'], 'month')

    def test_ticket_with_no_enforcer_is_in_the_total_and_not_ranked(self):
        self.make(utc(2024, 5, 2, 2), location='Walk In', enforcer=None)
        h = self.ok(date_from='2024-05-01', date_to='2024-05-31')
        self.assertEqual(h['total'], 1)
        self.assertEqual(h['top_enforcers'], [])
        self.assertEqual([r['area'] for r in h['hotspots']], ['Walk In'])

    def test_reversed_and_invalid_dates_use_the_phase1_400(self):
        bad = self.fetch(date_from='2024-05-10', date_to='2024-05-01')
        self.assertEqual(bad.status_code, 400)
        self.assertIn('on or before', bad.json()['detail'])
        invalid = self.fetch(date_from='2024-13-01', date_to='2024-05-01')
        self.assertEqual(invalid.status_code, 400)
        self.assertIn('date_from', invalid.json()['detail'])
