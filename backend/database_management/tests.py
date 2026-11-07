from datetime import date, datetime, timezone as dt_timezone

from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone as django_timezone
from rest_framework import status
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.models import CustomUser
from violations.models import Violation, Assessment

from .archive_utils import run_archive, get_archive_preview
from audit.models import AuditLog
from .export_utils import (
    build_full_export_workbook, build_archived_export_workbook,
    get_exportable_columns, get_archived_export_columns,
)
from .models import ArchivedViolation


def _make_violation(**overrides):
    defaults = dict(
        violator_name='Juan Dela Cruz',
        license_number='N01-23-456789',
        date_issued=datetime(2024, 6, 1, tzinfo=dt_timezone.utc),
        status=Violation.Status.PENDING,
    )
    defaults.update(overrides)
    return Violation.objects.create(**defaults)


class DatabaseManagementTests(TestCase):
    def setUp(self):
        self.admin = CustomUser.objects.create_user(
            email='admin@example.com', password='pass1234',
            full_name='Admin User', id_number='2026-ADM-0001',
            role=CustomUser.Role.ADMIN,
        )

    # ── Full Database Export (PART 3, Tests 1-4) ──────────────────────
    def test_full_export_includes_every_status_regardless_of_settlement(self):
        """Export must never filter by settlement or processing status."""
        _make_violation(status=Violation.Status.PAID)          # settled
        _make_violation(status=Violation.Status.PENDING)       # staff pending
        _make_violation(status=Violation.Status.PROCESSING)    # staff processing
        _make_violation(status=Violation.Status.PENDING, violator_name='Maria Santos')  # a second pending record

        wb, count = build_full_export_workbook()
        self.assertEqual(count, 4)
        ws = wb.active
        # header row + 4 data rows
        self.assertEqual(ws.max_row, 5)

    def test_full_export_never_modifies_active_data(self):
        _make_violation(status=Violation.Status.PENDING)
        build_full_export_workbook()
        self.assertEqual(Violation.objects.count(), 1)

    # ── Archive must not destroy in-progress workflows (PART 8/17/18) ──
    def test_archive_skips_pending_and_processing_records(self):
        settled = _make_violation(status=Violation.Status.PAID)
        pending = _make_violation(status=Violation.Status.PENDING)
        processing = _make_violation(status=Violation.Status.PROCESSING)

        batch = run_archive(self.admin)

        self.assertEqual(batch.archived_count, 1)
        self.assertEqual(batch.skipped_in_progress_count, 2)
        # Only the settled/completed record was removed from the active table.
        self.assertFalse(Violation.objects.filter(pk=settled.pk).exists())
        self.assertTrue(Violation.objects.filter(pk=pending.pk).exists())
        self.assertTrue(Violation.objects.filter(pk=processing.pk).exists())

    def test_archive_skips_locked_records_even_if_status_is_complete(self):
        """A record can be locked (active Resume session) while its status
        is technically a 'complete' one (e.g. re-opened for correction) —
        the lock itself must protect it."""
        locked = _make_violation(status=Violation.Status.PAID, locked_by=self.admin)

        batch = run_archive(self.admin)

        self.assertEqual(batch.archived_count, 0)
        self.assertEqual(batch.skipped_in_progress_count, 1)
        self.assertTrue(Violation.objects.filter(pk=locked.pk).exists())

    # NOTE: test_archive_includes_unsettled_but_processing_complete_records
    # was removed here. It exercised an "assessed but unpaid" record — a
    # status outside IN_PROGRESS_STATUSES yet not yet paid. Under the
    # simplified 3-status workflow (pending, processing, paid) that state
    # no longer exists: 'processing' IS in-progress, and the only way out
    # of it is 'paid' (assessment + ticket + payment happen together in
    # one "Mark as Paid" step). There is no longer any unsettled-but-not-
    # in-progress status for this test to construct.

    # ── Violation year is never the settlement year (PART 14/17) ───────
    def test_archived_violation_year_uses_date_issued_not_settlement(self):
        v = _make_violation(
            date_issued=datetime(2023, 12, 15, tzinfo=dt_timezone.utc),
            status=Violation.Status.PAID,
        )
        batch = run_archive(self.admin)
        archived = ArchivedViolation.objects.get(batch=batch, original_violation_id=v.pk)
        self.assertEqual(archived.violation_year, 2023)

    # ── Preview reflects the eligible/in-progress split ─────────────────
    def test_preview_reports_in_progress_separately(self):
        _make_violation(status=Violation.Status.PAID)
        _make_violation(status=Violation.Status.PENDING)

        preview = get_archive_preview()
        self.assertEqual(preview['active_count'], 2)
        self.assertEqual(preview['eligible_count'], 1)
        self.assertEqual(preview['in_progress_count'], 1)

    # ── #005: archiving must never lose the Assessment (payment) record ──
    # Assessment CASCADE-deletes with its Violation the moment archiving
    # removes the active row, so the O.R. number / amount paid / who
    # received it / real payment date must all survive inside the
    # snapshot, or they're gone forever.
    def test_archive_preserves_payment_data_in_snapshot(self):
        v = _make_violation(status=Violation.Status.PAID)
        Assessment.objects.create(
            violation=v, or_number='OR-2026-0042', penalty=500,
            amount_paid=500, received_by='Cashier Reyes',
            date_paid=date(2024, 6, 5),
        )

        batch = run_archive(self.admin)

        archived = ArchivedViolation.objects.get(batch=batch, original_violation_id=v.pk)
        snap_assessment = archived.data['assessment']
        self.assertEqual(snap_assessment['or_number'], 'OR-2026-0042')
        self.assertEqual(snap_assessment['amount_paid'], 500.0)
        self.assertEqual(snap_assessment['received_by'], 'Cashier Reyes')
        self.assertEqual(snap_assessment['date_paid'], '2024-06-05')
        # settled_at now reflects the REAL payment date, not Violation.updated_at.
        # Compare in local (Asia/Manila) wall-clock time, since settled_at is
        # stored as an aware UTC instant and midnight-Manila can fall on the
        # previous UTC calendar date.
        self.assertEqual(django_timezone.localtime(archived.settled_at).date(), date(2024, 6, 5))

    def test_archive_snapshot_assessment_is_none_when_never_assessed(self):
        """A paid-status edge case aside, an unassessed pending/processing
        record never reaches archiving (see in-progress tests above) — but
        the snapshot must still degrade gracefully rather than error."""
        v = _make_violation(status=Violation.Status.PAID)  # no Assessment created
        batch = run_archive(self.admin)
        archived = ArchivedViolation.objects.get(batch=batch, original_violation_id=v.pk)
        self.assertIsNone(archived.data['assessment'])
        self.assertIsNone(archived.settled_at)

    # ── Snapshot completeness (source, vehicle_use, latitude, longitude) ──
    def test_archive_snapshot_preserves_source_vehicle_use_and_coordinates(self):
        """These four fields exist on Violation but were previously missing
        from the archive snapshot — once archived they'd be gone forever."""
        v = _make_violation(
            status=Violation.Status.PAID,
            source=Violation.Source.STAFF_WALK_IN,
            vehicle_use=Violation.VehicleUse.PUBLIC,
            latitude=13.9313, longitude=121.6169,
        )
        batch = run_archive(self.admin)
        archived = ArchivedViolation.objects.get(batch=batch, original_violation_id=v.pk)
        self.assertEqual(archived.data['source'], 'staff_walk_in')
        self.assertEqual(archived.data['vehicle_use'], 'public')
        self.assertEqual(archived.data['latitude'], 13.9313)
        self.assertEqual(archived.data['longitude'], 121.6169)

    # ── Archived Records Export ─────────────────────────────────────────
    def test_archived_export_reads_from_snapshot_not_active_table(self):
        v = _make_violation(status=Violation.Status.PAID)
        Assessment.objects.create(
            violation=v, or_number='OR-2026-0007', amount_paid=300,
            received_by='Cashier Cruz', date_paid=date(2024, 6, 10),
        )
        run_archive(self.admin)
        self.assertEqual(Violation.objects.count(), 0)  # active table is empty

        wb, count = build_archived_export_workbook()
        self.assertEqual(count, 1)
        ws = wb.active
        self.assertEqual(ws.max_row, 2)  # header + 1 row
        headers = [c.value for c in ws[1]]
        self.assertIn('OR Number', headers)
        self.assertIn('Payment Processed By', headers)

    def test_archived_export_year_filter_excludes_other_years(self):
        _make_violation(date_issued=datetime(2025, 3, 1, tzinfo=dt_timezone.utc), status=Violation.Status.PAID)
        _make_violation(date_issued=datetime(2026, 3, 1, tzinfo=dt_timezone.utc), status=Violation.Status.PAID)
        run_archive(self.admin)

        wb, count = build_archived_export_workbook(year=2026)
        self.assertEqual(count, 1)

    def test_archived_export_never_deletes_archived_records(self):
        _make_violation(status=Violation.Status.PAID)
        run_archive(self.admin)
        before = ArchivedViolation.objects.count()
        build_archived_export_workbook()
        self.assertEqual(ArchivedViolation.objects.count(), before)


class ArchiveMonthsAndDeleteAPITests(APITestCase):
    """TEST C/D/E (month grouping), TEST K/L (delete + authorization)."""

    def setUp(self):
        self.admin = CustomUser.objects.create_user(
            email='admin2@example.com', password='pass1234',
            full_name='Admin User', id_number='2026-ADM-0002',
            role=CustomUser.Role.ADMIN,
        )
        self.staff = CustomUser.objects.create_user(
            email='staff@example.com', password='pass1234',
            full_name='Staff User', id_number='2026-STF-0001',
            role=CustomUser.Role.STAFF,
        )

    def _auth_as(self, user):
        access = str(RefreshToken.for_user(user).access_token)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')

    # ── #005: archived payment data must be reachable, not just preserved ─
    def test_violator_history_full_view_exposes_or_number_for_archived_records(self):
        v = _make_violation(status=Violation.Status.PAID, violator_name='Pedro Reyes',
                             license_number='P01-23-999999')
        Assessment.objects.create(
            violation=v, or_number='OR-2026-0099', amount_paid=750,
            date_paid=date(2024, 3, 1),
        )
        run_archive(self.admin)

        self._auth_as(self.admin)
        resp = self.client.get(
            reverse('violator-history-full'),
            {'violator_name': 'Pedro Reyes', 'license_number': 'P01-23-999999'},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        archived_row = next(r for r in resp.data['records'] if r['is_archived'])
        self.assertEqual(archived_row['or_number'], 'OR-2026-0099')
        self.assertEqual(archived_row['date_paid'], '2024-03-01')

    def test_months_grouped_by_violation_date_not_archive_date(self):
        """TEST C/D: June 26 + June 27 + Aug 21 violation dates → June has 2,
        August has 1, regardless of when the archive run happened."""
        _make_violation(date_issued=datetime(2026, 6, 26, tzinfo=dt_timezone.utc), status=Violation.Status.PAID)
        _make_violation(date_issued=datetime(2026, 6, 27, tzinfo=dt_timezone.utc), status=Violation.Status.PAID)
        _make_violation(date_issued=datetime(2026, 8, 21, tzinfo=dt_timezone.utc), status=Violation.Status.PAID)
        run_archive(self.admin)

        self._auth_as(self.staff)
        resp = self.client.get(reverse('archive-months'), {'year': 2026})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        by_month = {row['month']: row['total'] for row in resp.data['months']}
        self.assertEqual(by_month.get(6), 2)
        self.assertEqual(by_month.get(8), 1)

    def test_empty_month_is_not_returned(self):
        """TEST E: no July records → July absent from the response."""
        _make_violation(date_issued=datetime(2026, 6, 1, tzinfo=dt_timezone.utc), status=Violation.Status.PAID)
        run_archive(self.admin)

        self._auth_as(self.staff)
        resp = self.client.get(reverse('archive-months'), {'year': 2026})
        months_present = {row['month'] for row in resp.data['months']}
        self.assertNotIn(7, months_present)

    @override_settings(ARCHIVE_DELETE_ENABLED=True)
    def test_admin_can_delete_single_archived_record_only(self):
        """TEST K: deleting one archived record leaves other archived
        records, and the (already-removed) active table, untouched."""
        v1 = _make_violation(status=Violation.Status.PAID)
        v2 = _make_violation(status=Violation.Status.PAID, violator_name='Maria Santos')
        run_archive(self.admin)
        self.assertEqual(ArchivedViolation.objects.count(), 2)
        target = ArchivedViolation.objects.get(original_violation_id=v1.pk)
        other = ArchivedViolation.objects.get(original_violation_id=v2.pk)

        self._auth_as(self.admin)
        resp = self.client.delete(reverse('archive-record-delete', args=[target.pk]))

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(ArchivedViolation.objects.filter(pk=target.pk).exists())
        self.assertTrue(ArchivedViolation.objects.filter(pk=other.pk).exists())

    @override_settings(ARCHIVE_DELETE_ENABLED=True)
    def test_non_admin_cannot_delete_archived_record(self):
        """TEST L: backend rejects deletion attempts from non-admin roles,
        independent of whether the frontend button is shown."""
        v1 = _make_violation(status=Violation.Status.PAID)
        run_archive(self.admin)
        target = ArchivedViolation.objects.get(original_violation_id=v1.pk)

        self._auth_as(self.staff)
        resp = self.client.delete(reverse('archive-record-delete', args=[target.pk]))

        self.assertIn(resp.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_401_UNAUTHORIZED))
        self.assertTrue(ArchivedViolation.objects.filter(pk=target.pk).exists())

    @override_settings(ARCHIVE_DELETE_ENABLED=False)
    def test_delete_rejected_when_feature_disabled_even_for_admin(self):
        """Frontend hiding the button is not enough — backend must also
        refuse the request when ARCHIVE_DELETE_ENABLED is off."""
        v1 = _make_violation(status=Violation.Status.PAID)
        run_archive(self.admin)
        target = ArchivedViolation.objects.get(original_violation_id=v1.pk)

        self._auth_as(self.admin)
        resp = self.client.delete(reverse('archive-record-delete', args=[target.pk]))

        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(ArchivedViolation.objects.filter(pk=target.pk).exists())


class ArchivedExportAPITests(APITestCase):
    """Admin-only access for the Archived Records Export endpoints, and a
    basic end-to-end check that the download responds correctly."""

    def setUp(self):
        self.admin = CustomUser.objects.create_user(
            email='admin3@example.com', password='pass1234',
            full_name='Admin User', id_number='2026-ADM-0003',
            role=CustomUser.Role.ADMIN,
        )
        self.staff = CustomUser.objects.create_user(
            email='staff2@example.com', password='pass1234',
            full_name='Staff User', id_number='2026-STF-0002',
            role=CustomUser.Role.STAFF,
        )

    def _auth_as(self, user):
        access = str(RefreshToken.for_user(user).access_token)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')

    def test_admin_can_fetch_archive_export_fields(self):
        _make_violation(status=Violation.Status.PAID)
        run_archive(self.admin)

        self._auth_as(self.admin)
        resp = self.client.get(reverse('archive-export-fields'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['archived_record_count'], 1)
        self.assertIn('OR Number', resp.data['labels'])

    def test_staff_cannot_access_archive_export_fields(self):
        self._auth_as(self.staff)
        resp = self.client.get(reverse('archive-export-fields'))
        self.assertIn(resp.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_401_UNAUTHORIZED))

    def test_admin_can_download_archive_export(self):
        _make_violation(status=Violation.Status.PAID)
        run_archive(self.admin)

        self._auth_as(self.admin)
        resp = self.client.get(reverse('archive-export'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIn('spreadsheetml', resp['Content-Type'])
        self.assertIn('attachment', resp['Content-Disposition'])

    def test_staff_cannot_download_archive_export(self):
        self._auth_as(self.staff)
        resp = self.client.get(reverse('archive-export'))
        self.assertIn(resp.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_401_UNAUTHORIZED))

    def test_archive_export_year_param_scopes_results(self):
        _make_violation(date_issued=datetime(2025, 1, 1, tzinfo=dt_timezone.utc), status=Violation.Status.PAID)
        _make_violation(date_issued=datetime(2026, 1, 1, tzinfo=dt_timezone.utc), status=Violation.Status.PAID)
        run_archive(self.admin)

        self._auth_as(self.admin)
        resp = self.client.get(reverse('archive-export-fields'), {'year': 2026})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['archived_record_count'], 1)


# ─────────────────────────────────────────────────────────────────────────
# PDF EXPORT DATA endpoints (export/full/pdf-data/, archive/export/pdf-data/)
# ─────────────────────────────────────────────────────────────────────────
import json


class PdfDataEndpointTests(APITestCase):
    def setUp(self):
        mk = CustomUser.objects.create_user
        self.admin = mk(email='pdf-admin@example.com', password='pass1234',
                        full_name='Admin Uploader', id_number='2026-ADM-0100',
                        role=CustomUser.Role.ADMIN)
        self.staff = mk(email='pdf-staff@example.com', password='pass1234',
                        full_name='Staff Assessor', id_number='2026-STF-0100',
                        role=CustomUser.Role.STAFF)
        self.enforcer = mk(email='pdf-enf@example.com', password='pass1234',
                           full_name='Enforcer Santos', id_number='2026-ENF-0100',
                           role=CustomUser.Role.ENFORCER)
        self.full_url = reverse('db-export-full-pdf-data')
        self.arch_url = reverse('archive-export-pdf-data')

    def _auth(self, user):
        access = str(RefreshToken.for_user(user).access_token)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')

    def _assessed_paid(self, **kw):
        v = _make_violation(status=Violation.Status.PAID, enforcer=self.enforcer, **kw)
        Assessment.objects.create(
            violation=v, or_number='OR-77', penalty=500, amount_paid=500,
            received_by='Cashier Reyes', date_paid=date(2024, 6, 5),
            assessed_by=self.staff, assessor_name_snapshot='Staff Assessor',
            assessor_snapshot_source='event',
            payment_confirmed_by=self.admin,
            payment_confirmer_name_snapshot='Admin Uploader',
            payment_confirmer_snapshot_source='event',
        )
        return v

    # ── permissions ────────────────────────────────────────────────────
    def test_non_admins_and_anonymous_are_refused(self):
        for url in (self.full_url, self.arch_url):
            self.client.credentials()
            self.assertEqual(self.client.get(url).status_code, status.HTTP_401_UNAUTHORIZED)
            for user in (self.staff, self.enforcer):
                self._auth(user)
                self.assertEqual(self.client.get(url).status_code, status.HTTP_403_FORBIDDEN)

    def test_endpoints_are_get_only(self):
        self._auth(self.admin)
        for url in (self.full_url, self.arch_url):
            self.assertEqual(self.client.post(url, {}).status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
            self.assertEqual(self.client.delete(url).status_code, status.HTTP_405_METHOD_NOT_ALLOWED)

    # ── Full export contract ───────────────────────────────────────────
    def test_full_payload_keeps_the_36_field_contract(self):
        _make_violation()
        self._auth(self.admin)
        data = self.client.get(self.full_url).json()
        self.assertEqual(len(data['columns']), 36)
        self.assertEqual(
            [(c['key'], c['label']) for c in data['columns']], get_exportable_columns(),
        )
        self.assertIn('Assessed By', [c['label'] for c in data['columns']])
        self.assertEqual(data['record_count'], 1)
        self.assertEqual(set(data['records'][0]), {c['key'] for c in data['columns']})

    def test_full_payload_is_read_only(self):
        _make_violation(status=Violation.Status.PENDING)
        _make_violation(status=Violation.Status.PAID)
        self._auth(self.admin)
        self.client.get(self.full_url)
        self.assertEqual(Violation.objects.count(), 2)
        self.assertEqual(ArchivedViolation.objects.count(), 0)

    def test_full_payload_resolves_enforcer_and_assessor_identity(self):
        self._assessed_paid()
        self._auth(self.admin)
        rec = self.client.get(self.full_url).json()['records'][0]
        self.assertEqual(rec['enforcer_name'], 'Enforcer Santos')
        self.assertEqual(rec['assessed_by_name'], 'Staff Assessor')

    def test_full_payload_unprovable_legacy_assessor_stays_blank(self):
        v = _make_violation(status=Violation.Status.PAID)
        Assessment.objects.create(violation=v, penalty=100, assessed_by=self.admin)  # source=unknown
        self._auth(self.admin)
        rec = self.client.get(self.full_url).json()['records'][0]
        self.assertEqual(rec['assessed_by_name'], '')

    def test_imported_by_is_readable_admin_name_not_a_model_object(self):
        _make_violation(source='imported', imported_by=self.admin, enforcer=None)
        self._auth(self.admin)
        resp = self.client.get(self.full_url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        rec = resp.json()['records'][0]
        self.assertEqual(rec['imported_by'], 'Admin Uploader')
        self.assertNotIn('CustomUser', json.dumps(rec))
        self.assertEqual(rec['enforcer_name'], '')

    def test_imported_by_is_blank_for_non_imported_records(self):
        _make_violation()
        self._auth(self.admin)
        self.assertEqual(self.client.get(self.full_url).json()['records'][0]['imported_by'], '')

    def test_timestamps_are_converted_to_asia_manila(self):
        # 20:00 UTC on 1 Jun is 04:00 on 2 Jun in Manila (UTC+8).
        _make_violation(date_issued=datetime(2024, 6, 1, 20, 0, tzinfo=dt_timezone.utc))
        self._auth(self.admin)
        rec = self.client.get(self.full_url).json()['records'][0]
        self.assertEqual(rec['date_issued'], '2024-06-02 04:00:00')

    def test_true_zero_and_false_survive_while_missing_is_blank(self):
        _make_violation(penalty_amount=0, is_printed=False)
        self._auth(self.admin)
        rec = self.client.get(self.full_url).json()['records'][0]
        self.assertEqual(rec['penalty_amount'], 0.0)
        self.assertNotEqual(rec['penalty_amount'], '')       # a true zero is not "missing"
        self.assertIs(rec['is_printed'], False)
        self.assertEqual(rec['assessed_at'], '')

    def test_meta_block_describes_the_export(self):
        _make_violation()
        self._auth(self.admin)
        meta = self.client.get(self.full_url).json()['meta']
        self.assertEqual(meta['generated_by'], 'Admin Uploader')
        self.assertEqual(meta['record_count'], 1)
        self.assertEqual(meta['timezone'], 'Asia/Manila')
        self.assertTrue(meta['generated_at'].endswith('+08:00'))

    # ── Archived export contract ───────────────────────────────────────
    def test_archived_payload_keeps_the_41_field_contract_without_assessed_by(self):
        self._assessed_paid()
        run_archive(self.admin)
        self._auth(self.admin)
        data = self.client.get(self.arch_url).json()
        labels = [c['label'] for c in data['columns']]
        self.assertEqual(len(labels), 41)
        self.assertEqual(
            [(c['key'], c['label']) for c in data['columns']], get_archived_export_columns(),
        )
        self.assertNotIn('Assessed By', labels)
        self.assertNotIn('assessed_by_name', data['records'][0])
        self.assertIn('Payment Processed By', labels)

    def test_archived_payload_never_leaks_the_assessor(self):
        self._assessed_paid()
        run_archive(self.admin)
        self._auth(self.admin)
        rec = self.client.get(self.arch_url).json()['records'][0]
        # Payment confirmer is shown; the assessor name appears nowhere.
        self.assertEqual(rec['assessed_by_processed'], 'Admin Uploader')
        self.assertNotIn('Staff Assessor', json.dumps(rec))

    def test_archived_payload_reads_the_snapshot_and_keeps_payment_data(self):
        self._assessed_paid()
        run_archive(self.admin)
        self._auth(self.admin)
        rec = self.client.get(self.arch_url).json()['records'][0]
        self.assertEqual(rec['or_number'], 'OR-77')
        self.assertEqual(rec['amount_paid'], 500.0)
        self.assertEqual(rec['received_by'], 'Cashier Reyes')
        self.assertEqual(rec['date_paid'], '2024-06-05')
        self.assertEqual(rec['enforcer_name'], 'Enforcer Santos')

    def test_archived_payload_does_not_fabricate_missing_snapshot_data(self):
        _make_violation(status=Violation.Status.PAID, source='imported',
                        imported_by=self.admin, enforcer=None)
        run_archive(self.admin)
        self._auth(self.admin)
        rec = self.client.get(self.arch_url).json()['records'][0]
        # The frozen snapshot holds no imported_by / payment data — stay blank.
        self.assertEqual(rec['imported_by'], '')
        self.assertEqual(rec['or_number'], '')
        self.assertEqual(rec['amount_paid'], '')

    def test_archived_timestamps_are_converted_to_asia_manila(self):
        _make_violation(status=Violation.Status.PAID,
                        date_issued=datetime(2024, 6, 1, 20, 0, tzinfo=dt_timezone.utc))
        run_archive(self.admin)
        self._auth(self.admin)
        rec = self.client.get(self.arch_url).json()['records'][0]
        self.assertEqual(rec['date_issued'], '2024-06-02 04:00:00')
        self.assertRegex(rec['created_at'], r'^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$')

    def test_archived_year_filter_and_all_years(self):
        _make_violation(date_issued=datetime(2025, 3, 1, tzinfo=dt_timezone.utc), status=Violation.Status.PAID)
        _make_violation(date_issued=datetime(2026, 3, 1, tzinfo=dt_timezone.utc), status=Violation.Status.PAID)
        _make_violation(date_issued=datetime(2026, 4, 1, tzinfo=dt_timezone.utc), status=Violation.Status.PAID)
        run_archive(self.admin)
        self._auth(self.admin)
        allyears = self.client.get(self.arch_url).json()
        y2026 = self.client.get(self.arch_url, {'year': 2026}).json()
        self.assertEqual(allyears['record_count'], 3)
        self.assertIsNone(allyears['meta']['year'])
        self.assertEqual(y2026['record_count'], 2)
        self.assertEqual(y2026['meta']['year'], 2026)

    def test_archived_invalid_year_is_rejected(self):
        self._auth(self.admin)
        self.assertEqual(self.client.get(self.arch_url, {'year': 'abc'}).status_code,
                         status.HTTP_400_BAD_REQUEST)

    def test_archived_payload_is_read_only(self):
        _make_violation(status=Violation.Status.PAID)
        run_archive(self.admin)
        before = ArchivedViolation.objects.count()
        self._auth(self.admin)
        self.client.get(self.arch_url)
        self.assertEqual(ArchivedViolation.objects.count(), before)

    # ── audit logging ──────────────────────────────────────────────────
    def test_pdf_data_requests_are_audit_logged(self):
        _make_violation(status=Violation.Status.PAID)
        run_archive(self.admin)
        self._auth(self.admin)
        self.client.get(self.full_url)
        self.client.get(self.arch_url, {'year': 2024})
        full = AuditLog.objects.filter(action='EXPORT', module='Database Management').latest('id')
        arch = AuditLog.objects.filter(action='EXPORT', module='Archive Management').latest('id')
        self.assertEqual(full.status, 'SUCCESS')
        self.assertEqual(full.details['format'], 'pdf')
        self.assertEqual(arch.details['year'], 2024)
        self.assertEqual(arch.user, self.admin)

    # ── regressions: legacy Excel code + Archive/Delete untouched ─────
    def test_legacy_excel_exports_still_work(self):
        _make_violation(status=Violation.Status.PAID)
        run_archive(self.admin)
        self._auth(self.admin)
        self.assertIn('spreadsheetml', self.client.get(reverse('db-export-full'))['Content-Type'])
        self.assertIn('spreadsheetml', self.client.get(reverse('archive-export'))['Content-Type'])

    def test_legacy_excel_now_prints_readable_imported_by_and_manila_time(self):
        _make_violation(source='imported', imported_by=self.admin, enforcer=None,
                        date_issued=datetime(2024, 6, 1, 20, 0, tzinfo=dt_timezone.utc))
        wb, _ = build_full_export_workbook()
        ws = wb.active
        header = [c.value for c in ws[1]]
        row = [c.value for c in ws[2]]
        self.assertEqual(row[header.index('Imported By')], 'Admin Uploader')
        self.assertEqual(row[header.index('Date Issued')], '2024-06-02 04:00:00')

    @override_settings(ARCHIVE_DELETE_ENABLED=True)
    def test_archive_and_delete_behaviour_is_unchanged(self):
        _make_violation(status=Violation.Status.PAID)
        _make_violation(status=Violation.Status.PENDING)
        self._auth(self.admin)
        resp = self.client.post(reverse('archive-execute'))
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data['archived_count'], 1)
        self.assertEqual(Violation.objects.count(), 1)       # pending stays active
        rec = ArchivedViolation.objects.get()
        self.assertEqual(
            self.client.delete(reverse('archive-record-delete', args=[rec.pk])).status_code,
            status.HTTP_204_NO_CONTENT,
        )
        self.assertEqual(ArchivedViolation.objects.count(), 0)