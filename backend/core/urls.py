from django.contrib import admin
from django.urls import path, include
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from django.conf import settings
from django.conf.urls.static import static
from core.health import liveness, readiness

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/health/', liveness, name='health-liveness'),
    path('api/ready/', readiness, name='health-readiness'),
    path('api/schema/', SpectacularAPIView.as_view(), name='schema'),
    path('api/docs/', SpectacularSwaggerView.as_view(url_name='schema'), name='swagger-ui'),
] + [
    path('api/auth/',       include('accounts.urls')),
    path('api/violations/', include('violations.urls')),
    path('api/enforcers/',  include('enforcers.urls')),
    path('api/reports/',    include('reports.urls')),
    path('api/audit/',      include('audit.urls')),
    path('api/notifications/', include('notifications.urls')),
    path('api/database/', include('database_management.urls')),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)