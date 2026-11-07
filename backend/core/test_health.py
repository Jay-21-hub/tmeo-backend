"""
Stage B - health checks for Render.

Run with:  python manage.py test core.test_health --settings=core.test_settings
"""
from unittest import mock

from django.test import TestCase, override_settings


class Liveness(TestCase):

    def test_healthz_ok(self):
        res = self.client.get('/healthz')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.content, b'ok')

    def test_healthz_ignores_host_validation(self):
        # Render's probe may use a Host that is not in ALLOWED_HOSTS.
        res = self.client.get('/healthz', HTTP_HOST='some-internal-host.invalid')
        self.assertEqual(res.status_code, 200)

    @override_settings(SECURE_SSL_REDIRECT=True)
    def test_healthz_is_not_redirected_to_https(self):
        res = self.client.get('/healthz')  # plain HTTP request
        self.assertEqual(res.status_code, 200)

    def test_healthz_head_ok_and_post_not_served(self):
        self.assertEqual(self.client.head('/healthz').status_code, 200)
        self.assertNotEqual(self.client.post('/healthz').status_code, 200)

    def test_healthz_never_touches_the_database(self):
        with mock.patch('django.db.backends.utils.CursorWrapper.execute',
                        side_effect=AssertionError('DB used by liveness')):
            self.assertEqual(self.client.get('/healthz').status_code, 200)


class AppLiveness(TestCase):

    def test_api_health_ok_and_public(self):
        res = self.client.get('/api/health/')   # no auth header
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {'status': 'ok'})

    def test_api_health_never_touches_the_database(self):
        with mock.patch('django.db.backends.utils.CursorWrapper.execute',
                        side_effect=AssertionError('DB used by liveness')):
            self.assertEqual(self.client.get('/api/health/').status_code, 200)

    def test_api_health_is_read_only_http(self):
        self.assertEqual(self.client.head('/api/health/').status_code, 200)


class Readiness(TestCase):

    def test_ready_ok_and_public(self):
        res = self.client.get('/api/ready/')   # no auth header
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {'status': 'ok'})

    def test_ready_only_runs_a_read_only_select(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext
        with CaptureQueriesContext(connection) as ctx:
            self.assertEqual(self.client.get('/api/ready/').status_code, 200)
        statements = [q['sql'].strip().upper() for q in ctx.captured_queries]
        self.assertEqual(statements, ['SELECT 1'])

    def test_ready_503_without_leaking_detail(self):
        with mock.patch('core.health.connection.cursor', side_effect=Exception('password=hunter2 host=db.internal')):
            with self.assertLogs('core.health', level='ERROR'):
                res = self.client.get('/api/ready/')
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.json(), {'status': 'degraded'})
        self.assertNotIn(b'hunter2', res.content)