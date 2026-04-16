from django.urls import path
from . import views

urlpatterns = [
    path('',                 views.EnforcerListView.as_view(),   name='enforcer_list'),
    path('live-locations/',  views.LiveLocationsView.as_view(),  name='live_locations'),
    path('update-location/', views.UpdateLocationView.as_view(), name='update_location'),
    path('deploy/', views.DeployEnforcerView.as_view(), name='deploy-enforcer'),
]