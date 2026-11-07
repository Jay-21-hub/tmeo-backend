"""
Phase 1 + addendum — archive safety tests.

Covers: Asia/Manila year, idempotency, id conflicts, verification + rollback,
delete-count check, PostgreSQL advisory lock (BUSY / 409), cross-session and
threaded concurrency, audit status/outcome, and the READ-ONLY inspection
command. Lock/concurrency tests need PostgreSQL and are skipped on SQLite.
"""
import json
import threading
import time
from datetime import datetime, timezone as dt_timezone
from io import StringIO
from unittest import mock

import psycopg2
from django.core.management import call_command
from django.db import connection, connections, transaction
from django.db.models.query import QuerySet
from django.test import TestCase, TransactionTestCase, skipUnlessDBFeature
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken
import unittest

from accounts.models import CustomUser
from audit.models import AuditLog
from violations.models import Violation

from . import archive_utils
from .archive_utils import (
    ARCHIVE_ADVISORY_LOCK_KEY, ArchiveBusyError, ArchiveReconciliationError,
    get_archive_preview, run_archive,
)
from .models import ArchiveBatch, ArchivedViolation

IS_PG = connection.vendor == 'postgresql'
needs_pg = unittest.skipUnless(IS_PG, 'requires PostgreSQL advisory locks')


def mk(**kw):
    d = dict(
        violator_name='Juan Dela Cruz', license_number='N01-23-456789',
        date_issued=datetime(2024, 6, 1, 4, 0, tzinfo=dt_timezone.utc),
        status=Violation.Status.PAID,
    )
    d.update(kw)
    return Violation.objects.create(**d)


def mk_admin(n=1):
    return CustomUser.objects.create_user(
        email=f'adm{n}@example.com', password='pass1234', full_name='Admin',
        id_number=f'2026-ADM-9{n:03d}', role=CustomUser.Role.ADMIN,
    )


def fake_archive_of(v, **over):
    """An ArchivedViolation row that already represents violation `v`."""
    b = ArchiveBatch.objects.create(status='success')
    data = archive_utils._snapshot_violation(v)
    data.update(over.pop('data_over', {}))
    return ArchivedViolation.objects.create(
        batch=b, original_violation_id=v.id,
        violation_year=over.pop('violation_year', 2024),
        date_issued=v.date_issued, settlement_status='settled',
        violator_name=v.violator_name, data=data, **over)


class ArchiveCoreSafetyTests(TestCase):
    def setUp(self):
        self.admin = mk_admin()

    # ── Asia/Manila year ───────────────────────────────────────────────
    def test_year_uses_manila_not_utc(self):
        # 2025-12-31 20:00 UTC == 2026-01-01 04:00 Manila  -> 2026
        v = mk(date_issued=datetime(2025, 12, 31, 20, 0, tzinfo=dt_timezone.utc))
        run_archive(self.admin)
        self.assertEqual(ArchivedViolation.objects.get(original_violation_id=v.id).violation_year, 2026)

    def test_year_boundary_just_before_manila_new_year_stays_old_year(self):
        # 2025-12-31 15:59 UTC == 2025-12-31 23:59 Manila -> 2025
        v = mk(date_issued=datetime(2025, 12, 31, 15, 59, tzinfo=dt_timezone.utc))
        run_archive(self.admin)
        self.assertEqual(ArchivedViolation.objects.get(original_violation_id=v.id).violation_year, 2025)

    def test_preview_year_breakdown_uses_manila_year(self):
        mk(date_issued=datetime(2025, 12, 31, 20, 0, tzinfo=dt_timezone.utc))
        years = [r['year'] for r in get_archive_preview()['year_breakdown']]
        self.assertEqual(years, [2026])

    # ── snapshot content ───────────────────────────────────────────────
    def test_snapshot_keeps_three_confiscated_keys(self):
        v = mk(license_status='confiscated', confiscated_document_type='others',
               confiscated_document_name='Senior ID', confiscated_document_number='SC-77')
        run_archive(self.admin)
        d = ArchivedViolation.objects.get(original_violation_id=v.id).data
        self.assertEqual(d['confiscated_document_type'], 'others')
        self.assertEqual(d['confiscated_document_name'], 'Senior ID')
        self.assertEqual(d['confiscated_document_number'], 'SC-77')

    # ── baseline behaviour kept ────────────────────────────────────────
    def test_in_progress_and_locked_stay_active(self):
        done = mk()
        pend = mk(status=Violation.Status.PENDING)
        proc = mk(status=Violation.Status.PROCESSING)
        locked = mk(locked_by=self.admin)
        batch = run_archive(self.admin)
        self.assertEqual(batch.archived_count, 1)
        self.assertEqual(batch.skipped_in_progress_count, 3)
        self.assertFalse(Violation.objects.filter(pk=done.pk).exists())
        for v in (pend, proc, locked):
            self.assertTrue(Violation.objects.filter(pk=v.pk).exists())

    # ── idempotency ────────────────────────────────────────────────────
    def test_second_run_is_a_noop(self):
        mk(); mk()
        first = run_archive(self.admin)
        second = run_archive(self.admin)
        self.assertEqual(first.archived_count, 2)
        self.assertEqual(second.archived_count, 0)
        self.assertEqual(ArchivedViolation.objects.count(), 2)

    def test_already_archived_same_violation_is_not_archived_twice_and_left_active(self):
        v = mk()
        fake_archive_of(v)                      # same id AND same created_at
        batch = run_archive(self.admin)
        self.assertEqual(batch.archived_count, 0)
        self.assertEqual(batch.skipped_already_archived_count, 1)
        self.assertEqual(batch.archive_conflict_count, 0)
        self.assertEqual(ArchivedViolation.objects.filter(original_violation_id=v.id).count(), 1)
        self.assertTrue(Violation.objects.filter(pk=v.pk).exists())   # nothing destroyed

    def test_conflicting_archive_id_is_reported_and_untouched(self):
        v = mk()
        fake_archive_of(v, data_over={'created_at': '2001-01-01T00:00:00+00:00'})
        batch = run_archive(self.admin)
        self.assertEqual(batch.archive_conflict_count, 1)
        self.assertEqual(batch.skipped_already_archived_count, 0)
        self.assertEqual(batch.archived_count, 0)
        self.assertEqual(ArchivedViolation.objects.filter(original_violation_id=v.id).count(), 1)
        self.assertTrue(Violation.objects.filter(pk=v.pk).exists())

    def test_mixed_run_archives_only_the_clean_records(self):
        clean = mk()
        dup = mk()
        fake_archive_of(dup)
        batch = run_archive(self.admin)
        self.assertEqual(batch.archived_count, 1)
        self.assertEqual(batch.skipped_already_archived_count, 1)
        self.assertFalse(Violation.objects.filter(pk=clean.pk).exists())
        self.assertTrue(Violation.objects.filter(pk=dup.pk).exists())

    def test_preview_reports_already_archived_and_conflicts(self):
        a, b, c = mk(), mk(), mk()
        fake_archive_of(a)
        fake_archive_of(b, data_over={'created_at': '2001-01-01T00:00:00+00:00'})
        p = get_archive_preview()
        self.assertEqual(p['already_archived_active_count'], 1)
        self.assertEqual(p['archive_conflict_count'], 1)
        self.assertEqual(p['eligible_count'], 1)

    # ── verification + transaction rollback ────────────────────────────
    def test_short_bulk_create_rolls_everything_back(self):
        mk(); mk()
        real = ArchivedViolation.objects.bulk_create

        def short(objs, *a, **k):
            return real(list(objs)[:-1], *a, **k)

        with mock.patch.object(type(ArchivedViolation.objects), 'bulk_create', side_effect=short):
            with self.assertRaises(ArchiveReconciliationError):
                run_archive(self.admin)
        self.assertEqual(Violation.objects.count(), 2)
        self.assertEqual(ArchivedViolation.objects.count(), 0)
        self.assertEqual(ArchiveBatch.objects.count(), 0)

    def test_delete_count_mismatch_rolls_everything_back(self):
        mk(); mk()
        with mock.patch.object(QuerySet, 'delete', return_value=(1, {'violations.Violation': 1})):
            with self.assertRaises(ArchiveReconciliationError):
                run_archive(self.admin)
        self.assertEqual(Violation.objects.count(), 2)
        self.assertEqual(ArchivedViolation.objects.count(), 0)
        self.assertEqual(ArchiveBatch.objects.count(), 0)

    def test_unexpected_error_mid_run_rolls_back(self):
        mk(); mk()
        with mock.patch.object(archive_utils, '_snapshot_violation', side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                run_archive(self.admin)
        self.assertEqual(Violation.objects.count(), 2)
        self.assertEqual(ArchivedViolation.objects.count(), 0)

    def test_wrong_year_in_written_rows_is_caught_by_verification(self):
        mk()
        real = ArchivedViolation.objects.bulk_create

        def corrupt(objs, *a, **k):
            objs = list(objs)
            for o in objs:
                o.violation_year = 1999
            return real(objs, *a, **k)

        with mock.patch.object(type(ArchivedViolation.objects), 'bulk_create', side_effect=corrupt):
            with self.assertRaises(ArchiveReconciliationError):
                run_archive(self.admin)
        self.assertEqual(Violation.objects.count(), 1)
        self.assertEqual(ArchivedViolation.objects.count(), 0)

    # ── delete flag ────────────────────────────────────────────────────
    def test_archive_delete_flag_defaults_to_off(self):
        from django.conf import settings
        self.assertFalse(settings.ARCHIVE_DELETE_ENABLED)


@needs_pg
class ArchiveAdvisoryLockTests(APITestCase):
    """The advisory lock is held by a SECOND PostgreSQL session."""

    def setUp(self):
        self.admin = mk_admin()
        s = connection.settings_dict
        self.other = psycopg2.connect(
            dbname=s['NAME'], user=s['USER'], password=s['PASSWORD'],
            host=s['HOST'], port=s['PORT'] or 5432)
        self.other.autocommit = True

    def tearDown(self):
        self.other.close()

    def _hold(self):
        cur = self.other.cursor()
        cur.execute('SELECT pg_advisory_lock(%s)', [ARCHIVE_ADVISORY_LOCK_KEY])

    def _auth(self):
        self.client.credentials(
            HTTP_AUTHORIZATION=f'Bearer {RefreshToken.for_user(self.admin).access_token}')

    def test_busy_when_another_session_holds_the_lock(self):
        mk()
        self._hold()
        with self.assertRaises(ArchiveBusyError):
            run_archive(self.admin)
        self.assertEqual(Violation.objects.count(), 1)
        self.assertEqual(ArchiveBatch.objects.count(), 0)

    def test_view_returns_409_busy_and_audits_a_warning(self):
        mk()
        self._hold()
        self._auth()
        resp = self.client.post(reverse('archive-execute'))
        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(resp.data['status'], 'BUSY')
        log = AuditLog.objects.filter(action='ARCHIVE').latest('timestamp')
        self.assertEqual(log.status, 'WARNING')
        self.assertEqual(log.details['outcome'], 'busy')
        self.assertEqual(Violation.objects.count(), 1)

    def test_works_again_once_the_other_session_releases(self):
        mk()
        self._hold()
        with self.assertRaises(ArchiveBusyError):
            run_archive(self.admin)
        self.other.cursor().execute('SELECT pg_advisory_unlock_all()')
        self.assertEqual(run_archive(self.admin).archived_count, 1)

    def test_lock_does_not_outlive_a_failed_run(self):
        mk()
        with mock.patch.object(archive_utils, '_snapshot_violation', side_effect=RuntimeError('x')):
            with self.assertRaises(RuntimeError):
                run_archive(self.admin)
        # a different session can take the lock immediately => it was released
        cur = self.other.cursor()
        cur.execute('SELECT pg_try_advisory_lock(%s)', [ARCHIVE_ADVISORY_LOCK_KEY])
        self.assertTrue(cur.fetchone()[0])


@needs_pg
class ArchiveConcurrencyTests(TransactionTestCase):
    """Real threads, real separate connections, real commits."""

    def setUp(self):
        self.admin = mk_admin()

    def test_two_simultaneous_runs_only_one_wins_and_nothing_is_duplicated(self):
        for _ in range(5):
            mk()
        start = threading.Barrier(2)
        results = []

        real_snapshot = archive_utils._snapshot_violation

        def slow_snapshot(v):
            time.sleep(0.4)          # keep run #1 inside its transaction
            return real_snapshot(v)

        def worker():
            try:
                start.wait(timeout=10)
                with mock.patch.object(archive_utils, '_snapshot_violation', side_effect=slow_snapshot):
                    b = run_archive(self.admin)
                results.append(('ok', b.archived_count))
            except ArchiveBusyError:
                results.append(('busy', 0))
            except Exception as exc:                      # pragma: no cover
                results.append(('error', repr(exc)))
            finally:
                connections.close_all()

        threads = [threading.Thread(target=worker) for _ in range(2)]
        [t.start() for t in threads]
        [t.join(timeout=30) for t in threads]

        kinds = sorted(r[0] for r in results)
        self.assertEqual(kinds, ['busy', 'ok'], results)
        self.assertEqual(ArchivedViolation.objects.count(), 5)
        self.assertEqual(
            ArchivedViolation.objects.values('original_violation_id').distinct().count(), 5)
        self.assertEqual(Violation.objects.count(), 0)

    def test_sequential_runs_after_commit_do_not_double_archive(self):
        for _ in range(3):
            mk()
        run_archive(self.admin)
        run_archive(self.admin)
        self.assertEqual(ArchivedViolation.objects.count(), 3)

    def test_lock_is_free_after_a_successful_commit(self):
        mk()
        run_archive(self.admin)
        with transaction.atomic():
            with connection.cursor() as cur:
                cur.execute('SELECT pg_try_advisory_xact_lock(%s)', [ARCHIVE_ADVISORY_LOCK_KEY])
                self.assertTrue(cur.fetchone()[0])

    def test_row_lock_blocks_a_concurrent_status_change_until_archive_ends(self):
        """FOR UPDATE: a writer touching an eligible row waits for the archive
        to finish instead of racing it.

        Deterministic: no sleep and no completion-order assertion. (The old
        version compared the order in which two threads appended to a list
        right after COMMIT; the writer's reply can legitimately reach Python
        before the archiver's own COMMIT call returns, so that order is not
        decidable client-side.)  Instead the archiver PARKS on an Event inside
        its transaction, and PostgreSQL itself is asked whether the writer's
        UPDATE is waiting on a lock held by the archiver's backend.
        """
        v = mk(remarks='original')
        entered, release, writer_done = threading.Event(), threading.Event(), threading.Event()
        info = {}
        real_snapshot = archive_utils._snapshot_violation

        def parked(vv):
            if 'pid' not in info:
                with connection.cursor() as cur:
                    cur.execute('select pg_backend_pid()')
                    info['pid'] = cur.fetchone()[0]
                entered.set()
                release.wait(timeout=20)      # stay INSIDE the archive transaction
            return real_snapshot(vv)

        def archiver():
            try:
                with mock.patch.object(archive_utils, '_snapshot_violation', side_effect=parked):
                    info['batch'] = run_archive(self.admin)
            finally:
                connections.close_all()

        def writer():
            try:
                entered.wait(timeout=10)
                info['rows'] = Violation.objects.filter(pk=v.pk).update(remarks='late edit')
                writer_done.set()
            finally:
                connections.close_all()

        ta, tw = threading.Thread(target=archiver), threading.Thread(target=writer)
        ta.start(); tw.start()
        self.assertTrue(entered.wait(timeout=10))

        s = connection.settings_dict
        probe = psycopg2.connect(dbname=s['NAME'], user=s['USER'], password=s['PASSWORD'],
                                 host=s['HOST'], port=s['PORT'], **s.get('OPTIONS', {}))
        probe.autocommit = True
        cur = probe.cursor()
        blocked_by = None
        deadline = time.monotonic() + 5            # bounded poll of PostgreSQL itself
        while time.monotonic() < deadline and not writer_done.is_set():
            cur.execute("""SELECT wait_event_type, pg_blocking_pids(pid) FROM pg_stat_activity
                           WHERE datname = current_database() AND state = 'active'
                             AND query ILIKE 'UPDATE%%remarks%%'""")
            row = cur.fetchone()
            if row and row[0] == 'Lock':
                blocked_by = row[1]
                break
            time.sleep(0.01)
        try:
            # 1) archive transaction still open: the writer is WAITING on a lock
            #    held by the archiver's own backend, and has not completed.
            self.assertFalse(writer_done.is_set(),
                             'writer completed while the archive transaction was open')
            self.assertIsNotNone(blocked_by, 'writer was never observed waiting on a lock')
            self.assertIn(info['pid'], blocked_by)
            self.assertFalse(writer_done.wait(timeout=0.2))
        finally:
            release.set(); ta.join(30); tw.join(30); probe.close()

        # 2) archive finished: the late edit hit an already-archived (removed)
        #    row and never reached the snapshot.
        self.assertTrue(writer_done.is_set())
        self.assertEqual(info['rows'], 0)
        self.assertEqual(info['batch'].archived_count, 1)
        self.assertEqual(
            ArchivedViolation.objects.get(original_violation_id=v.pk).data.get('remarks'),
            'original')

class ArchiveViewAuditTests(APITestCase):
    def setUp(self):
        self.admin = mk_admin()
        self.client.credentials(
            HTTP_AUTHORIZATION=f'Bearer {RefreshToken.for_user(self.admin).access_token}')

    def test_success_response_and_audit(self):
        mk(); mk(status=Violation.Status.PENDING)
        resp = self.client.post(reverse('archive-execute'))
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.data['archived_count'], 1)
        self.assertEqual(resp.data['skipped_in_progress_count'], 1)
        self.assertEqual(resp.data['skipped_already_archived_count'], 0)
        self.assertEqual(resp.data['archive_conflict_count'], 0)
        log = AuditLog.objects.filter(action='ARCHIVE').latest('timestamp')
        self.assertEqual((log.status, log.details['outcome']), ('SUCCESS', 'archived'))

    def test_conflict_is_a_warning_in_audit_and_visible_in_response(self):
        v = mk()
        fake_archive_of(v, data_over={'created_at': '2001-01-01T00:00:00+00:00'})
        resp = self.client.post(reverse('archive-execute'))
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.data['archive_conflict_count'], 1)
        log = AuditLog.objects.filter(action='ARCHIVE').latest('timestamp')
        self.assertEqual((log.status, log.details['outcome']), ('WARNING', 'archived_with_conflicts'))
        self.assertEqual(log.details['archive_conflict_count'], 1)

    def test_nothing_to_archive_outcome(self):
        resp = self.client.post(reverse('archive-execute'))
        self.assertEqual(resp.status_code, 201)
        log = AuditLog.objects.filter(action='ARCHIVE').latest('timestamp')
        self.assertEqual(log.details['outcome'], 'nothing_to_archive')

    def test_reconciliation_failure_is_audited_failed_and_changes_nothing(self):
        mk()
        with mock.patch.object(QuerySet, 'delete', return_value=(0, {})):
            resp = self.client.post(reverse('archive-execute'))
        self.assertEqual(resp.status_code, 500)
        self.assertEqual(resp.data['status'], 'FAILED')
        log = AuditLog.objects.filter(action='ARCHIVE').latest('timestamp')
        self.assertEqual((log.status, log.details['outcome']), ('FAILED', 'reconciliation_failed'))
        self.assertEqual(Violation.objects.count(), 1)
        self.assertEqual(ArchivedViolation.objects.count(), 0)

    def test_overview_exposes_new_counts(self):
        v = mk()
        fake_archive_of(v)
        data = self.client.get(reverse('archive-overview')).data
        self.assertEqual(data['already_archived_active_count'], 1)
        self.assertEqual(data['archive_conflict_count'], 0)
        self.assertFalse(data['delete_enabled'])

    def test_delete_endpoint_refused_by_default(self):
        v = mk(); run_archive(self.admin)
        rec = ArchivedViolation.objects.get()
        self.assertEqual(
            self.client.delete(reverse('archive-record-delete', args=[rec.pk])).status_code, 403)


class InspectArchiveDuplicatesCommandTests(TestCase):
    def setUp(self):
        self.admin = mk_admin()

    def _run(self):
        out = StringIO()
        call_command('inspect_archive_duplicates', stdout=out)
        return out.getvalue()

    def test_command_is_strictly_read_only(self):
        v = mk(); fake_archive_of(v)
        mk(date_issued=datetime(2025, 12, 31, 20, 0, tzinfo=dt_timezone.utc))
        fake_archive_of(Violation.objects.latest('id'), violation_year=2025)
        before = (Violation.objects.count(), ArchivedViolation.objects.count(),
                  ArchiveBatch.objects.count(), AuditLog.objects.count())
        self._run()
        after = (Violation.objects.count(), ArchivedViolation.objects.count(),
                 ArchiveBatch.objects.count(), AuditLog.objects.count())
        self.assertEqual(before, after)

    def test_reports_duplicates_conflicts_repeats_and_year_mismatch(self):
        dup = mk(); fake_archive_of(dup)
        conf = mk(); fake_archive_of(conf, data_over={'created_at': '2001-01-01T00:00:00+00:00'})
        late = mk(date_issued=datetime(2025, 12, 31, 20, 0, tzinfo=dt_timezone.utc))
        fake_archive_of(late, violation_year=2025)          # stored UTC year, Manila is 2026
        late.delete()                                       # original gone: only the year mismatch remains
        fake_archive_of(dup)                                # archived twice
        text = self._run()
        self.assertIn('duplicates of a still-ACTIVE violation       : 2', text)
        self.assertIn('id conflicts with a DIFFERENT active record  : 1', text)
        self.assertIn('original ids archived more than once         : 1', text)
        self.assertIn('stored violation_year != Asia/Manila year    : 1', text)

    def test_clean_database_reports_zeroes(self):
        text = self._run()
        self.assertIn(': 0', text)
        self.assertNotIn('pk=', text)


# ─── Full snapshot content verification (v2 correction) ────────────────────

from datetime import date as _date  # noqa: E402

from violations.models import Assessment, ViolationItem, ViolationType  # noqa: E402

from .archive_utils import diff_snapshots  # noqa: E402


class SnapshotContentVerificationTests(TestCase):
    """The archive must prove the stored JSON equals the original BEFORE deleting."""

    def setUp(self):
        self.admin = mk_admin()
        self.vt = ViolationType.objects.create(code='SV-1', name='Snap type', penalty_amount=500)
        self.v = mk(
            license_status='confiscated', confiscated_document_type='others',
            confiscated_document_name='Senior ID', confiscated_document_number='SC-77',
            violator_name='SECRET PERSON', penalty_amount=500)
        ViolationItem.objects.create(violation=self.v, violation_type=self.vt,
                                     penalty_amount_snapshot=500)
        self.vt2 = ViolationType.objects.create(code='SV-2', name='Snap type 2', penalty_amount=250.5)
        ViolationItem.objects.create(violation=self.v, violation_type=self.vt2,
                                     penalty_amount_snapshot=250.5)
        self.a = Assessment.objects.create(
            violation=self.v, or_number='OR-1', penalty=500, amount_paid=500,
            received_by='Cashier', date_paid=_date(2024, 6, 5))

    # helper: corrupt what bulk_create writes
    def _corrupt(self, mutate):
        real = ArchivedViolation.objects.bulk_create

        def wrapper(objs, *a, **k):
            objs = list(objs)
            for o in objs:
                d = json.loads(json.dumps(o.data))
                mutate(d)
                o.data = d
            return real(objs, *a, **k)
        return mock.patch.object(type(ArchivedViolation.objects), 'bulk_create', side_effect=wrapper)

    def _assert_rolled_back_and_intact(self):
        self.assertEqual(ArchivedViolation.objects.count(), 0)
        self.assertEqual(ArchiveBatch.objects.count(), 0)
        v = Violation.objects.get(pk=self.v.pk)                 # still active
        self.assertEqual(v.confiscated_document_number, 'SC-77')
        self.assertEqual(v.items.count(), 2)
        a = Assessment.objects.get(violation=v)                 # payment data intact
        self.assertEqual((a.or_number, float(a.amount_paid), a.received_by, a.date_paid),
                         ('OR-1', 500.0, 'Cashier', _date(2024, 6, 5)))

    def _expect_failure(self, mutate, needle):
        with self._corrupt(mutate):
            with self.assertRaises(ArchiveReconciliationError) as cm:
                run_archive(self.admin)
        self.assertIn(needle, str(cm.exception))
        self.assertNotIn('SECRET PERSON', str(cm.exception))    # paths only, no PII
        self._assert_rolled_back_and_intact()

    # ── happy path ─────────────────────────────────────────────────────
    def test_complete_valid_snapshot_passes_and_contains_everything(self):
        batch = run_archive(self.admin)
        self.assertEqual(batch.archived_count, 1)
        d = ArchivedViolation.objects.get().data
        self.assertEqual(d['confiscated_document_number'], 'SC-77')
        self.assertEqual(d['assessment']['or_number'], 'OR-1')
        self.assertEqual(len(d['items']), 2)
        self.assertFalse(Violation.objects.filter(pk=self.v.pk).exists())

    # ── required mismatch scenarios ────────────────────────────────────
    def test_changed_confiscated_document_field_is_caught(self):
        self._expect_failure(lambda d: d.update(confiscated_document_number='SC-78'),
                             'confiscated_document_number')

    def test_missing_confiscated_document_key_is_caught(self):
        self._expect_failure(lambda d: d.pop('confiscated_document_type'),
                             'confiscated_document_type (missing)')

    def test_changed_payment_or_number_is_caught(self):
        self._expect_failure(lambda d: d['assessment'].update(or_number='OR-2'),
                             'assessment.or_number')

    def test_changed_payment_amount_by_one_centavo_is_caught(self):
        self._expect_failure(lambda d: d['assessment'].update(amount_paid=500.01),
                             'assessment.amount_paid')

    def test_changed_payment_date_is_caught(self):
        self._expect_failure(lambda d: d['assessment'].update(date_paid='2024-06-06'),
                             'assessment.date_paid')

    def test_missing_payment_key_is_caught(self):
        self._expect_failure(lambda d: d['assessment'].pop('received_by'),
                             'assessment.received_by (missing)')

    def test_dropped_assessment_is_caught(self):
        self._expect_failure(lambda d: d.update(assessment=None), 'assessment')

    def test_changed_item_penalty_is_caught(self):
        self._expect_failure(lambda d: d['items'][1].update(penalty_amount=250.0),
                             'items[1].penalty_amount')

    def test_dropped_item_is_caught(self):
        self._expect_failure(lambda d: d['items'].pop(), 'items')

    def test_changed_top_level_field_and_date_text_are_caught(self):
        self._expect_failure(lambda d: d.update(date_issued='2024-06-01T04:00:00Z'), 'date_issued')
        self._expect_failure(lambda d: d.update(violator_name='Other'), 'violator_name')

    def test_extra_unexpected_key_is_caught(self):
        self._expect_failure(lambda d: d.update(injected='x'), 'injected (unexpected)')

    def test_audit_view_reports_failure_and_nothing_changes(self):
        client = APITestCaseClient(self.admin)
        with self._corrupt(lambda d: d['assessment'].update(or_number='OR-9')):
            resp = client.post(reverse('archive-execute'))
        self.assertEqual(resp.status_code, 500)
        log = AuditLog.objects.filter(action='ARCHIVE').latest('timestamp')
        self.assertEqual((log.status, log.details['outcome']), ('FAILED', 'reconciliation_failed'))
        self._assert_rolled_back_and_intact()

    def test_advisory_lock_and_conflict_handling_still_work_alongside(self):
        fake_archive_of(self.v, data_over={'created_at': '2001-01-01T00:00:00+00:00'})
        batch = run_archive(self.admin)
        self.assertEqual(batch.archive_conflict_count, 1)
        self.assertTrue(Violation.objects.filter(pk=self.v.pk).exists())


class DiffSnapshotsUnitTests(unittest.TestCase):
    def test_int_float_same_value_equal_but_any_real_difference_flagged(self):
        self.assertEqual(diff_snapshots({'a': 500}, {'a': 500.0}), [])
        self.assertEqual(diff_snapshots({'a': 0.1}, {'a': 0.1}), [])
        self.assertTrue(diff_snapshots({'a': 500}, {'a': 500.01}))
        self.assertTrue(diff_snapshots({'a': 1e-9}, {'a': 0}))

    def test_type_and_emptiness_are_not_masked(self):
        for e, a in [(None, ''), ('', None), (True, 1), (0, False), ('1', 1), ([], None), ({}, [])]:
            self.assertTrue(diff_snapshots({'k': e}, {'k': a}), (e, a))

    def test_strings_dates_and_list_order_are_exact(self):
        self.assertTrue(diff_snapshots({'d': '2024-06-01T04:00:00+00:00'}, {'d': '2024-06-01T04:00:00Z'}))
        self.assertTrue(diff_snapshots({'l': [1, 2]}, {'l': [2, 1]}))
        self.assertTrue(diff_snapshots({'l': [1]}, {'l': [1, 2]}))

    def test_nested_paths_reported(self):
        out = diff_snapshots({'a': {'b': [{'c': 1}]}}, {'a': {'b': [{'c': 2}]}})
        self.assertEqual(out, ['a.b[0].c (changed)'])


def APITestCaseClient(user):
    from rest_framework.test import APIClient
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=f'Bearer {RefreshToken.for_user(user).access_token}')
    return c


# ─── Dedup identity review: legacy snapshots, precision, id reuse ───────────

from django.utils import timezone as _tz  # noqa: E402
from datetime import timedelta as _td  # noqa: E402

from .historical import deduped_archived, duplicate_archived_pks  # noqa: E402


class DedupIdentityReviewTests(TestCase):
    def setUp(self):
        self.v = mk()

    def _dups(self):
        return duplicate_archived_pks()

    def test_same_instant_in_other_offset_spelling_is_the_same_violation(self):
        manila = _tz.localtime(self.v.created_at).isoformat()          # +08:00 spelling
        row = fake_archive_of(self.v, data_over={'created_at': manila})
        self.assertIn(row.pk, self._dups())

    def test_one_microsecond_difference_is_a_different_violation_and_kept(self):
        later = (self.v.created_at + _td(microseconds=1)).isoformat()
        row = fake_archive_of(self.v, data_over={'created_at': later})
        self.assertNotIn(row.pk, self._dups())
        self.assertIn(row.pk, deduped_archived().values_list('pk', flat=True))

    def test_naive_created_at_is_not_guessed_falls_back_and_is_reported(self):
        naive = self.v.created_at.replace(tzinfo=None).isoformat()
        row = fake_archive_of(self.v, data_over={'created_at': naive})
        self.assertIn(row.pk, self._dups())                 # same id + same date_issued
        out = StringIO(); call_command('inspect_archive_duplicates', stdout=out)
        self.assertIn('WITHOUT usable created_at (weak id): 1', out.getvalue())
        self.assertIn(f'archived pk={row.pk}', out.getvalue())

    def test_legacy_snapshot_without_created_at_with_different_date_is_kept(self):
        row = fake_archive_of(self.v)
        data = dict(row.data); data.pop('created_at')
        ArchivedViolation.objects.filter(pk=row.pk).update(
            data=data, date_issued=self.v.date_issued + _td(days=3))
        self.assertNotIn(row.pk, self._dups())

    def test_legitimate_id_reuse_with_different_created_at_is_never_dropped(self):
        row = fake_archive_of(self.v, data_over={'created_at': '2001-01-01T00:00:00+00:00'})
        self.assertNotIn(row.pk, self._dups())
        self.assertEqual(deduped_archived().count(), 1)
        out = StringIO(); call_command('inspect_archive_duplicates', stdout=out)
        self.assertIn('id conflicts with a DIFFERENT active record  : 1', out.getvalue())

    def test_unparseable_created_at_falls_back_instead_of_crashing(self):
        row = fake_archive_of(self.v, data_over={'created_at': 'garbage'})
        self.assertIn(row.pk, self._dups())     # same id + same date_issued (weak, reported)