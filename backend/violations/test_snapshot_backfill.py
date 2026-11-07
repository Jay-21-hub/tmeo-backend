"""
Role Evolution — Phase 1: the conservative legacy backfill (migration 0029)
and the guarantee that Phase 1 migrations never touch users or invent history.

Run: python manage.py test violations.test_snapshot_backfill --settings=core.test_settings
"""
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase
from django.utils import timezone

# accounts is pinned at its Phase 1 migration so the historical CustomUser has every field.
BEFORE = [('accounts', '0008_user_role_history'), ('violations', '0028_identity_snapshots')]
AFTER  = [('accounts', '0008_user_role_history'), ('violations', '0029_backfill_enforcer_role_snapshot')]


class BackfillMigrationTests(TransactionTestCase):

    def setUp(self):
        self.executor = MigrationExecutor(connection)
        self.executor.migrate(BEFORE)
        self.old = self.executor.loader.project_state(BEFORE).apps
        U, V = self.old.get_model('accounts', 'CustomUser'), self.old.get_model('violations', 'Violation')

        def user(n, role):
            return U.objects.create(
                email=f'{role}{n}@x.test', full_name=f'{role} {n}', id_number=f'2026-{role[:3].upper()}-000{n}',
                role=role, hired_year=2026, password=f'pw-{n}',
            )

        self.enf, self.staff, self.admin = user(1, 'enforcer'), user(2, 'staff'), user(3, 'admin')
        self.users_before = list(U.objects.order_by('pk').values())

        def viol(tag, source, enforcer, **extra):
            return V.objects.create(
                violator_name=tag, source=source, enforcer=enforcer,
                date_issued=timezone.now(), **extra,
            ).pk

        self.ids = {
            'enf_ovr':        viol('enf_ovr', 'enforcer_ovr', self.enf),
            'staff_filed':    viol('staff_filed', 'enforcer_ovr', self.staff),
            'admin_filed':    viol('admin_filed', 'enforcer_ovr', self.admin),
            'walk_in':        viol('walk_in', 'staff_walk_in', None),
            'imported':       viol('imported', 'imported', None),
            'no_enforcer':    viol('no_enforcer', 'enforcer_ovr', None),
            'already_event':  viol('already_event', 'enforcer_ovr', self.enf,
                                   enforcer_role_snapshot='enforcer', enforcer_name_snapshot='Real Name',
                                   enforcer_id_number_snapshot='2026-ENF-0001', enforcer_snapshot_source='event'),
        }
        self.updated_before = dict(V.objects.values_list('pk', 'updated_at'))

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())

    def _migrate_forward(self):
        executor = MigrationExecutor(connection)
        executor.migrate(AFTER)
        return executor.loader.project_state(AFTER).apps

    def _row(self, apps, key):
        return apps.get_model('violations', 'Violation').objects.get(pk=self.ids[key])

    def test_only_enforcer_filed_enforcer_ovr_rows_get_an_assumed_role(self):
        new = self._migrate_forward()
        r = self._row(new, 'enf_ovr')
        self.assertEqual((r.enforcer_role_snapshot, r.enforcer_snapshot_source), ('enforcer', 'assumed'))
        # NOT fabricated: today's name / ID / badge are never copied as event-time truth.
        self.assertIsNone(r.enforcer_name_snapshot)
        self.assertIsNone(r.enforcer_id_number_snapshot)
        self.assertIsNone(r.enforcer_badge_snapshot)

    def test_everything_else_stays_unknown(self):
        new = self._migrate_forward()
        for key in ('staff_filed', 'admin_filed', 'walk_in', 'imported', 'no_enforcer'):
            r = self._row(new, key)
            self.assertEqual(r.enforcer_snapshot_source, 'unknown', key)
            self.assertIsNone(r.enforcer_role_snapshot, key)
            self.assertIsNone(r.enforcer_name_snapshot, key)
            self.assertIsNone(r.enforcer_id_number_snapshot, key)

    def test_nothing_is_ever_labelled_event_or_derived_by_the_backfill(self):
        new = self._migrate_forward()
        V = new.get_model('violations', 'Violation')
        sources = set(V.objects.exclude(pk=self.ids['already_event']).values_list('enforcer_snapshot_source', flat=True))
        self.assertTrue(sources <= {'assumed', 'unknown'}, sources)

    def test_an_existing_event_snapshot_is_left_untouched(self):
        new = self._migrate_forward()
        r = self._row(new, 'already_event')
        self.assertEqual((r.enforcer_snapshot_source, r.enforcer_name_snapshot, r.enforcer_id_number_snapshot),
                         ('event', 'Real Name', '2026-ENF-0001'))

    def test_backfill_does_not_touch_updated_at(self):
        new = self._migrate_forward()
        V = new.get_model('violations', 'Violation')
        self.assertEqual(dict(V.objects.values_list('pk', 'updated_at')), self.updated_before)

    def test_users_are_not_modified_and_no_history_is_invented(self):
        new = self._migrate_forward()
        U = new.get_model('accounts', 'CustomUser')
        self.assertEqual(list(U.objects.order_by('pk').values()), self.users_before)   # roles, IDs, passwords, hired_year, is_active…
        self.assertEqual(new.get_model('accounts', 'UserRoleHistory').objects.count(), 0)

    def test_backfill_is_reversible(self):
        self._migrate_forward()
        executor = MigrationExecutor(connection)
        executor.migrate(BEFORE)
        old = executor.loader.project_state(BEFORE).apps
        r = old.get_model('violations', 'Violation').objects.get(pk=self.ids['enf_ovr'])
        self.assertEqual((r.enforcer_role_snapshot, r.enforcer_snapshot_source), (None, 'unknown'))