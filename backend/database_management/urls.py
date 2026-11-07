from django.urls import path
from . import views

urlpatterns = [
    # Database Management
    path('export/fields/', views.ExportableFieldsView.as_view(), name='db-export-fields'),
    path('export/full/',   views.FullDatabaseExportView.as_view(), name='db-export-full'),
    path('export/full/pdf-data/', views.FullDatabasePdfDataView.as_view(), name='db-export-full-pdf-data'),

    # Archive Management
    path('archive/overview/', views.ArchiveOverviewView.as_view(), name='archive-overview'),
    path('archive/execute/',  views.ArchiveExecuteView.as_view(), name='archive-execute'),
    path('archive/years/',    views.ArchiveYearsView.as_view(), name='archive-years'),
    path('archive/months/',   views.ArchiveMonthsView.as_view(), name='archive-months'),
    path('archive/records/',  views.ArchiveRecordsView.as_view(), name='archive-records'),
    path('archive/records/<int:pk>/', views.ArchivedViolationDeleteView.as_view(), name='archive-record-delete'),
    path('archive/batches/',  views.ArchiveBatchListView.as_view(), name='archive-batches'),
    path('archive/export/fields/', views.ArchivedExportFieldsView.as_view(), name='archive-export-fields'),
    path('archive/export/',        views.ArchivedExportView.as_view(),       name='archive-export'),
    path('archive/export/pdf-data/', views.ArchivedExportPdfDataView.as_view(), name='archive-export-pdf-data'),
]