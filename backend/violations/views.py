import copy
import datetime
import io
from zoneinfo import ZoneInfo
from django.http import HttpResponse
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.exceptions import APIException
from rest_framework.views import APIView
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.pagination import PageNumberPagination
from django.db.models import Q, Count
from django.db.models.functions import Lower, ExtractYear
from django.db import models, transaction
from django.utils import timezone

from .models import (
    Violation, ViolationType, ViolationItem, VehicleBrandModel,
    Assessment, ViolationEvidence,
)
from .serializers import (
    ViolationListSerializer,
    ViolationDetailSerializer,
    ViolationTypeSerializer,
    VehicleBrandModelSerializer,
    AssessmentSerializer,
    AssessmentRecordSerializer,
    ViolationEvidenceSerializer,
    EvidenceAssociateSerializer,
    PublicViolationSerializer,
    _items_with_types,
)
from accounts.permissions import IsAdminOrReadOnly, IsAdmin
from audit.utils import log_action, build_changes, snapshot
from accounts.identity import (
    snapshot_fields, latest_enforcer_snapshots, grouped_enforcer_identity,
    enforcer_identity, assessor_identity,
)
from .views_sse import broadcast_lock_event
from .fine_history import record_fine_change, record_initial_fine
from .attribution import record_payment_confirmer
# REQUIREMENT #8 (Analytics Year Comparison): a settled violation is moved
# out of this app's own Violation table once archived (REQUIREMENT #2) and
# only continues to exist as an ArchivedViolation row in database_management.
# Year-comparison analytics has to read both tables or a year that has since
# been archived would silently show as empty. database_management.models
# only imports from accounts, so this does not introduce a circular import.
from database_management.models import ArchivedViolation
from database_management.historical import deduped_archived, manila_year

# The only vehicle_type values a NEW record can carry (VehicleCatalogField
# always writes the category label on save). Older records issued before
# that fix can still hold raw legacy text (e.g. "Bus", "Bike", "Tricycle")
# that doesn't belong to any of our 5 top-level categories — filtering to
# this list keeps those stray legacy values out of any vehicle-type
# breakdown/chart instead of listing them as if they were real categories.
VALID_VEHICLE_TYPE_LABELS = [label for _, label in VehicleBrandModel.Category.choices]


# ─── Permissions ────────────────────────────────────────────────────────────

class IsAdminOrStaff(permissions.BasePermission):
    def has_permission(self, request, view):
        return request.user.is_authenticated and request.user.role in ('admin', 'staff')


class IsEnforcer(permissions.BasePermission):
    def has_permission(self, request, view):
        return request.user.is_authenticated and request.user.role in ('admin', 'enforcer')


class EvidenceArchivedConflict(APIException):
    """409 for any write that would touch evidence owned by an archived record."""
    status_code = status.HTTP_409_CONFLICT
    default_detail = 'This evidence belongs to an archived record and is read-only.'


class IsEvidenceOwnerOrStaff(permissions.BasePermission):
    """
    Object-level check for evidence writes: the Enforcer who captured the
    photo may associate/edit it; Admin/Staff may always act on any evidence.
    """
    def has_object_permission(self, request, view, obj):
        user = request.user
        if not user.is_authenticated:
            return False
        if user.role in ('admin', 'staff'):
            return True
        return obj.captured_by_id == user.id


# ─── Repeat-violator status (active database / SAME calendar year ONLY) ─────
#
# "Repeat violator" is never stored on the model — it is always computed
# fresh from the active `Violation` table (see MASTER PROMPT: repeat status
# must be dynamic and must never be a permanent field). Archiving alone is
# NOT relied on to keep this year-clean: archiving is a manual/on-demand
# action (database_management.archive_utils.run_archive), so the active
# table can legitimately hold more than one year's worth of unarchived
# rows at once. Without an explicit year key, a violator's 2024 ticket and
# 2026 ticket would wrongly combine into "REPEAT VIOLATOR" just because
# both still happen to sit in the active table.
#
# So counts are grouped by (identity_key, date_issued year) — two rows only
# count toward each other's repeat total when they're the SAME violator AND
# the SAME calendar year. Two small aggregate queries (grouped by
# license_number, and separately by violator_name for the rare blank-license
# record) — not one query per row — so this stays cheap regardless of how
# many rows are being listed.
def build_repeat_count_maps():
    license_counts = (
        Violation.objects.exclude(license_number='')
        .annotate(_key=Lower('license_number'), _year=ExtractYear('date_issued'))
        .values('_key', '_year').annotate(c=Count('id')).values_list('_key', '_year', 'c')
    )
    name_counts = (
        Violation.objects.filter(license_number='')
        .exclude(violator_name='')
        .annotate(_key=Lower('violator_name'), _year=ExtractYear('date_issued'))
        .values('_key', '_year').annotate(c=Count('id')).values_list('_key', '_year', 'c')
    )
    return (
        {(k, y): c for k, y, c in license_counts},
        {(k, y): c for k, y, c in name_counts},
    )


# ─── Violation Types ─────────────────────────────────────────────────────────

class ViolationTypeListView(generics.ListCreateAPIView):
    serializer_class = ViolationTypeSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = None

    def get_queryset(self):
        return ViolationType.objects.all().order_by('category', 'code')

    def get_permissions(self):
        if self.request.method == 'POST':
            return [permissions.IsAuthenticated(), IsAdminOrStaff()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        # First fine-history row, so every type has a baseline from day one.
        with transaction.atomic():
            instance = serializer.save()
            record_initial_fine(instance, self.request.user)


class ViolationTypeDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = ViolationTypeSerializer
    permission_classes = [permissions.IsAuthenticated, IsAdminOrStaff]
    queryset = ViolationType.objects.all()

    def perform_update(self, serializer):
        # A fine is money: only an Administrator may change it, even though
        # Staff may still edit the other fields of a violation type. Checked
        # on the server so hiding the button in the UI is never the only guard.
        from rest_framework.exceptions import PermissionDenied
        new_fine = serializer.validated_data.get('penalty_amount')
        if (new_fine is not None
                and new_fine != serializer.instance.penalty_amount
                and self.request.user.role != 'admin'):
            raise PermissionDenied('Only an Administrator can change a violation fine.')
        # penalty_amount is audited so the Audit Log shows who changed the fine
        # and what it was before. Existing violations keep their own snapshot.
        audited = ('name', 'code', 'category', 'is_active', 'penalty_amount')
        before = snapshot(serializer.instance, audited)
        old_fine = serializer.instance.penalty_amount
        with transaction.atomic():
            instance = serializer.save()
            if instance.penalty_amount != old_fine:
                # Fine history: lets an offline-synced OVR be priced by the
                # fine that was in force when it was issued.
                record_fine_change(instance, old_fine, self.request.user)
        after = snapshot(instance, audited)
        log_action(
            user=self.request.user,
            action='UPDATE',
            module='Violation Types',
            description=f'{self.request.user.full_name} updated violation type: {instance.name}',
            request=self.request,
            target_type='ViolationType',
            target_id=instance.id,
            changes=build_changes(before, after),
        )

    def perform_destroy(self, instance):
        name = instance.name
        target_id = instance.id
        instance.delete()
        log_action(
            user=self.request.user,
            action='DELETE',
            module='Violation Types',
            description=f'{self.request.user.full_name} deleted violation type: {name}',
            request=self.request,
            target_type='ViolationType',
            target_id=target_id,
        )


# ─── Vehicle Brands / Models ─────────────────────────────────────────────────
# Shared brand/model catalog for both the enforcer's Submit Report and the
# staff Assessment Form. Each row carries its own `category` directly (no
# more separate VehicleType table/lookup — Category is the only
# classification now). Write access is admin-only per product decision —
# staff/enforcer can list, only admins add/edit/remove entries.

class VehicleBrandModelListView(generics.ListCreateAPIView):
    serializer_class = VehicleBrandModelSerializer
    permission_classes = [permissions.IsAuthenticated, IsAdminOrReadOnly]
    pagination_class = None
    queryset = VehicleBrandModel.objects.all()

    def perform_create(self, serializer):
        instance = serializer.save()
        log_action(
            user=self.request.user,
            action='CREATE',
            module='Vehicle Brands & Models',
            description=f'{self.request.user.full_name} added: {instance.brand} {instance.model}',
            request=self.request,
            target_type='VehicleBrandModel',
            target_id=instance.id,
        )


class VehicleBrandModelDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = VehicleBrandModelSerializer
    permission_classes = [permissions.IsAuthenticated, IsAdminOrReadOnly]
    queryset = VehicleBrandModel.objects.all()

    def perform_update(self, serializer):
        before = snapshot(serializer.instance, ('brand', 'model', 'category'))
        instance = serializer.save()
        after = snapshot(instance, ('brand', 'model', 'category'))
        log_action(
            user=self.request.user,
            action='UPDATE',
            module='Vehicle Brands & Models',
            description=f'{self.request.user.full_name} updated: {instance.brand} {instance.model}',
            request=self.request,
            target_type='VehicleBrandModel',
            target_id=instance.id,
            changes=build_changes(before, after),
        )

    def perform_destroy(self, instance):
        label = f'{instance.brand} {instance.model}'
        target_id = instance.id
        instance.delete()
        log_action(
            user=self.request.user,
            action='DELETE',
            module='Vehicle Brands & Models',
            description=f'{self.request.user.full_name} deleted: {label}',
            request=self.request,
            target_type='VehicleBrandModel',
            target_id=target_id,
        )


# ─── Violations (Enforcer — create) ──────────────────────────────────────────

def actor_label(user):
    """Role-accurate label for the user who PERFORMED an event, taken from the
    authoritative role field (never hardcoded, never the notification viewer):
    'Enforcer Erwin', 'Assessment Staff Jay', 'Administrator Ana'."""
    if user is None:
        return 'System'
    return f'{user.get_role_display()} {user.full_name}'.strip()


OFFLINE_SYNC_DENIED_MSG = 'This offline report cannot be synced with the current account.'


class ViolationCreateView(generics.CreateAPIView):
    serializer_class = ViolationDetailSerializer
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def create(self, request, *args, **kwargs):
        import json
        from django.http import QueryDict

        # Normalize violation_type_ids regardless of request format (JSON or multipart)
        if isinstance(request.data, QueryDict):
            # multipart/form-data — QueryDict supports getlist/setlist.
            # copy.copy (shallow) on purpose: QueryDict.copy() deep-copies, and an uploaded
            # file larger than FILE_UPLOAD_MAX_MEMORY_SIZE (2.5 MB, disk-backed
            # TemporaryUploadedFile) cannot be deep-copied -> HTTP 500 for any OVR with a
            # license photo above ~2.5 MB (the UI allows up to 5 MB).
            data = copy.copy(request.data)
            ids_from_multipart = request.data.getlist('violation_type_ids[]')
            if ids_from_multipart:
                data.setlist('violation_type_ids', ids_from_multipart)
            else:
                raw_ids = request.data.get('violation_type_ids', '[]')
                if isinstance(raw_ids, str):
                    try:
                        parsed_ids = json.loads(raw_ids)
                        data.setlist('violation_type_ids', [str(i) for i in parsed_ids])
                    except (json.JSONDecodeError, ValueError):
                        pass
        else:
            # JSON — request.data is a plain dict, no getlist/setlist
            data = dict(request.data)
            raw_ids = data.get('violation_type_ids', [])
            if isinstance(raw_ids, str):
                try:
                    raw_ids = json.loads(raw_ids)
                except (json.JSONDecodeError, ValueError):
                    raw_ids = []
            data['violation_type_ids'] = [str(i) for i in raw_ids]

        # ── Idempotent replay (Requirement #10 / #6) ────────────────────
        # The offline queue sends a client-generated `client_offline_id`
        # with every sync attempt for a given queued record. If a Violation
        # with that id already exists — because a previous sync attempt's
        # POST actually reached the server but the client never saw the
        # response (timeout, app closed, dropped connection) and so
        # re-sent it — return the EXISTING record instead of creating a
        # second one. This is the only thing that can safely dedupe across
        # retries; ovr_number is not unique and can't be used for this.
        client_offline_id = data.get('client_offline_id') or None
        if isinstance(client_offline_id, (list, tuple)):
            client_offline_id = client_offline_id[0] if client_offline_id else None
        if client_offline_id:
            # BATCH 0 (D7): offline-keyed creation belongs to Enforcers only,
            # and the role check runs BEFORE the replay lookup. A queued
            # offline OVR that reaches the server under a Staff/Admin token
            # (e.g. role changed while it sat unsynced on a device) must not
            # be filed as an enforcer_ovr attributed to a non-enforcer.
            # Same generic message for every refusal below so a caller
            # cannot probe which client_offline_ids exist or who owns them.
            if request.user.role != 'enforcer':
                return Response(
                    {'detail': OFFLINE_SYNC_DENIED_MSG},
                    status=status.HTTP_403_FORBIDDEN,
                )
            existing = Violation.objects.filter(client_offline_id=client_offline_id).first()
            if existing is not None:
                # Replay is only honoured for the enforcer who created the
                # record; anyone else gets the same generic 403 (no detail
                # leak, no ownership oracle).
                if existing.enforcer_id != request.user.id:
                    return Response(
                        {'detail': OFFLINE_SYNC_DENIED_MSG},
                        status=status.HTTP_403_FORBIDDEN,
                    )
                serializer = self.get_serializer(existing)
                return Response(serializer.data, status=status.HTTP_200_OK)

            # Archive hardening (Checkpoint 1): the ticket may have been
            # ARCHIVED between the original POST and this late re-sync, in
            # which case no active row exists any more and a plain create
            # would file a DUPLICATE of an already-archived ticket. The
            # snapshot keeps client_offline_id, so recognise it here.
            # One JSON key only, ordered by pk, LIMIT 1 (no sort, no payload).
            archived_owner = list(
                ArchivedViolation.objects
                .filter(data__client_offline_id=client_offline_id)
                .order_by('pk')
                .values_list('data__enforcer_user_id', flat=True)[:1]
            )
            if archived_owner:
                # Same ownership rule and the SAME generic 403 as the active
                # branch above, so a caller cannot tell an active id from an
                # archived one, nor learn who owns either. An archived record
                # with no recorded owner is refused too (fail closed).
                if archived_owner[0] != request.user.id:
                    return Response(
                        {'detail': OFFLINE_SYNC_DENIED_MSG},
                        status=status.HTTP_403_FORBIDDEN,
                    )
                # 200 (not 201): nothing was created. id is null because the
                # active ticket no longer exists; the offline queue treats this
                # as synced and stops retrying.
                return Response(
                    {'id': None, 'already_archived': True,
                     'client_offline_id': client_offline_id},
                    status=status.HTTP_200_OK,
                )

        # SOURCE IS DERIVED FROM THE AUTHENTICATED USER, NEVER TRUSTED FROM
        # THE CLIENT. `staff_walk_in` skips the mandatory manual OVR number
        # (see ViolationDetailSerializer.validate), so an enforcer who sent
        # source=staff_walk_in could otherwise file an OVR with no City Hall
        # OVR number at all. Enforcers are always ENFORCER_OVR; only
        # Admin/Staff may create walk-in records.
        if request.user.role == 'enforcer':
            data['source'] = Violation.Source.ENFORCER_OVR
        # Admin/Staff keep whatever they send; an unrecognised value is
        # rejected by the serializer's choice validation, and an omitted
        # one falls back to the model default (ENFORCER_OVR), which still
        # requires a manual OVR number. Nothing here weakens that rule.

        serializer = self.get_serializer(data=data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        headers = self.get_success_headers(serializer.data)
        return Response(serializer.data, status=status.HTTP_201_CREATED, headers=headers)

    def perform_create(self, serializer):
        # Enforcer-issued OVR: the authenticated Enforcer is the filer.
        # Staff walk-in complaint: there is NO Enforcer on this record —
        # never fabricate one just to satisfy the normal OVR relationship.
        source = serializer.validated_data.get('source', Violation.Source.ENFORCER_OVR)
        if source == Violation.Source.STAFF_WALK_IN:
            # No apprehending Enforcer: FK and every enforcer_* snapshot stay
            # at their defaults (NULL / source='unknown').
            violation = serializer.save(enforcer=None)
        else:
            # Role Evolution Phase 2: freeze the filer's identity AT EVENT
            # TIME, from the authenticated server-side user only (the client
            # payload can never supply it). Offline sync reaches this line
            # only after the Batch 0 role / ownership guards in create().
            violation = serializer.save(
                enforcer=self.request.user,
                **snapshot_fields(self.request.user, 'enforcer', badge=True),
            )

        # Send notifications AFTER items are saved so vtype_names is accurate
        try:
            from notifications.models import Notification
            from notifications.views_sse import broadcast_notification
            vtype_names = ', '.join(
                violation.items.select_related('violation_type')
                               .values_list('violation_type__name', flat=True)
            ) or 'N/A'
            # The actor is whoever actually created the record, labelled with
            # their REAL role. An Enforcer OVR reads "Enforcer <name>"; a Staff
            # walk-in (Assessment Form) reads "Assessment Staff <name>" — it is
            # never called an Enforcer.
            submitter     = violation.enforcer or self.request.user
            submitter_lbl = actor_label(submitter)
            staff_title   = 'New Violation Submitted'
            staff_msg     = (
                f'{submitter_lbl} submitted a violation for '
                f'{violation.violator_name} ({vtype_names}).'
            )
            admin_title   = 'New Violation Submitted'
            admin_msg     = (
                f'{submitter_lbl} filed a violation — {vtype_names} '
                f'at {violation.location or "N/A"}.'
            )
            Notification.objects.create(
                recipient_role='staff',
                notif_type='new_violation',
                title=staff_title,
                message=staff_msg,
                related_user=submitter,
                related_violation_id=violation.id,
            )
            Notification.objects.create(
                recipient_role='admin',
                notif_type='new_violation',
                title=admin_title,
                message=admin_msg,
                related_user=submitter,
                related_violation_id=violation.id,
            )
            # Broadcast real-time via SSE
            broadcast_notification('staff', staff_title, staff_msg, 'new_violation', violation.id)
            broadcast_notification('admin', admin_title, admin_msg, 'new_violation', violation.id)
        except Exception:
            pass

        log_action(
            user        = self.request.user,
            action      = 'CREATE',
            module      = 'Violations',
            description = (
                f'{self.request.user.full_name} filed a violation ticket for '
                f'{violation.violator_name} — Plate: {violation.plate_number or "N/A"} '
                f'at {violation.location or "N/A"}'
            ),
            request     = self.request,
            target_type = 'Violation',
            target_id   = violation.id,
            details     = {
                'violation_id':   violation.id,
                'violator_name':  violation.violator_name,
                'plate_number':   violation.plate_number or None,
                'location':       violation.location or None,
                'ovr_number':     getattr(violation, 'ovr_number', None) or None,
                'violations':     list(
                    violation.items.select_related('violation_type')
                                   .values_list('violation_type__name', flat=True)
                ),
                'penalty_amount': str(violation.penalty_amount) if violation.penalty_amount else None,
                'enforcer':       self.request.user.full_name,
                'badge_no':       self.request.user.badge_number or None,
            },
        )


def _name_suggestions(last_name, first_name):
    """Up to 5 distinct people whose stored name starts with the last name.

    Names are stored as "Last, First ..." (Assessment also uses commas
    between the remaining parts). First name, when given, must appear
    after the comma. Only name and address are returned.
    """
    qs = Violation.objects.filter(violator_name__istartswith=last_name)
    first = (first_name or '').strip()
    if first:
        qs = qs.filter(
            Q(violator_name__icontains=f', {first}')
            | Q(violator_name__icontains=f',{first}')
        )
    seen = set()
    suggestions = []
    for row in qs.order_by('-date_issued').values('violator_name', 'address')[:200]:
        name = (row['violator_name'] or '').strip()
        address = (row['address'] or '').strip()
        key = (name.lower(), address.lower())
        if not name or key in seen:
            continue
        seen.add(key)
        suggestions.append({'violator_name': name, 'address': address})
        if len(suggestions) == 5:
            break
    return suggestions


class ViolatorLookupView(APIView):
    """
    Looks up a violator's history by license number and/or plate number,
    called BEFORE a new violation is saved (enforcer's Submit Report form,
    staff's Assessment Form). Two things come out of this:

      1. `match` — identity fields from their most recent violation, used
         to auto-fill the form (name, address, vehicle info, etc).
      2. `violation_count` / `history` — how many prior violations exist
         and where, used to show a repeat-offender badge.

    This is a READ-ONLY aggregation over existing Violation rows. It never
    edits, merges, or copies old records into a new one — each violation
    stays its own independent row. The "repeat offender" count is always
    computed fresh from a query, never stored/stacked onto any record, so
    past violations never pile up onto the current one being filed.
    """
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        user = request.user
        if (
            getattr(user, 'role', None) not in ('enforcer', 'staff', 'admin')
            or not getattr(user, 'is_active', False)
            or getattr(user, 'is_separated', False)
        ):
            return Response({'error': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)
        license_number = (request.query_params.get('license_number') or '').strip()
        plate_number = (request.query_params.get('plate_number') or '').strip()
        last_name = (request.query_params.get('last_name') or '').strip()
        first_name = (request.query_params.get('first_name') or '').strip()

        if not license_number and not plate_number and last_name:
            if len(last_name) < 3:
                return Response(
                    {'error': 'last_name must be at least 3 characters.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            suggestions = _name_suggestions(last_name, first_name)
            return Response({
                'found': bool(suggestions),
                'violation_count': 0,
                'is_repeat_offender': False,
                'match': None,
                'personal': None,
                'vehicle': None,
                'history': [],
                'suggestions': suggestions,
            })

        if not license_number and not plate_number:
            return Response(
                {'error': 'Provide license_number and/or plate_number.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        match_q = Q()
        if license_number:
            match_q |= Q(license_number__iexact=license_number)
        if plate_number:
            match_q |= Q(plate_number__iexact=plate_number)

        qs = Violation.objects.filter(match_q).order_by('-date_issued')

        personal = None
        if license_number:
            person = (
                Violation.objects.filter(license_number__iexact=license_number)
                .order_by('-date_issued')
                .first()
            )
            if person:
                personal = {
                    'violator_name': person.violator_name,
                    'address': person.address,
                    'license_number': person.license_number,
                }
        vehicle = None
        if plate_number:
            car = (
                Violation.objects.filter(plate_number__iexact=plate_number)
                .order_by('-date_issued')
                .first()
            )
            if car:
                vehicle = {
                    'plate_number': car.plate_number,
                    'registration_number': car.registration_number,
                    'vehicle_type': car.vehicle_type,
                    'vehicle_brand': car.vehicle_brand,
                    'vehicle_model': car.vehicle_model,
                    'vehicle_use': car.vehicle_use,
                    'violator_name': car.violator_name,
                    'address': car.address,
                }

        if not qs.exists():
            return Response({
                'found': False,
                'violation_count': 0,
                'is_repeat_offender': False,
                'match': None,
                'personal': personal,
                'vehicle': vehicle,
                'history': [],
                'suggestions': [],
            })

        # This lookup runs while filing a NEW OVR dated "now", so the
        # repeat-offender count/flag is scoped to the SAME calendar year as
        # the ticket being filed — a violation from a prior year (still
        # sitting in the active table because archiving hasn't run yet)
        # must not make today's first ticket of the year look like a repeat.
        current_year = timezone.now().year
        violation_count = qs.filter(date_issued__year=current_year).count()

        # `match` (autofill) and `history` (context for staff/admin) still
        # draw from the violator's full active-table record, not just this
        # year — only the repeat COUNT/FLAG is year-scoped.
        latest = qs.first()

        history = list(
            qs.values('id', 'date_issued', 'location', 'address', 'status',
                      'latitude', 'longitude')[:20]
        )
        # Bulk-fetch violation type names for the history rows (2 queries
        # total instead of N+1 — one per history row).
        history_ids = [row['id'] for row in history]
        type_map = {}
        for row in ViolationItem.objects.filter(violation_id__in=history_ids) \
                                         .values('violation_id', 'violation_type__name'):
            type_map.setdefault(row['violation_id'], []).append(row['violation_type__name'])
        for row in history:
            row['violation_types'] = type_map.get(row['id'], [])

        # An enforcer filing a new OVR legitimately needs this violator's
        # identity (to auto-fill) and their prior-violation COUNT (repeat
        # badge) — but not the per-ticket rows, which describe other
        # enforcers' cases. Staff/Admin keep the full history.
        if request.user.role == 'enforcer':
            history = []

        return Response({
            'found': True,
            'violation_count': violation_count,
            'is_repeat_offender': violation_count > 0,  # now year-scoped, see comment above
            'match': {
                'violator_name':       latest.violator_name,
                'address':             latest.address,
                'license_number':      latest.license_number,
                'license_status':      latest.license_status,
                'plate_number':        latest.plate_number,
                'registration_number': latest.registration_number,
                'vehicle_type':        latest.vehicle_type,
                'vehicle_brand':       latest.vehicle_brand,
                'vehicle_model':       latest.vehicle_model,
            },
            # License fills driver details only. Plate fills vehicle details and
            # the name/address stored on that same record. Neither includes the
            # old ticket's violations or confiscation choice. suggestions is the
            # name-search list and stays empty on these paths.
            'personal': personal,
            'vehicle': vehicle,
            'history': history,
            'suggestions': [],
        })


class ViolatorHistoryFullView(APIView):
    """
    Returns the FULL record for every violation filed against one violator,
    matched by violator_name AND license_number (both case-insensitive) —
    across BOTH the active `violations.Violation` table AND anything already
    moved into `database_management.ArchivedViolation`. A violator's older
    (already-settled/archived) tickets and their newer active ones are
    combined into one list so the repeat-violator UI (ViolationRecords,
    DigitalTickets, ArchiveManagement) can show — and let staff reprint —
    every one of a person's tickets, not just whichever half still lives in
    the active table.

    Unlike ViolatorLookupView (which matches on license_number OR
    plate_number and returns a trimmed autofill/history payload before a NEW
    violation is filed), this view:
      - requires BOTH name and license_number to match, so someone who filed
        under a different vehicle/plate is still grouped correctly, while
        two different people who merely share a name are not conflated
      - returns the same shape of fields as the violation list table for
        both sources, so each entry can be rendered as its own standalone,
        printable card regardless of whether it's active or archived

    Read-only aggregation only — never edits, merges, or copies data. Each
    Violation/ArchivedViolation row stays fully independent; archived rows
    are rendered from their frozen `data` snapshot, never rehydrated back
    into the active table.
    """
    # Full cross-year history of one violator (active + archived) —
    # a records/administration tool, so Admin/Staff only.
    permission_classes = [permissions.IsAuthenticated, IsAdminOrStaff]

    def get(self, request):
        from database_management.models import ArchivedViolation

        violator_name = (request.query_params.get('violator_name') or request.query_params.get('name') or '').strip()
        license_number = (request.query_params.get('license_number') or '').strip()

        if not violator_name or not license_number:
            return Response(
                {'error': 'Provide both violator_name and license_number.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        active_qs = Violation.objects.filter(
            violator_name__iexact=violator_name,
            license_number__iexact=license_number,
        ).select_related('enforcer', 'assessed_by').prefetch_related('items__violation_type').order_by('-date_issued')

        active_records = ViolationListSerializer(active_qs, many=True).data
        for r in active_records:
            r['source'] = 'active'
            r['is_archived'] = False

        archived_qs = ArchivedViolation.objects.filter(
            violator_name__iexact=violator_name,
            license_number__iexact=license_number,
        ).order_by('-date_issued')

        archived_records = []
        for a in archived_qs:
            snap = a.data or {}
            assessment_snap = snap.get('assessment') or {}
            archived_records.append({
                'id': a.original_violation_id,
                'violator_name': a.violator_name,
                'license_number': a.license_number,
                'plate_number': a.plate_number,
                'vehicle_type': snap.get('vehicle_type', ''),
                'location': snap.get('location', ''),
                'latitude': None,
                'longitude': None,
                'date_issued': a.date_issued.isoformat() if a.date_issued else None,
                'penalty_amount': snap.get('penalty_amount'),
                # snap['status'] is a human-readable display value (e.g. "Paid") —
                # this always matches the model's Status.choices labels, so
                # lowercasing it recovers the raw status key for the badge.
                'status': (snap.get('status') or '').lower(),
                'enforcer_name': snap.get('enforcer_name', ''),
                # Archive confidentiality (#12): 'Assessed By' (who assessed
                # the violation) is intentionally NOT re-exposed for archived
                # rows here, even though it's still in the frozen snapshot.
                # Active rows above are untouched — they still carry
                # assessed_by_name via ViolationListSerializer.
                # #005: payment info from the archived Assessment snapshot —
                # previously missing here entirely, so a settled/archived
                # ticket looked unpaid with no O.R. number to point to.
                'or_number': assessment_snap.get('or_number', ''),
                'date_paid': assessment_snap.get('date_paid'),
                'item_count': len(snap.get('items') or []),
                'violation_types': [
                    {'id': None, 'name': i.get('name'), 'code': i.get('code')}
                    for i in (snap.get('items') or [])
                ],
                'created_at': snap.get('created_at'),
                'source': 'archived',
                'is_archived': True,
                'archived_at': a.archived_at.isoformat() if a.archived_at else None,
                # Checkpoint 2: Asia/Manila year of date_issued (stored column is UTC-era)
                'violation_year': manila_year(a.date_issued) if a.date_issued else a.violation_year,
                'settlement_status': a.settlement_status,
            })

        records = sorted(
            active_records + archived_records,
            key=lambda r: r['date_issued'] or '',
            reverse=True,
        )

        return Response({
            'violator_name': violator_name,
            'license_number': license_number,
            'violation_count': len(records),
            'is_repeat_violator': len(records) > 1,
            'active_count': len(active_records),
            'archived_count': len(archived_records),
            'records': records,
        })


class RelatedActiveViolationsView(APIView):
    """
    GET /api/violations/<pk>/related/

    Powers the Admin Violation Records "View" panel's "Other Violations"
    section (MASTER PROMPT Part 21-25): every OTHER active-table violation
    belonging to the same violator, excluding the record being viewed.

    Matched by license_number (case-insensitive), falling back to
    violator_name when the source record has no license number on file —
    the same identifier logic used for the repeat_status count.

    Deliberately ACTIVE-ONLY — unlike ViolatorHistoryFullView (which
    intentionally combines active + archived for full-history browsing),
    this endpoint must never mix in archived years, since it exists purely
    to answer "who else got a ticket this active year". Archive stays a
    separate historical source, reached through Archive Management instead.

    Read-only aggregation — never edits, merges, or creates anything.
    """
    # Lists OTHER violators' records tied to the same person —
    # Admin/Staff records tooling, never enforcer-visible.
    permission_classes = [permissions.IsAuthenticated, IsAdminOrStaff]

    def get(self, request, pk):
        try:
            violation = Violation.objects.get(pk=pk)
        except Violation.DoesNotExist:
            return Response({'error': 'Violation not found.'}, status=404)

        if violation.license_number and violation.license_number.strip():
            match_q = Q(license_number__iexact=violation.license_number.strip())
        elif violation.violator_name and violation.violator_name.strip():
            match_q = Q(violator_name__iexact=violation.violator_name.strip())
        else:
            return Response({'violation_id': violation.id, 'repeat_status': None, 'related': []})

        related_qs = Violation.objects.filter(match_q).exclude(pk=violation.pk) \
            .select_related('enforcer', 'assessed_by') \
            .prefetch_related('items__violation_type') \
            .order_by('-date_issued')

        by_license, by_name = build_repeat_count_maps()
        context = {'repeat_counts_by_license': by_license, 'repeat_counts_by_name': by_name}

        return Response({
            'violation_id': violation.id,
            'repeat_status': ViolationListSerializer(violation, context=context).data.get('repeat_status'),
            'related': ViolationListSerializer(related_qs, many=True, context=context).data,
        })


# ─── Violations (Staff/Admin — list & detail) ────────────────────────────────

class StandardResultsPagination(PageNumberPagination):
    """Real server-side pagination — 10 per page by default, matching what
    ViolationRecords.jsx and MyReports.jsx already send via ?page= and
    ?page_size=. Capped at 1000: GISViolationMap.jsx requests
    ?page_size=1000 to plot every violation for hotspot analysis, and the
    previous cap of 100 was silently clamping that request, truncating the
    map to only the 100 most recent violations."""
    page_size = 10
    page_size_query_param = 'page_size'
    max_page_size = 1000


class ViolationListView(generics.ListAPIView):
    """
    NOTE on `group_by_violator=1` (MASTER PROMPT: Repeated Violator /
    Violation History):

    This endpoint is shared by several consumers besides the Admin
    Violation Records table — GISViolationMap.jsx (needs every point
    plotted), and MyReports.jsx/EnforcerHome.jsx (an enforcer needs every
    ticket they personally filed, not just one per violator). So the
    "one row per violator, latest violation only" behavior is opt-in via
    `?group_by_violator=1`, sent only by ViolationRecords.jsx (Admin).
    Every other caller gets exactly the rows it always has.

    Nothing is stored, merged, or deleted — see `_latest_per_violator()`.
    """
    serializer_class = ViolationListSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class   = StandardResultsPagination

    def get_serializer_context(self):
        context = super().get_serializer_context()
        by_license, by_name = build_repeat_count_maps()
        context['repeat_counts_by_license'] = by_license
        context['repeat_counts_by_name']    = by_name
        return context

    @staticmethod
    def _violator_key(v):
        """Same violator-identity rule as build_repeat_count_maps() /
        RelatedActiveViolationsView: license_number (case-insensitive,
        trimmed) when present, else violator_name (case-insensitive,
        trimmed). Records with neither are never collapsed together —
        each stands alone under its own id."""
        lic = (v.license_number or '').strip().lower()
        if lic:
            return ('lic', lic)
        name = (v.violator_name or '').strip().lower()
        if name:
            return ('name', name)
        return ('id', v.id)

    def _latest_per_violator(self, queryset):
        """
        Collapse an already-filtered/ordered queryset down to one row per
        violator — their single most recent violation among the rows that
        matched the current filters, by date_issued (tie-broken by id, the
        same authoritative "latest" fields used elsewhere in this file).

        Nothing is deleted or merged: every other Violation row is left
        completely untouched in the database. Older rows for the same
        violator simply aren't the row shown in this response — they
        remain reachable via GET /api/violations/<id>/related/.

        Implementation note: this evaluates the queryset once (a single
        query — same cost class as build_repeat_count_maps(), which
        already scans the full active table on every request to this
        view) and keeps only the winning rows, in their existing relative
        order. That means whatever ordering/search/type/status/date
        filtering was already applied by get_queryset()/filter_queryset()
        is preserved automatically — there's no separate sort/filter
        logic to keep in sync.
        """
        rows = list(queryset)
        latest_for_key = {}
        for v in rows:
            key = self._violator_key(v)
            current = latest_for_key.get(key)
            if current is None or (v.date_issued, v.id) > (current.date_issued, current.id):
                latest_for_key[key] = v
        winning_ids = {v.id for v in latest_for_key.values()}
        return [v for v in rows if v.id in winning_ids]

    def list(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())

        if request.query_params.get('group_by_violator') in ('1', 'true', 'True'):
            queryset = self._latest_per_violator(queryset)

        page = self.paginate_queryset(queryset)
        if page is not None:
            serializer = self.get_serializer(page, many=True)
            return self.get_paginated_response(serializer.data)

        serializer = self.get_serializer(queryset, many=True)
        return Response(serializer.data)

    def get_queryset(self):
        qs = Violation.objects.select_related(
            'enforcer', 'assessed_by', 'assessment'
        ).prefetch_related('items__violation_type', 'evidence').order_by('-created_at')

        status_filter = self.request.query_params.get('status')
        search = self.request.query_params.get('search')
        violation_type = self.request.query_params.get('violation_type')
        date = self.request.query_params.get('date')
        date_from = self.request.query_params.get('date_from')
        date_to = self.request.query_params.get('date_to')
        is_printed = self.request.query_params.get('is_printed')
        role = self.request.user.role

        if role == 'enforcer':
            qs = qs.filter(enforcer=self.request.user)

        # ViolationRecords.jsx explicitly sends a comma-separated default
        # scope (pending,processing,paid) when no single status is chosen,
        # so its "count" stays accurate under real pagination. Every other
        # caller keeps sending one plain value (e.g. DigitalTickets.jsx's
        # status=paid), which still works exactly as before.
        if status_filter:
            statuses = [s for s in status_filter.split(',') if s]
            qs = qs.filter(status__in=statuses) if len(statuses) > 1 else qs.filter(status=statuses[0])

        if search:
            qs = qs.filter(
                Q(violator_name__icontains=search) |
                Q(plate_number__icontains=search) |
                Q(license_number__icontains=search) |
                Q(items__violation_type__name__icontains=search)
            )

        # ViolationRecords.jsx sends the violation type's display name
        # (falling back to its id only if the name is missing), so match on
        # either — this mirrors what the "Type" filter dropdown actually sends.
        if violation_type:
            type_filter = Q(items__violation_type__name=violation_type)
            if violation_type.isdigit():
                type_filter |= Q(items__violation_type_id=violation_type)
            qs = qs.filter(type_filter)

        # Single-day filter (Admin's <input type="date"> "Date" field).
        if date:
            qs = qs.filter(date_issued__date=date)

        # Range filter (Enforcer's "My Reports" date_from/date_to).
        if date_from:
            qs = qs.filter(date_issued__date__gte=date_from)
        if date_to:
            qs = qs.filter(date_issued__date__lte=date_to)

        # DigitalTickets.jsx's stats bar needs an accurate printed count
        # without downloading every "paid" row — used together with
        # page_size=1 (count-only requests).
        if is_printed in ('1', 'true', 'True'):
            qs = qs.filter(is_printed=True)
        elif is_printed in ('0', 'false', 'False'):
            qs = qs.filter(is_printed=False)

        return qs.distinct()


# ─── Public (unauthenticated) ────────────────────────────────────────────────

class PublicViolationListView(generics.ListAPIView):
    """
    Read-only, unauthenticated feed for the public Violation Updates section.

    Eligibility is unchanged: status 'paid' only. Each ViolationItem on a
    paid ticket is its own row, so a ticket with several violations is not
    returned as one merged entry. Filtering by violation_type matches that
    item, not the whole ticket.

    Only public-safe fields are returned — see PublicViolationSerializer.

    Date filters (date, date_from, date_to) are intentionally NOT supported:
    the response does not expose when a ticket was issued, and a date filter
    would let an anonymous caller recover that by bisecting ranges.
    """
    serializer_class = PublicViolationSerializer
    permission_classes = [permissions.AllowAny]
    pagination_class = StandardResultsPagination

    def get_queryset(self):
        # '-pk' is only a tie-breaker so pagination order is stable; it is never returned.
        qs = (
            ViolationItem.objects.filter(violation__status='paid')
            .select_related('violation_type', 'violation')
            .order_by('-violation__date_issued', '-pk')
        )

        violation_type = self.request.query_params.get('violation_type')
        if violation_type:
            type_filter = Q(violation_type__name=violation_type)
            if violation_type.isdigit():
                type_filter |= Q(violation_type_id=violation_type)
            qs = qs.filter(type_filter)

        return qs


class PublicViolationTypeHighlightsView(APIView):
    """
    Public, read-only list of the (up to) 5 most frequently issued ACTIVE
    violation types, for the landing-page carousel.

    Returns type-level information only: code, name, category, description and
    the current standard fine. It never returns dates, counts, violators,
    plates, locations or enforcers. Ranking uses paid tickets only (same
    eligibility as the public stats); ties and zero-count types fall back to
    code order, so the list is never empty while active types exist.
    """
    permission_classes = [permissions.AllowAny]
    HIGHLIGHT_LIMIT = 5

    def get(self, request):
        rows = (
            ViolationType.objects.filter(is_active=True)
            .annotate(_n=Count('violation_items', filter=Q(violation_items__violation__status='paid')))
            .order_by('-_n', 'code')[:self.HIGHLIGHT_LIMIT]
        )
        return Response([
            {
                'code': t.code,
                'name': t.name,
                'category': t.category,
                'description': t.description,
                'penalty_amount': float(t.penalty_amount),
            }
            for t in rows
        ])


class PublicViolationStatsView(APIView):
    """
    Aggregate-only statistics for the public landing page.

    Everything here is a count or a sum grouped by violation TYPE or by
    MONTH/YEAR — never by violator, vehicle, plate, or enforcer. Uses the
    same 'paid' eligibility as PublicViolationListView, and the same
    per-item penalty_amount_snapshot fine source (never the
    case-adjusted Violation.penalty_amount).
    """
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        from decimal import Decimal
        from django.db.models import Sum
        from django.db.models.functions import TruncMonth

        today = timezone.localdate()
        year_start = today.replace(month=1, day=1)
        month_start = today.replace(day=1)

        # ACTIVE paid tickets + ARCHIVED settled tickets (archiving only moves
        # a paid ticket, it is not a business event). Duplicate snapshots of an
        # already-counted violation are removed (deduped_archived), so the same
        # original violation is never counted twice before/after archiving.
        # From the archive ONLY counts, violation-type names, per-item fines
        # and dates are read — never name, license, plate, address, enforcer.
        base_qs = Violation.objects.filter(status='paid')
        items_qs = ViolationItem.objects.filter(violation__in=base_qs)
        arch_qs = deduped_archived(ArchivedViolation.objects.filter(settlement_status='settled'))

        def arch_items(qs):
            """{type name: [item count, fines Decimal]} from the JSON items."""
            out = {}
            for items in qs.values_list('data__items', flat=True).iterator(chunk_size=2000):
                for it in (items or []):
                    e = out.setdefault(it.get('name') or None, [0, Decimal('0')])
                    e[0] += 1
                    e[1] += Decimal(str(it.get('penalty_amount') or 0))
            return out

        def arch_fines(qs):
            return sum((v[1] for v in arch_items(qs).values()), Decimal('0'))

        total_all_time = base_qs.count() + arch_qs.count()
        total_this_year = (base_qs.filter(date_issued__date__gte=year_start).count()
                           + arch_qs.filter(date_issued__date__gte=year_start).count())
        total_this_month = (base_qs.filter(date_issued__date__gte=month_start).count()
                            + arch_qs.filter(date_issued__date__gte=month_start).count())

        by_type_map = {}
        for row in (items_qs.values('violation_type__name')
                    .annotate(count=Count('id'), total_fines=Sum('penalty_amount_snapshot'))):
            e = by_type_map.setdefault(row['violation_type__name'], [0, Decimal('0')])
            e[0] += row['count']
            e[1] += row['total_fines'] or Decimal('0')
        for name, (cnt, fines) in arch_items(arch_qs).items():
            e = by_type_map.setdefault(name, [0, Decimal('0')])
            e[0] += cnt
            e[1] += fines
        by_type = [
            {'violation_type': name, 'count': cnt, 'total_fines': float(fines)}
            for name, (cnt, fines) in sorted(
                by_type_map.items(), key=lambda kv: (-kv[1][0], kv[0] or ''))
        ]
        most_common = by_type[0]['violation_type'] if by_type else None

        month_map = {}
        for qs in (base_qs, arch_qs):
            for row in (qs.annotate(month=TruncMonth('date_issued'))
                        .values('month')
                        .annotate(count=Count('id', distinct=True))):
                if row['month']:
                    k = row['month'].strftime('%Y-%m')
                    e = month_map.setdefault(k, {'label': row['month'].strftime('%b %Y'), 'count': 0})
                    e['count'] += row['count']
        by_month = [
            {'month': k, 'label': v['label'], 'count': v['count']}
            for k, v in sorted(month_map.items())
        ]

        total_fines_recorded = float(
            (items_qs.aggregate(t=Sum('penalty_amount_snapshot'))['t'] or Decimal('0'))
            + arch_fines(arch_qs)
        )

        # Year-over-year comparison for the landing page's "vs. last year"
        # trend chips. Same 'paid' eligibility and the same per-item
        # penalty_amount_snapshot source as everything above.
        # Like-for-like: this year is year-to-date, so compare it against the
        # same Jan 1 -> today window of last year (not the full prior year).
        last_year_start = year_start.replace(year=year_start.year - 1)
        try:
            last_year_end = today.replace(year=today.year - 1)
        except ValueError:  # today is Feb 29
            last_year_end = today.replace(year=today.year - 1, day=28)
        ly = dict(date_issued__date__gte=last_year_start, date_issued__date__lte=last_year_end)
        total_last_year = base_qs.filter(**ly).count() + arch_qs.filter(**ly).count()
        fines_this_year = float(
            (items_qs.filter(violation__date_issued__date__gte=year_start)
             .aggregate(t=Sum('penalty_amount_snapshot'))['t'] or Decimal('0'))
            + arch_fines(arch_qs.filter(date_issued__date__gte=year_start))
        )
        fines_last_year = float(
            (items_qs.filter(
                violation__date_issued__date__gte=last_year_start,
                violation__date_issued__date__lte=last_year_end,
            ).aggregate(t=Sum('penalty_amount_snapshot'))['t'] or Decimal('0'))
            + arch_fines(arch_qs.filter(**ly))
        )

        # Share (%) of the most common violation type among all recorded
        # violation items — feeds the "32% of total" caption.
        total_items = sum(row['count'] for row in by_type)
        most_common_share = (
            round(by_type[0]['count'] / total_items * 100) if by_type and total_items else 0
        )

        return Response({
            'total_all_time': total_all_time,
            'total_this_year': total_this_year,
            'total_last_year': total_last_year,
            'total_this_month': total_this_month,
            'most_common_violation': most_common,
            'most_common_share': most_common_share,
            'total_fines_recorded': total_fines_recorded,
            'total_fines_this_year': fines_this_year,
            'total_fines_last_year': fines_last_year,
            'current_year': today.year,
            'by_type': by_type,
            'by_month': by_month,
        })


class ViolationDetailView(generics.RetrieveUpdateDestroyAPIView):
    """
    Retrieve/update/delete a single Violation.

    AUTHORIZATION (enforced here in the backend, never only in the UI):
      - Admin/Staff : any record — they run assessment and payment.
      - Enforcer    : ONLY records they filed themselves. The queryset is
        scoped (rather than checked after fetching), so an enforcer who
        guesses another enforcer's id gets a 404 instead of that record's
        violator name, license number and address.
      - Enforcer writes may never touch `status`: the pending -> processing
        -> paid lifecycle belongs to Staff/Admin, so an enforcer cannot
        mark anything processing or paid.
    """
    serializer_class = ViolationDetailSerializer
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_queryset(self):
        qs = Violation.objects.prefetch_related('items__violation_type').select_related(
            'enforcer', 'assessed_by', 'locked_by'
        )
        if self.request.user.role == 'enforcer':
            qs = qs.filter(enforcer=self.request.user)
        return qs

    def update(self, request, *args, **kwargs):
        from rest_framework.exceptions import PermissionDenied, ValidationError
        if request.user.role == 'enforcer' and 'status' in request.data:
            raise PermissionDenied(
                'Only Assessment Staff may change the status of an OVR.'
            )
        instance = self.get_object()
        if instance.status == Violation.Status.PAID:
            # A paid record is the authoritative basis of a recorded payment
            # (amount, printed Assessment Form). Enforcers can never touch
            # it, and nobody can re-price it by swapping violation types.
            if request.user.role == 'enforcer':
                raise PermissionDenied('This violation is already paid and can no longer be edited.')
            if 'violation_type_ids' in request.data or 'violation_type_ids[]' in request.data:
                raise ValidationError({
                    'violation_type_ids': 'The violations of a paid record cannot be changed.'
                })
        return super().update(request, *args, **kwargs)

    def perform_update(self, serializer):
        before = snapshot(
            serializer.instance,
            ('status', 'violator_name', 'plate_number', 'location', 'penalty_amount', 'remarks'),
        )
        violation = serializer.save()
        after = snapshot(
            violation,
            ('status', 'violator_name', 'plate_number', 'location', 'penalty_amount', 'remarks'),
        )

        new_status = serializer.validated_data.get('status')
        if new_status == 'processing':
            Violation.objects.filter(pk=violation.pk).update(locked_by=self.request.user)
            violation.locked_by = self.request.user
            broadcast_lock_event(
                violation_id=violation.pk,
                status='processing',
                locked_by_id=self.request.user.pk,
                locked_by_name=self.request.user.full_name,
            )
        elif new_status == 'paid':
            Violation.objects.filter(pk=violation.pk).update(locked_by=None)
            violation.locked_by = None
            broadcast_lock_event(
                violation_id=violation.pk,
                status=new_status,
                locked_by_id=None,
                locked_by_name=None,
            )

        log_action(
            user        = self.request.user,
            action      = 'UPDATE',
            module      = 'Violations',
            description = (
                f'{self.request.user.full_name} updated violation record '
                f'#{violation.id} — {violation.violator_name}'
            ),
            request     = self.request,
            target_type = 'Violation',
            target_id   = violation.id,
            changes     = build_changes(before, after),
            details     = {
                'violation_id':  violation.id,
                'violator_name': violation.violator_name,
                'plate_number':  violation.plate_number or None,
                'location':      violation.location or None,
                'status':        violation.status,
                'penalty_amount': str(violation.penalty_amount) if violation.penalty_amount else None,
                'updated_by':    self.request.user.full_name,
                'role':          self.request.user.role,
            },
        )

    def perform_destroy(self, instance):
        if instance.status == 'paid':
            from rest_framework.exceptions import ValidationError
            raise ValidationError(
                f'Cannot delete a {instance.status} violation. '
                'Only pending violations may be removed.'
            )
        from django.db.models import ProtectedError
        from .custody_models import CustodyProtectedAPIError
        # Checkpoint 3: a violation that has a license-custody record can never be
        # deleted. Controlled 409 (stable code), never a server error. The audit
        # row and the delete share one transaction so a refusal leaves no trace.
        try:
            with transaction.atomic():
                log_action(
                    user        = self.request.user,
                    action      = 'DELETE',
                    module      = 'Violations',
                    description = (
                        f'{self.request.user.full_name} deleted violation record '
                        f'#{instance.id} — {instance.violator_name}, Plate: {instance.plate_number or "N/A"}'
                    ),
                    request     = self.request,
                    target_type = 'Violation',
                    target_id   = instance.id,
                    details     = {
                        'violation_id':  instance.id,
                        'violator_name': instance.violator_name,
                        'plate_number':  instance.plate_number or None,
                        'location':      instance.location or None,
                        'status':        instance.status,
                        'penalty_amount': str(instance.penalty_amount) if instance.penalty_amount else None,
                        'deleted_by':    self.request.user.full_name,
                        'role':          self.request.user.role,
                    },
                )
                instance.delete()
        except ProtectedError:
            raise CustodyProtectedAPIError()


# ─── Assessment (Staff) ───────────────────────────────────────────────────────

class AssessmentView(generics.UpdateAPIView):
    """PATCH /api/violations/<id>/assess/ — staff approves or saves draft"""
    serializer_class = AssessmentSerializer
    permission_classes = [IsAdminOrStaff]

    def get_queryset(self):
        return Violation.objects.filter(status__in=['pending', 'processing'])

    def patch(self, request, *args, **kwargs):
        violation = self.get_object()
        before = snapshot(violation, ('status', 'penalty_amount', 'remarks'))
        serializer = self.get_serializer(violation, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        violation.refresh_from_db()  # ← i-add ito
        after = snapshot(violation, ('status', 'penalty_amount', 'remarks'))
        broadcast_lock_event(
            violation_id=violation.pk,
            status=violation.status,
            locked_by_id=None,
            locked_by_name=None,
        )
        # Notify admin
        try:
            from notifications.models import Notification
            Notification.objects.create(
                recipient_role='admin',
                notif_type='new_violation',
                title='Violation Assessed',
                message=(
                    f'{actor_label(request.user)} assessed violation #{violation.id} '
                    f'({violation.violator_name}) — Status: {violation.status.upper()}'
                ),
                related_user=request.user,
                related_violation_id=violation.id,
            )
        except Exception:
            pass

        log_action(
            user        = request.user,
            action      = 'UPDATE',
            module      = 'Assessment',
            description = (
                f'{request.user.full_name} assessed violation #{violation.id} '
                f'({violation.violator_name}) — Status set to: {violation.status.upper()}'
            ),
            request     = request,
            target_type = 'Violation',
            target_id   = violation.id,
            changes     = build_changes(before, after),
            details     = {
                'violation_id':   violation.id,
                'violator_name':  violation.violator_name,
                'plate_number':   violation.plate_number or None,
                'location':       violation.location or None,
                'status_set_to':  violation.status,
                'penalty_amount': str(violation.penalty_amount) if violation.penalty_amount else None,
                'remarks':        violation.remarks or None,
                'assessed_by':    request.user.full_name,
                'role':           request.user.role,
            },
        )
        return Response(ViolationDetailSerializer(
            violation, context={'request': request}
        ).data)


# ─── Generate Ticket payload (Staff) — READ ONLY ─────────────────────────────

def authoritative_penalty(violation):
    """
    The authoritative assessed penalty, derived on the server only.

    - Normal records: the sum of the ViolationItem penalty SNAPSHOTS taken
      when each item was created (never today's ViolationType price).
    - Imported historical records (and any record without items): their
      ticket-level `penalty_amount` is the only authoritative figure.
    """
    from decimal import Decimal
    if violation.source != Violation.Source.IMPORTED:
        items = list(violation.items.all())
        if items:
            return sum((i.penalty_amount_snapshot for i in items), Decimal('0'))
    return violation.penalty_amount or Decimal('0')


class GenerateTicketView(APIView):
    """POST /violations/<pk>/generate-ticket/ — returns the printable payload
    of an EXISTING record. It creates/changes nothing and writes no audit
    row; print and reprint are audited by MarkTicketPrintedView."""
    permission_classes = [IsAdminOrStaff]

    def post(self, request, pk):
        try:
            violation = Violation.objects.prefetch_related('items__violation_type').get(pk=pk)
        except Violation.DoesNotExist:
            return Response({'error': 'Violation not found.'}, status=404)

        if violation.status not in ('processing', 'paid'):
            return Response(
                {'error': 'Only processing or paid violations can generate a ticket.'},
                status=400
            )

        data = ViolationDetailSerializer(violation, context={'request': request}).data
        data['ticket_number'] = f'TKT-{violation.id:06d}'
        data['generated_at']  = timezone.now().isoformat()
        data['payment_status'] = 'Paid' if violation.status == 'paid' else 'Unpaid'
        return Response(data)


# ─── Confirm Payment (Staff) ──────────────────────────────────────────────────

class ConfirmPaymentView(APIView):
    """
    POST /violations/<pk>/confirm-payment/ — the ONLY operation that can move
    a violation processing -> paid.

    Body: { "or_number": "<optional>" } — nothing else is read. Amount Paid,
    Date Paid, Assessed By and the penalty are all derived on the server;
    Received By is never set here (Treasury fills it by hand on the printed
    form). Everything happens in ONE transaction, so a failure anywhere
    leaves the violation exactly as it was (still processing, no partial
    Assessment/payment data). Printing is a separate action.
    """
    permission_classes = [IsAdminOrStaff]

    def post(self, request, pk):
        or_number = request.data.get('or_number', '')
        if or_number is None:
            or_number = ''
        if not isinstance(or_number, str):
            return Response({'or_number': 'O.R. Number must be text.'}, status=400)
        or_number = or_number.strip()
        if len(or_number) > 50:
            return Response({'or_number': 'O.R. Number may not exceed 50 characters.'}, status=400)

        with transaction.atomic():
            try:
                violation = (
                    Violation.objects.select_for_update()
                    .prefetch_related('items__violation_type').get(pk=pk)
                )
            except Violation.DoesNotExist:
                return Response({'error': 'Violation not found.'}, status=404)

            if violation.status == Violation.Status.PAID:
                return Response(
                    {'error': 'This violation is already paid. Payment was not processed again.'},
                    status=409,
                )
            if violation.status != Violation.Status.PROCESSING:
                return Response(
                    {'error': f'Payment can only be confirmed while the violation is being processed. Current status: {violation.status}.'},
                    status=400,
                )

            amount = authoritative_penalty(violation)
            if amount <= 0:
                return Response(
                    {'error': 'This violation has no assessed penalty to collect.'},
                    status=400,
                )

            paid_on = timezone.localdate()       # server date, Asia/Manila
            now = timezone.now()

            assessment, _ = Assessment.objects.get_or_create(violation=violation)
            assessment.penalty      = amount
            assessment.amount_paid  = amount
            assessment.date_paid    = paid_on
            assessment.or_number    = or_number      # optional; blank stays blank
            assessment.received_by  = ''             # Treasury signs by hand
            # PAYMENT CONFIRMER — a different actor from the assessor. This
            # view NEVER writes assessed_by / assessed_at / assessor_* on
            # Assessment or Violation: the assessor was established by
            # PATCH /assess/ and must survive payment.
            record_payment_confirmer(assessment, request.user, when=now)
            if assessment.assessed_by_id is None and violation.assessed_by_id:
                # Record assessed before Phase 2 and still in flight: the
                # Violation mirror holds the real assessor (it had not been
                # overwritten yet). Carry the FK across; no identity snapshot
                # is invented (assessor_snapshot_source stays 'unknown').
                assessment.assessed_by = violation.assessed_by
                assessment.assessed_at = violation.assessed_at
            assessment.save()

            violation.penalty_amount = amount
            violation.status         = Violation.Status.PAID
            violation.locked_by      = None
            violation.save()

            log_action(
                user        = request.user,
                action      = 'UPDATE',
                module      = 'Payment',
                description = (
                    f'PAYMENT CONFIRMED — {request.user.full_name} confirmed payment of '
                    f'violation #{violation.id} ({violation.violator_name})'
                ),
                request     = request,
                target_type = 'Violation',
                target_id   = violation.id,
                changes     = {'status': {'before': 'processing', 'after': 'paid'}},
                details     = {
                    'event':        'PAYMENT_CONFIRMED',
                    'violation_id': violation.id,
                    'amount_paid':  str(amount),
                    'date_paid':    paid_on.isoformat(),
                    'or_number':    or_number or None,
                    # Legacy-compatible keys: 'assessed_by' has always carried
                    # the confirming user's name here; kept so older audit
                    # rows and readers stay consistent. The explicit key below
                    # is the unambiguous one.
                    'assessed_by':  request.user.full_name,
                    'payment_confirmed_by': request.user.full_name,
                    'role':         request.user.role,
                },
            )

            transaction.on_commit(lambda: broadcast_lock_event(
                violation_id=violation.pk, status='paid',
                locked_by_id=None, locked_by_name=None,
            ))

        # ONE 'Violation Paid' event per successful confirmation (this view is
        # the only place a violation can become paid; the post_save signal no
        # longer creates one). The amount is the persisted amount_paid and the
        # actor is the authenticated user who confirmed the payment.
        try:
            from notifications.models import Notification
            paid_msg = (
                f'Violation #{violation.id} for {violation.violator_name} has been '
                f'marked as paid. Amount: \u20b1{amount}. '
                f'Confirmed by {actor_label(request.user)}.'
            )
            for recipient in ('staff', 'admin'):
                Notification.objects.create(
                    recipient_role=recipient,
                    notif_type='violation_paid',
                    title='Violation Paid',
                    message=paid_msg,
                    related_user=request.user,
                    related_violation_id=violation.id,
                )
        except Exception:
            pass

        violation = Violation.objects.prefetch_related('items__violation_type').get(pk=violation.pk)
        data = ViolationDetailSerializer(violation, context={'request': request}).data
        data['ticket_number']  = f'TKT-{violation.id:06d}'
        data['generated_at']   = timezone.now().isoformat()
        data['payment_status'] = 'Paid'
        return Response(data)


# ─── Stats ───────────────────────────────────────────────────────────────────

# ─── Staff Assessment record (separate from Enforcer's Violation/OVR) ───────

class AssessmentDetailView(APIView):
    """
    GET  /violations/<pk>/assessment/  — fetch (or lazily create) the Staff
         Assessment record tied to this Violation/OVR. Enforcer fields are
         NOT duplicated here — the frontend reads those from the parent
         Violation and only uses this endpoint for Staff-only fields
         (penalty, O.R. Number, amount paid, received by, date paid).
    PATCH /violations/<pk>/assessment/ — Staff may only update `notes`.
         Every payment field (O.R. No., amount, date, received by, assessor)
         is written exclusively by ConfirmPaymentView and is rejected here.
    """
    permission_classes = [IsAdminOrStaff]

    def get_object(self, pk):
        violation = Violation.objects.get(pk=pk)
        assessment, _ = Assessment.objects.get_or_create(violation=violation)
        return assessment

    def get(self, request, pk):
        try:
            assessment = self.get_object(pk)
        except Violation.DoesNotExist:
            return Response({'error': 'Violation not found.'}, status=404)
        return Response(AssessmentRecordSerializer(assessment).data)

    PAYMENT_FIELDS = ('or_number', 'penalty', 'amount_paid', 'received_by',
                      'date_paid', 'assessed_by', 'assessed_at',
                      'payment_confirmed_by', 'payment_confirmed_at')

    def patch(self, request, pk):
        try:
            assessment = self.get_object(pk)
        except Violation.DoesNotExist:
            return Response({'error': 'Violation not found.'}, status=404)
        blocked = [f for f in self.PAYMENT_FIELDS if f in request.data]
        if blocked:
            return Response(
                {'error': 'Payment fields can only be recorded through Confirm Payment.',
                 'fields': blocked},
                status=400,
            )
        serializer = AssessmentRecordSerializer(
            assessment, data=request.data, partial=True, context={'request': request}
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)


# ─── Evidence (camera capture — separate feature, linked to an OVR) ────────

class EvidenceListCreateView(generics.ListCreateAPIView):
    """
    Flat evidence endpoint (evidence is captured standalone — NOT nested
    under a Violation/OVR — and may be associated to one later):

    GET  /violations/evidence/              — role-aware list.
         Enforcer  → only their own captured evidence.
         Admin/Staff → all evidence; optional ?violation=<id> filter for
         Staff's "View Evidence" action on a specific OVR, and
         ?unassociated=1 to list photos still awaiting an OVR link.
    POST /violations/evidence/              — Camera Capture feature saves a
         photo here, standalone (no violation required yet). captured_by is
         always the authenticated user (never a client-supplied field), so
         identity can't be spoofed.
    """
    serializer_class = ViolationEvidenceSerializer
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]
    pagination_class = None

    def get_queryset(self):
        user = self.request.user
        # Archived evidence (archived_violation set) is a read-only part of an
        # archive record, reachable only through the archive endpoints. It must
        # never appear here, in particular never as an "unassociated" capture.
        qs = ViolationEvidence.objects.select_related('captured_by', 'violation').filter(
            archived_violation__isnull=True
        )

        if user.role in ('admin', 'staff'):
            violation_id = self.request.query_params.get('violation')
            if violation_id:
                qs = qs.filter(violation_id=violation_id)
        else:
            qs = qs.filter(captured_by=user)

        if self.request.query_params.get('unassociated') == '1':
            qs = qs.filter(violation__isnull=True)

        return qs

    def get_permissions(self):
        if self.request.method == 'POST':
            return [permissions.IsAuthenticated(), IsEnforcer()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        violation = serializer.validated_data.get('violation')
        evidence = serializer.save(captured_by=self.request.user)
        log_action(
            user=self.request.user,
            action='CREATE',
            module='Evidence',
            description=(
                f'{self.request.user.full_name} captured evidence'
                + (f' for Violation/OVR #{violation.id} ({violation.ovr_number or "N/A"}).'
                   if violation else ' (standalone, not yet associated with an OVR).')
            ),
            request=self.request,
            target_type='ViolationEvidence',
            target_id=evidence.id,
            details={
                'violation_id': violation.id if violation else None,
                'ovr_number': violation.ovr_number or None if violation else None,
                'captured_at': evidence.captured_at.isoformat() if evidence.captured_at else None,
                'latitude': evidence.latitude,
                'longitude': evidence.longitude,
                'gps_accuracy': evidence.gps_accuracy,
            },
        )


class EvidenceAssociateView(generics.UpdateAPIView):
    """
    PATCH /violations/evidence/<pk>/  — "Associate with OVR" action.
    Only the `violation` field is writable. Restricted to the Enforcer who
    captured the photo, or Admin/Staff.
    """
    queryset = ViolationEvidence.objects.all()
    serializer_class = EvidenceAssociateSerializer
    permission_classes = [permissions.IsAuthenticated, IsEvidenceOwnerOrStaff]
    http_method_names = ['patch']

    def update(self, request, *args, **kwargs):
        # get_object() runs the object-level permission first, so a
        # non-owner Enforcer gets 403 BEFORE anything about the archive state
        # of this evidence can be learned from the response.
        instance = self.get_object()
        if instance.archived_violation_id is not None:
            return Response(
                {'detail': 'This evidence belongs to an archived record and is read-only.'},
                status=status.HTTP_409_CONFLICT,
            )
        return super().update(request, *args, **kwargs)

    def perform_update(self, serializer):
        from django.db import IntegrityError
        try:
            # Savepoint: if the ticket was archived between the check above and
            # this save, evidence_active_xor_archived_link refuses the write.
            with transaction.atomic():
                evidence = serializer.save()
        except IntegrityError:
            raise EvidenceArchivedConflict()
        log_action(
            user=self.request.user,
            action='UPDATE',
            module='Evidence',
            description=(
                f'{self.request.user.full_name} associated evidence #{evidence.id} '
                f'with Violation/OVR #{evidence.violation_id} '
                f'({evidence.violation.ovr_number or "N/A"}).'
            ),
            request=self.request,
            target_type='ViolationEvidence',
            target_id=evidence.id,
            details={'violation_id': evidence.violation_id},
        )


class StatsRangeError(Exception):
    """Bad `range` / `date_from` / `date_to` on GET /api/violations/stats/."""

    def __init__(self, detail):
        self.detail = detail


# Inclusive day count at which the dashboard trend switches from one point
# per day to one point per month. 92 covers a full quarter; "This year" and
# `range=all` are longer, so they bucket by month.
_TREND_DAY_LIMIT = 92
_MANILA = ZoneInfo('Asia/Manila')
_MONTH_ABBR = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
               'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')


def parse_stats_range(params):
    """None when the caller sent no window — the response stays exactly as before.

    ``range=all`` is the all-time preset (monthly trend, archived included).
    A date window is ``date_from`` and ``date_to`` together, YYYY-MM-DD,
    interpreted as Asia/Manila calendar dates. ``date_to`` is inclusive.
    """
    raw_range = (params.get('range') or '').strip().lower()
    raw_from = (params.get('date_from') or '').strip()
    raw_to = (params.get('date_to') or '').strip()
    if not raw_range and not raw_from and not raw_to:
        return None
    if raw_range and raw_range != 'all':
        raise StatsRangeError('range must be "all".')
    if raw_range == 'all' and (raw_from or raw_to):
        raise StatsRangeError('Pass range=all on its own, or date_from and date_to, not both.')
    if raw_range == 'all':
        return ('all', None, None)
    if not raw_from or not raw_to:
        raise StatsRangeError('date_from and date_to are both required (YYYY-MM-DD).')
    start = _parse_ymd(raw_from, 'date_from')
    end = _parse_ymd(raw_to, 'date_to')
    if start > end:
        raise StatsRangeError('date_from must be on or before date_to.')
    return ('dates', start, end)


def _parse_ymd(value, name):
    if len(value) != 10 or value[4] != '-' or value[7] != '-':
        raise StatsRangeError(f'{name} must be YYYY-MM-DD.')
    try:
        return datetime.date.fromisoformat(value)
    except ValueError:
        raise StatsRangeError(f'{name} must be YYYY-MM-DD.')


def _manila_bounds(date_from, date_to):
    """[start, end) aware datetimes. ``date_to`` covers the whole Manila day."""
    start = datetime.datetime.combine(date_from, datetime.time.min, tzinfo=_MANILA)
    end = datetime.datetime.combine(
        date_to + datetime.timedelta(days=1), datetime.time.min, tzinfo=_MANILA)
    return start, end


def _manila_today():
    return datetime.datetime.now(_MANILA).date()


def _earliest_manila_date(qs):
    moment = qs.aggregate(m=models.Min('date_issued'))['m']
    if moment is None:
        return None
    return timezone.localtime(moment, _MANILA).date()


def _all_time_dates(user):
    """First Manila month that has a ticket through today. Empty → this month."""
    today = _manila_today()
    active = Violation.objects.all()
    if user.role == 'enforcer':
        sources = (active.filter(enforcer=user),)
    else:
        sources = (active, deduped_archived())
    found = [d for d in (_earliest_manila_date(qs) for qs in sources) if d is not None]
    if not found:
        return today.replace(day=1), today
    return min(found).replace(day=1), today


def _count_by_manila_day(qs, paid_q):
    from django.db.models.functions import TruncDate

    counts = {}
    rows = (
        qs.annotate(day=TruncDate('date_issued', tzinfo=_MANILA))
          .values('day')
          .annotate(total=Count('id'), paid=Count('id', filter=paid_q))
    )
    for row in rows:
        day = row['day']
        if day is None:
            continue
        if isinstance(day, datetime.datetime):
            day = timezone.localtime(day, _MANILA).date()
        slot = counts.setdefault(day, {'total': 0, 'paid': 0})
        slot['total'] += row['total'] or 0
        slot['paid'] += row['paid'] or 0
    return counts


def _trend_sources(user, start, end):
    """Active rows in the window, plus deduped archived rows for office-wide roles.

    Enforcers stay on their own active tickets. Archived snapshots are not
    scoped by a user FK, so they are not mixed into an enforcer's series.
    """
    active = Violation.objects.filter(date_issued__gte=start, date_issued__lt=end)
    if user.role == 'enforcer':
        return (active.filter(enforcer=user), Q(status='paid')), None
    archived = deduped_archived().filter(date_issued__gte=start, date_issued__lt=end)
    return (active, Q(status='paid')), (archived, Q(settlement_status='settled'))


def _merged_day_counts(user, start, end):
    merged = {}
    for source in _trend_sources(user, start, end):
        if source is None:
            continue
        qs, paid_q = source
        for day, counts in _count_by_manila_day(qs, paid_q).items():
            slot = merged.setdefault(day, {'total': 0, 'paid': 0})
            slot['total'] += counts['total']
            slot['paid'] += counts['paid']
    return merged


def _trend_points(user, start, end, date_from, date_to, bucket):
    """One point per day or per month, including zeros so the chart has no gaps."""
    by_day = _merged_day_counts(user, start, end)
    if bucket == 'day':
        points = []
        day = date_from
        while day <= date_to:
            counts = by_day.get(day, {'total': 0, 'paid': 0})
            points.append({
                'day': day.strftime('%a'),
                'date': day.strftime('%m/%d'),
                'total': counts['total'],
                'paid': counts['paid'],
            })
            day += datetime.timedelta(days=1)
        return points

    points = []
    year, month = date_from.year, date_from.month
    while (year, month) <= (date_to.year, date_to.month):
        total = paid = 0
        for day, counts in by_day.items():
            if day.year == year and day.month == month:
                total += counts['total']
                paid += counts['paid']
        label = _MONTH_ABBR[month - 1]
        points.append({
            'day': label,
            'date': f'{label} {year}',
            'total': total,
            'paid': paid,
        })
        month += 1
        if month == 13:
            month = 1
            year += 1
    return points


def _window_figures(start, end):
    """Same money rules as historical_kpis(), limited to [start, end).

    pending / processing are intentionally absent: those stay current-state.
    """
    from decimal import Decimal
    from django.db.models import DecimalField, Sum
    from django.db.models.fields.json import KeyTextTransform
    from django.db.models.functions import Cast

    active = Violation.objects.filter(date_issued__gte=start, date_issued__lt=end)
    archived = (
        deduped_archived()
        .filter(date_issued__gte=start, date_issued__lt=end)
        .annotate(x_pen=Cast(KeyTextTransform('penalty_amount', 'data'),
                             DecimalField(max_digits=12, decimal_places=2)))
    )
    a = active.aggregate(
        total=Count('id'),
        paid=Count('id', filter=Q(status='paid')),
        pen=models.Sum('penalty_amount'),
        col=models.Sum('penalty_amount', filter=Q(status='paid')),
    )
    h = archived.aggregate(
        total=Count('id'),
        paid=Count('id', filter=Q(settlement_status='settled')),
        pen=Sum('x_pen'),
        col=Sum('x_pen', filter=Q(settlement_status='settled')),
    )
    zero = Decimal('0')
    return {
        'scope': 'date_range_including_archived',
        'total': (a['total'] or 0) + (h['total'] or 0),
        'paid': (a['paid'] or 0) + (h['paid'] or 0),
        'total_penalty': float((a['pen'] or zero) + (h['pen'] or zero)),
        'total_collected': float((a['col'] or zero) + (h['col'] or zero)),
        'active_count': a['total'] or 0,
        'archived_count': h['total'] or 0,
    }


def apply_stats_range(data, user, spec):
    """Replace the trend (and, for a date window, the admin cumulative totals).

    ``range=all`` keeps the all-time historical totals and switches the trend
    to a monthly series. A date window filters total / paid / collected and
    the trend. Pending and enforcer headcounts are left untouched.
    """
    mode, date_from, date_to = spec
    if mode == 'all':
        date_from, date_to = _all_time_dates(user)
        bucket = 'month'
    else:
        span_days = (date_to - date_from).days + 1
        bucket = 'day' if span_days <= _TREND_DAY_LIMIT else 'month'
    start, end = _manila_bounds(date_from, date_to)
    data['daily_data'] = _trend_points(user, start, end, date_from, date_to, bucket)
    data['trend_bucket'] = bucket
    if user.role == 'admin' and mode == 'dates':
        data['historical'].update(_window_figures(start, end))


def historical_kpis():
    """All-time KPIs = ACTIVE table + ARCHIVED snapshots (duplicates removed).

    pending/processing exist only in the active table (they are never
    archived); archived rows are settled (paid) tickets. Money comes from the
    ticket-level penalty_amount on both sides.
    """
    from decimal import Decimal
    from django.db.models import DecimalField, Sum
    from django.db.models.fields.json import KeyTextTransform
    from django.db.models.functions import Cast

    a = Violation.objects.aggregate(
        total=Count('id'),
        pending=Count('id', filter=Q(status='pending')),
        processing=Count('id', filter=Q(status='processing')),
        paid=Count('id', filter=Q(status='paid')),
        pen=models.Sum('penalty_amount'),
        col=models.Sum('penalty_amount', filter=Q(status='paid')),
    )
    h = (deduped_archived()
         .annotate(x_pen=Cast(KeyTextTransform('penalty_amount', 'data'),
                              DecimalField(max_digits=12, decimal_places=2)))
         .aggregate(
             total=Count('id'),
             paid=Count('id', filter=Q(settlement_status='settled')),
             pen=Sum('x_pen'),
             col=Sum('x_pen', filter=Q(settlement_status='settled'))))
    zero = Decimal('0')
    return {
        'scope': 'all_time_including_archived',
        'total': (a['total'] or 0) + (h['total'] or 0),
        'pending': a['pending'] or 0,
        'processing': a['processing'] or 0,
        'paid': (a['paid'] or 0) + (h['paid'] or 0),
        'total_penalty': float((a['pen'] or zero) + (h['pen'] or zero)),
        'total_collected': float((a['col'] or zero) + (h['col'] or zero)),
        'active_count': a['total'] or 0,
        'archived_count': h['total'] or 0,
    }


class ViolationStatsView(APIView):
    """Role-aware counts. Enforcers see ONLY their own records (queryset is
    filtered below), which is what the enforcer home screen reads so its
    totals cover the whole authorized dataset instead of one page."""
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        from django.utils import timezone
        from django.db.models import Count, Sum

        try:
            spec = parse_stats_range(request.query_params)
        except StatsRangeError as exc:
            return Response({'detail': exc.detail}, status=status.HTTP_400_BAD_REQUEST)

        # localdate(), not now().date(): settings.TIME_ZONE is Asia/Manila
        # and USE_TZ is on, so now().date() is the UTC date and "today"
        # would be wrong for the first 8 hours of every Philippine day.
        today = timezone.localdate()
        qs = Violation.objects.all()

        if request.user.role == 'enforcer':
            qs = qs.filter(enforcer=request.user)

        data = {
            'total':         qs.count(),
            'pending':       qs.filter(status='pending').count(),
            'processing':    qs.filter(status='processing').count(),
            'paid':          qs.filter(status='paid').count(),
            'today':         qs.filter(date_issued__date=today).count(),
            'total_penalty':   float(qs.aggregate(t=Sum('penalty_amount'))['t'] or 0),
            'total_collected': float(qs.filter(status='paid').aggregate(t=Sum('penalty_amount'))['t'] or 0),
            'total_violations': qs.count(),
            # Requirement: Offline Issuances KPI. client_offline_id is set
            # once, at creation, only by the dedicated offline workflow (see
            # ViolationDetailSerializer) and is never cleared afterwards —
            # so this count is independent of the local sync queue and
            # stays correct across the record's whole status lifecycle.
            # Uses the same role-scoped `qs` as every other figure above,
            # so an Enforcer only sees their own offline issuances while
            # Staff/Admin see the organization-wide total.
            'offline_issuances': qs.filter(client_offline_id__isnull=False).count(),
        }

        week_start = today - datetime.timedelta(days=6)
        from django.db.models.functions import TruncDate
        day_counts = {
            row['day']: row['cnt']
            for row in qs.filter(date_issued__date__gte=week_start)
                         .annotate(day=TruncDate('date_issued'))
                         .values('day')
                         .annotate(cnt=Count('id'))
        }
        weekly = []
        for i in range(6, -1, -1):
            day = today - datetime.timedelta(days=i)
            weekly.append({
                'day':   day.strftime('%a'),
                'date':  day.strftime('%m/%d'),
                'count': day_counts.get(day, 0),
            })
        data['weekly_data'] = weekly

        from .models import ViolationItem
        category_qs = (
            ViolationItem.objects
            .filter(violation__in=qs)
            .values('violation_type__category')
            .annotate(count=Count('id'))
            .order_by('-count')
        )
        data['category_data'] = [
            {
                'category': item['violation_type__category'] or 'Uncategorized',
                'count':    item['count'],
            }
            for item in category_qs
        ]

        month_start = today.replace(day=1)
        month_qs = Violation.objects.filter(date_issued__date__gte=month_start)
        if request.user.role == 'enforcer':
            month_qs = month_qs.filter(enforcer=request.user)

        top_raw = list(
            month_qs
            .values('enforcer__id', 'enforcer__full_name')
            .annotate(tickets=Count('id'))
            .order_by('-tickets', 'enforcer__id')[:5]
        )
        # Phase 3: grouped on the stable user id; the displayed name is the
        # latest EVENT-TIME name and the badge is snapshot-only.
        top_snaps = latest_enforcer_snapshots([e['enforcer__id'] for e in top_raw])
        max_tickets = top_raw[0]['tickets'] if top_raw else 1
        data['top_enforcers'] = []
        for e in top_raw:
            ident = grouped_enforcer_identity(e['enforcer__id'], e['enforcer__full_name'], top_snaps)
            data['top_enforcers'].append({
                'id':      e['enforcer__id'],
                'name':    ident['name'] or '—',
                'badge':   ident['badge'],
                'tickets': e['tickets'],
                'rate':    round((e['tickets'] / max_tickets) * 100) if max_tickets else 0,
            })

        hotspot_raw = list(
            qs.exclude(location__isnull=True)
              .exclude(location__exact='')
              .values('location')
              .annotate(count=Count('id'))
              .order_by('-count')[:5]
        )
        data['hotspots'] = [
            {'area': h['location'], 'count': h['count'], 'trend': None}
            for h in hotspot_raw
        ]

        gps_qs = qs.exclude(latitude__isnull=True).exclude(longitude__isnull=True)
        data['heatmap_points'] = list(
            gps_qs.values('latitude', 'longitude')
        )

        # ── Desktop dashboard additions ─────────────────────────────────
        # Purely additive: every key above is unchanged, so the mobile
        # enforcer home and any other reader of /stats/ keep working.
        data['processing'] = qs.filter(status='processing').count()

        paid_by_day = {
            row['day']: row['cnt']
            for row in qs.filter(date_issued__date__gte=week_start, status='paid')
                         .annotate(day=TruncDate('date_issued'))
                         .values('day')
                         .annotate(cnt=Count('id'))
        }
        # Same 7-day window as weekly_data. "paid" = of the OVRs issued that
        # day, how many are now paid — not payments received that day.
        data['daily_data'] = []
        for i in range(6, -1, -1):
            day = today - datetime.timedelta(days=i)
            data['daily_data'].append({
                'day':   day.strftime('%a'),
                'date':  day.strftime('%m/%d'),
                'total': day_counts.get(day, 0),
                'paid':  paid_by_day.get(day, 0),
            })

        data['week_total'] = sum(day_counts.values())
        data['prev_week_total'] = qs.filter(
            date_issued__date__gte=week_start - datetime.timedelta(days=7),
            date_issued__date__lt=week_start,
        ).count()

        # By violation type (name), top 5 + everything else grouped.
        type_rows = list(
            ViolationItem.objects
            .filter(violation__in=qs)
            .values('violation_type__name')
            .annotate(count=Count('id'))
            .order_by('-count')
        )
        top_types = [
            {'name': r['violation_type__name'] or 'Unknown', 'count': r['count']}
            for r in type_rows[:5]
        ]
        other_count = sum(r['count'] for r in type_rows[5:])
        if other_count:
            top_types.append({'name': 'Other', 'count': other_count})
        data['type_data'] = top_types

        # Staff/Admin only — enforcers have no business with headcounts.
        if request.user.role != 'enforcer':
            from accounts.models import CustomUser
            from enforcers.duty import sync_all_enforcers_duty
            sync_all_enforcers_duty()   # mirror = schedule + local time (no scheduler exists)
            active = CustomUser.objects.filter(role='enforcer', employment_status='active')
            data['active_enforcers'] = active.count()
            data['on_duty_enforcers'] = active.filter(duty_status='on_duty').count()

        # Admin only: cumulative (all-time, active + archived) figures, kept in
        # their own block so every key above stays the OPERATIONAL (active
        # table) number the Staff/Enforcer screens already read.
        if request.user.role == 'admin':
            data['historical'] = historical_kpis()
            # Checkpoint 2 panels. No date params: hist_period (default month)
            # still decides Top Enforcers only. A range or date window wins
            # over hist_period and uses the same Manila bounds as the totals.
            from .historical_dashboard import ENFORCER_PERIODS, historical_breakdowns
            if spec is None:
                hist_period = request.query_params.get('hist_period', 'month')
                data['historical'].update(historical_breakdowns(
                    hist_period if hist_period in ENFORCER_PERIODS else 'month'))
            elif spec[0] == 'all':
                data['historical'].update(historical_breakdowns('all'))
            else:
                data['historical'].update(historical_breakdowns(
                    window=_manila_bounds(spec[1], spec[2])))

        # No range params: daily_data stays the last 7 active days, above.
        # range=all or date_from/date_to replaces that series (zeros filled).
        if spec is not None:
            apply_stats_range(data, request.user, spec)

        return Response(data)


# ─── Analytics ───────────────────────────────────────────────────────────────

class AnalyticsSummaryView(APIView):
    """Thin wrapper: all aggregation lives in violations/analytics.py.
    Query params: period, location, category, vehicle_type (legacy), status (pending|processing|paid, optional) plus
    violation_type (code), weekday (1=Mon..7=Sun), hour (0-23), scope
    (all|active; default all = active + archived)."""
    permission_classes = [IsAdminOrStaff]

    def get(self, request):
        from .analytics import compute_analytics
        try:
            spec = parse_stats_range(request.query_params)
        except StatsRangeError as exc:
            return Response({'detail': exc.detail}, status=status.HTTP_400_BAD_REQUEST)
        return Response(compute_analytics(request.query_params, spec))


# ─── Year Comparison View ─────────────────────────────────────────────────────

class YearComparisonView(APIView):
    # Office-wide analytics, including per-enforcer breakdowns — Admin/Staff only.
    permission_classes = [permissions.IsAuthenticated, IsAdminOrStaff]

    # REQUIREMENT #8: a settled Violation is deleted from the active table
    # the moment it's archived (REQUIREMENT #2) and only survives as an
    # ArchivedViolation snapshot, so every aggregation below reads BOTH
    # sources and merges them by year before ranking/rendering. Nothing
    # here fabricates a year, a count, or a category — an entry simply
    # doesn't appear unless at least one real row (active or archived)
    # produced it.

    def _archived_breakdown_counts(self, key, years):
        """Yields (label, year, count) tuples for one breakdown dimension,
        read from historical (already-archived) violations.

        `violation_year` is a real indexed column on ArchivedViolation, so
        narrowing to the requested years is a normal DB-level filter. The
        category value itself (status/vehicle type/location/enforcer/
        violation category) lives inside the JSON `data` snapshot rather
        than its own indexed column, so once narrowed to just the archived
        rows for these years it's tallied in Python. Archived years are
        settled/closed and don't keep growing, so this stays a small,
        bounded read — not a scan of the whole archive.

        Never reads `data['assessed_by_name']` (Archive Confidentiality,
        REQUIREMENT #12) — only category-shaped fields are touched.
        """
        if key not in ('status', 'violation_category', 'vehicle_type', 'location', 'enforcer'):
            return
        category_label_map = dict(ViolationType.Category.choices)
        tally = {}  # (label, year) -> count
        # Year = Asia/Manila year of date_issued (not the stored column, which
        # older archive runs computed in UTC); duplicate snapshots of an
        # already-counted violation are removed by deduped_archived().
        rows = (deduped_archived()
                .filter(date_issued__year__in=years)
                .annotate(yr=ExtractYear('date_issued'))
                .only('date_issued', 'data'))
        for row in rows:
            yr = row.yr
            d = row.data or {}
            if key == 'status':
                label = d.get('status') or 'Unknown'
                tally[(label, yr)] = tally.get((label, yr), 0) + 1
            elif key == 'vehicle_type':
                vt = d.get('vehicle_type') or ''
                if vt not in VALID_VEHICLE_TYPE_LABELS:
                    continue
                tally[(vt, yr)] = tally.get((vt, yr), 0) + 1
            elif key == 'location':
                loc = d.get('location') or ''
                if not loc:
                    continue
                tally[(loc, yr)] = tally.get((loc, yr), 0) + 1
            elif key == 'enforcer':
                name = d.get('enforcer_name') or ''
                if not name:
                    continue
                tally[(name, yr)] = tally.get((name, yr), 0) + 1
            elif key == 'violation_category':
                for item in (d.get('items') or []):
                    code = item.get('category') or ''
                    label = category_label_map.get(code, code or 'Unknown')
                    tally[(label, yr)] = tally.get((label, yr), 0) + 1
        for (label, yr), cnt in tally.items():
            yield label, yr, cnt

    def _breakdown_rows(self, key, years):
        """Returns a list of {'category': label, <year>: count, ...} for one
        breakdown dimension, aggregated across the given years, merging
        active Violation records with historical ArchivedViolation records
        (REQUIREMENT #8) so a comparison spanning an archived year stays
        accurate. Pivoting on the display LABEL (not the raw code) from the
        start is what lets the two sources merge cleanly, since archived
        snapshots store status as a label already."""
        from django.db.models import Count
        from django.db.models.functions import ExtractYear

        pivot = {}  # label -> {year: count}

        def add(label, yr, cnt):
            pivot.setdefault(label, {})
            pivot[label][yr] = pivot[label].get(yr, 0) + cnt

        if key == 'status':
            qs = (
                Violation.objects
                .filter(date_issued__year__in=years)
                .annotate(yr=ExtractYear('date_issued'))
                .values('yr', 'status')
                .annotate(cnt=Count('id'))
            )
            label_map = dict(Violation.Status.choices)
            for row in qs:
                add(label_map.get(row['status'], row['status'] or 'Unknown'), row['yr'], row['cnt'])

        elif key == 'violation_category':
            qs = (
                ViolationItem.objects
                .filter(violation__date_issued__year__in=years)
                .annotate(yr=ExtractYear('violation__date_issued'))
                .values('yr', 'violation_type__category')
                .annotate(cnt=Count('id'))
            )
            label_map = dict(ViolationType.Category.choices)
            for row in qs:
                code = row['violation_type__category']
                add(label_map.get(code, code or 'Unknown'), row['yr'], row['cnt'])

        elif key == 'vehicle_type':
            qs = (
                Violation.objects
                .filter(date_issued__year__in=years)
                .exclude(vehicle_type__exact='')
                .filter(vehicle_type__in=VALID_VEHICLE_TYPE_LABELS)
                .annotate(yr=ExtractYear('date_issued'))
                .values('yr', 'vehicle_type')
                .annotate(cnt=Count('id'))
            )
            for row in qs:
                add(row['vehicle_type'] or 'Unknown', row['yr'], row['cnt'])

        elif key == 'location':
            qs = (
                Violation.objects
                .filter(date_issued__year__in=years)
                .exclude(location__exact='')
                .annotate(yr=ExtractYear('date_issued'))
                .values('yr', 'location')
                .annotate(cnt=Count('id'))
            )
            for row in qs:
                add(row['location'] or 'Unknown', row['yr'], row['cnt'])

        elif key == 'enforcer':
            qs = (
                Violation.objects
                .filter(date_issued__year__in=years)
                .exclude(enforcer__isnull=True)
                .annotate(yr=ExtractYear('date_issued'))
                .values('yr', 'enforcer__id', 'enforcer__full_name')
                .annotate(cnt=Count('id'))
            )
            # Phase 3: group on the stable id, label with the latest
            # event-time name (one label per person across every year).
            rows = list(qs)
            snaps = latest_enforcer_snapshots({r['enforcer__id'] for r in rows})
            for row in rows:
                ident = grouped_enforcer_identity(row['enforcer__id'], row['enforcer__full_name'], snaps)
                add(ident['name'] or 'Unknown', row['yr'], row['cnt'])

        else:
            return []

        # ── merge in historical (archived) counts for the same dimension ──
        for label, yr, cnt in self._archived_breakdown_counts(key, years):
            add(label, yr, cnt)

        # Rank by total across selected years, cap to top 8 so the chart
        # stays readable for high-cardinality dimensions (location, enforcer).
        totals = {label: sum(counts.values()) for label, counts in pivot.items()}
        # Tie-break on the label so the ranking (and the top-8 cut) is the same
        # whether a record is still active or already archived.
        ranked_labels = sorted(totals.keys(), key=lambda k: (-totals[k], str(k)))[:8]

        result = []
        for label in ranked_labels:
            entry = {'category': label}
            for yr in years:
                entry[str(yr)] = pivot[label].get(yr, 0)
            result.append(entry)
        return result

    def get(self, request):
        from django.db.models import Count
        from django.db.models.functions import ExtractMonth, ExtractYear

        today = timezone.localdate()   # Asia/Manila, not the server's UTC date
        current_year = today.year

        raw_years = request.query_params.getlist('years')
        try:
            years = sorted(set(int(y) for y in raw_years if y.isdigit()))
        except Exception:
            years = []

        if len(years) == 0:
            years = [current_year - 1, current_year]

        # ── active (currently in the working table) monthly counts ──
        rows = (
            Violation.objects
            .filter(date_issued__year__in=years)
            .annotate(yr=ExtractYear('date_issued'), mo=ExtractMonth('date_issued'))
            .values('yr', 'mo')
            .annotate(cnt=Count('id'))
        )

        lookup = {yr: {} for yr in years}
        for row in rows:
            lookup[row['yr']][row['mo']] = row['cnt']

        # ── historical (archived) monthly counts, same date field ──
        # (date_issued) — REQUIREMENT #8: a year fully moved into the
        # archive by REQUIREMENT #2 must not show as empty here. Merged by
        # adding rather than overwriting, since a given year could have
        # some records still active (in-progress ones are never archived)
        # and some already archived (settled ones).
        archived_rows = (
            deduped_archived()
            .filter(date_issued__year__in=years)
            .annotate(yr=ExtractYear('date_issued'), mo=ExtractMonth('date_issued'))
            .values('yr', 'mo')
            .annotate(cnt=Count('id'))
        )
        for row in archived_rows:
            yr = row['yr']
            lookup.setdefault(yr, {})
            lookup[yr][row['mo']] = lookup[yr].get(row['mo'], 0) + row['cnt']

        year_comparison = []
        for month in range(1, 13):
            entry = {'month': datetime.date(current_year, month, 1).strftime('%b')}
            for yr in years:
                entry[str(yr)] = lookup[yr].get(month, 0)
            year_comparison.append(entry)

        active_years_with_data = set(
            Violation.objects
            .annotate(yr=ExtractYear('date_issued'))
            .values_list('yr', flat=True)
            .distinct()
        )
        archived_years_with_data = set(
            deduped_archived().annotate(yr=ExtractYear('date_issued'))
            .values_list('yr', flat=True).distinct()
        )
        all_years_with_data = sorted(active_years_with_data | archived_years_with_data)

        # Optional per-category breakdowns, requested via ?breakdown=status&breakdown=vehicle_type...
        valid_breakdown_keys = {'status', 'violation_category', 'vehicle_type', 'location', 'enforcer'}
        requested_breakdowns = [
            b for b in request.query_params.getlist('breakdown') if b in valid_breakdown_keys
        ]
        breakdowns = {
            key: self._breakdown_rows(key, years) for key in requested_breakdowns
        }

        return Response({
            'years': years,
            'year_comparison': year_comparison,
            'available_years': all_years_with_data,
            'breakdowns': breakdowns,
        })


# ─── Staff Dashboard ──────────────────────────────────────────────────────────

class StaffDashboardView(APIView):
    # Staff assessment queue — exposes every pending violator's identity,
    # so it is Admin/Staff only. Enforcers use /stats/ + MyReports instead.
    permission_classes = [permissions.IsAuthenticated, IsAdminOrStaff]

    def get(self, request):
        from django.utils import timezone
        from django.db.models import Sum

        # localdate(), not now().date(): see the note on ViolationStatsView —
        # settings.TIME_ZONE is Asia/Manila, so this keeps "today" correct
        # for the first 8 hours of every Philippine day.
        today = timezone.localdate()
        qs = Violation.objects.all()

        pending_queue = qs.filter(status__in=['pending', 'processing']).order_by('-created_at')[:10]

        # "Today's Summary" is per-request-user ("Your assessment activity"),
        # not an all-staff/all-time figure, so it is scoped to Assessment
        # records THIS staff member actually touched today — not to
        # Violation.date_issued, which is set by the Enforcer at OVR time
        # and has nothing to do with when Staff processed it.
        my_assessments_today = Assessment.objects.filter(
            assessed_by=request.user, assessed_at__date=today,
        )
        # Payments are counted by who CONFIRMED them (Phase 2): assessing and
        # confirming payment are separate events and may be different people.
        my_payments_today = Assessment.objects.filter(
            payment_confirmed_by=request.user, date_paid=today,
        )

        # Violation Breakdown — today's violations by type, system-wide
        # (an operational "what came in today" view, not staff-scoped).
        breakdown_qs = (
            ViolationItem.objects
            .filter(violation__date_issued__date=today)
            .values('violation_type__name')
            .annotate(count=Count('id'))
            .order_by('-count')
        )
        violation_breakdown = [
            {'name': item['violation_type__name'] or 'Unknown', 'count': item['count']}
            for item in breakdown_qs
        ]

        # Latest movement on any OVR (issued, being processed, assessed,
        # approved, paid), newest first — the "Recent Actions" panel.
        recent_actions = [
            {
                'id':               v.id,
                'ovr_number':       v.ovr_number,
                'status':           v.status,
                # Phase 3: who FILED / who ASSESSED are historical events ->
                # event-time snapshot first (assessor never from the live FK).
                # locked_by_name below is the CURRENT lock holder (present
                # state, not an event), so it stays live.
                'enforcer_name':    enforcer_identity(v)['name'],
                'assessed_by_name': (assessor_identity(v.assessment)['name']
                                     if hasattr(v, 'assessment') else None),
                'locked_by_name':   v.locked_by.full_name if v.locked_by else None,
                'updated_at':       v.updated_at,
            }
            for v in qs.select_related('enforcer', 'assessed_by', 'locked_by', 'assessment').order_by('-updated_at')[:6]
        ]

        return Response({
            'pending_count':    qs.filter(status='pending').count(),
            'processing_count': qs.filter(status='processing').count(),
            'paid_count':       qs.filter(status='paid').count(),
            'recent_actions':   recent_actions,
            'pending_queue': [
                {
                    'id':            v.id,
                    'violator_name': v.violator_name,
                    'enforcer_name': enforcer_identity(v)['name'],
                    'plate_number':  v.plate_number,
                    'location':      v.location,
                    'status':        v.status,
                    'locked_by_id':  v.locked_by_id,
                    'locked_by_name': v.locked_by.full_name if v.locked_by else None,
                    # Without this, staff who revisit an already-'processing' violation
                    # (locked_by_id === their own id) get routed straight to the
                    # Assessment Form using this list item instead of a fresh detail
                    # fetch — so the evidence photo appears to "disappear" after the
                    # first view even though nothing was ever deleted.
                    'image':         v.image.url if v.image else None,
                    'license_number':         v.license_number,
                    'license_status':         v.license_status,
                    'registration_number':    v.registration_number,
                    'vehicle_type':           v.vehicle_type,
                    'vehicle_brand':          v.vehicle_brand,
                    'vehicle_model':          v.vehicle_model,
                    'address':                v.address,
                    'ovr_number':             v.ovr_number,
                    'date_issued':            v.date_issued,
                    'remarks':                v.remarks,
                    'penalty_amount':         str(v.penalty_amount),
                    'items': [
                        {
                            'violation_type': {
                                'id':             i.violation_type.id,
                                'name':           i.violation_type.name,
                                'code':           i.violation_type.code,
                                'penalty_amount': str(i.violation_type.penalty_amount),
                            },
                            'penalty_amount_snapshot': str(i.penalty_amount_snapshot),
                        }
                        for i in _items_with_types(v)
                    ],
                }
                for v in pending_queue.select_related('enforcer', 'locked_by').prefetch_related('items__violation_type')
            ],
            'summary': {
                'assessments_completed': my_assessments_today.count(),
                'tickets_generated':     my_assessments_today.filter(violation__status='paid').count(),
                'payments_recorded':     my_payments_today.count(),
                'total_penalties':       float(my_assessments_today.aggregate(t=Sum('penalty'))['t'] or 0),
            },
            'violation_breakdown': violation_breakdown,
        })


# ─── Pending Violations ───────────────────────────────────────────────────────

class PendingViolationListView(APIView):
    # Same reasoning as StaffDashboardView — the pending queue is the Staff
    # workload list, not enforcer-visible data.
    permission_classes = [permissions.IsAuthenticated, IsAdminOrStaff]

    def get(self, request):
        from django.utils import timezone

        today = timezone.localdate()
        qs = Violation.objects.filter(status__in=['pending', 'processing']).order_by('-created_at')

        search = request.query_params.get('search', '')
        if search:
            search_filter = Q(violator_name__icontains=search) | Q(plate_number__icontains=search) | Q(license_number__icontains=search)
            if search.isdigit():
                search_filter |= Q(id=int(search))
            qs = qs.filter(search_filter)

        oldest = qs.filter(status='pending').order_by('created_at').first()
        oldest_days = (timezone.localdate() - timezone.localtime(oldest.created_at).date()).days if oldest else 0

        try:
            page_size = int(request.query_params.get('page_size', 10))
        except (TypeError, ValueError):
            page_size = 10
        page_size = max(1, min(page_size, 100))

        try:
            page = max(1, int(request.query_params.get('page', 1)))
        except (TypeError, ValueError):
            page = 1

        total_matching = qs.count()
        start = (page - 1) * page_size

        return Response({
            'count':            total_matching,
            'total_pending':    qs.filter(status='pending').count(),
            'processing_count': qs.filter(status='processing').count(),
            'oldest_days':      oldest_days,
            'violations_today': Violation.objects.filter(date_issued__date=today).count(),
            'results': [
                {
                    'id':                     v.id,
                    'violator_name':          v.violator_name,
                    'license_number':         v.license_number,
                    'license_status':         v.license_status,
                    'plate_number':           v.plate_number,
                    'registration_number':    v.registration_number,
                    'vehicle_type':           v.vehicle_type,
                    'address':                v.address,
                    'ovr_number':             v.ovr_number,
                    'location':               v.location,
                    'date_issued':            v.date_issued,
                    'remarks':                v.remarks,
                    'penalty_amount':         str(v.penalty_amount),
                    # See same note in StaffDashboardView.pending_queue above —
                    # without this the evidence photo disappears the second time
                    # staff open an already-'processing' violation.
                    'image':                  v.image.url if v.image else None,
                    'status':                 v.status,
                    'created_at':             v.created_at,
                    'enforcer_name':          enforcer_identity(v)['name'] or '—',
                    'locked_by_id':           v.locked_by_id,
                    'locked_by_name':         v.locked_by.full_name if v.locked_by else None,
                    'items': [
                        {
                            'violation_type': {
                                'id':             i.violation_type.id,
                                'name':           i.violation_type.name,
                                'code':           i.violation_type.code,
                                'penalty_amount': str(i.violation_type.penalty_amount),
                            },
                            'penalty_amount_snapshot': str(i.penalty_amount_snapshot),
                        }
                        for i in _items_with_types(v)
                    ],
                }
                for v in qs.select_related('enforcer', 'locked_by').prefetch_related('items__violation_type')[start:start + page_size]
            ]
        })


# ─── CSV Import ───────────────────────────────────────────────────────────────

class ImportViolationsView(APIView):
    """
    Admin-only Excel (.xlsx) bulk import. See violations/import_service.py for
    the full rule set. POST = preview; POST ?save=true = all-or-nothing save.

    Imported records: enforcer=NULL, source='imported', imported_by=uploader.
    The uploader is NEVER recorded as the issuing enforcer.
    """
    permission_classes = [permissions.IsAuthenticated, IsAdmin]

    def post(self, request):
        from django.db import transaction
        from . import import_service as imp

        file = request.FILES.get('file')
        if not file:
            return Response({'error': 'No file uploaded.'}, status=400)
        try:
            result = imp.validate(file)
        except imp.ImportFileError as exc:
            return Response({'error': str(exc)}, status=400)

        errors, valid = result['errors'], result['valid']
        save = request.query_params.get('save', 'false').lower() == 'true'

        if not save:
            return Response({
                'preview': True,
                'total_rows':   result['total_rows'],
                'valid_count':  len(valid),
                'error_count':  len(errors),
                'errors':       errors,
                'valid_rows':   result['preview_rows'],
                'can_import':   not errors and bool(valid),
                'ignored_columns': result['ignored_columns'],
                'notes': ['Imported records have no issuing enforcer, and no item-level penalty breakdown '
                          '(only the ticket total is stored). Paid rows and ambiguous dates are rejected.'],
                'limits': {'max_rows': imp.MAX_ROWS, 'max_file_mb': imp.MAX_FILE_BYTES // (1024 * 1024)},
            })

        if errors or not valid:
            return Response({
                'error': (f'{len(errors)} row(s) have errors. Nothing was imported — fix them and try again.'
                          if errors else 'There are no valid rows to import.'),
                'errors': errors,
            }, status=400)

        created_ids = []
        with transaction.atomic():
            for r in valid:
                violation = Violation.objects.create(
                    source          = Violation.Source.IMPORTED,
                    enforcer        = None,
                    imported_by     = request.user,
                    date_issued     = timezone.make_aware(datetime.datetime.combine(r['date_issued'], datetime.time(12, 0))),
                    plate_number    = r['plate_number'],
                    violator_name   = r['violator_name'],
                    license_number  = r['license_number'],
                    address         = r['address'],
                    vehicle_type    = r['vehicle_type'],
                    location        = r['location'],
                    remarks         = r['remarks'],
                    penalty_amount  = r['penalty_amount'],
                    status          = r['status'],
                )
                # penalty_amount_snapshot intentionally left at its 0 placeholder:
                # there is no authoritative item-level amount for imported rows.
                for vt in r['vtypes']:
                    ViolationItem.objects.create(violation=violation, violation_type=vt)
                created_ids.append(violation.id)

        log_action(
            user        = request.user,
            action      = 'CREATE',
            module      = 'Violations',
            description = f'{request.user.full_name} imported {len(created_ids)} violation record(s) via Excel.',
            request     = request,
            target_type = 'Violation',
            details     = {
                'imported_count': len(created_ids),
                'violation_ids':  created_ids,
                'imported_by':    request.user.full_name,
                'role':           request.user.role,
                'source':         Violation.Source.IMPORTED,
                'file_name':      file.name,
            },
        )

        return Response({
            'success': True,
            'created': len(created_ids),
            'message': f'Successfully imported {len(created_ids)} violation record(s).',
        }, status=201)


class ImportTemplateView(APIView):
    """Admin-only: .xlsx template with headers only (no sample rows), an
    instructions sheet, and a reference sheet listing the ACTIVE violation codes."""
    permission_classes = [permissions.IsAuthenticated, IsAdmin]

    def get(self, request):
        import openpyxl
        from openpyxl.styles import Font
        from . import import_service as imp

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = 'Violations'
        ws.append(imp.ALL_COLS)
        for c in ws[1]:
            c.font = Font(bold=True)
        for i, col in enumerate(imp.ALL_COLS, 1):
            ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = 20
        ws.freeze_panes = 'A2'

        ref = wb.create_sheet('Violation Codes')
        ref.append(['code', 'name', 'category', 'penalty_amount (current)'])
        for c in ref[1]:
            c.font = Font(bold=True)
        for vt in ViolationType.objects.filter(is_active=True).order_by('code'):
            ref.append([vt.code, vt.name, vt.get_category_display(), float(vt.penalty_amount)])
        ref.column_dimensions['A'].width = 14
        ref.column_dimensions['B'].width = 50
        ref.column_dimensions['C'].width = 20
        ref.column_dimensions['D'].width = 24

        info = wb.create_sheet('Instructions')
        for line in [
            'Fill in the "Violations" sheet, one ticket per row. Delete nothing in the header row.',
            'Required columns: ' + ', '.join(imp.REQUIRED_COLS),
            'Optional columns: ' + ', '.join(imp.OPTIONAL_COLS),
            'date_issued: a real Excel date, or text in the form YYYY-MM-DD. Other text formats are rejected.',
            'violation_codes: comma-separated codes copied from the "Violation Codes" sheet.',
            'penalty_amount: the ticket total in PHP. It is stored at ticket level only.',
            'status: pending or processing (default pending). Paid rows are rejected.',
            f'Limits: {imp.MAX_ROWS} rows and {imp.MAX_FILE_BYTES // (1024 * 1024)} MB per file. .xlsx only.',
            'The import is all-or-nothing: if any row has an error, no row is saved.',
        ]:
            info.append([line])
        info.column_dimensions['A'].width = 110

        buf = io.BytesIO()
        wb.save(buf)
        resp = HttpResponse(buf.getvalue(), content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        resp['Content-Disposition'] = 'attachment; filename="violations_import_template.xlsx"'
        return resp


# ─── Mark Ticket as Printed ──────────────────────────────────────────────────

class MarkTicketPrintedView(APIView):
    """
    PATCH /violations/tickets/<pk>/mark-printed/ — audit hook fired when the
    Assessment Form is printed. Valid ONLY for a paid violation whose payment
    was confirmed. The first call sets is_printed and logs ASSESSMENT FORM
    PRINTED; later calls log ASSESSMENT FORM REPRINTED. It never changes
    status, amount, date, assessor or any payment data.
    """
    permission_classes = [permissions.IsAuthenticated, IsAdminOrStaff]

    def patch(self, request, pk):
        try:
            violation = Violation.objects.get(pk=pk)
        except Violation.DoesNotExist:
            return Response({'detail': 'Violation not found.'}, status=status.HTTP_404_NOT_FOUND)

        if violation.status != Violation.Status.PAID:
            return Response(
                {'detail': 'The Assessment Form can only be printed after payment is confirmed.'},
                status=status.HTTP_409_CONFLICT,
            )

        first_print = Violation.objects.filter(pk=violation.pk, is_printed=False).update(is_printed=True) == 1
        event = 'PRINTED' if first_print else 'REPRINTED'

        log_action(
            user=request.user,
            action='UPDATE',
            module='Assessment',
            description=(
                f'ASSESSMENT FORM {event} — {request.user.full_name} '
                f'{event.lower()} the Assessment Form of violation #{violation.id}.'
            ),
            request=request,
            target_type='Violation',
            target_id=violation.id,
            details={
                'event':        f'ASSESSMENT_FORM_{event}',
                'violation_id': violation.id,
                'printed_by':   request.user.full_name,
                'role':         request.user.role,
            },
        )

        return Response({
            'success': True, 'id': violation.id, 'is_printed': True,
            'print_event': event.lower(),
        })


# ─── OCR License Scan ─────────────────────────────────────────────────────────

class ScanLicenseView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        image_data = request.data.get('image', '')
        if not image_data:
            return Response(
                {'error': 'No image data provided.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        try:
            from .ocr import extract_text_from_base64, parse_license_info
            raw_text = extract_text_from_base64(image_data)
            parsed   = parse_license_info(raw_text)
            return Response({
                'raw_text': raw_text,
                'parsed':   parsed,
            })
        except Exception as e:
            return Response(
                {'error': 'OCR processing failed.', 'detail': str(e)},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )