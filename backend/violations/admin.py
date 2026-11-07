from django.contrib import admin
from .models import (
    ViolationType, Violation, ViolationItem, VehicleBrandModel,
    Assessment, ViolationEvidence, LicenseCustody, LicenseCustodyEvent,
)
from .custody_models import CONFISCATION_FIELDS

@admin.register(ViolationType)
class ViolationTypeAdmin(admin.ModelAdmin):
    list_display  = ['code', 'name', 'category', 'penalty_amount', 'is_active']
    list_filter   = ['category', 'is_active']
    search_fields = ['code', 'name']

@admin.register(VehicleBrandModel)
class VehicleBrandModelAdmin(admin.ModelAdmin):
    list_display  = ['brand', 'model', 'category', 'is_active']
    list_filter   = ['category', 'is_active']
    search_fields = ['brand', 'model']

@admin.register(Violation)
class ViolationAdmin(admin.ModelAdmin):
    list_display  = ['id', 'ovr_number', 'source', 'violator_name', 'plate_number', 'penalty_amount', 'status', 'created_at']
    list_filter   = ['status', 'source']
    search_fields = ['violator_name', 'plate_number', 'license_number', 'ovr_number']

    def get_readonly_fields(self, request, obj=None):
        # D3 lock: confiscation fields become read-only once the ticket is
        # paid or a custody record exists (the model pre_save backstop also
        # rejects any ORM save that would change them).
        ro = list(super().get_readonly_fields(request, obj))
        if obj is not None and obj.pk and (
            obj.status == Violation.Status.PAID or LicenseCustody.objects.filter(violation=obj).exists()
        ):
            ro += [f for f in CONFISCATION_FIELDS if f not in ro]
        return ro

@admin.register(ViolationItem)
class ViolationItemAdmin(admin.ModelAdmin):
    list_display  = ['id', 'violation', 'violation_type']
    search_fields = ['violation__violator_name', 'violation_type__code']

@admin.register(Assessment)
class AssessmentAdmin(admin.ModelAdmin):
    list_display  = ['id', 'violation', 'or_number', 'amount_paid', 'received_by', 'date_paid', 'assessed_by']
    list_filter   = ['date_paid']
    search_fields = ['violation__violator_name', 'or_number', 'received_by']

@admin.register(ViolationEvidence)
class ViolationEvidenceAdmin(admin.ModelAdmin):
    list_display  = ['id', 'violation', 'captured_by', 'captured_at', 'server_received_at']
    list_filter   = ['captured_at']
    search_fields = ['violation__violator_name']


class _ReadOnlyAdmin(admin.ModelAdmin):
    """Custody ledger models: view only - no add, change or delete."""
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(LicenseCustody)
class LicenseCustodyAdmin(_ReadOnlyAdmin):
    list_display = ['id', 'original_violation_id', 'status', 'doc_type_status', 'version', 'released_at']
    list_filter = ['status', 'doc_type_status']


@admin.register(LicenseCustodyEvent)
class LicenseCustodyEventAdmin(_ReadOnlyAdmin):
    list_display = ['id', 'custody', 'event_type', 'actor_name_snapshot', 'created_at']
    list_filter = ['event_type']