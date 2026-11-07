from django.urls import path
from .views import AuditLogListView, AuditLogFilterOptionsView

urlpatterns = [
    path('logs/', AuditLogListView.as_view(), name='audit-logs'),
    path('filter-options/', AuditLogFilterOptionsView.as_view(), name='audit-filter-options'),
]