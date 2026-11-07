"""Confiscated Licenses API (Staff = daily operations, Admin = oversight)."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.db.models import (
    CharField, DateTimeField, Exists, F, IntegerField, OuterRef, Q, Value, Case, When,
)
from django.db.models.fields.json import KT, KeyTextTransform
from django.db.models.functions import Cast, Coalesce, Concat
from django.utils import timezone
from rest_framework import status as http
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsAdmin, IsAdminOrStaff
from audit.models import AuditLog
from database_management.models import ArchivedViolation

from .custody import (
    DL, CustodyError, execute, resolve_target, _target_for_custody,
)
from .custody_models import LicenseCustody, LicenseCustodyEvent
from .custody_serializers import (
    CorrectSerializer, MarkReadySerializer, ReleaseSerializer,
    VerifyDocumentTypeSerializer, event_payload, release_payload,
)
from .models import Violation

MANILA = ZoneInfo('Asia/Manila')
C = CharField()
COLS = ('c_key', 'c_kind', 'c_ref', 'c_orig', 'c_ticket', 'c_owner', 'c_license', 'c_date',
        'c_status', 'c_doc', 'c_version', 'c_released', 'c_custody')


def _char(expr):
    return Cast(expr, C)


def _s1_active():
    """Active qualifying violations, left-joined to their (optional) custody."""
    return (
        Violation.objects
        .filter(license_status='confiscated')
        .filter(Q(confiscated_document_type=DL) | Q(confiscated_document_type=''))
        .annotate(
            c_key=Concat(Value('v'), _char('id'), output_field=C),
            c_kind=Value('active', output_field=C),
            c_ref=F('id'), c_orig=F('id'),
            c_ticket=_char('ovr_number'), c_owner=_char('violator_name'),
            c_license=Case(
                When(custody__corrected_license_number__gt='', then=F('custody__corrected_license_number')),
                default=F('license_number'), output_field=C),
            c_date=F('date_issued'),
            c_status=Coalesce('custody__status', Value('confiscated'), output_field=C),
            c_doc=Coalesce(
                'custody__doc_type_status',
                Case(When(confiscated_document_type='', then=Value('pending')),
                     default=Value('not_required'), output_field=C),
                output_field=C),
            c_version=Coalesce('custody__version', Value(0), output_field=IntegerField()),
            c_released=F('custody__released_at'),
            c_custody=F('custody__id'),
        )
    )


def _s2_archived_custody():
    """Custody rows linked to an archived violation: the row itself qualifies."""
    return (
        LicenseCustody.objects.filter(archived_violation__isnull=False)
        .annotate(
            c_key=Concat(Value('a'), _char('archived_violation_id'), output_field=C),
            c_kind=Value('archived', output_field=C),
            c_ref=F('archived_violation_id'), c_orig=F('original_violation_id'),
            c_ticket=Coalesce(_char(KeyTextTransform('ovr_number', 'archived_violation__data')), Value(''), output_field=C),
            c_owner=_char('archived_violation__violator_name'),
            c_license=Case(
                When(corrected_license_number__gt='', then=F('corrected_license_number')),
                default=F('archived_violation__license_number'), output_field=C),
            c_date=F('archived_violation__date_issued'),
            c_status=_char('status'), c_doc=_char('doc_type_status'),
            c_version=F('version'), c_released=F('released_at'), c_custody=F('id'),
        )
    )


def _s3_archived_snapshots():
    """Archived snapshots that qualify from their JSON and have no custody row
    and no active violation with the same id + date_issued."""
    active_twin = Violation.objects.filter(
        id=OuterRef('original_violation_id'), date_issued=OuterRef('date_issued'))
    return (
        ArchivedViolation.objects
        .filter(data__license_status='Confiscated')
        .filter(Q(data__confiscated_document_type__in=[DL, '']) | ~Q(data__has_key='confiscated_document_type'))
        .filter(custody__isnull=True)
        .exclude(Exists(active_twin))
        .annotate(
            c_typ=Coalesce(_char(KT('data__confiscated_document_type')), Value(''), output_field=C),
            c_key=Concat(Value('a'), _char('id'), output_field=C),
            c_kind=Value('archived', output_field=C),
            c_ref=F('id'), c_orig=F('original_violation_id'),
            c_ticket=Coalesce(_char(KT('data__ovr_number')), Value(''), output_field=C),
            c_owner=_char('violator_name'), c_license=_char('license_number'),
            c_date=F('date_issued'),
            c_status=Value('confiscated', output_field=C),
            c_doc=Case(When(c_typ='', then=Value('pending')),
                       default=Value('not_required'), output_field=C),
            c_version=Value(0, output_field=IntegerField()),
            c_released=Value(None, output_field=DateTimeField()),
            c_custody=Value(None, output_field=IntegerField()),
        )
    )


def _parse_day(s, end=False):
    try:
        d = datetime.strptime(s, '%Y-%m-%d')
    except (TypeError, ValueError):
        return None
    d = d.replace(tzinfo=MANILA)
    return d + timedelta(days=1) if end else d


def _filtered(qs, p, is_admin):
    q = (p.get('search') or '').strip()
    if q:
        qs = qs.filter(Q(c_ticket__icontains=q) | Q(c_owner__icontains=q) | Q(c_license__icontains=q))
    st = p.get('status')
    if st in ('confiscated', 'ready_for_release', 'released'):
        qs = qs.filter(c_status=st)
    start, end = _parse_day(p.get('date_from')), _parse_day(p.get('date_to'), end=True)
    if start:
        qs = qs.filter(c_date__gte=start)
    if end:
        qs = qs.filter(c_date__lt=end)
    legacy = p.get('legacy')
    if legacy == 'only':
        qs = qs.exclude(c_doc='not_required')
    elif legacy == 'exclude':
        qs = qs.filter(c_doc='not_required')
    if not (is_admin and p.get('include_excluded') in ('1', 'true', 'True')):
        qs = qs.exclude(c_doc='excluded')
    return qs.values(*COLS)


def build_union(params, is_admin):
    parts = [_filtered(b(), params, is_admin) for b in (_s1_active, _s2_archived_custody, _s3_archived_snapshots)]
    return parts[0].union(parts[1], parts[2])


def _row(r, is_admin, now):
    out = {
        'key': r['c_key'], 'record_kind': r['c_kind'], 'ticket_number': r['c_ticket'] or None,
        'owner_name': r['c_owner'], 'license_number': r['c_license'],
        'date_confiscated': r['c_date'], 'status': r['c_status'],
        'doc_type_status': r['c_doc'],
        'document_type_unverified': r['c_doc'] == 'pending',
        'legacy': r['c_doc'] != 'not_required',
        'version': r['c_version'], 'released_at': r['c_released'],
    }
    if is_admin:
        # Neutral elapsed-time display only - no overdue classification.
        end = r['c_released'] or now
        out['days_held'] = max((end - r['c_date']).days, 0)
    return out


def _summary(rows, now, is_admin):
    s = {'total': len(rows), 'confiscated': 0, 'pending_release': 0, 'released': 0,
         'legacy_unverified': 0}
    for r in rows:
        st, doc, dt = r['c_status'], r['c_doc'], r['c_date']
        key = {'confiscated': 'confiscated', 'ready_for_release': 'pending_release',
               'released': 'released'}[st]
        s[key] += 1
        if doc == 'pending':
            s['legacy_unverified'] += 1
    return s


class CustodyListView(APIView):
    permission_classes = [IsAdminOrStaff]

    def get(self, request):
        is_admin = request.user.role == 'admin'
        # ONE ordered pass over the union feeds both the page and the summary,
        # so the summary can never disagree with the list.
        all_rows = list(build_union(request.query_params, is_admin).order_by('-c_date', 'c_key'))
        now = timezone.now()
        summary = _summary(all_rows, now, is_admin)
        try:
            size = min(max(int(request.query_params.get('page_size', 10)), 1), 100)
            page = max(int(request.query_params.get('page', 1)), 1)
        except ValueError:
            size, page = 10, 1
        rows = all_rows[(page - 1) * size: page * size]
        return Response({
            'count': summary['total'], 'page': page, 'page_size': size,
            'summary': summary,
            'results': [_row(r, is_admin, now) for r in rows],
        })


class CustodySummaryView(APIView):
    permission_classes = [IsAdminOrStaff]

    def get(self, request):
        is_admin = request.user.role == 'admin'
        return Response(_summary(list(build_union(request.query_params, is_admin)),
                                 timezone.now(), is_admin))


def _error(e):
    body = {'code': e.code, 'detail': e.message, **e.extra}
    return Response(body, status=e.status)


def _detail(target, custody, is_admin):
    v, a = target.violation, target.archived
    if v is not None:
        data = {
            'ticket_number': v.ovr_number or None, 'owner_name': v.violator_name,
            'license_number': v.license_number, 'date_confiscated': v.date_issued,
            'violations': [i.violation_type.name for i in v.items.select_related('violation_type')],
            'notes': v.remarks,
        }
        legacy_blank = (v.confiscated_document_type or '') == ''
    else:
        d = a.data or {}
        data = {
            'ticket_number': d.get('ovr_number') or None, 'owner_name': a.violator_name,
            'license_number': a.license_number, 'date_confiscated': a.date_issued,
            'violations': [i.get('name', '') for i in d.get('items', [])],
            'notes': d.get('remarks', ''),
        }
        legacy_blank = d.get('confiscated_document_type', '') in ('', None)
    if custody is not None and custody.corrected_license_number:
        data['license_number'] = custody.corrected_license_number
    doc = custody.doc_type_status if custody else ('pending' if legacy_blank else 'not_required')
    data.update({
        'key': target.key, 'record_kind': target.kind,
        'status': custody.status if custody else 'confiscated',
        'doc_type_status': doc, 'document_type_unverified': doc == 'pending',
        'legacy': doc != 'not_required',
        'version': custody.version if custody else 0,
        'custody_id': custody.pk if custody else None,
        'ready_marked_at': custody.ready_marked_at if custody else None,
        'ready_marked_by': (custody.ready_marked_by.full_name
                            if custody and custody.ready_marked_by_id else ''),
        'release': release_payload(custody),
        'can_correct': is_admin and target.kind == 'active',
    })
    return data


class CustodyDetailView(APIView):
    permission_classes = [IsAdminOrStaff]

    def get(self, request, key):
        from django.db import transaction
        try:
            with transaction.atomic():
                t = resolve_target(key)
        except CustodyError as e:
            return _error(e)
        return Response(_detail(t, t.custody, request.user.role == 'admin'))


class _WriteView(APIView):
    permission_classes = [IsAdminOrStaff]
    serializer_class = None
    operation = None

    def fields(self, d):
        return {}

    def post(self, request, key):
        s = self.serializer_class(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        try:
            res = execute(request.user, self.operation, key, d['expected_version'],
                          d['client_request_id'], self.fields(d), request=request)
        except CustodyError as e:
            return _error(e)
        body = _detail(res.target, res.custody, request.user.role == 'admin')
        body['replayed'] = res.replayed
        return Response(body, status=http.HTTP_200_OK)


class MarkReadyView(_WriteView):
    serializer_class, operation = MarkReadySerializer, 'mark_ready'


class ReleaseView(_WriteView):
    serializer_class, operation = ReleaseSerializer, 'release'

    def fields(self, d):
        return {k: d[k] for k in ('released_to_name', 'claimant_id_type', 'claimant_id_last4',
                                  'authorization_reference', 'release_remarks')}


class VerifyDocumentTypeView(_WriteView):
    serializer_class, operation = VerifyDocumentTypeSerializer, 'verify_document_type'

    def fields(self, d):
        return {'decision': d['decision'], 'reason': d['reason']}


class CorrectView(_WriteView):
    permission_classes = [IsAdmin]          # corrections are Administrator-only
    serializer_class, operation = CorrectSerializer, 'correct'

    def fields(self, d):
        return {'license_number': d['license_number'], 'reason': d['reason']}


class CustodyTimelineView(APIView):
    """Per-record events. Staff see limited fields; Admin sees everything."""
    permission_classes = [IsAdminOrStaff]

    def get(self, request, key):
        from django.db import transaction
        try:
            with transaction.atomic():
                t = resolve_target(key)
        except CustodyError as e:
            return _error(e)
        is_admin = request.user.role == 'admin'
        events = (LicenseCustodyEvent.objects.filter(custody=t.custody)
                  if t.custody else LicenseCustodyEvent.objects.none())
        return Response({'results': [event_payload(e, is_admin) for e in events]})


class CustodyHistoryView(APIView):
    """Admin-only: global custody history + the matching AuditLog entries."""
    permission_classes = [IsAdmin]

    def get(self, request):
        events = LicenseCustodyEvent.objects.order_by('-created_at', '-id')[:200]
        audit = (AuditLog.objects.filter(target_type='LicenseCustody')
                 .order_by('-timestamp').values('id', 'timestamp', 'description', 'target_id', 'status')[:200])
        return Response({
            'events': [event_payload(e, True) for e in events],
            'audit_log': list(audit),
        })