from django.contrib import admin
from .models import ViolationType, Violation, DigitalTicket

@admin.register(ViolationType)
class ViolationTypeAdmin(admin.ModelAdmin):
    list_display  = ['code', 'name', 'category', 'penalty_amount', 'is_active']
    list_filter   = ['category', 'is_active']
    search_fields = ['code', 'name']

@admin.register(Violation)
class ViolationAdmin(admin.ModelAdmin):
    list_display  = ['violation_id', 'violator_name', 'plate_number', 'violation_type', 'status', 'created_at']
    list_filter   = ['status', 'vehicle_type']
    search_fields = ['violation_id', 'violator_name', 'plate_number']

@admin.register(DigitalTicket)
class DigitalTicketAdmin(admin.ModelAdmin):
    list_display  = ['ticket_number', 'violation', 'generated_at', 'is_printed']
    search_fields = ['ticket_number']