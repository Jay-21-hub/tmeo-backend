"""
Date window on GET /api/violations/stats/.

No params keeps today's payload: 7-day active-only daily_data, all-time
historical block. ``range=all`` is the all-time preset (monthly trend,
archived included). ``date_from`` / ``date_to`` are Asia/Manila dates,
``date_to`` inclusive.

Run on PostgreSQL (archive snapshots share the analytics path):
    python manage.py test violations.test_stats_range --settings=core.test_settings_pg
"""
import datetime

from violations.test_archive_consistency import H, utc


class StatsRangeTests(H):

    def fetch(self, user=None, **params):
        res = self.as_user(user or self.admin).get('/api/violations/stats/', params)
        return res

    def ok(self, user=None, **params):
        res = self.fetch(user, **params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_no_params_keep_the_seven_day_active_trend(self):
        self.archived_only(utc(2020, 6, 15, 2))
        body = self.ok()
        self.assertNotIn('trend_bucket', body)
        self.assertEqual(len(body['daily_data']), 7)
        self.assertEqual(sum(d['total'] for d in body['daily_data']), body['week_total'])
        self.assertEqual(body['historical']['scope'], 'all_time_including_archived')
        # The archived 2020 ticket is in the cumulative total, not in the 7-day chart.
        self.assertGreaterEqual(body['historical']['total'], 1)
        self.assertEqual(sum(d['total'] for d in body['daily_data']), body['week_total'])

    def test_normal_range_includes_archived_and_fills_empty_days(self):
        self.make(utc(2024, 5, 1, 2), status='paid')                 # May 1, 10:00 Manila, 500
        self.archived_only(utc(2024, 5, 3, 2), vtype=self.vtype2)    # May 3, archived, 1000
        plain = self.ok()
        body = self.ok(date_from='2024-05-01', date_to='2024-05-04')

        self.assertEqual(body['trend_bucket'], 'day')
        self.assertEqual([d['date'] for d in body['daily_data']], ['05/01', '05/02', '05/03', '05/04'])
        self.assertEqual([d['total'] for d in body['daily_data']], [1, 0, 1, 0])
        self.assertEqual([d['paid'] for d in body['daily_data']], [1, 0, 1, 0])
        self.assertEqual(body['historical']['total'], 2)
        self.assertEqual(body['historical']['paid'], 2)
        self.assertEqual(body['historical']['total_collected'], 1500.0)
        self.assertEqual(body['historical']['scope'], 'date_range_including_archived')
        # Pending and who is on duty stay current-state.
        self.assertEqual(body['pending'], plain['pending'])
        self.assertEqual(body['historical']['pending'], plain['historical']['pending'])
        self.assertEqual(body['active_enforcers'], plain['active_enforcers'])
        self.assertEqual(body['on_duty_enforcers'], plain['on_duty_enforcers'])
        # The rolling 7-day figure is not the filtered series.
        self.assertEqual(body['week_total'], plain['week_total'])

    def test_empty_range_returns_zeros(self):
        res = self.fetch(date_from='1999-01-01', date_to='1999-01-03')
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual([d['total'] for d in body['daily_data']], [0, 0, 0])
        self.assertEqual([d['paid'] for d in body['daily_data']], [0, 0, 0])
        self.assertEqual(body['historical']['total'], 0)
        self.assertEqual(body['historical']['paid'], 0)
        self.assertEqual(body['historical']['total_collected'], 0.0)
        self.assertEqual(body['pending'], self.ok()['pending'])

    def test_invalid_date_is_400(self):
        for params in (
            {'date_from': '2026-13-01', 'date_to': '2026-01-01'},
            {'date_from': '03/15/2026', 'date_to': '2026-03-16'},
            {'date_from': '2026-02-31', 'date_to': '2026-03-01'},
            {'date_from': '2026-05-01'},
        ):
            res = self.fetch(**params)
            self.assertEqual(res.status_code, 400, params)
            self.assertIn('date_from', res.json()['detail'])

    def test_date_from_after_date_to_is_400(self):
        res = self.fetch(date_from='2026-03-20', date_to='2026-03-01')
        self.assertEqual(res.status_code, 400)
        self.assertIn('on or before', res.json()['detail'])

    def test_unknown_range_and_mixed_params_are_400(self):
        bad_range = self.fetch(**{'range': 'week'})
        self.assertEqual(bad_range.status_code, 400)
        mixed = self.fetch(**{'range': 'all', 'date_from': '2024-01-01', 'date_to': '2024-01-02'})
        self.assertEqual(mixed.status_code, 400)

    def test_midnight_boundary_is_asia_manila(self):
        # 15:30 UTC = 23:30 Manila on Mar 15. 16:30 UTC = 00:30 Manila on Mar 16.
        # 16:00 UTC next day = 00:00 Manila on Mar 17, outside Mar 16.
        self.make(utc(2026, 3, 15, 15, 30), status='paid')
        self.archived_only(utc(2026, 3, 15, 16, 30), vtype=self.vtype2)
        self.make(utc(2026, 3, 16, 16, 0), status='pending')

        march_15 = self.ok(date_from='2026-03-15', date_to='2026-03-15')
        self.assertEqual(march_15['daily_data'][0]['total'], 1)
        self.assertEqual(march_15['daily_data'][0]['paid'], 1)
        self.assertEqual(march_15['historical']['total'], 1)

        march_16 = self.ok(date_from='2026-03-16', date_to='2026-03-16')
        self.assertEqual(march_16['daily_data'][0]['total'], 1)
        self.assertEqual(march_16['daily_data'][0]['paid'], 1)
        self.assertEqual(march_16['historical']['total_collected'], 1000.0)
        self.assertEqual(march_16['historical']['total'], 1)

        both = self.ok(date_from='2026-03-15', date_to='2026-03-16')
        self.assertEqual([d['total'] for d in both['daily_data']], [1, 1])

    def test_duplicate_archive_snapshot_is_counted_once(self):
        ticket = self.make(utc(2024, 7, 2, 2), status='paid')
        self.snapshot_of(ticket)
        body = self.ok(date_from='2024-07-01', date_to='2024-07-03')
        self.assertEqual(body['historical']['total'], 1)
        self.assertEqual([d['total'] for d in body['daily_data']], [0, 1, 0])

    def test_day_bucket_through_92_days_and_month_bucket_after(self):
        daily = self.ok(date_from='2024-01-01', date_to='2024-04-01')
        self.assertEqual((datetime.date(2024, 4, 1) - datetime.date(2024, 1, 1)).days + 1, 92)
        self.assertEqual(daily['trend_bucket'], 'day')
        self.assertEqual(len(daily['daily_data']), 92)
        self.assertTrue(all(point['total'] == 0 for point in daily['daily_data']))

        monthly = self.ok(date_from='2024-01-01', date_to='2024-04-02')
        self.assertEqual(monthly['trend_bucket'], 'month')
        self.assertEqual([d['date'] for d in monthly['daily_data']],
                         ['Jan 2024', 'Feb 2024', 'Mar 2024', 'Apr 2024'])
        self.assertTrue(all(point['total'] == 0 for point in monthly['daily_data']))

    def test_range_all_is_monthly_and_keeps_all_time_totals(self):
        self.make(utc(2020, 6, 15, 2), status='paid')
        self.archived_only(utc(2020, 8, 1, 2), vtype=self.vtype2)
        plain = self.ok()
        body = self.ok(**{'range': 'all'})

        self.assertEqual(body['trend_bucket'], 'month')
        hist, base = body['historical'], plain['historical']
        for key in ('scope', 'total', 'paid', 'pending', 'processing', 'total_penalty',
                    'total_collected', 'active_count', 'archived_count', 'type_data', 'hotspots'):
            self.assertEqual(hist[key], base[key], key)
        self.assertEqual(base['period']['top_enforcers']['scope'], 'month')
        self.assertEqual(hist['period']['top_enforcers']['scope'], 'all')
        self.assertEqual(body['week_total'], plain['week_total'])
        self.assertNotEqual(body['daily_data'], plain['daily_data'])
        labels = [d['date'] for d in body['daily_data']]
        self.assertEqual(labels[0], 'Jun 2020')
        self.assertEqual(labels[1], 'Jul 2020')
        self.assertEqual(labels[2], 'Aug 2020')
        # No missing month between the first ticket and the latest label.
        self.assertEqual(len(labels), len(set(labels)))
        self.assertGreater(len(labels), 3)
        by_label = {d['date']: d for d in body['daily_data']}
        self.assertEqual(by_label['Jun 2020']['total'], 1)
        self.assertEqual(by_label['Jun 2020']['paid'], 1)
        self.assertEqual(by_label['Jul 2020']['total'], 0)
        self.assertEqual(by_label['Aug 2020']['total'], 1)
        self.assertEqual(by_label['Aug 2020']['paid'], 1)

    def test_enforcer_range_does_not_include_someone_elses_archive(self):
        self.archived_only(utc(2024, 1, 10, 2), enforcer=self.enforcer_b)
        mine = self.ok(self.enforcer_a, date_from='2024-01-01', date_to='2024-01-31')
        self.assertNotIn('historical', mine)
        self.assertEqual(sum(d['total'] for d in mine['daily_data']), 0)
        office = self.ok(date_from='2024-01-01', date_to='2024-01-31')
        self.assertEqual(sum(d['total'] for d in office['daily_data']), 1)
