"""
Archive x license-custody integration (Checkpoint 3 Stage B). PostgreSQL only.

Run:  TEST_PG_HOST=/tmp/pg TEST_PG_PORT=54329 \
      python manage.py test database_management.test_archive_custody --settings=core.test_settings_pg
"""
from datetime import timedelta
from unittest import mock, skipUnless

from django.db import connection
from django.db.models import ProtectedError
from django.utils import timezone

from database_management import archive_utils
from database_management.archive_utils import ArchiveReconciliationError, run_archive
from database_management.models import ArchiveBatch, ArchivedViolation
from violations.custody_models import LicenseCustody, LicenseCustodyEvent
from violations.models import Violation
from violations.test_license_custody import BASE, CustodyMixin, release_body, rid
from violations.tests import BaseRoleTestCase

PG = skipUnless(connection.vendor == 'postgresql', 'PostgreSQL-only')


@PG
class ArchiveCustodyTests(CustodyMixin, BaseRoleTestCase):
    def test_active_custody_is_relinked_atomically_and_listing_continues(self):
        v = self.conf()
        self.ready(self.staff, f'v{v.id}')
        run_archive(self.admin)
        self.assertFalse(Violation.objects.filter(pk=v.pk).exists())
        c = LicenseCustody.objects.get()
        a = ArchivedViolation.objects.get(original_violation_id=v.id)
        self.assertEqual((c.violation_id, c.archived_violation_id, c.original_violation_id),
                         (None, a.pk, v.id))
        self.assertEqual(c.status, 'ready_for_release')
        rows = self.listing(self.staff).data['results']
        self.assertEqual([(r['key'], r['record_kind'], r['status']) for r in rows],
                         [(f'a{a.pk}', 'archived', 'ready_for_release')])         # exactly once

    def test_released_row_survives_archive_and_delete(self):
        v = self.conf()
        k = f'v{v.id}'
        self.ready(self.staff, k)
        self.post(self.staff, k, 'release', 1, **release_body())
        released_at = LicenseCustody.objects.get().released_at
        run_archive(self.admin)
        c = LicenseCustody.objects.get()
        self.assertEqual((c.status, c.released_at, c.released_to_name), ('released', released_at, 'Juan Dela Cruz'))
        self.assertEqual(LicenseCustodyEvent.objects.count(), 2)
        with self.assertRaises(ProtectedError):                  # snapshot cannot be deleted from under it
            ArchivedViolation.objects.get(pk=c.archived_violation_id).delete()

    def test_archive_without_custody_creates_none_for_regular_licenses(self):
        self.conf()
        run_archive(self.admin)
        self.assertEqual(LicenseCustody.objects.count(), 0)
        self.assertEqual(self.listing(self.staff).data['count'], 1)               # still listed via the snapshot set

    def test_legacy_blank_type_gets_pending_custody_so_it_is_preserved(self):
        v = self.conf(doc='')
        run_archive(self.admin)
        c = LicenseCustody.objects.get()
        self.assertEqual((c.doc_type_status, c.status, c.version, c.original_violation_id),
                         ('pending', 'confiscated', 1, v.id))
        row = self.listing(self.staff).data['results'][0]
        self.assertTrue(row['document_type_unverified'])
        self.assertEqual(self.ready(self.staff, row['key'], 1).data['code'], 'document_type_unverified')

    def test_two_archive_runs_create_no_duplicates(self):
        v = self.conf(doc='')
        w = self.conf(ovr='OVR-C-2')
        self.ready(self.staff, f'v{w.id}')
        run_archive(self.admin)
        run_archive(self.admin)
        self.assertEqual(LicenseCustody.objects.count(), 2)
        self.assertEqual(ArchivedViolation.objects.filter(original_violation_id__in=[v.id, w.id]).count(), 2)
        self.assertEqual(self.listing(self.staff).data['count'], 2)

    def test_archive_conflict_creates_no_custody(self):
        v = self.conf(doc='')
        # Same id already archived for a DIFFERENT violation (different date) -> archive_conflict.
        batch = ArchiveBatch.objects.create(status='success')
        ArchivedViolation.objects.create(
            batch=batch, original_violation_id=v.id, violation_year=2020,
            date_issued=timezone.now() - timedelta(days=2000), settlement_status='settled',
            violator_name='OTHER', data={'license_status': 'Not Confiscated'})
        b = run_archive(self.admin)
        self.assertEqual(b.archive_conflict_count, 1)
        self.assertTrue(Violation.objects.filter(pk=v.pk).exists())               # untouched
        self.assertEqual(LicenseCustody.objects.count(), 0)

    def test_failed_relink_rolls_back_everything(self):
        v = self.conf()
        self.ready(self.staff, f'v{v.id}')
        before_batches = ArchiveBatch.objects.count()
        with mock.patch.object(archive_utils, '_verify_relinked_custody', return_value=['forced failure']):
            with self.assertRaises(ArchiveReconciliationError):
                run_archive(self.admin)
        c = LicenseCustody.objects.get()
        self.assertEqual((c.violation_id, c.archived_violation_id), (v.id, None))   # still linked to the active row
        self.assertTrue(Violation.objects.filter(pk=v.pk).exists())
        self.assertEqual(ArchivedViolation.objects.count(), 0)
        self.assertEqual(ArchiveBatch.objects.count(), before_batches)

    def test_release_then_archive_and_archive_then_release_both_consistent(self):
        a, b = self.conf(ovr='ORD-A'), self.conf(ovr='ORD-B')
        for v in (a, b):
            self.ready(self.staff, f'v{v.id}')
        # order 1: release, then archive
        self.assertEqual(self.post(self.staff, f'v{a.id}', 'release', 1, **release_body()).status_code, 200)
        run_archive(self.admin)
        # order 2 (b was archived by the same run): release via the OLD active key
        r = self.post(self.staff, f'v{b.id}', 'release', 1, **release_body())
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.data['record_kind'], 'archived')
        cs = LicenseCustody.objects.order_by('original_violation_id')
        self.assertEqual([(c.status, c.violation_id) for c in cs], [('released', None)] * 2)
        self.assertEqual(LicenseCustodyEvent.objects.filter(operation='release').count(), 2)

    def test_delete_blocked_for_violation_with_custody_until_relinked(self):
        v = self.conf(status='pending')
        LicenseCustody.objects.create(violation=v, original_violation_id=v.id)
        with self.assertRaises(ProtectedError):
            Violation.objects.get(pk=v.pk).delete()

    def test_pending_violations_with_custody_are_not_archived(self):
        v = self.conf(status='pending')
        LicenseCustody.objects.create(violation=v, original_violation_id=v.id)
        run_archive(self.admin)
        self.assertTrue(Violation.objects.filter(pk=v.pk).exists())
        self.assertEqual(LicenseCustody.objects.get().violation_id, v.id)