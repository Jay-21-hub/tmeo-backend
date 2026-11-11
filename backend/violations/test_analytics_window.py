"""Date window on GET /api/violations/analytics/.

These methods are attached to AnalyticsAggregationTests so they use that
seed and do not insert a second copy of it. No existing test method is edited.
"""
import datetime
from unittest import mock

from django.utils import timezone

from violations.models import Violation

TODAY = datetime.date(2026, 3, 20)
URL = '/api/violations/analytics/'


def fetch(self, **params):
    self.client.force_authenticate(self.admin)
    with mock.patch('django.utils.timezone.localdate', return_value=TODAY):
        return self.client.get(URL, params)


def ok(self, **params):
    res = fetch(self, **params)
    self.assertEqual(res.status_code, 200, res.content)
    return res.json()


def test_no_date_params_match_the_period_preset(self):
    plain = ok(self)
    month = ok(self, period='month')
    self.assertEqual(plain['total'], month['total'])
    self.assertNotIn('trend_bucket', plain)
    self.assertEqual(plain['comparison']['label'], month['comparison']['label'])
    year = ok(self, period='year')
    self.assertEqual(year['total'], 7)
    self.assertNotIn('trend_bucket', year)


def test_date_window_is_inclusive_and_beats_period(self):
    body = ok(self, period='today', date_from='2026-01-05', date_to='2026-01-05')
    self.assertEqual(body['total'], 3)
    self.assertEqual(body['scope']['range'], {'start': '2026-01-05', 'end': '2026-01-05'})
    self.assertEqual(body['trend_bucket'], 'day')
    self.assertEqual(body['comparison']['label'], 'vs previous period')
    self.assertEqual(body['comparison']['total_pct'], 100.0)


def test_manila_midnight_boundary(self):
    rows = list(Violation.objects.order_by('pk')[:2])
    rows[0].date_issued = timezone.make_aware(datetime.datetime(2026, 3, 15, 23, 30))
    rows[0].location = 'Night Edge'
    rows[0].save(update_fields=['date_issued', 'location'])
    rows[1].date_issued = timezone.make_aware(datetime.datetime(2026, 3, 16, 0, 30))
    rows[1].location = 'After Midnight'
    rows[1].save(update_fields=['date_issued', 'location'])
    fifteenth = ok(self, date_from='2026-03-15', date_to='2026-03-15', location='Night Edge')
    self.assertEqual(fifteenth['total'], 1)
    sixteenth = ok(self, date_from='2026-03-16', date_to='2026-03-16', location='After Midnight')
    self.assertEqual(sixteenth['total'], 1)
    self.assertEqual(ok(self, date_from='2026-03-15', date_to='2026-03-15', location='After Midnight')['total'], 0)


def test_range_all_is_monthly_and_has_no_comparison(self):
    body = ok(self, **{'range': 'all', 'period': 'today'})
    self.assertEqual(body['total'], 7)
    self.assertEqual(body['trend_bucket'], 'month')
    self.assertLess(len(body['by_day']), 80)
    self.assertEqual(body['by_day'][0]['date'], 'Jan 2026')
    self.assertIsNone(body['comparison']['total_pct'])
    self.assertIsNone(body['comparison']['label'])


def test_long_range_buckets_by_month(self):
    body = ok(self, date_from='2026-01-01', date_to='2026-04-03')
    self.assertEqual(body['trend_bucket'], 'month')
    self.assertEqual([d['date'] for d in body['by_day']],
                     ['Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026'])


def test_scope_active_still_excludes_archived_inside_the_window(self):
    body = ok(self, scope='active', date_from='2026-01-05', date_to='2026-01-05')
    self.assertEqual(body['total'], 2)
    self.assertEqual(body['scope']['archived_count'], 0)


def test_reversed_and_invalid_dates_use_the_stats_400(self):
    bad = fetch(self, date_from='2026-01-10', date_to='2026-01-01')
    self.assertEqual(bad.status_code, 400)
    self.assertIn('on or before', bad.json()['detail'])
    invalid = fetch(self, date_from='2026-13-01', date_to='2026-01-01')
    self.assertEqual(invalid.status_code, 400)
    self.assertIn('date_from', invalid.json()['detail'])


def test_outstanding_tickets_ignore_the_date_window(self):
    windowed = ok(self, date_from='2026-01-05', date_to='2026-01-05')
    preset = ok(self, period='today')
    self.assertEqual(windowed['penalty_aging'], preset['penalty_aging'])


WINDOW_TESTS = (
    test_no_date_params_match_the_period_preset,
    test_date_window_is_inclusive_and_beats_period,
    test_manila_midnight_boundary,
    test_range_all_is_monthly_and_has_no_comparison,
    test_long_range_buckets_by_month,
    test_scope_active_still_excludes_archived_inside_the_window,
    test_reversed_and_invalid_dates_use_the_stats_400,
    test_outstanding_tickets_ignore_the_date_window,
)


def bind_window_tests(cls):
    for fn in WINDOW_TESTS:
        setattr(cls, fn.__name__, fn)
