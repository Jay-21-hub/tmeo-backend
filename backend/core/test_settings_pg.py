"""
TEST-ONLY settings for an ISOLATED local PostgreSQL. Never used in production.
Refuses to start if the configured host looks like Supabase / a remote cloud DB.

Run:  TEST_PG_HOST=/tmp/pg TEST_PG_PORT=54329 python manage.py test --settings=core.test_settings_pg
"""
import os

from .test_settings import *  # noqa: F401,F403

_HOST = os.environ.get('TEST_PG_HOST', 'localhost')
_BAD = ('supabase', 'pooler', 'amazonaws', 'render.com', 'neon.tech')
if any(b in _HOST.lower() for b in _BAD):
    raise RuntimeError(f'Refusing to run tests against non-local host: {_HOST!r}')

DATABASES = {'default': {
    'ENGINE': 'django.db.backends.postgresql',
    'NAME': os.environ.get('TEST_PG_NAME', 'tmeo_test'),
    'USER': os.environ.get('TEST_PG_USER', 'tmeo_app'),
    'PASSWORD': os.environ.get('TEST_PG_PASSWORD', 'tmeo'),
    'HOST': _HOST,
    'PORT': os.environ.get('TEST_PG_PORT', '5432'),
    'TEST': {'NAME': 'tmeo_test_run'},
}}


# ── TEST-ONLY flush shim ─────────────────────────────────────────────────────
# TransactionTestCase teardown flushes every table with TRUNCATE, which the
# append-only event ledger (correctly) refuses. The shim disables that one
# trigger for the duration of the flush and re-enables it ENABLE ALWAYS. It is
# applied only when this settings module is loaded; production never loads it.
def _install_flush_shim():
    from django.db.backends.postgresql.operations import DatabaseOperations
    if getattr(DatabaseOperations, '_custody_flush_shim', False):
        return
    original = DatabaseOperations.execute_sql_flush
    trig = 'license_custody_event_no_truncate'
    table = 'violations_licensecustodyevent'

    def execute_sql_flush(self, sql_list):
        with self.connection.cursor() as c:
            c.execute("SELECT 1 FROM pg_trigger WHERE tgname = %s", [trig])
            has = c.fetchone() is not None
            if has:
                c.execute(f'ALTER TABLE {table} DISABLE TRIGGER {trig}')
        try:
            return original(self, sql_list)
        finally:
            if has:
                with self.connection.cursor() as c:
                    c.execute(f'ALTER TABLE {table} ENABLE ALWAYS TRIGGER {trig}')

    DatabaseOperations.execute_sql_flush = execute_sql_flush
    DatabaseOperations._custody_flush_shim = True


_install_flush_shim()