"""
Confiscated Licenses custody - Checkpoint 3 Stage B tests.

PostgreSQL only (constraints, triggers, row locks): every class skips on SQLite.
Run:  TEST_PG_HOST=/tmp/pg TEST_PG_PORT=54329 \
      python manage.py test violations.test_license_custody --settings=core.test_settings_pg
"""
import threading
import uuid
from datetime import timedelta
from unittest import mock, skipUnless

import psycopg2
from django.contrib.admin.sites import site as admin_site
from django.core.management import call_command
from django.db import DatabaseError, IntegrityError, connection, connections, transaction
from django.db.models import ProtectedError
from django.test import RequestFactory, TransactionTestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.history_guard import get_user_historical_references
from accounts.models import CustomUser
from audit.models import AuditLog
from database_management.models import ArchivedViolation, ArchiveBatch
from violations.custody_models import (
    ConfiscationLockedError, CustodyIntegrityError, LicenseCustody, LicenseCustodyEvent,
)
from violations.models import Violation, ViolationItem, ViolationType
from violations.tests import BaseRoleTestCase

PG = skipUnless(connection.vendor == 'postgresql', 'PostgreSQL-only (constraints/triggers/locks)')
BASE = '/api/violations/confiscated-licenses/'


def rid():
    return str(uuid.uuid4())


def release_body(**kw):
    b = {'released_to_name': 'Juan Dela Cruz', 'claimant_id_type': 'passport',
         'claimant_id_last4': '4567', 'authorization_reference': 'AUTH-001'}
    b.update(kw)
    return b


class CustodyMixin:
    """Helpers shared by the TestCase and TransactionTestCase classes."""

    def conf(self, ovr='OVR-C-1', status='paid', doc='drivers_license', lic='D01-1234567',
             date_issued=None, enforcer=None):
        v = Violation.objects.create(
            violator_name='DELA CRUZ, JUAN', license_number=lic, ovr_number=ovr,
            date_issued=date_issued or timezone.now(), location='Tagarao', status=status,
            enforcer=enforcer or self.enforcer_a, license_status='confiscated',
            confiscated_document_type=doc,
        )
        ViolationItem.objects.create(violation=v, violation_type=self.vtype, penalty_amount_snapshot=500)
        return v

    def post(self, user, key, op, version=0, request_id=None, **body):
        data = {'expected_version': version, 'client_request_id': request_id or rid()}
        data.update(body)
        return self.as_user(user).post(f'{BASE}{key}/{op}/', data, format='json')

    def ready(self, user, key, version=0):
        return self.post(user, key, 'mark-ready', version)

    def make_archived(self, original_id, data=None, **kw):
        batch = ArchiveBatch.objects.create(status='success')
        d = {'license_status': 'Confiscated', 'confiscated_document_type': 'drivers_license',
             'ovr_number': 'OVR-ARC', 'items': [{'name': 'Test violation'}]}
        d.update(data or {})
        fields = dict(batch=batch, original_violation_id=original_id, violation_year=2024,
                      date_issued=timezone.now() - timedelta(days=100), settlement_status='settled',
                      violator_name='ARCHIVED, ANA', license_number='N01-999', data=d)
        fields.update(kw)
        return ArchivedViolation.objects.create(**fields)

    def listing(self, user, **params):
        return self.as_user(user).get(BASE, params)


# ═══════════════════════════════════════════════════════════════════════════
@PG
class LinkageTests(CustodyMixin, BaseRoleTestCase):
    def test_xor_rejects_both_null_and_both_set(self):
        v = self.conf()
        a = self.make_archived(v.id)
        for kwargs in ({}, {'violation': v, 'archived_violation': a}):
            with self.assertRaises(IntegrityError), transaction.atomic():
                LicenseCustody.objects.create(original_violation_id=v.id, **kwargs)

    def test_protected_error_deleting_linked_violation(self):
        v = self.conf()
        LicenseCustody.objects.create(violation=v, original_violation_id=v.id)
        with self.assertRaises(ProtectedError):
            v.delete()

    def test_protected_error_deleting_linked_archived_row(self):
        a = self.make_archived(555)
        LicenseCustody.objects.create(archived_violation=a, original_violation_id=555)
        with self.assertRaises(ProtectedError):
            a.delete()

    def test_second_custody_for_same_violation_rejected(self):
        v = self.conf()
        LicenseCustody.objects.create(violation=v, original_violation_id=v.id)
        with self.assertRaises(IntegrityError), transaction.atomic():
            LicenseCustody.objects.create(violation=v, original_violation_id=v.id)

    def test_original_id_mismatch_rejected_for_active_rows(self):
        v = self.conf()
        with self.assertRaises(IntegrityError), transaction.atomic():
            LicenseCustody.objects.create(violation=v, original_violation_id=v.id + 1)

    def test_doc_type_gate_check_constraint(self):
        v = self.conf(doc='')
        c = LicenseCustody.objects.create(violation=v, original_violation_id=v.id,
                                          doc_type_status='pending')
        with self.assertRaises(IntegrityError), transaction.atomic():
            LicenseCustody.objects.filter(pk=c.pk).update(
                status='ready_for_release', ready_marked_at=timezone.now(), ready_marked_by=self.staff)


# ═══════════════════════════════════════════════════════════════════════════
@PG
class TriggerTests(CustodyMixin, BaseRoleTestCase):
    def setUp(self):
        self.v = self.conf()
        self.assertEqual(self.ready(self.staff, f'v{self.v.id}').status_code, 200)
        self.assertEqual(self.post(self.staff, f'v{self.v.id}', 'release', 1, **release_body()).status_code, 200)
        self.c = LicenseCustody.objects.get(violation=self.v)
        self.e = LicenseCustodyEvent.objects.first()

    def raw(self, sql, params=()):
        with self.assertRaises(DatabaseError), transaction.atomic():
            with connection.cursor() as cur:
                cur.execute(sql, params)

    def test_orm_blocks_event_update_delete_bulk(self):
        self.e.event_type = 'x'
        with self.assertRaises(CustodyIntegrityError):
            self.e.save()
        with self.assertRaises(CustodyIntegrityError):
            self.e.delete()
        for op in (lambda: LicenseCustodyEvent.objects.update(event_type='x'),
                   lambda: LicenseCustodyEvent.objects.all().delete(),
                   lambda: LicenseCustodyEvent.objects.bulk_update([self.e], ['event_type']),
                   lambda: LicenseCustodyEvent.objects.all()._raw_delete('default')):
            with self.assertRaises(CustodyIntegrityError):
                op()

    def test_raw_sql_update_delete_truncate_blocked_on_events(self):
        self.raw('UPDATE violations_licensecustodyevent SET event_type = %s', ['x'])
        self.raw('DELETE FROM violations_licensecustodyevent')
        self.raw('TRUNCATE violations_licensecustodyevent CASCADE')

    def test_custody_delete_blocked_orm_and_sql(self):
        with self.assertRaises(CustodyIntegrityError):
            self.c.delete()
        with self.assertRaises(CustodyIntegrityError):
            LicenseCustody.objects.all().delete()
        self.raw('DELETE FROM violations_licensecustody')

    def test_status_regression_blocked(self):
        self.raw("UPDATE violations_licensecustody SET status = 'ready_for_release' WHERE id = %s", [self.c.pk])
        self.raw("UPDATE violations_licensecustody SET status = 'confiscated', ready_marked_at = NULL "
                 "WHERE id = %s", [self.c.pk])

    def test_ready_and_released_fields_immutable(self):
        for col, val in (("released_to_name", "'Someone Else'"), ("released_at", "now()"),
                         ("claimant_id_last4", "'0000'"), ("authorization_reference", "'X'"),
                         ("ready_marked_at", "now()"), ("release_remarks", "'edited'")):
            self.raw(f"UPDATE violations_licensecustody SET {col} = {val} WHERE id = %s", [self.c.pk])

    def test_descriptive_column_remains_editable_and_forward_transition_allowed(self):
        v2 = self.conf(ovr='OVR-C-2')
        self.assertEqual(self.ready(self.staff, f'v{v2.id}').status_code, 200)   # forward transition
        r = self.post(self.admin, f'v{v2.id}', 'correct', 1, license_number='D99-0000001', reason='typo')
        self.assertEqual(r.status_code, 200)

    def test_atomic_relink_active_to_archived_allowed_reverse_blocked(self):
        v2 = self.conf(ovr='OVR-C-3')
        c2 = LicenseCustody.objects.create(violation=v2, original_violation_id=v2.id)
        a = self.make_archived(v2.id)
        LicenseCustody.objects.filter(pk=c2.pk).update(archived_violation=a, violation=None)
        self.raw("UPDATE violations_licensecustody SET violation_id = %s, archived_violation_id = NULL "
                 "WHERE id = %s", [v2.id, c2.pk])


@PG
class SuperuserBypassAndMigrationTests(CustodyMixin, TransactionTestCase):
    """Needs real transactions (separate superuser connection) - no BaseRole fixtures."""

    def setUp(self):
        self.user = CustomUser.objects.create_user(
            email='s@tmeo.test', password='x', full_name='Staff S', id_number='S-1', role='staff')
        self.vt = ViolationType.objects.create(code='T1', name='T', penalty_amount=1)
        self.v = Violation.objects.create(
            violator_name='A', license_number='L1', ovr_number='O1', date_issued=timezone.now(),
            license_status='confiscated', confiscated_document_type='drivers_license')
        c = LicenseCustody.objects.create(violation=self.v, original_violation_id=self.v.id)
        self.ev = LicenseCustodyEvent.objects.create(
            custody=c, operation='mark_ready', event_type='marked_ready', actor=self.user)

    def superuser(self):
        s = connection.settings_dict
        try:
            conn = psycopg2.connect(dbname=s['NAME'], user='postgres', host=s['HOST'], port=s['PORT'])
        except psycopg2.OperationalError:
            self.skipTest('no superuser connection available')
        conn.autocommit = True
        return conn

    def test_replica_mode_does_not_bypass_event_triggers(self):
        conn = self.superuser()
        cur = conn.cursor()
        cur.execute('SET session_replication_role = replica')
        for sql in ('UPDATE violations_licensecustodyevent SET event_type = %s',
                    'DELETE FROM violations_licensecustodyevent',
                    'TRUNCATE violations_licensecustodyevent CASCADE'):
            with self.assertRaises(psycopg2.Error):
                cur.execute(sql, ['x'] if '%s' in sql else None)
        cur.close()
        conn.close()
        self.assertEqual(LicenseCustodyEvent.objects.count(), 1)

    def test_migration_fails_loudly_for_role_without_privileges(self):
        import importlib
        import types
        mig = importlib.import_module('violations.migrations.0034_license_custody')
        from django.db.backends.postgresql.base import DatabaseWrapper
        s = connection.settings_dict
        su = self.superuser()
        cur = su.cursor()
        cur.execute("DROP ROLE IF EXISTS tmeo_nopriv")
        cur.execute("CREATE ROLE tmeo_nopriv LOGIN PASSWORD 'x'")
        cur.execute(f'GRANT CONNECT ON DATABASE "{s["NAME"]}" TO tmeo_nopriv')
        w = DatabaseWrapper({**s, 'USER': 'tmeo_nopriv', 'PASSWORD': 'x'}, alias='default')
        try:
            with self.assertRaises(RuntimeError) as ctx:
                mig.create_triggers(None, types.SimpleNamespace(connection=w))
            self.assertIn('could not create', str(ctx.exception))
        finally:
            w.close()
            cur.execute(f'REVOKE ALL ON DATABASE "{s["NAME"]}" FROM tmeo_nopriv')
            cur.execute("DROP ROLE IF EXISTS tmeo_nopriv")
            su.close()

    def test_preflight_command_reports_ok_when_protections_installed(self):
        from io import StringIO
        from django.core.management.base import CommandError
        out = StringIO()
        call_command('check_license_custody_protection', stdout=out)
        self.assertIn('Preflight OK.', out.getvalue())
        self.assertIn('license_custody_guard: present', out.getvalue())

    def test_reverse_and_reforward_migration(self):
        def trig_count():
            with connection.cursor() as c:
                c.execute("SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'license_custody%%'")
                return c.fetchone()[0]
        self.assertEqual(trig_count(), 4)
        try:
            call_command('migrate', 'violations', '0033', verbosity=0)
            self.assertEqual(trig_count(), 0)
            with connection.cursor() as c:
                c.execute("SELECT to_regclass('violations_licensecustody')")
                self.assertIsNone(c.fetchone()[0])
        finally:
            call_command('migrate', 'violations', verbosity=0)
        self.assertEqual(trig_count(), 4)
        call_command('migrate', 'violations', verbosity=0)


# ═══════════════════════════════════════════════════════════════════════════
@PG
class WorkflowTests(CustodyMixin, BaseRoleTestCase):
    def test_mark_ready_then_release_full_flow(self):
        v = self.conf()
        k = f'v{v.id}'
        r = self.ready(self.staff, k)
        self.assertEqual((r.status_code, r.data['status'], r.data['version']), (200, 'ready_for_release', 1))
        r = self.post(self.staff, k, 'release', 1, **release_body())
        self.assertEqual((r.status_code, r.data['status']), (200, 'released'))
        self.assertEqual(r.data['release']['claimant_id'], '••••4567')
        c = LicenseCustody.objects.get(violation=v)
        self.assertEqual((c.released_by, c.ready_marked_by), (self.staff, self.staff))
        self.assertEqual(LicenseCustodyEvent.objects.count(), 2)

    def test_admin_may_also_process(self):
        v = self.conf()
        self.assertEqual(self.ready(self.admin, f'v{v.id}').status_code, 200)

    def test_enforcer_forbidden_and_unauthenticated_rejected(self):
        v = self.conf()
        self.assertEqual(self.ready(self.enforcer_a, f'v{v.id}').status_code, 403)
        self.assertEqual(self.as_user(self.enforcer_a).get(BASE).status_code, 403)
        self.client.force_authenticate(None)
        self.assertIn(self.client.get(BASE).status_code, (401, 403))

    def test_cannot_release_before_ready(self):
        v = self.conf()
        r = self.post(self.staff, f'v{v.id}', 'release', 0, **release_body())
        self.assertEqual((r.status_code, r.data['code']), (409, 'not_ready'))
        self.assertFalse(LicenseCustody.objects.filter(violation=v).exists())   # no row left behind

    def test_duplicate_release_blocked(self):
        v = self.conf()
        k = f'v{v.id}'
        self.ready(self.staff, k)
        self.post(self.staff, k, 'release', 1, **release_body())
        r = self.post(self.staff, k, 'release', 2, **release_body())
        self.assertEqual((r.status_code, r.data['code']), (409, 'already_released'))
        self.assertEqual(LicenseCustodyEvent.objects.filter(operation='release').count(), 1)

    def test_stale_version_conflict(self):
        v = self.conf()
        k = f'v{v.id}'
        self.ready(self.staff, k)
        r = self.post(self.staff, k, 'release', 0, **release_body())
        self.assertEqual((r.status_code, r.data['code'], r.data['current_version']), (409, 'version_conflict', 1))

    def test_missing_client_request_id_or_version_is_400(self):
        v = self.conf()
        c = self.as_user(self.staff)
        self.assertEqual(c.post(f'{BASE}v{v.id}/mark-ready/', {'expected_version': 0}, format='json').status_code, 400)
        self.assertEqual(c.post(f'{BASE}v{v.id}/mark-ready/', {'client_request_id': rid()}, format='json').status_code, 400)

    def test_release_validation_and_no_full_id_stored(self):
        v = self.conf()
        k = f'v{v.id}'
        self.ready(self.staff, k)
        for bad in ({'claimant_id_last4': '12345'}, {'claimant_id_last4': '12-4'},
                    {'claimant_id_type': 'sss'}, {'authorization_reference': ''},
                    {'released_to_name': ' '}):
            r = self.post(self.staff, k, 'release', 1, **release_body(**bad))
            self.assertEqual(r.status_code, 400, bad)
        self.assertEqual(LicenseCustody.objects.get(violation=v).status, 'ready_for_release')
        self.post(self.staff, k, 'release', 1, **release_body(claimant_id_last4='A1b2'))
        blob = str(list(LicenseCustodyEvent.objects.values())) + str(list(AuditLog.objects.values('details', 'description')))
        self.assertNotIn('1234567', blob.replace('D01-1234567', ''))   # only the license no. of the record itself

    def test_non_confiscated_or_other_document_is_404(self):
        v = self.conf(doc='umid')
        self.assertEqual(self.ready(self.staff, f'v{v.id}').status_code, 404)
        self.assertEqual(self.ready(self.staff, 'v999999').status_code, 404)
        self.assertEqual(self.ready(self.staff, 'bogus').status_code, 404)

    def test_correct_license_number_audited_and_original_violation_untouched(self):
        v = self.conf()
        before = Violation.objects.filter(pk=v.pk).values().first()
        r = self.post(self.admin, f'v{v.id}', 'correct', 0, license_number='D55-7654321', reason='misread')
        self.assertEqual((r.status_code, r.data['license_number']), (200, 'D55-7654321'))
        self.assertEqual(Violation.objects.filter(pk=v.pk).values().first(), before)
        ev = LicenseCustodyEvent.objects.get()
        self.assertEqual(ev.details['before']['license_number'], 'D01-1234567')
        self.assertTrue(AuditLog.objects.filter(target_type='LicenseCustody').exists())

    def test_correct_blocked_for_archived_records(self):
        a = self.make_archived(700)
        r = self.post(self.admin, f'a{a.id}', 'correct', 0, license_number='X1', reason='r')
        self.assertEqual((r.status_code, r.data['code']), (409, 'archived_locked'))

    def test_archived_record_stays_releasable_and_old_key_resolves(self):
        a = self.make_archived(701)
        k = f'a{a.id}'
        self.assertEqual(self.ready(self.staff, k).status_code, 200)
        r = self.post(self.staff, k, 'release', 1, **release_body())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.as_user(self.staff).get(f'{BASE}v701/').data['status'], 'released')


# ═══════════════════════════════════════════════════════════════════════════
@PG
class IdempotencyTests(CustodyMixin, BaseRoleTestCase):
    def test_replay_returns_200_replayed_without_new_event(self):
        v = self.conf()
        k, req = f'v{v.id}', rid()
        first = self.post(self.staff, k, 'mark-ready', 0, request_id=req)
        again = self.post(self.staff, k, 'mark-ready', 0, request_id=req)
        self.assertEqual((first.data['replayed'], again.status_code, again.data['replayed']), (False, 200, True))
        self.assertEqual(LicenseCustodyEvent.objects.count(), 1)
        self.assertEqual(LicenseCustody.objects.get(violation=v).version, 1)

    def test_conflicting_reuse_is_409(self):
        v1, v2 = self.conf(), self.conf(ovr='OVR-C-2')
        req = rid()
        self.post(self.staff, f'v{v1.id}', 'mark-ready', 0, request_id=req)
        # different target
        r = self.post(self.staff, f'v{v2.id}', 'mark-ready', 0, request_id=req)
        self.assertEqual((r.status_code, r.data['code']), (409, 'idempotency_conflict'))
        # different operation
        r = self.post(self.staff, f'v{v1.id}', 'release', 1, request_id=req, **release_body())
        self.assertEqual(r.data['code'], 'idempotency_conflict')
        # different payload (expected_version)
        r = self.post(self.staff, f'v{v1.id}', 'mark-ready', 5, request_id=req)
        self.assertEqual(r.data['code'], 'idempotency_conflict')

    def test_release_payload_change_is_conflict(self):
        v = self.conf()
        k = f'v{v.id}'
        self.ready(self.staff, k)
        req = rid()
        self.post(self.staff, k, 'release', 1, request_id=req, **release_body())
        r = self.post(self.staff, k, 'release', 1, request_id=req, **release_body(released_to_name='Other'))
        self.assertEqual(r.data['code'], 'idempotency_conflict')

    def test_same_id_from_different_actor_is_independent_and_leaks_nothing(self):
        v1, v2, v3 = self.conf(), self.conf(ovr='OVR-C-2'), self.conf(ovr='OVR-C-3')
        req = rid()
        self.assertEqual(self.post(self.staff, f'v{v1.id}', 'mark-ready', 0, request_id=req).status_code, 200)
        # Another actor re-using the id on a different record: independent, not a conflict.
        r = self.post(self.admin, f'v{v2.id}', 'mark-ready', 0, request_id=req)
        self.assertEqual((r.status_code, r.data['replayed']), (200, False))
        # Another actor re-using the id on the SAME record: a normal state error,
        # never a replay and never an idempotency_conflict about someone else's request.
        r = self.post(self.enforcer_a.__class__.objects.get(pk=self.staff.pk), f'v{v3.id}', 'mark-ready', 0)
        self.assertEqual(r.status_code, 200)
        other = CustomUser.objects.create_user(email='s2@tmeo.test', password='x', full_name='S2',
                                               id_number='S-2', role='staff')
        r = self.post(other, f'v{v1.id}', 'mark-ready', 0, request_id=req)
        self.assertNotIn('replayed', r.data)
        self.assertEqual(r.data['code'], 'version_conflict')

    def test_replay_after_archive_still_matches(self):
        from database_management.archive_utils import run_archive
        v = self.conf()
        req = rid()
        self.post(self.staff, f'v{v.id}', 'mark-ready', 0, request_id=req)
        run_archive(self.admin)
        again = self.post(self.staff, f'v{v.id}', 'mark-ready', 0, request_id=req)
        self.assertEqual((again.status_code, again.data['replayed']), (200, True))


# ═══════════════════════════════════════════════════════════════════════════
@PG
class LegacyDocumentTests(CustodyMixin, BaseRoleTestCase):
    def test_blank_type_listed_flagged_and_not_releasable_while_pending(self):
        v = self.conf(doc='')
        row = self.listing(self.staff).data['results'][0]
        self.assertTrue(row['document_type_unverified'])
        self.assertEqual(self.listing(self.staff).data['summary']['legacy_unverified'], 1)
        r = self.ready(self.staff, f'v{v.id}')
        self.assertEqual((r.status_code, r.data['code']), (409, 'document_type_unverified'))
        self.assertFalse(LicenseCustody.objects.filter(violation=v).exists())   # rejected action leaves no row
        self.assertTrue(self.as_user(self.staff).get(f'{BASE}v{v.id}/').data['document_type_unverified'])

    def test_staff_confirm_then_release_allowed(self):
        v = self.conf(doc='')
        k = f'v{v.id}'
        before = Violation.objects.filter(pk=v.pk).values().first()
        r = self.post(self.staff, k, 'verify-document-type', 0, decision='drivers_license', reason='saw the card')
        self.assertEqual((r.status_code, r.data['doc_type_status']), (200, 'confirmed_drivers_license'))
        self.assertEqual(self.ready(self.staff, k, 1).status_code, 200)
        self.assertEqual(Violation.objects.filter(pk=v.pk).values().first(), before)   # row byte-identical

    def test_only_admin_may_exclude_and_reason_required(self):
        v = self.conf(doc='')
        k = f'v{v.id}'
        r = self.post(self.staff, k, 'verify-document-type', 0, decision='not_drivers_license', reason='x')
        self.assertEqual((r.status_code, r.data['code']), (403, 'admin_required'))
        self.assertFalse(LicenseCustody.objects.filter(violation=v).exists())
        self.assertEqual(self.post(self.admin, k, 'verify-document-type', 0,
                                   decision='not_drivers_license', reason=' ').status_code, 400)
        r = self.post(self.admin, k, 'verify-document-type', 0, decision='not_drivers_license', reason='PRC ID')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.listing(self.staff).data['count'], 0)                      # hidden by default
        self.assertEqual(self.listing(self.admin, include_excluded='1').data['count'], 1)
        self.assertEqual(self.listing(self.staff, include_excluded='1').data['count'], 0)  # staff cannot opt in
        r = self.ready(self.admin, k, 1)
        self.assertEqual(r.data['code'], 'record_excluded')

    def test_verification_only_when_pending(self):
        v = self.conf()                         # explicit driver's license: nothing to verify
        r = self.post(self.staff, f'v{v.id}', 'verify-document-type', 0, decision='drivers_license', reason='r')
        self.assertEqual(r.data['code'], 'verification_not_pending')

    def test_legacy_filter(self):
        self.conf(doc='', ovr='L1')
        self.conf(doc='drivers_license', ovr='L2')
        self.assertEqual(self.listing(self.staff, legacy='only').data['count'], 1)
        self.assertEqual(self.listing(self.staff, legacy='exclude').data['count'], 1)

    def test_snapshot_missing_json_key_qualifies_as_legacy(self):
        a = self.make_archived(800)
        del a.data['confiscated_document_type']
        a.save()
        rows = self.listing(self.staff, legacy='only').data['results']
        self.assertEqual([r['key'] for r in rows], [f'a{a.id}'])
        self.assertEqual(self.ready(self.staff, f'a{a.id}').data['code'], 'document_type_unverified')


# ═══════════════════════════════════════════════════════════════════════════
@PG
class ListingTests(CustodyMixin, BaseRoleTestCase):
    def build(self):
        now = timezone.now()
        self.active = [self.conf(ovr=f'A{i}', status='pending', date_issued=now - timedelta(days=i))
                       for i in range(1, 5)]
        self.active.append(self.conf(ovr='SAME', status='pending', date_issued=now))   # same date as another row
        self.conf(ovr='NOTCONF', status='pending')
        Violation.objects.filter(ovr_number='NOTCONF').update(license_status='not_confiscated')
        self.conf(ovr='UMID', doc='umid')                              # other document: not listed
        a_cust = self.make_archived(901)                               # S2: archived + custody
        LicenseCustody.objects.create(archived_violation=a_cust, original_violation_id=901)
        self.s3 = [self.make_archived(902 + i, date_issued=now - timedelta(days=50 + i)) for i in range(3)]
        self.make_archived(910, data={'license_status': 'Not Confiscated'})        # not qualifying
        self.make_archived(911, data={'confiscated_document_type': 'umid'})         # not a license
        twin = self.active[0]                                                       # S3 with active twin: excluded
        self.make_archived(twin.id, date_issued=twin.date_issued)
        self.expected = {f'v{v.id}' for v in self.active} | {f'a{a_cust.id}'} | {f'a{a.id}' for a in self.s3}

    def test_each_record_exactly_once_across_pages_and_summary_matches(self):
        self.build()
        seen, page = [], 1
        while True:
            d = self.listing(self.staff, page=page, page_size=3).data
            seen += [r['key'] for r in d['results']]
            if len(d['results']) < 3:
                break
            page += 1
        self.assertEqual(len(seen), len(set(seen)), 'a record appeared twice')
        self.assertEqual(set(seen), self.expected)
        s = self.listing(self.staff).data['summary']
        self.assertEqual(s['total'], len(seen))
        self.assertEqual(s['confiscated'] + s['pending_release'] + s['released'], s['total'])
        self.assertEqual(self.as_user(self.staff).get(BASE + 'summary/').data, s)

    def test_ordering_is_date_desc_then_key_stable(self):
        self.build()
        full = [r['key'] for r in self.listing(self.staff, page_size=100).data['results']]
        paged = []
        for p in range(1, 20):
            rows = self.listing(self.staff, page=p, page_size=2).data['results']
            if not rows:
                break
            paged += [r['key'] for r in rows]
        self.assertEqual(full, paged)

    def test_active_record_with_custody_appears_once_with_derived_status(self):
        v = self.conf()
        self.ready(self.staff, f'v{v.id}')
        rows = self.listing(self.staff).data['results']
        self.assertEqual([(r['key'], r['status']) for r in rows], [(f'v{v.id}', 'ready_for_release')])
        self.assertEqual(self.listing(self.staff, status='released').data['count'], 0)

    def test_search_and_date_filters(self):
        self.conf(ovr='T-2024-001', date_issued=timezone.now() - timedelta(days=10))
        self.conf(ovr='T-2024-002', date_issued=timezone.now() - timedelta(days=2))
        self.assertEqual(self.listing(self.staff, search='2024-002').data['count'], 1)
        day = (timezone.now() - timedelta(days=2)).astimezone().strftime('%Y-%m-%d')
        self.assertGreaterEqual(self.listing(self.staff, date_from=day).data['count'], 1)

    def test_no_overdue_policy_anywhere(self):
        """No automatic overdue classification, KPI or filter (not an approved policy)."""
        self.conf(ovr='OLD', status='pending', date_issued=timezone.now() - timedelta(days=400))
        self.conf(ovr='NEW', status='pending', date_issued=timezone.now() - timedelta(days=3))
        for user in (self.admin, self.staff):
            d = self.listing(user).data
            self.assertNotIn('overdue', d['summary'])
            for r in d['results']:
                self.assertFalse([k for k in r if 'overdue' in k.lower()])
            self.assertEqual(self.listing(user, overdue='1').data['count'], d['count'])   # param is ignored
            self.assertEqual(self.listing(user, status='overdue').data['count'], d['count'])
            self.assertNotIn('overdue', str(self.as_user(user).get(BASE + 'summary/').data))

    def test_admin_sees_neutral_days_held_staff_does_not(self):
        self.conf(ovr='OLD', status='pending', date_issued=timezone.now() - timedelta(days=45))
        a, s = self.listing(self.admin).data, self.listing(self.staff).data
        self.assertEqual(a['results'][0]['days_held'], 45)
        self.assertNotIn('days_held', s['results'][0])


# ═══════════════════════════════════════════════════════════════════════════
@PG
class TimelineVisibilityTests(CustodyMixin, BaseRoleTestCase):
    def test_staff_limited_admin_full_and_history_admin_only(self):
        v = self.conf()
        k = f'v{v.id}'
        self.post(self.admin, k, 'correct', 0, license_number='D77-1', reason='secret reason')
        s = self.as_user(self.staff).get(f'{BASE}{k}/timeline/').data['results'][0]
        self.assertEqual(set(s), {'id', 'event_type', 'created_at', 'actor_name', 'from_status', 'to_status'})
        a = self.as_user(self.admin).get(f'{BASE}{k}/timeline/').data['results'][0]
        self.assertEqual(a['details']['reason'], 'secret reason')
        self.assertEqual(self.as_user(self.staff).get(BASE + 'history/').status_code, 403)
        h = self.as_user(self.admin).get(BASE + 'history/').data
        self.assertEqual((len(h['events']), len(h['audit_log'])), (1, 1))


# ═══════════════════════════════════════════════════════════════════════════
@PG
class ConfiscationLockTests(CustodyMixin, BaseRoleTestCase):
    def patch(self, user, v, **data):
        return self.as_user(user).patch(f'/api/violations/{v.id}/', data, format='json')

    def test_paid_ticket_locks_changes_but_allows_unrelated_and_unchanged(self):
        v = self.conf(status='paid')
        r = self.patch(self.staff, v, license_number='CHANGED')
        self.assertEqual((r.status_code, r.data['code']), (409, 'confiscation_locked'))
        v.refresh_from_db()
        self.assertEqual(v.license_number, 'D01-1234567')
        self.assertEqual(self.patch(self.staff, v, remarks='note').status_code, 200)               # unrelated
        self.assertEqual(self.patch(self.staff, v, license_number='D01-1234567').status_code, 200)  # unchanged value

    def test_custody_row_locks_pending_ticket(self):
        v = self.conf(status='pending')
        self.assertEqual(self.patch(self.staff, v, license_number='D02-1').status_code, 200)   # before custody
        LicenseCustody.objects.create(violation=v, original_violation_id=v.id)
        self.assertEqual(self.patch(self.staff, v, license_number='D03-1').status_code, 409)
        self.assertEqual(self.patch(self.staff, v, license_status='not_confiscated').status_code, 409)
        self.assertEqual(self.patch(self.staff, v, remarks='ok').status_code, 200)

    def test_enforcer_prepayment_edits_unaffected(self):
        v = self.conf(status='pending', enforcer=self.enforcer_a)
        r = self.patch(self.enforcer_a, v, license_number='D04-9')
        self.assertEqual(r.status_code, 200)

    def test_pre_save_backstop_blocks_orm_changes_but_not_unrelated_saves(self):
        v = self.conf(status='paid')
        v = Violation.objects.get(pk=v.pk)
        v.license_number = 'HACK'
        with self.assertRaises(ConfiscationLockedError):
            v.save()
        v = Violation.objects.get(pk=v.pk)
        v.remarks = 'fine'
        v.save()                                                       # unrelated edit passes
        v.save(update_fields=['remarks'])
        v.license_number = 'x'
        v.save(update_fields=['remarks'])                              # field not in update_fields -> not written
        self.assertEqual(Violation.objects.get(pk=v.pk).license_number, 'D01-1234567')

    def test_backstop_allows_the_paid_transition_itself(self):
        v = self.conf(status='pending')
        v.license_number = 'D09-1'
        v.status = 'paid'
        v.save()                                  # pending in DB -> not locked yet
        self.assertEqual(Violation.objects.get(pk=v.pk).license_number, 'D09-1')

    def test_admin_makes_confiscation_fields_readonly_when_locked(self):
        ma = admin_site._registry[Violation]
        req = RequestFactory().get('/')
        req.user = self.admin
        free = self.conf(status='pending', ovr='F1')
        locked = self.conf(status='paid', ovr='P1')
        self.assertNotIn('license_number', ma.get_readonly_fields(req, free))
        self.assertIn('license_number', ma.get_readonly_fields(req, locked))
        for m in (LicenseCustody, LicenseCustodyEvent):
            a = admin_site._registry[m]
            self.assertFalse(a.has_add_permission(req) or a.has_change_permission(req) or a.has_delete_permission(req))

    def test_assessment_patch_still_works(self):
        v = self.conf(status='pending')
        LicenseCustody.objects.create(violation=v, original_violation_id=v.id)   # even with custody present
        r = self.as_user(self.staff).patch(f'/api/violations/{v.id}/assess/',
                                           {'status': 'processing', 'assessment_notes': 'n'}, format='json')
        self.assertEqual(r.status_code, 200)


# ═══════════════════════════════════════════════════════════════════════════
@PG
class UserDeletionGuardTests(CustodyMixin, BaseRoleTestCase):
    def test_custody_actions_count_as_history(self):
        fresh = CustomUser.objects.create_user(
            email='newstaff@tmeo.test', password='x', full_name='New Staff', id_number='NS-1', role='staff')
        self.assertFalse(get_user_historical_references(fresh)['has_history'])
        v = self.conf()
        self.ready(fresh, f'v{v.id}')
        refs = get_user_historical_references(fresh)
        self.assertIn('license_custody', refs['categories'])
        with self.assertRaises(ProtectedError):
            fresh.delete()


# ═══════════════════════════════════════════════════════════════════════════
@PG
class ConcurrencyTests(CustodyMixin, TransactionTestCase):
    def setUp(self):
        def mk(role, n):
            return CustomUser.objects.create_user(
                email=f'{role}{n}@tmeo.test', password='x', full_name=f'{role} {n}',
                id_number=f'CC-{role}-{n}', role=role)
        self.enforcer_a, self.staff, self.admin = mk('enforcer', 1), mk('staff', 1), mk('admin', 1)
        self.vtype = ViolationType.objects.create(code='CC', name='CC', penalty_amount=1)

    def as_user(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def run_threads(self, fns):
        out, bar = [None] * len(fns), threading.Barrier(len(fns))

        def wrap(i, fn):
            try:
                bar.wait(10)
                out[i] = fn()
            except Exception as exc:                    # surfaced by the assertions below
                out[i] = exc
            finally:
                connections.close_all()
        ts = [threading.Thread(target=wrap, args=(i, f)) for i, f in enumerate(fns)]
        [t.start() for t in ts]
        [t.join(60) for t in ts]
        return out

    def test_concurrent_first_call_produces_one_event(self):
        v = self.conf()
        req = rid()
        res = self.run_threads([lambda: self.post(self.staff, f'v{v.id}', 'mark-ready', 0, request_id=req)] * 2)
        self.assertEqual([r.status_code for r in res], [200, 200], res)
        self.assertEqual(sorted(r.data['replayed'] for r in res), [False, True])
        self.assertEqual(LicenseCustodyEvent.objects.count(), 1)
        self.assertEqual(LicenseCustody.objects.get().version, 1)

    def test_concurrent_duplicate_release_only_one_wins(self):
        v = self.conf()
        k = f'v{v.id}'
        self.ready(self.staff, k)
        res = self.run_threads([lambda: self.post(self.staff, k, 'release', 1, **release_body()),
                                lambda: self.post(self.admin, k, 'release', 1, **release_body())])
        self.assertEqual(sorted(r.status_code for r in res), [200, 409], res)
        self.assertEqual(LicenseCustodyEvent.objects.filter(operation='release').count(), 1)

    def test_rejected_requests_commit_nothing_visible_to_another_connection(self):
        """Real commits (TransactionTestCase) and an independent connection: a
        rejected or failed request must not have committed anything."""
        unpaid = self.conf(ovr='RC-U', status='pending')
        legacy = self.conf(ovr='RC-L', doc='')
        paid = self.conf(ovr='RC-P')
        c = APIClient(raise_request_exception=False)
        c.force_authenticate(self.staff)

        def call(user, key, op, version, **body):
            c.force_authenticate(user)
            return c.post(f'{BASE}{key}/{op}/', {'expected_version': version, 'client_request_id': rid(), **body},
                          format='json')
        self.assertEqual(call(self.staff, f'v{unpaid.id}', 'mark-ready', 0).data['code'], 'payment_required')
        self.assertEqual(call(self.staff, f'v{paid.id}', 'mark-ready', 7).data['code'], 'version_conflict')
        self.assertEqual(call(self.staff, f'v{paid.id}', 'release', 0, **release_body()).data['code'], 'not_ready')
        self.assertEqual(call(self.staff, f'v{legacy.id}', 'verify-document-type', 0,
                              decision='not_drivers_license', reason='x').status_code, 403)
        self.assertEqual(call(self.admin, f'v{paid.id}', 'correct', 0, license_number='D01-1234567',
                              reason='same').data['code'], 'no_change')
        with mock.patch('violations.custody.log_action', side_effect=RuntimeError('boom')):
            self.assertEqual(call(self.staff, f'v{paid.id}', 'mark-ready', 0).status_code, 500)

        s = connection.settings_dict
        other = psycopg2.connect(dbname=s['NAME'], user=s['USER'], password=s['PASSWORD'],
                                 host=s['HOST'], port=s['PORT'])
        try:
            cur = other.cursor()
            for table in ('violations_licensecustody', 'violations_licensecustodyevent'):
                cur.execute(f'SELECT count(*) FROM {table}')
                self.assertEqual(cur.fetchone()[0], 0, table)
            cur.execute("SELECT count(*) FROM audit_auditlog WHERE target_type = 'LicenseCustody'")
            self.assertEqual(cur.fetchone()[0], 0)
        finally:
            other.close()

    def test_release_racing_archive_ends_consistent(self):
        from database_management.archive_utils import run_archive
        v = self.conf()
        k = f'v{v.id}'
        self.ready(self.staff, k)
        res = self.run_threads([lambda: self.post(self.staff, k, 'release', 1, **release_body()),
                                lambda: run_archive(self.admin)])
        self.assertEqual(res[0].status_code, 200, res)
        self.assertFalse(isinstance(res[1], Exception), res[1])
        c = LicenseCustody.objects.get()
        self.assertEqual((c.status, c.violation_id is None, c.archived_violation_id is not None),
                         ('released', True, True))
        self.assertFalse(Violation.objects.filter(pk=v.pk).exists())
        self.assertEqual(LicenseCustody.objects.count(), 1)


# ═══════════════════════════════════════════════════════════════════════════
@PG
class PermissionsPaymentGateAndDeleteTests(CustodyMixin, BaseRoleTestCase):
    """Rules added after review: Admin-only corrections, server-side payment gate,
    forward-only workflow, controlled 409 on delete."""

    # -- corrections are Administrator-only ---------------------------------
    def test_staff_cannot_correct_but_can_view_verify_ready_release(self):
        v = self.conf()
        k = f'v{v.id}'
        before = Violation.objects.filter(pk=v.pk).values().first()
        r = self.post(self.staff, k, 'correct', 0, license_number='D55-1', reason='x')
        self.assertEqual(r.status_code, 403)
        self.assertFalse(LicenseCustody.objects.exists() or LicenseCustodyEvent.objects.exists())
        self.assertEqual(Violation.objects.filter(pk=v.pk).values().first(), before)
        self.assertEqual(self.as_user(self.staff).get(f'{BASE}{k}/').status_code, 200)       # view
        self.assertEqual(self.ready(self.staff, k).status_code, 200)                         # mark ready
        self.assertEqual(self.post(self.staff, k, 'release', 1, **release_body()).status_code, 200)  # release
        d = self.as_user(self.staff).get(f'{BASE}{k}/').data
        self.assertFalse(d['can_correct'])
        # staff still blocked after the record exists, and nothing changed
        self.assertEqual(self.post(self.staff, k, 'correct', 2, license_number='D55-2', reason='x').status_code, 403)
        self.assertEqual(LicenseCustody.objects.get().corrected_license_number, '')

    def test_staff_can_verify_legacy_document_type(self):
        v = self.conf(doc='')
        r = self.post(self.staff, f'v{v.id}', 'verify-document-type', 0, decision='drivers_license', reason='saw it')
        self.assertEqual(r.status_code, 200)

    def test_enforcer_and_anonymous_cannot_correct(self):
        v = self.conf()
        self.assertEqual(self.post(self.enforcer_a, f'v{v.id}', 'correct', 0, license_number='X', reason='r').status_code, 403)
        self.client.force_authenticate(None)
        r = self.client.post(f'{BASE}v{v.id}/correct/', {'expected_version': 0, 'client_request_id': rid(),
                             'license_number': 'X', 'reason': 'r'}, format='json')
        self.assertIn(r.status_code, (401, 403))

    def test_admin_can_correct_and_detail_advertises_it(self):
        v = self.conf()
        r = self.post(self.admin, f'v{v.id}', 'correct', 0, license_number='D55-9', reason='misread')
        self.assertEqual((r.status_code, r.data['can_correct']), (200, True))

    def test_service_layer_also_refuses_non_admin_correction(self):
        from violations.custody import CustodyError, execute
        v = self.conf()
        with self.assertRaises(CustodyError) as ctx:
            execute(self.staff, 'correct', f'v{v.id}', 0, uuid.uuid4(), {'license_number': 'X', 'reason': 'r'})
        self.assertEqual((ctx.exception.code, ctx.exception.status), ('admin_required', 403))
        self.assertFalse(LicenseCustody.objects.exists())

    # -- payment gate -------------------------------------------------------
    def test_unpaid_records_cannot_be_marked_ready(self):
        for status in ('pending', 'processing'):
            v = self.conf(ovr=f'U-{status}', status=status)
            for user in (self.staff, self.admin):
                r = self.ready(user, f'v{v.id}')
                self.assertEqual((r.status_code, r.data['code']), (409, 'payment_required'), (status, user.role))
            self.assertFalse(LicenseCustody.objects.filter(violation=v).exists())
        self.assertEqual(LicenseCustodyEvent.objects.count(), 0)

    def test_unpaid_record_cannot_be_released_even_if_a_ready_row_exists(self):
        v = self.conf(status='pending')
        LicenseCustody.objects.create(
            violation=v, original_violation_id=v.id, status='ready_for_release',
            ready_marked_by=self.staff, ready_marked_at=timezone.now(), version=1)
        r = self.post(self.staff, f'v{v.id}', 'release', 1, **release_body())
        self.assertEqual((r.status_code, r.data['code']), (409, 'payment_required'))
        self.assertEqual(LicenseCustody.objects.get().status, 'ready_for_release')

    def test_paid_record_can_be_marked_ready(self):
        v = self.conf(status='paid')
        self.assertEqual(self.ready(self.staff, f'v{v.id}').status_code, 200)

    def test_payment_alone_never_marks_ready_or_releases(self):
        v = self.conf(status='pending')
        k = f'v{v.id}'
        self.assertEqual(self.ready(self.staff, k).status_code, 409)
        Violation.objects.filter(pk=v.pk).update(status='paid')            # payment happens
        row = self.listing(self.staff).data['results'][0]
        self.assertEqual(row['status'], 'confiscated')                      # still In Custody
        self.assertFalse(LicenseCustody.objects.exists())
        self.assertEqual(self.post(self.staff, k, 'release', 0, **release_body()).data['code'], 'not_ready')
        self.assertEqual(self.ready(self.staff, k).status_code, 200)        # needs the explicit action
        self.assertEqual(LicenseCustody.objects.get().status, 'ready_for_release')

    def test_archived_unsettled_snapshot_cannot_be_marked_ready(self):
        a = self.make_archived(810, settlement_status='unsettled')
        r = self.ready(self.staff, f'a{a.id}')
        self.assertEqual((r.status_code, r.data['code']), (409, 'payment_required'))
        self.assertFalse(LicenseCustody.objects.exists())

    def test_archived_settled_snapshot_uses_historical_payment_data(self):
        a = self.make_archived(811, settlement_status='settled')
        self.assertEqual(self.ready(self.staff, f'a{a.id}').status_code, 200)

    def test_record_archived_while_paid_stays_gated_correctly(self):
        from database_management.archive_utils import run_archive
        v = self.conf(status='paid')
        run_archive(self.admin)
        a = ArchivedViolation.objects.get(original_violation_id=v.id)
        self.assertEqual(a.settlement_status, 'settled')
        self.assertEqual(self.ready(self.staff, f'v{v.id}').status_code, 200)   # old key, historical payment

    # -- forward-only workflow ---------------------------------------------
    def test_workflow_is_forward_only(self):
        v = self.conf()
        k = f'v{v.id}'
        self.assertEqual(self.post(self.staff, k, 'release', 0, **release_body()).data['code'], 'not_ready')
        self.ready(self.staff, k)
        again = self.ready(self.staff, k, 1)                                 # new request id, same step
        self.assertEqual((again.status_code, again.data['code']), (409, 'invalid_transition'))
        self.post(self.staff, k, 'release', 1, **release_body())
        self.assertEqual(self.ready(self.staff, k, 2).data['code'], 'invalid_transition')   # no way back
        self.assertEqual(self.post(self.staff, k, 'release', 2, **release_body()).data['code'], 'already_released')
        self.assertEqual(LicenseCustody.objects.get().status, 'released')
        self.assertEqual(list(LicenseCustodyEvent.objects.values_list('event_type', flat=True)),
                         ['marked_ready', 'released'])

    # -- DELETE returns a controlled 409 -----------------------------------
    def delete(self, user, v):
        c = APIClient(raise_request_exception=False)       # a server traceback would surface as 500
        c.force_authenticate(user)
        return c.delete(f'/api/violations/{v.id}/')

    def test_delete_pending_violation_with_custody_is_controlled_409(self):
        v = self.conf(status='pending')
        LicenseCustody.objects.create(violation=v, original_violation_id=v.id)
        audit_before = AuditLog.objects.filter(action='DELETE').count()
        r = self.delete(self.admin, v)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.data['code'], 'custody_protected')
        self.assertIn('cannot be deleted', r.data['detail'])
        self.assertNotIn('Traceback', str(r.data))
        self.assertTrue(Violation.objects.filter(pk=v.pk).exists())
        self.assertEqual(LicenseCustody.objects.count(), 1)
        self.assertEqual(AuditLog.objects.filter(action='DELETE').count(), audit_before)   # no false DELETE entry

    def test_delete_pending_violation_without_custody_still_works(self):
        v = self.conf(status='pending')
        self.assertEqual(self.delete(self.admin, v).status_code, 204)
        self.assertFalse(Violation.objects.filter(pk=v.pk).exists())

    def test_delete_paid_violation_still_rejected_as_before(self):
        v = self.conf(status='paid')
        self.assertEqual(self.delete(self.admin, v).status_code, 400)


# ═══════════════════════════════════════════════════════════════════════════
@PG
class RejectedRequestRollbackTests(CustodyMixin, BaseRoleTestCase):
    """Every rejected request must leave NOTHING behind: no custody row, no event,
    no audit entry, no change to any violation / archive row, no version bump."""

    def state(self):
        return {
            'custody': list(LicenseCustody.objects.order_by('pk').values()),
            'events': list(LicenseCustodyEvent.objects.order_by('pk').values()),
            'audit': list(AuditLog.objects.order_by('pk').values_list('pk', flat=True)),
            'violations': list(Violation.objects.order_by('pk').values()),
            'archived': list(ArchivedViolation.objects.order_by('pk').values()),
        }

    def rejected(self, user, key, op, version, status, code, **body):
        before = self.state()
        r = self.post(user, key, op, version, **body)
        self.assertEqual(r.status_code, status, (op, key, r.data))
        if code:
            self.assertEqual(r.data.get('code'), code, (op, key, r.data))
        self.assertEqual(self.state(), before, f'{op} {key} -> {code or status} left something behind')
        return r

    # -- mark-ready ---------------------------------------------------------
    def test_unpaid_mark_ready_leaves_nothing_behind(self):
        for st in ('pending', 'processing'):
            v = self.conf(ovr=f'RB-{st}', status=st)
            for u in (self.staff, self.admin):
                self.rejected(u, f'v{v.id}', 'mark-ready', 0, 409, 'payment_required')
        a = self.make_archived(820, settlement_status='unsettled')
        self.rejected(self.staff, f'a{a.id}', 'mark-ready', 0, 409, 'payment_required')

    def test_unpaid_release_with_existing_custody_changes_nothing(self):
        v = self.conf(status='pending')
        LicenseCustody.objects.create(violation=v, original_violation_id=v.id, status='ready_for_release',
                                      ready_marked_by=self.staff, ready_marked_at=timezone.now(), version=1)
        self.rejected(self.staff, f'v{v.id}', 'release', 1, 409, 'payment_required', **release_body())

    def test_invalid_transitions_leave_nothing_behind(self):
        v = self.conf()
        k = f'v{v.id}'
        self.rejected(self.staff, k, 'release', 0, 409, 'not_ready', **release_body())     # no row yet
        self.ready(self.staff, k)
        self.rejected(self.staff, k, 'mark-ready', 1, 409, 'invalid_transition')           # already ready
        self.post(self.staff, k, 'release', 1, **release_body())
        self.rejected(self.staff, k, 'mark-ready', 2, 409, 'invalid_transition')           # after release
        self.rejected(self.staff, k, 'release', 2, 409, 'already_released', **release_body())

    def test_stale_versions_leave_nothing_behind(self):
        v = self.conf()
        k = f'v{v.id}'
        # no custody row exists yet: a wrong expected_version must not leave the lazily created row
        self.rejected(self.staff, k, 'mark-ready', 3, 409, 'version_conflict')
        self.rejected(self.admin, k, 'correct', 2, 409, 'version_conflict', license_number='D1-1', reason='r')
        self.ready(self.staff, k)                                                           # row now at version 1
        self.rejected(self.staff, k, 'release', 0, 409, 'version_conflict', **release_body())
        self.rejected(self.admin, k, 'correct', 0, 409, 'version_conflict', license_number='D1-1', reason='r')
        lv = self.conf(ovr='RB-LEG', doc='')
        self.rejected(self.staff, f'v{lv.id}', 'verify-document-type', 4, 409, 'version_conflict',
                      decision='drivers_license', reason='r')

    def test_invalid_legacy_verification_leaves_nothing_behind(self):
        legacy = self.conf(ovr='RB-L', doc='')
        lk = f'v{legacy.id}'
        self.rejected(self.staff, lk, 'verify-document-type', 0, 403, 'admin_required',
                      decision='not_drivers_license', reason='PRC ID')           # staff cannot exclude
        self.rejected(self.admin, lk, 'verify-document-type', 0, 400, None,
                      decision='not_drivers_license', reason='   ')              # blank reason
        self.rejected(self.admin, lk, 'verify-document-type', 0, 400, None, decision='maybe', reason='r')
        regular = self.conf(ovr='RB-R')                                          # nothing to verify
        self.rejected(self.staff, f'v{regular.id}', 'verify-document-type', 0, 409, 'verification_not_pending',
                      decision='drivers_license', reason='r')
        self.post(self.staff, lk, 'verify-document-type', 0, decision='drivers_license', reason='saw it')
        self.rejected(self.admin, lk, 'verify-document-type', 1, 409, 'verification_not_pending',
                      decision='not_drivers_license', reason='changed my mind')  # already verified

    def test_invalid_corrections_leave_nothing_behind(self):
        v = self.conf()
        k = f'v{v.id}'
        self.rejected(self.staff, k, 'correct', 0, 403, None, license_number='D2-2', reason='r')
        self.rejected(self.admin, k, 'correct', 0, 400, None, license_number=' ', reason='r')
        self.rejected(self.admin, k, 'correct', 0, 400, None, license_number='D2-2', reason=' ')
        a = self.make_archived(830)
        self.rejected(self.admin, f'a{a.id}', 'correct', 0, 409, 'archived_locked', license_number='D2-2', reason='r')
        self.rejected(self.admin, 'v99999999', 'correct', 0, 404, 'not_found', license_number='D2-2', reason='r')

    def test_noop_correction_is_rejected_without_side_effects(self):
        v = self.conf()
        k = f'v{v.id}'
        self.rejected(self.admin, k, 'correct', 0, 409, 'no_change', license_number='D01-1234567', reason='same')
        self.post(self.admin, k, 'correct', 0, license_number='D9-9', reason='fix')
        self.rejected(self.admin, k, 'correct', 1, 409, 'no_change', license_number='D9-9', reason='same again')

    def test_validation_errors_and_idempotency_conflict_leave_nothing_behind(self):
        v = self.conf()
        k = f'v{v.id}'
        before = self.state()
        self.assertEqual(self.as_user(self.staff).post(f'{BASE}{k}/mark-ready/', {}, format='json').status_code, 400)
        self.assertEqual(self.state(), before)
        req = rid()
        self.post(self.staff, k, 'mark-ready', 0, request_id=req)
        self.rejected(self.staff, k, 'release', 1, 409, 'idempotency_conflict', request_id=req, **release_body())

    # -- real transaction rollback (failure injected AFTER the data was written) ----
    def _boom(self, op, version=0, **body):
        c = APIClient(raise_request_exception=False)
        c.force_authenticate(self.staff if op != 'correct' else self.admin)
        data = {'expected_version': version, 'client_request_id': rid(), **body}
        with mock.patch('violations.custody.log_action', side_effect=RuntimeError('audit down')):
            return c.post(f'{BASE}{self._key}/{op}/', data, format='json')

    def test_failure_after_writes_rolls_everything_back(self):
        v = self.conf()
        self._key = f'v{v.id}'
        before = self.state()
        self.assertEqual(self._boom('mark-ready').status_code, 500)
        self.assertEqual(self.state(), before)                       # row, event and version bump all rolled back
        self.ready(self.staff, self._key)
        mid = self.state()
        self.assertEqual(self._boom('release', 1, **release_body()).status_code, 500)
        self.assertEqual(self.state(), mid)
        self.assertEqual(self._boom('correct', 1, license_number='D8-8', reason='r').status_code, 500)
        self.assertEqual(self.state(), mid)
        # and the failed attempts did not poison later work
        self.assertEqual(self.post(self.staff, self._key, 'release', 1, **release_body()).status_code, 200)

    def test_failure_during_event_insert_rolls_back_the_state_change(self):
        v = self.conf()
        before = self.state()
        c = APIClient(raise_request_exception=False)
        c.force_authenticate(self.staff)
        with mock.patch.object(LicenseCustodyEvent.objects, 'create', side_effect=RuntimeError('disk full')):
            r = c.post(f'{BASE}v{v.id}/mark-ready/', {'expected_version': 0, 'client_request_id': rid()}, format='json')
        self.assertEqual(r.status_code, 500)
        self.assertEqual(self.state(), before)


# ═══════════════════════════════════════════════════════════════════════════
@PG
class CorrectionConsistencyTests(CustodyMixin, BaseRoleTestCase):
    """An Admin correction lives on the custody row. It must show the same
    everywhere in the module while the Violation row and the archive snapshot
    keep the originally recorded value."""
    ORIG, NEW = 'D01-1234567', 'D55-7654321'

    def correct(self, v, new=None, version=0):
        r = self.post(self.admin, f'v{v.id}', 'correct', version, license_number=new or self.NEW, reason='misread')
        self.assertEqual(r.status_code, 200, r.data)
        return r

    def rows(self, user, **p):
        return self.listing(user, **p).data['results']

    def test_correction_shows_in_detail_list_and_search_for_both_roles(self):
        v = self.conf()
        k = f'v{v.id}'
        before_violation = Violation.objects.filter(pk=v.pk).values().first()
        r = self.correct(v)
        self.assertEqual(r.data['license_number'], self.NEW)
        for u in (self.admin, self.staff):
            self.assertEqual(self.as_user(u).get(f'{BASE}{k}/').data['license_number'], self.NEW)
            self.assertEqual([x['license_number'] for x in self.rows(u)], [self.NEW])
            self.assertEqual([x['key'] for x in self.rows(u, search=self.NEW)], [k])
            self.assertEqual([x['key'] for x in self.rows(u, search=self.NEW.lower())], [k])
            self.assertEqual(self.rows(u, search=self.ORIG), [])        # search follows the effective number
        self.assertEqual(Violation.objects.filter(pk=v.pk).values().first(), before_violation)   # original preserved

    def test_second_correction_chain_is_audited_with_previous_value(self):
        v = self.conf()
        self.correct(v, 'D10-0000001')
        self.correct(v, 'D20-0000002', version=1)
        evs = list(LicenseCustodyEvent.objects.order_by('id'))
        self.assertEqual([(e.details['before']['license_number'], e.details['after']['license_number']) for e in evs],
                         [(self.ORIG, 'D10-0000001'), ('D10-0000001', 'D20-0000002')])
        self.assertEqual([x['license_number'] for x in self.rows(self.staff)], ['D20-0000002'])

    def test_staff_cannot_correct_and_nothing_changes(self):
        v = self.conf()
        r = self.post(self.staff, f'v{v.id}', 'correct', 0, license_number=self.NEW, reason='x')
        self.assertEqual(r.status_code, 403)
        self.assertEqual([x['license_number'] for x in self.rows(self.staff)], [self.ORIG])
        self.assertFalse(LicenseCustody.objects.exists())

    def test_correction_survives_archive_in_every_view_and_snapshot_keeps_original(self):
        from database_management.archive_utils import run_archive
        v = self.conf()
        self.correct(v)
        run_archive(self.admin)
        a = ArchivedViolation.objects.get(original_violation_id=v.id)
        # custody views (new key and the old active key)
        for key in (f'a{a.pk}', f'v{v.id}'):
            for u in (self.admin, self.staff):
                d = self.as_user(u).get(f'{BASE}{key}/').data
                self.assertEqual((d['license_number'], d['record_kind']), (self.NEW, 'archived'))
        for u in (self.admin, self.staff):
            rows = self.rows(u)
            self.assertEqual([(x['key'], x['license_number']) for x in rows], [(f'a{a.pk}', self.NEW)])
            self.assertEqual([x['key'] for x in self.rows(u, search=self.NEW)], [f'a{a.pk}'])
            self.assertEqual(self.rows(u, search=self.ORIG), [])
        # historical archive snapshot: preserved exactly as recorded
        a.refresh_from_db()
        self.assertEqual((a.license_number, a.data['license_number']), (self.ORIG, self.ORIG))
        # the generic archive browser is a historical view of the snapshot -> original
        res = self.as_user(self.admin).get('/api/database/archive/records/', {'search': self.ORIG})
        self.assertEqual(res.status_code, 200)
        self.assertIn(self.ORIG, str(res.data))
        self.assertNotIn(self.NEW, str(res.data))

    def test_archived_records_cannot_be_corrected_but_snapshot_only_rows_show_original(self):
        a = self.make_archived(840, license_number='N01-999')
        self.assertEqual([x['license_number'] for x in self.rows(self.admin)], ['N01-999'])
        r = self.post(self.admin, f'a{a.id}', 'correct', 0, license_number='N02-000', reason='r')
        self.assertEqual((r.status_code, r.data['code']), (409, 'archived_locked'))
        self.assertFalse(self.as_user(self.admin).get(f'{BASE}a{a.id}/').data['can_correct'])

    def test_correction_after_release_is_consistent_and_release_data_untouched(self):
        v = self.conf()
        k = f'v{v.id}'
        self.ready(self.staff, k)
        self.post(self.staff, k, 'release', 1, **release_body())
        released = LicenseCustody.objects.values('released_at', 'released_to_name', 'status', 'ready_marked_at').get()
        self.correct(v, version=2)
        self.assertEqual(LicenseCustody.objects.values('released_at', 'released_to_name', 'status', 'ready_marked_at').get(), released)
        self.assertEqual([(x['license_number'], x['status']) for x in self.rows(self.staff)], [(self.NEW, 'released')])

    def test_correction_on_legacy_blank_type_record_keeps_it_unverified(self):
        v = self.conf(doc='')
        self.correct(v)
        row = self.rows(self.staff)[0]
        self.assertEqual((row['license_number'], row['document_type_unverified']), (self.NEW, True))
        self.assertEqual(self.ready(self.staff, f'v{v.id}', 1).data['code'], 'document_type_unverified')

    def test_whitespace_is_trimmed_in_the_stored_correction(self):
        v = self.conf()
        self.correct(v, '  D77-0000007  ')
        self.assertEqual(LicenseCustody.objects.get().corrected_license_number, 'D77-0000007')