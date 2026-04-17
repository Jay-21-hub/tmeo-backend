from django.urls import path
from . import views

urlpatterns = [
    # Enforcer management
    path('',                 views.EnforcerListView.as_view(),   name='enforcer_list'),
    path('deploy/',          views.DeployEnforcerView.as_view(), name='deploy_enforcer'),

    # GPS Location
    path('live-locations/',  views.LiveLocationsView.as_view(),  name='live_locations'),
    path('update-location/', views.UpdateLocationView.as_view(), name='update_location'),

    # Schedule — Admin
    path('schedules/',       views.ScheduleListView.as_view(),   name='schedule_list'),
    path('schedules/<int:pk>/', views.ScheduleDetailView.as_view(), name='schedule_detail'),

    # Schedule — Enforcer (own schedule)
    path('my-schedule/',     views.MyScheduleView.as_view(),     name='my_schedule'),
]