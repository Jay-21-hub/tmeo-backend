"""
Preflight for migration 0034 (license custody protections).

Run it with PRODUCTION settings BEFORE `migrate violations 0034`:

    python manage.py check_license_custody_protection

It changes nothing permanently: the trial function is created inside a
savepoint that is always rolled back. Exit code 0 = safe to migrate (or the
protections are already installed); non-zero = do not migrate yet.
"""
from django.core.management.base import BaseCommand, CommandError
from django.db import DatabaseError, connection, transaction

TRIGGERS = (
    'license_custody_event_no_update_delete',
    'license_custody_event_no_truncate',
    'license_custody_no_delete',
    'license_custody_guard',
)


class _Rollback(Exception):
    pass


class Command(BaseCommand):
    help = 'Report whether the database role can install the license-custody triggers.'

    def handle(self, *args, **opts):
        if connection.vendor != 'postgresql':
            raise CommandError('PostgreSQL is required (triggers are not available on this database).')
        problems = []
        with connection.cursor() as cur:
            cur.execute('SELECT current_user, current_schema(), current_database()')
            user, schema, db = cur.fetchone()
            cur.execute('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')
            is_super = cur.fetchone()[0]
            cur.execute('SELECT has_schema_privilege(current_user, current_schema(), %s)', ['CREATE'])
            can_create = cur.fetchone()[0]
            cur.execute("SELECT to_regclass('violations_licensecustody') IS NOT NULL")
            tables_exist = cur.fetchone()[0]
            cur.execute('SELECT tgname FROM pg_trigger WHERE tgname = ANY(%s) AND NOT tgisinternal', [list(TRIGGERS)])
            present = {r[0] for r in cur.fetchall()}
            self.stdout.write(f'database={db} role={user} schema={schema} superuser={is_super}')
            self.stdout.write(f'CREATE privilege on schema: {can_create}')
            self.stdout.write(f'custody tables exist: {tables_exist}')
            for t in TRIGGERS:
                self.stdout.write(f'  trigger {t}: {"present" if t in present else "missing"}')

        if not can_create:
            problems.append(f'role "{user}" has no CREATE privilege on schema "{schema}"')
        try:
            with transaction.atomic():
                with connection.cursor() as cur:
                    cur.execute("""CREATE FUNCTION license_custody_preflight_probe() RETURNS trigger
                                   LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$""")
                self.stdout.write('trial function create: OK (rolled back)')
                raise _Rollback()
        except _Rollback:
            pass
        except DatabaseError as exc:
            problems.append(f'trial function create failed: {exc}')

        if tables_exist and present and len(present) != len(TRIGGERS):
            problems.append('some protection triggers are missing: ' + ', '.join(sorted(set(TRIGGERS) - present)))
        if problems:
            for p in problems:
                self.stderr.write(self.style.ERROR('PROBLEM: ' + p))
            raise CommandError('Preflight FAILED - do not apply migration 0034 until this is resolved.')
        self.stdout.write(self.style.SUCCESS('Preflight OK.'))