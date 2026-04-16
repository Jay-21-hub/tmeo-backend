from django.contrib import admin
from .models import AuditLog

@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display  = ['user', 'action', 'module', 'description', 'ip_address', 'timestamp']
    list_filter   = ['action', 'module']
    search_fields = ['user__email', 'description']
    readonly_fields = ['user', 'action', 'module', 'description', 'ip_address', 'timestamp']