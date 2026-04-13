from django.contrib import admin
from .models import EnforcerLocation

@admin.register(EnforcerLocation)
class EnforcerLocationAdmin(admin.ModelAdmin):
    list_display  = ['enforcer', 'latitude', 'longitude', 'status', 'updated_at']
    list_filter   = ['status']