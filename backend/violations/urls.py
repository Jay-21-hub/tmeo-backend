from django.urls import path, include
from rest_framework.routers import DefaultRouter
from . import views

router = DefaultRouter()
router.register('records', views.ViolationViewSet,     basename='violations')
router.register('types',   views.ViolationTypeViewSet, basename='violation-types')
router.register('tickets', views.DigitalTicketViewSet, basename='tickets')

urlpatterns = [
    path('', include(router.urls)),
    path('scan-license/', views.OCRScanView.as_view(), name='scan-license'),
]