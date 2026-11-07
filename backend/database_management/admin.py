from django.contrib import admin
from .models import ArchiveBatch, ArchivedViolation


@admin.register(ArchiveBatch)
class ArchiveBatchAdmin(admin.ModelAdmin):
    list_display = ('id', 'created_by', 'created_at', 'status', 'active_count_before', 'archived_count', 'skipped_in_progress_count')
    list_filter = ('status',)
    readonly_fields = [f.name for f in ArchiveBatch._meta.fields]


@admin.register(ArchivedViolation)
class ArchivedViolationAdmin(admin.ModelAdmin):
    list_display = ('id', 'original_violation_id', 'violation_year', 'settlement_status', 'violator_name', 'batch')
    list_filter = ('violation_year', 'settlement_status')
    search_fields = ('violator_name', 'license_number', 'plate_number', 'original_violation_id')
    readonly_fields = [f.name for f in ArchivedViolation._meta.fields]