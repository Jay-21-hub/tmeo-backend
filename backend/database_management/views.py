from django.conf import settings
from django.http import HttpResponse
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.pagination import PageNumberPagination
from rest_framework import status as http_status

from accounts.permissions import IsAdmin, IsAdminOrStaff
from audit.utils import log_action
from violations.models import Violation

from .export_utils import (
    build_full_export_workbook, get_exportable_columns,
    build_archived_export_workbook, get_archived_export_columns,
    build_full_pdf_payload, build_archived_pdf_payload,
)
from .archive_utils import (
    get_archive_preview, run_archive, ArchiveReconciliationError, ArchiveBusyError,
)
from .historical import archived_in_period, archived_years, deduped_archived
from .models import ArchiveBatch, ArchivedViolation
from .serializers import ArchiveBatchSerializer, ArchivedViolationSerializer


class ArchiveResultsPagination(PageNumberPagination):
    """Same shape as violations.views.StandardResultsPagination, kept local
    to this app so database_management doesn't depend on violations/views.py
    internals."""
    page_size = 20
    page_size_query_param = 'page_size'
    max_page_size = 100


def _int_param(request, name, lo, hi, required=False):
    """Parse an optional integer query parameter. Returns (value, error_response);
    a missing optional parameter is (None, None); anything non-numeric or out of
    range is a 400 instead of a database error."""
    raw = request.query_params.get(name)
    if raw in (None, ''):
        if required:
            return None, Response({'error': f'{name} is required.'}, status=http_status.HTTP_400_BAD_REQUEST)
        return None, None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None, Response({'error': f'{name} must be a number.'}, status=http_status.HTTP_400_BAD_REQUEST)
    if not lo <= value <= hi:
        return None, Response({'error': f'{name} is out of range.'}, status=http_status.HTTP_400_BAD_REQUEST)
    return value, None


YEAR_MIN, YEAR_MAX = 1900, 2200


# ─────────────────────────────────────────────────────────────────────────
# DATABASE MANAGEMENT — Full Database Export
# ─────────────────────────────────────────────────────────────────────────

class ExportableFieldsView(APIView):
    """Lets the frontend show which columns the current Full Export will
    contain, without generating the file — used for the pre-export summary."""
    permission_classes = [IsAdmin]

    def get(self, request):
        columns = get_exportable_columns()
        return Response({
            'field_count': len(columns),
            'labels': [label for _key, label in columns],
            'active_record_count': Violation.objects.count(),
        })


class FullDatabaseExportView(APIView):
    """
    Full Database Export (PART 5-11). Read-only: reads all active
    Violation records and returns them as an .xlsx download. Never
    modifies, archives, or deletes active data. Columns are derived
    dynamically at request time (see export_utils.get_exportable_columns).
    """
    permission_classes = [IsAdmin]

    def get(self, request):
        try:
            wb, record_count = build_full_export_workbook()
        except Exception as exc:
            log_action(
                user=request.user, action='EXPORT', module='Database Management',
                description='Full Database Export failed.',
                request=request, status='FAILED',
                details={'error': str(exc)},
            )
            return Response(
                {'error': 'Export failed. Please try again.'},
                status=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        timestamp = timezone.localtime().strftime('%Y-%m-%d_%H-%M')
        filename = f'TMEO_Full_Database_{timestamp}.xlsx'

        response = HttpResponse(
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
        wb.save(response)

        log_action(
            user=request.user, action='EXPORT', module='Database Management',
            description=f'Full Database Export — {record_count} active records exported to {filename}.',
            request=request, status='SUCCESS',
            details={'record_count': record_count, 'filename': filename},
        )
        return response


# ─────────────────────────────────────────────────────────────────────────
# ARCHIVE MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────

class ArchiveOverviewView(APIView):
    """Read-only preview for the confirmation dialog (PART 21) — how many
    active records exist and their year/settlement breakdown, plus how many
    are already archived."""
    permission_classes = [IsAdmin]

    def get(self, request):
        preview = get_archive_preview()
        preview['already_archived_count'] = ArchivedViolation.objects.count()
        preview['delete_enabled'] = settings.ARCHIVE_DELETE_ENABLED
        return Response(preview)


class ArchiveExecuteView(APIView):
    """
    Executes the archive operation: moves all current active Violation
    records into persistent ArchivedViolation storage, verifies the count
    reconciles, then clears the active table. All-or-nothing — see
    archive_utils.run_archive for the transactional guarantee.
    """
    permission_classes = [IsAdmin]

    def post(self, request):
        try:
            batch = run_archive(request.user)
        except ArchiveBusyError as exc:
            log_action(
                user=request.user, action='ARCHIVE', module='Archive Management',
                description='Archive request refused — another archive run is in progress. No data was changed.',
                request=request, status='WARNING',
                details={'outcome': 'busy', 'error': str(exc)},
            )
            return Response(
                {'error': str(exc), 'status': 'BUSY'},
                status=http_status.HTTP_409_CONFLICT,
            )
        except ArchiveReconciliationError as exc:
            log_action(
                user=request.user, action='ARCHIVE', module='Archive Management',
                description='Archive operation failed reconciliation — no data was changed.',
                request=request, status='FAILED',
                details={'outcome': 'reconciliation_failed', 'error': str(exc)},
            )
            return Response(
                {'error': str(exc), 'status': 'FAILED'},
                status=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        except Exception as exc:
            log_action(
                user=request.user, action='ARCHIVE', module='Archive Management',
                description='Archive operation failed unexpectedly — no data was changed.',
                request=request, status='FAILED',
                details={'outcome': 'failed', 'error': str(exc)},
            )
            return Response(
                {'error': 'Archive operation failed. No data was changed.', 'status': 'FAILED'},
                status=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        already = getattr(batch, 'skipped_already_archived_count', 0)
        conflicts = getattr(batch, 'archive_conflict_count', 0)
        notes = []
        if batch.skipped_in_progress_count:
            notes.append(f'{batch.skipped_in_progress_count} in-progress record(s) were left active.')
        if already:
            notes.append(f'{already} already-archived record(s) were left untouched.')
        if conflicts:
            notes.append(f'{conflicts} record(s) with a conflicting archive id were left untouched.')
        skip_note = (' ' + ' '.join(notes)) if notes else ''

        if conflicts:
            outcome, audit_status = 'archived_with_conflicts', 'WARNING'
        elif batch.archived_count:
            outcome, audit_status = 'archived', 'SUCCESS'
        else:
            outcome, audit_status = 'nothing_to_archive', 'SUCCESS'
        log_action(
            user=request.user, action='ARCHIVE', module='Archive Management',
            description=(
                f'Archived {batch.archived_count} record(s) '
                f'(batch #{batch.id}).{skip_note}'
            ),
            request=request, status=audit_status,
            details={
                'outcome': outcome,
                'batch_id': batch.id,
                'active_count_before': batch.active_count_before,
                'archived_count': batch.archived_count,
                'skipped_in_progress_count': batch.skipped_in_progress_count,
                'skipped_already_archived_count': already,
                'archive_conflict_count': conflicts,
            },
            target_type='ArchiveBatch', target_id=batch.id,
        )
        return Response(ArchiveBatchSerializer(batch).data, status=http_status.HTTP_201_CREATED)


class ArchiveYearsView(APIView):
    """Distinct archive years, derived dynamically from what's actually
    been archived (PART 14) — never a hardcoded list."""
    permission_classes = [IsAdminOrStaff]

    def get(self, request):
        # Checkpoint 2: Asia/Manila year of the original violation date
        # (date_issued), duplicate snapshots excluded — never the stored
        # violation_year column, which older archive runs computed in UTC.
        return Response({'years': archived_years()})


class ArchiveMonthsView(APIView):
    """
    Dynamic month list for a given archive year (Archive Management spec:
    ARCHIVE YEAR → MONTH). Grouping is always by the original violation
    date (date_issued), never the archive timestamp — an August-archived
    record for a June violation belongs to June. Months with zero records
    are never returned; there is no hardcoded 12-month list.
    """
    permission_classes = [IsAdminOrStaff]

    def get(self, request):
        year, err = _int_param(request, 'year', YEAR_MIN, YEAR_MAX, required=True)
        if err:
            return err

        from django.db.models.functions import ExtractMonth
        from django.db.models import Count, Q

        rows = (
            archived_in_period(deduped_archived(), year=year)
            .annotate(month=ExtractMonth('date_issued'))
            .values('month')
            .annotate(
                total=Count('id'),
                settled=Count('id', filter=Q(settlement_status='settled')),
                unsettled=Count('id', filter=Q(settlement_status='unsettled')),
            )
            .order_by('month')
        )
        return Response({'year': year, 'months': list(rows)})


class ArchiveRecordsView(APIView):
    """
    Browsable archived records (PART 22), filterable by year, month (of the
    original violation date), settlement status, and a text search across
    violator name / license / plate / violation ID.
    """
    permission_classes = [IsAdminOrStaff]
    pagination_class = ArchiveResultsPagination

    def get(self, request):
        year, err = _int_param(request, 'year', YEAR_MIN, YEAR_MAX)
        if err:
            return err
        month, err = _int_param(request, 'month', 1, 12)
        if err:
            return err

        # Checkpoint 2: duplicate snapshots removed; year/month are the
        # Asia/Manila year/month of date_issued; newest violation first.
        qs = deduped_archived(
            ArchivedViolation.objects.prefetch_related('evidence__captured_by')
        )
        qs = archived_in_period(qs, year=year, month=month)
        qs = qs.order_by('-date_issued', '-pk')

        settlement = request.query_params.get('settlement_status')
        if settlement in ('settled', 'unsettled'):
            qs = qs.filter(settlement_status=settlement)

        search = request.query_params.get('search')
        if search:
            from django.db.models import Q
            qs = qs.filter(
                Q(violator_name__icontains=search) |
                Q(license_number__icontains=search) |
                Q(plate_number__icontains=search) |
                Q(original_violation_id__icontains=search)
            )

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request)
        serializer = ArchivedViolationSerializer(page, many=True, context={'request': request})
        return paginator.get_paginated_response(serializer.data)


class ArchiveBatchListView(APIView):
    """History of past archive operations (success and failure)."""
    permission_classes = [IsAdmin]

    def get(self, request):
        batches = ArchiveBatch.objects.all()[:50]
        return Response(ArchiveBatchSerializer(batches, many=True).data)


class ArchivedViolationDeleteView(APIView):
    """
    Individual archived-record deletion (dev/beta feature). Deletes ONLY
    the targeted ArchivedViolation row — never the active Violation, ticket,
    payment, or evidence, and never a whole month/year/archive.

    Backend enforces both the admin-only permission and the
    ARCHIVE_DELETE_ENABLED flag itself, independent of whether the frontend
    button is shown, per the spec's "frontend hiding alone is not security."
    """
    permission_classes = [IsAdmin]

    def delete(self, request, pk):
        if not settings.ARCHIVE_DELETE_ENABLED:
            return Response(
                {'error': 'Archive deletion is disabled on this environment.'},
                status=http_status.HTTP_403_FORBIDDEN,
            )
        try:
            record = ArchivedViolation.objects.get(pk=pk)
        except ArchivedViolation.DoesNotExist:
            return Response({'error': 'Archived record not found.'}, status=http_status.HTTP_404_NOT_FOUND)

        snapshot = {
            'original_violation_id': record.original_violation_id,
            'violator_name': record.violator_name,
            'violation_year': record.violation_year,
            'settlement_status': record.settlement_status,
        }
        # Archive hardening (Checkpoint 1): evidence relinked to this record
        # is PROTECTed. Refuse with 409 instead of orphaning (or destroying)
        # the photos; nothing is deleted.
        from django.db.models import ProtectedError
        try:
            record.delete()
        except ProtectedError:
            return Response(
                {'error': 'This archived record has preserved evidence and cannot be deleted.'},
                status=http_status.HTTP_409_CONFLICT,
            )

        log_action(
            user=request.user, action='DELETE', module='Archive Management',
            description=(
                f"Deleted archived violation record "
                f"#{snapshot['original_violation_id']} "
                f"({snapshot['violator_name']}, {snapshot['violation_year']})."
            ),
            request=request, status='SUCCESS',
            details=snapshot,
            target_type='ArchivedViolation', target_id=pk,
        )
        return Response(status=http_status.HTTP_204_NO_CONTENT)

# ─────────────────────────────────────────────────────────────────────────
# ARCHIVE MANAGEMENT — Archived Records Export
#
# Same pattern as the active-data Full Database Export above, but reads
# ArchivedViolation snapshots instead — the export the frontend's Archive
# Management "Export" tab calls, never the active Violation table.
# ─────────────────────────────────────────────────────────────────────────

class ArchivedExportFieldsView(APIView):
    """Lets the frontend show which columns an Archived Records export will
    contain (and how many records match), without generating the file —
    same pre-export summary role as ExportableFieldsView, scoped to the
    archive and an optional ?year= filter."""
    permission_classes = [IsAdmin]

    def get(self, request):
        year_int, err = _int_param(request, 'year', YEAR_MIN, YEAR_MAX)
        if err:
            return err
        columns = get_archived_export_columns()
        # Same Manila-year filter + duplicate removal as the export itself, so
        # the pre-export count always equals the number of exported rows.
        qs = archived_in_period(deduped_archived(), year=year_int)
        return Response({
            'field_count': len(columns),
            'labels': [label for _key, label in columns],
            'archived_record_count': qs.count(),
            'year': year_int,
        })


class ArchivedExportView(APIView):
    """
    Archived Records Export (Archive Management). Read-only: reads
    ArchivedViolation snapshots — never the active Violation table — and
    returns them as an .xlsx download. Optional `?year=` scopes the export
    to a single archive year; omitted, every archived record is exported.
    """
    permission_classes = [IsAdmin]

    def get(self, request):
        year_int, err = _int_param(request, 'year', YEAR_MIN, YEAR_MAX)
        if err:
            return err

        try:
            wb, record_count = build_archived_export_workbook(year=year_int)
        except Exception as exc:
            log_action(
                user=request.user, action='EXPORT', module='Archive Management',
                description='Archived Records Export failed.',
                request=request, status='FAILED',
                details={'error': str(exc), 'year': year_int},
            )
            return Response(
                {'error': 'Export failed. Please try again.'},
                status=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        timestamp = timezone.localtime().strftime('%Y-%m-%d_%H-%M')
        year_part = f'_{year_int}' if year_int else '_All'
        filename = f'TMEO_Archived_Records{year_part}_{timestamp}.xlsx'

        response = HttpResponse(
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
        wb.save(response)

        log_action(
            user=request.user, action='EXPORT', module='Archive Management',
            description=(
                f'Archived Records Export — {record_count} archived record(s) '
                f'exported to {filename}.'
            ),
            request=request, status='SUCCESS',
            details={'record_count': record_count, 'filename': filename, 'year': year_int},
        )
        return response


# ─────────────────────────────────────────────────────────────────────────
# PDF EXPORT DATA — Full Database Export + Archived Records Export
#
# Read-only, Admin-only. The PDF is drawn in the browser (jsPDF); these
# endpoints only return the already-resolved rows (see export_utils
# build_*_pdf_payload) plus the metadata the PDF header needs. The legacy
# .xlsx endpoints above are intentionally left in place, unreachable from
# the normal Admin UI.
# ─────────────────────────────────────────────────────────────────────────

def _pdf_meta(request, *, scope, year, record_count):
    generated = timezone.localtime(timezone.now())   # Asia/Manila (TIME_ZONE)
    return {
        'generated_at': generated.isoformat(),
        'generated_by': (request.user.full_name or '').strip(),
        'scope': scope,
        'year': year,
        'record_count': record_count,
        'timezone': 'Asia/Manila',
    }


class FullDatabasePdfDataView(APIView):
    """Data for the Full Database Export PDF — every active Violation."""
    permission_classes = [IsAdmin]

    def get(self, request):
        try:
            payload = build_full_pdf_payload()
        except Exception as exc:
            log_action(
                user=request.user, action='EXPORT', module='Database Management',
                description='Full Database Export (PDF) failed.',
                request=request, status='FAILED',
                details={'error': str(exc), 'format': 'pdf'},
            )
            return Response(
                {'error': 'Export failed. Please try again.'},
                status=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        record_count = payload['record_count']
        payload['meta'] = _pdf_meta(
            request, scope='Full Database (Active Records)', year=None,
            record_count=record_count,
        )
        log_action(
            user=request.user, action='EXPORT', module='Database Management',
            description=f'Full Database Export (PDF) — {record_count} active records prepared.',
            request=request, status='SUCCESS',
            details={'record_count': record_count, 'format': 'pdf'},
        )
        return Response(payload)


class ArchivedExportPdfDataView(APIView):
    """Data for the Archived Records Export PDF. Optional `?year=` scopes it
    to one violation year; omitted = All Years."""
    permission_classes = [IsAdmin]

    def get(self, request):
        year_int, err = _int_param(request, 'year', YEAR_MIN, YEAR_MAX)
        if err:
            return err

        try:
            payload = build_archived_pdf_payload(year=year_int)
        except Exception as exc:
            log_action(
                user=request.user, action='EXPORT', module='Archive Management',
                description='Archived Records Export (PDF) failed.',
                request=request, status='FAILED',
                details={'error': str(exc), 'year': year_int, 'format': 'pdf'},
            )
            return Response(
                {'error': 'Export failed. Please try again.'},
                status=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        record_count = payload['record_count']
        payload['meta'] = _pdf_meta(
            request, scope='Archived Records', year=year_int, record_count=record_count,
        )
        log_action(
            user=request.user, action='EXPORT', module='Archive Management',
            description=(
                f'Archived Records Export (PDF) — {record_count} archived record(s) prepared'
                f'{f" for {year_int}" if year_int else " (all years)"}.'
            ),
            request=request, status='SUCCESS',
            details={'record_count': record_count, 'year': year_int, 'format': 'pdf'},
        )
        return Response(payload)