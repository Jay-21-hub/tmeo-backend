from django.urls import path
from .views import NotificationListView, NotificationMarkReadView
from .views_sse import NotificationSSEView

urlpatterns = [
    path('',               NotificationListView.as_view(),      name='notifications'),
    path('sse/',           NotificationSSEView.as_view(),        name='notifications-sse'),
    path('read/',          NotificationMarkReadView.as_view(),   name='notif-mark-all-read'),
    path('<int:pk>/read/', NotificationMarkReadView.as_view(),   name='notif-mark-read'),
]