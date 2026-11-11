import math
from datetime import timedelta

from rest_framework import serializers
from django.db import transaction
from django.utils import timezone
from .custody_models import (
    CONFISCATION_FIELDS, ConfiscationLockedAPIError, confiscation_changes, confiscation_is_locked,
)
from .models import (
    Violation, ViolationType, ViolationItem, VehicleBrandModel,
    Assessment, ViolationEvidence,
)
from accounts.serializers import UserSerializer
from accounts.identity import (
    assessor_identity, enforcer_identity, payment_confirmer_identity,
)
from .attribution import record_assessor
from .upload_validation import validate_image_size


def _validate_gps_coordinate(value, low, high, label):
    """Reject coordinates outside the real geographic range.

    None is valid: both Violation and ViolationEvidence store latitude and
    longitude as optional. DRF only calls this for fields present in the
    request, so a partial update does not re-check coordinates that were omitted.
    """
    if value is None:
        return None
    # DRF's FloatField accepts the strings 'nan' / 'inf'. NaN fails every
    # comparison, so the range test below would let it through and PostgreSQL
    # would store it. Reject every non-finite value with the same message.
    if not math.isfinite(value) or value < low or value > high:
        raise serializers.ValidationError(
            f'{label} must be between {low} and {high}.'
        )
    return value


class GpsCoordinateValidationMixin:
    """Shared latitude/longitude range checks for violation and evidence writes."""

    def validate_latitude(self, value):
        return _validate_gps_coordinate(value, -90, 90, 'Latitude')

    def validate_longitude(self, value):
        return _validate_gps_coordinate(value, -180, 180, 'Longitude')


def _vehicle_category_key(vehicle_type):
    """Map the vehicle type text sent by the forms (a category label such as
    'Motorcycles', or a key such as 'motorcycle') to a category key.
    Returns '' when it cannot be resolved (e.g. a free-typed vehicle type)."""
    text = ''.join((vehicle_type or '').lower().split())
    if not text:
        return ''
    for key, label in VehicleBrandModel.Category.choices:
        if text in (''.join(key.lower().split()), ''.join(label.lower().split())):
            return key
    return ''


def _check_types_match_vehicle(types, vehicle_type):
    """Reject violation types assigned to a different vehicle category.
    Types with no vehicle_category (not assigned yet) are always accepted."""
    key = _vehicle_category_key(vehicle_type)
    if not key:
        return
    bad = [t for t in types if t.vehicle_category and t.vehicle_category != key]
    if bad:
        raise serializers.ValidationError({
            'violation_type_ids': 'These violations do not apply to the selected vehicle type: '
                                  + ', '.join(t.name for t in bad)
        })


class ViolationTypeSerializer(serializers.ModelSerializer):
    vehicle_category_label = serializers.CharField(source='get_vehicle_category_display', read_only=True)

    class Meta:
        model = ViolationType
        fields = [
            'id', 'code', 'name', 'category', 'penalty_amount', 'description',
            'is_active', 'vehicle_category', 'vehicle_category_label',
        ]


class VehicleBrandModelSerializer(serializers.ModelSerializer):
    category_label = serializers.CharField(source='get_category_display', read_only=True)

    class Meta:
        model = VehicleBrandModel
        fields = ['id', 'brand', 'model', 'category', 'category_label', 'is_active']


class ViolationItemSerializer(serializers.ModelSerializer):
    violation_type = ViolationTypeSerializer(read_only=True)
    violation_type_id = serializers.PrimaryKeyRelatedField(
        queryset=ViolationType.objects.filter(is_active=True),
        source='violation_type', write_only=True
    )

    class Meta:
        model = ViolationItem
        fields = ['violation_type', 'violation_type_id']


class ViolationItemListSerializer(serializers.ModelSerializer):
    id   = serializers.IntegerField(source='violation_type.id',   read_only=True)
    name = serializers.CharField(  source='violation_type.name',  read_only=True)
    code = serializers.CharField(  source='violation_type.code',  read_only=True)

    class Meta:
        model = ViolationItem
        fields = ['id', 'name', 'code']


class AssessmentRecordSerializer(serializers.ModelSerializer):
    """
    STAFF-side record — separate from the Enforcer's Violation/OVR.
    O.R. Number is always manual (from City Hall), never auto-generated.
    """
    # Phase 3: both names are EVENT-TIME snapshots. The assessor is never
    # taken from the live FK (legacy payment confirmation overwrote it), so an
    # unprovable legacy assessor is null, not the FK's current name.
    assessed_by_name = serializers.SerializerMethodField()
    assessor_historical = serializers.SerializerMethodField()
    payment_confirmed_by_name = serializers.SerializerMethodField()
    payment_confirmer_historical = serializers.SerializerMethodField()

    def get_assessed_by_name(self, obj):
        return assessor_identity(obj)['name']

    def get_assessor_historical(self, obj):
        return assessor_identity(obj)['historical']

    def get_payment_confirmed_by_name(self, obj):
        return payment_confirmer_identity(obj)['name']

    def get_payment_confirmer_historical(self, obj):
        return payment_confirmer_identity(obj)['historical']

    class Meta:
        model = Assessment
        fields = [
            'id', 'violation', 'or_number', 'penalty', 'amount_paid',
            'received_by', 'date_paid', 'assessed_by', 'assessed_by_name',
            'assessor_historical',
            'assessed_at', 'payment_confirmed_by', 'payment_confirmed_by_name',
            'payment_confirmer_historical',
            'payment_confirmed_at', 'notes', 'created_at', 'updated_at',
        ]
        # Every payment field is written ONLY by ConfirmPaymentView (atomic,
        # server-derived). Through this serializer (Assessment PATCH) the
        # only writable field is `notes`, so it can never be used to forge
        # or rewrite a payment.
        read_only_fields = [
            'id', 'violation', 'or_number', 'penalty', 'amount_paid',
            'received_by', 'date_paid', 'assessed_by', 'assessed_by_name',
            'assessor_historical',
            'assessed_at', 'payment_confirmed_by', 'payment_confirmed_by_name',
            'payment_confirmer_historical',
            'payment_confirmed_at', 'created_at', 'updated_at',
        ]


class ViolationEvidenceSerializer(GpsCoordinateValidationMixin, serializers.ModelSerializer):
    """
    Camera-capture evidence — separate from the OVR document itself.
    captured_by is always the authenticated uploader, never a
    client-supplied value (prevents spoofing another Enforcer).

    `violation` is optional — a photo can exist standalone (captured before
    an OVR is issued) and be linked afterwards via EvidenceAssociateSerializer.
    """
    captured_by_name = serializers.CharField(source='captured_by.full_name', read_only=True)
    ovr_number = serializers.CharField(source='violation.ovr_number', read_only=True, default=None)

    def validate_image(self, value):
        return validate_image_size(value)

    class Meta:
        model = ViolationEvidence
        fields = [
            'id', 'violation', 'ovr_number', 'image', 'captured_at', 'server_received_at',
            'latitude', 'longitude', 'gps_accuracy',
            'captured_by', 'captured_by_name', 'created_at',
        ]
        read_only_fields = ['id', 'server_received_at', 'captured_by', 'captured_by_name', 'created_at']
        extra_kwargs = {
            'violation': {'required': False, 'allow_null': True},
        }

    def create(self, validated_data):
        validated_data['captured_by'] = self.context['request'].user
        return super().create(validated_data)


class EvidenceAssociateSerializer(serializers.ModelSerializer):
    """
    PATCH-only serializer for the "Associate with OVR" action — the ONLY
    writable field is `violation`. Everything else about the evidence photo
    (image, captured_at, gps, captured_by) is immutable once uploaded.
    """
    class Meta:
        model = ViolationEvidence
        fields = ['id', 'violation']
        read_only_fields = ['id']

    def validate_violation(self, value):
        if value is None:
            raise serializers.ValidationError("A violation must be selected to associate this evidence with.")
        # An enforcer may only attach evidence to an OVR THEY filed.
        # IsEvidenceOwnerOrStaff already checks who owns the PHOTO; without
        # this check an enforcer could still staple their own photo onto
        # another enforcer's case file.
        request = self.context.get('request')
        user = getattr(request, 'user', None)
        if user is not None and getattr(user, 'role', None) == 'enforcer' and value.enforcer_id != user.id:
            raise serializers.ValidationError(
                "You can only associate evidence with an OVR you filed yourself."
            )
        return value


def _items_with_types(obj):
    """
    The violation's items with their violation_type loaded, WITHOUT an extra query per row when the
    view already prefetched `items__violation_type` (calling .select_related() on a prefetched manager
    ignores the prefetch and queries again for every row). Falls back to a single join query otherwise.
    """
    if 'items' in getattr(obj, '_prefetched_objects_cache', {}):
        items = list(obj.items.all())
        if all('violation_type' in i._state.fields_cache for i in items):
            return sorted(items, key=lambda i: i.id)  # stable order: ViolationItem has no default ordering
    return sorted(obj.items.select_related('violation_type').all(), key=lambda i: i.id)


class ViolationListSerializer(serializers.ModelSerializer):
    """Lightweight serializer for list views."""
    # Phase 3: event-time snapshot first (see accounts.identity). Keys are the
    # same as before; *_historical says whether the value is a stored snapshot.
    enforcer_name    = serializers.SerializerMethodField()
    enforcer_historical = serializers.SerializerMethodField()
    assessed_by_name = serializers.SerializerMethodField()
    assessed_by_historical = serializers.SerializerMethodField()
    violation_types  = serializers.SerializerMethodField()
    item_count       = serializers.IntegerField(source='items.count',        read_only=True)
    repeat_status    = serializers.SerializerMethodField()
    has_assessment   = serializers.SerializerMethodField()
    evidence_count   = serializers.IntegerField(source='evidence.count', read_only=True)

    # Date Paid / settlement date — lives on the separate Assessment record
    # (Assessment.date_paid), never on Violation.date_issued. Exposed here
    # (list serializer) so screens like Digital Tickets and Violation
    # Records don't have to fetch the full detail endpoint per row just to
    # tell Date Issued and Date Paid apart. None until Staff has actually
    # recorded a payment via ConfirmPaymentView.
    date_paid        = serializers.SerializerMethodField()
    or_number        = serializers.SerializerMethodField()

    def get_has_assessment(self, obj):
        return hasattr(obj, 'assessment')

    def get_enforcer_name(self, obj):
        return enforcer_identity(obj)['name']

    def get_enforcer_historical(self, obj):
        return enforcer_identity(obj)['historical']

    def get_assessed_by_name(self, obj):
        record = getattr(obj, 'assessment', None)
        return assessor_identity(record)['name'] if record else None

    def get_assessed_by_historical(self, obj):
        record = getattr(obj, 'assessment', None)
        return assessor_identity(record)['historical'] if record else False

    def get_date_paid(self, obj):
        record = getattr(obj, 'assessment', None)
        return record.date_paid if record else None

    def get_or_number(self, obj):
        record = getattr(obj, 'assessment', None)
        return record.or_number if record else None

    def get_violation_types(self, obj):
        return [
            {
                'id':   item.violation_type.id,
                'name': item.violation_type.name,
                'code': item.violation_type.code,
            }
            for item in _items_with_types(obj)
        ]

    def get_repeat_status(self, obj):
        """
        FIRST VIOLATION / REPEAT VIOLATOR — computed ONLY from the current
        active `Violation` table (never archive), matched by license_number
        (case-insensitive) AND the SAME calendar year as `obj.date_issued`,
        falling back to violator_name when no license number is on file.
        Year is part of the match key so a violator's 2024 ticket and 2026
        ticket never count toward each other just because both still sit in
        the active table (archiving is manual/on-demand, not automatic per
        year). The counts are precomputed once per request by the view (see
        ViolationListView.get_serializer_context / RelatedActiveViolationsView)
        and passed in via context — this stays dynamic (nothing stored on
        the model) and avoids N+1 queries.
        """
        by_license = self.context.get('repeat_counts_by_license') or {}
        by_name    = self.context.get('repeat_counts_by_name') or {}
        year = obj.date_issued.year if obj.date_issued else None
        if year is None:
            return None
        if obj.license_number and obj.license_number.strip():
            count = by_license.get((obj.license_number.strip().lower(), year))
        elif obj.violator_name and obj.violator_name.strip():
            count = by_name.get((obj.violator_name.strip().lower(), year))
        else:
            count = None
        if count is None:
            return None
        return 'REPEAT VIOLATOR' if count >= 2 else 'FIRST VIOLATION'

    class Meta:
        model = Violation
        fields = [
            'id', 'source', 'violator_name', 'license_number', 'plate_number',
            'vehicle_type', 'vehicle_use', 'location', 'latitude', 'longitude',
            'date_issued', 'date_paid', 'or_number', 'penalty_amount',
            'status', 'enforcer_name', 'enforcer_historical',
            'assessed_by_name', 'assessed_by_historical',
            'item_count', 'violation_types', 'created_at',
            'repeat_status', 'has_assessment', 'evidence_count',
        ]


# How far an enforcer-submitted `date_issued` may drift from the server clock.
# The Issue OVR form stamps the time from the phone, so a wrong phone clock
# (or a deliberately changed one) would otherwise be saved as-is.
#   - FUTURE: an OVR can't be issued later than "now"; a few minutes of
#     leeway covers ordinary clock differences between phone and server.
#   - PAST:   OVRs saved offline are uploaded later by Sync Data, so old
#     timestamps are legitimate — but not unlimited.
OVR_FUTURE_TOLERANCE = timedelta(minutes=5)
OVR_MAX_BACKDATE = timedelta(days=7)


class ViolationDetailSerializer(GpsCoordinateValidationMixin, serializers.ModelSerializer):
    """Full serializer for create / retrieve / update."""
    enforcer    = UserSerializer(read_only=True)
    assessed_by = UserSerializer(read_only=True)
    items       = ViolationItemSerializer(many=True, read_only=True)
    evidence    = ViolationEvidenceSerializer(many=True, read_only=True)

    # Read-only nested Staff Assessment record (separate model — see
    # Assessment docstring). None until Staff has started processing.
    assessment = serializers.SerializerMethodField()

    def get_assessment(self, obj):
        record = getattr(obj, 'assessment', None)
        if record is None:
            return None
        return AssessmentRecordSerializer(record).data

    locked_by_id   = serializers.SerializerMethodField()
    locked_by_name = serializers.SerializerMethodField()

    def get_locked_by_id(self, obj):
        return obj.locked_by_id

    def get_locked_by_name(self, obj):
        return obj.locked_by.full_name if obj.locked_by else None

    # Write-only: list of ViolationType IDs from the enforcer
    violation_type_ids = serializers.ListField(
        child=serializers.CharField(),
        write_only=True,
        required=False,
        allow_empty=False,
    )

    # Idempotency key from the offline queue (Requirement #10). Optional —
    # normal (non-offline) submissions never send this. Write-once: it is
    # set on create and never changed afterwards (see validate()).
    client_offline_id = serializers.CharField(
        required=False, allow_null=True, allow_blank=True, max_length=100,
    )

    def validate_image(self, value):
        return validate_image_size(value)

    class Meta:
        model = Violation
        fields = [
            'id', 'source',
            'violator_name', 'license_number', 'license_status',
            'confiscated_document_type', 'confiscated_document_name',
            'confiscated_document_number',
            'plate_number', 'registration_number',
            'vehicle_type', 'vehicle_brand', 'vehicle_model', 'vehicle_use',
            'address', 'location', 'latitude', 'longitude', 'date_issued',
            'remarks', 'ovr_number', 'penalty_amount', 'status',
            'enforcer', 'assessed_by', 'assessed_at', 'assessment_notes',
            'locked_by_id', 'locked_by_name',
            'image',
            'items', 'evidence', 'assessment',
            'violation_type_ids', 'client_offline_id',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'penalty_amount', 'enforcer', 'assessed_by',
            'assessed_at', 'created_at', 'updated_at',
            'locked_by_id', 'locked_by_name', 'evidence', 'assessment',
        ]

    def validate_violation_type_ids(self, value):
        try:
            int_ids = [int(v) for v in value]
        except (ValueError, TypeError):
            raise serializers.ValidationError("Invalid violation type ID format.")
        types = ViolationType.objects.filter(id__in=int_ids, is_active=True)
        if len(types) != len(set(int_ids)):
            raise serializers.ValidationError("One or more violation type IDs are invalid or inactive.")
        return int_ids

    def validate(self, attrs):
        """
        OVR Number is MANUAL and comes from City Hall — required for
        Enforcer-issued OVRs, but never required (and never fabricated)
        for a Staff walk-in complaint that has no physical OVR.
        """
        source = attrs.get('source', self.instance.source if self.instance else Violation.Source.ENFORCER_OVR)
        ovr_number = attrs.get('ovr_number', self.instance.ovr_number if self.instance else '')

        # `imported` provenance may ONLY be stamped by the Admin bulk-import
        # endpoint (which writes through the ORM directly). Without this
        # guard, a client could send source=imported through the normal
        # create/update API and skip the mandatory OVR number, or re-label
        # (or un-label) genuine records.
        current_source = self.instance.source if self.instance else None
        if 'source' in attrs and attrs['source'] != current_source and (
            attrs['source'] == Violation.Source.IMPORTED
            or current_source == Violation.Source.IMPORTED
        ):
            raise serializers.ValidationError({
                'source': 'The "imported" source is set only by the Excel bulk import and cannot be changed here.'
            })
        if source == Violation.Source.ENFORCER_OVR and not (ovr_number or '').strip():
            raise serializers.ValidationError({
                'ovr_number': 'OVR Number is required and must be entered manually (from the City Hall booklet).'
            })

        self._check_status_transition(attrs)
        self._check_confiscation(attrs)
        self._check_enforcer_date_issued(attrs)

        # Normalize '' -> None so the unique constraint on client_offline_id
        # never collides across ordinary (non-offline) submissions.
        if attrs.get('client_offline_id') == '':
            attrs['client_offline_id'] = None

        return attrs

    def _check_status_transition(self, attrs):
        """`paid` can ONLY be reached through ConfirmPaymentView. No create
        or update through this serializer may set it, and a record that is
        already paid can never be moved back."""
        if 'status' not in attrs:
            return
        new_status = attrs['status']
        if new_status == Violation.Status.PAID:
            raise serializers.ValidationError({
                'status': 'A violation can only become Paid through Confirm Payment.'
            })
        if self.instance is not None and self.instance.status == Violation.Status.PAID \
                and new_status != self.instance.status:
            raise serializers.ValidationError({
                'status': 'A paid violation cannot be moved back to another status.'
            })
        request = self.context.get('request')
        if self.instance is None and request is not None \
                and getattr(request.user, 'role', None) == 'enforcer':
            attrs['status'] = Violation.Status.PENDING

    def _check_confiscation(self, attrs):
        """
        Backend enforcement of the Step 1 confiscation rules (never only a
        UI show/hide):
          NOT CONFISCATED -> every confiscation-detail field is cleared, so
                             no stale document data stays authoritative.
          CONFISCATED     -> document type required; Others needs a custom
                             name; the relevant number is required
                             (Driver's License -> license_number, every
                             other type -> confiscated_document_number).
        Strict checks apply to Staff/Admin (who do the assessment). The
        Enforcer's Issue-OVR wizard has no document fields, so an Enforcer's
        confiscated record is accepted as-is and Staff completes the
        details during assessment. Historical records are only re-validated
        when a confiscation-related field is part of the request.
        """
        inst = self.instance
        touched = any(k in attrs for k in (
            'license_status', 'confiscated_document_type',
            'confiscated_document_name', 'confiscated_document_number',
        )) or (inst is None)
        if not touched:
            return

        def cur(field, default=''):
            if field in attrs:
                return attrs[field]
            return getattr(inst, field, default) if inst is not None else default

        status_value = cur('license_status', 'not_confiscated') or 'not_confiscated'

        if status_value != 'confiscated':
            attrs['confiscated_document_type'] = ''
            attrs['confiscated_document_name'] = ''
            attrs['confiscated_document_number'] = ''
            return

        request = self.context.get('request')
        if request is not None and getattr(request.user, 'role', None) == 'enforcer':
            return

        doc_type = (cur('confiscated_document_type') or '').strip()
        errors = {}
        if not doc_type:
            errors['confiscated_document_type'] = 'Select the confiscated document type.'
        else:
            if doc_type == Violation.ConfiscatedDocument.OTHERS:
                if not (cur('confiscated_document_name') or '').strip():
                    errors['confiscated_document_name'] = 'Enter the document name for "Others".'
            else:
                attrs['confiscated_document_name'] = ''
            if doc_type == Violation.ConfiscatedDocument.DRIVERS_LICENSE:
                if not (cur('license_number') or '').strip():
                    errors['license_number'] = "Enter the Driver's License number."
                # One authoritative number: the license number. Never keep a
                # second, possibly conflicting, document number.
                attrs['confiscated_document_number'] = ''
            elif not (cur('confiscated_document_number') or '').strip():
                errors['confiscated_document_number'] = 'Enter the Document / Reference Number.'
        if errors:
            raise serializers.ValidationError(errors)

    def _check_enforcer_date_issued(self, attrs):
        """
        Enforcers only, and only when creating: `date_issued` must be a
        believable moment — not in the future, not more than
        OVR_MAX_BACKDATE old. Staff/Admin encode records after the fact
        (walk-ins, corrections), so they are not limited here.
        """
        request = self.context.get('request')
        if self.instance is not None or request is None:
            return
        if getattr(request.user, 'role', None) != 'enforcer':
            return
        issued = attrs.get('date_issued')
        if issued is None:
            return

        now = timezone.now()
        if issued > now + OVR_FUTURE_TOLERANCE:
            raise serializers.ValidationError({
                'date_issued': "The date and time on this device is ahead of the server. "
                               "Set your phone's date and time to automatic, then submit again."
            })
        if issued < now - OVR_MAX_BACKDATE:
            raise serializers.ValidationError({
                'date_issued': f"This OVR is more than {OVR_MAX_BACKDATE.days} days old and can't be "
                               "submitted from the enforcer app. Please contact your supervisor."
            })

    def create(self, validated_data):
        type_ids = validated_data.pop('violation_type_ids', [])
        if not type_ids:
            raise serializers.ValidationError({'violation_type_ids': 'At least one violation type is required.'})
        # Each violation type applies to one vehicle category. Types with no
        # category assigned yet are accepted for every vehicle type.
        _check_types_match_vehicle(
            list(ViolationType.objects.filter(id__in=type_ids)),
            validated_data.get('vehicle_type'),
        )
        # enforcer is injected by ViolationCreateView.perform_create via serializer.save(enforcer=request.user)
        violation = Violation.objects.create(**validated_data)

        for type_id in type_ids:
            vtype = ViolationType.objects.get(id=type_id)
            ViolationItem.objects.create(
                violation=violation,
                violation_type=vtype,
                penalty_amount_snapshot=vtype.penalty_amount,
            )

        violation.compute_total()
        return violation

    def update(self, instance, validated_data):
        # D3 lock (Checkpoint 3): the confiscation fields are frozen once the
        # ticket is paid or a custody record exists. The violation row is locked
        # for the whole update so a concurrent custody action cannot slip in.
        with transaction.atomic():
            locked = Violation.objects.select_for_update().get(pk=instance.pk)
            changed = confiscation_changes(
                {f: getattr(locked, f) for f in CONFISCATION_FIELDS}, validated_data)
            if changed and confiscation_is_locked(locked.pk, locked.status):
                raise ConfiscationLockedAPIError()
            return self._update_unlocked(instance, validated_data)

    def _update_unlocked(self, instance, validated_data):
        # client_offline_id is write-once (set at creation only) — never let
        # a later PATCH change or clear an existing record's idempotency key.
        validated_data.pop('client_offline_id', None)
        type_ids = validated_data.pop('violation_type_ids', None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        if type_ids is not None:
            # Only NEWLY added violation types are checked against the vehicle
            # type, so editing an old record that already holds a violation
            # which no longer matches is not blocked. The whole update runs
            # inside transaction.atomic(), so a rejection rolls everything back.
            current = set(instance.items.values_list('violation_type_id', flat=True))
            _check_types_match_vehicle(
                list(ViolationType.objects.filter(id__in=[t for t in type_ids if t not in current])),
                instance.vehicle_type,
            )

            # Respect penalty snapshots: items for a type that stays selected
            # keep their ORIGINAL snapshot; only newly added types take the
            # current price, and removed types are dropped. (Previously every
            # item was deleted and re-priced at today's ViolationType price.)
            wanted = set(type_ids)
            instance.items.exclude(violation_type_id__in=wanted).delete()
            have = set(instance.items.values_list('violation_type_id', flat=True))
            for type_id in type_ids:
                if type_id in have:
                    continue
                vtype = ViolationType.objects.get(id=type_id)
                ViolationItem.objects.create(
                    violation=instance,
                    violation_type=vtype,
                    penalty_amount_snapshot=vtype.penalty_amount,
                )
                have.add(type_id)
            if instance.source != Violation.Source.IMPORTED:
                instance.compute_total()

        return instance


class AssessmentSerializer(serializers.ModelSerializer):
    """Staff use — move a violation between pending/processing and save
    notes. It can NEVER set `paid` (only ConfirmPaymentView can) and it
    never accepts a client-supplied penalty: the amount is derived from the
    violation's stored item snapshots."""
    status = serializers.ChoiceField(
        choices=[Violation.Status.PENDING, Violation.Status.PROCESSING],
        required=False,
    )

    class Meta:
        model = Violation
        fields = ['status', 'assessment_notes', 'penalty_amount']
        read_only_fields = ['penalty_amount']

    def update(self, instance, validated_data):
        instance.status           = validated_data.get('status', instance.status)
        instance.assessment_notes = validated_data.get('assessment_notes', instance.assessment_notes)
        # Imported records have no authoritative item snapshots — their
        # ticket-level penalty_amount is authoritative and is left alone.
        if instance.source != Violation.Source.IMPORTED:
            instance.compute_total()
        # The authenticated user performing this PATCH IS the assessor
        # (Role Evolution, Phase 2): record_assessor sets Violation +
        # Assessment assessed_by/assessed_at and the assessor_* identity
        # snapshot in one transaction, from request.user only.
        record_assessor(instance, self.context['request'].user)
        return instance

# ─── Public (unauthenticated) ────────────────────────────────────────────────

class PublicViolationSerializer(serializers.ModelSerializer):
    """
    Privacy-conscious serializer for the public landing page.

    Deliberately excludes everything identifying the violator, the vehicle,
    the enforcer, exact GPS, or the location/area of the violation: no
    violator_name, license_number, plate_number, address, location,
    latitude/longitude, remarks, assessment_notes, image, enforcer, status,
    and no internal ids or timestamps (id, date_issued, updated_at), so the
    public feed cannot be used to enumerate records or infer when a ticket
    was issued. The public cards show the violation type(s) and fine only.

    Fine/penalty: sourced from ViolationItem.penalty_amount_snapshot, NOT
    Violation.penalty_amount. penalty_amount_snapshot is the official
    ViolationType.penalty_amount as it stood when this ticket was written —
    a per-violation-type prescribed fine. Violation.penalty_amount, by
    contrast, is a case-specific total that staff can override during
    assessment, so it is never safe to expose publicly as "the" fine.
    """
    violation_types = serializers.SerializerMethodField()

    def get_violation_types(self, obj):
        return [
            {
                'name': item.violation_type.name,
                'category': item.violation_type.category,
                'description': item.violation_type.description,
                'fine': float(item.penalty_amount_snapshot),
            }
            for item in _items_with_types(obj)
        ]

    class Meta:
        model = Violation
        fields = ['violation_types']
        read_only_fields = fields