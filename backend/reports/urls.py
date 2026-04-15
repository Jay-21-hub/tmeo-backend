from django.urls import path
from . import views

urlpatterns = [
    path('dashboard-stats/',  views.DashboardStatsView.as_view(),   name='dashboard_stats'),
    path('violation-by-type/', views.ViolationByTypeView.as_view(), name='violation_by_type'),
    path('trends/',           views.ViolationTrendsView.as_view(),  name='trends'),
    path('hotspots/',         views.ViolationHotspotsView.as_view(), name='hotspots'),
    path('top-enforcers/',    views.TopEnforcersView.as_view(),     name='top_enforcers'),
    path('collection/',       views.CollectionSummaryView.as_view(), name='collection'),
    path('generate/',         views.GenerateReportView.as_view(),   name='generate_report'),
    path('export/pdf/', views.ExportViolationsPDFView.as_view(), name='export-pdf'),
    path('export/excel/', views.ExportViolationsExcelView.as_view(), name='export-excel'),
]