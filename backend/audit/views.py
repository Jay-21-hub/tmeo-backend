from django.db.models import Q
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.pagination import PageNumberPagination

from accounts.permissions import IsAdmin
from accounts.models import CustomUser
from .models import AuditLog
from .serializers import AuditLogSerializer


class AuditLogPagination(PageNumberPagination):
    page_size             = 20
    page_size_query_param = 'page_size'
    max_page_size         = 100


class AuditLogListView(APIView):
    permission_classes = [IsAdmin]

    def get(self, request):
        logs = AuditLog.objects.select_related('user').all()

        action    = request.query_params.get('action')
        module    = request.query_params.get('module')
        status    = request.query_params.get('status')
        user_id   = request.query_params.get('user_id')
        search    = request.query_params.get('search')
        date_from = request.query_params.get('date_from')
        date_to   = request.query_params.get('date_to')

        if action:
            logs = logs.filter(action=action)
        if module:
            logs = logs.filter(module__icontains=module)
        if status:
            logs = logs.filter(status=status)
        if user_id:
            logs = logs.filter(user__id=user_id)
        if search:
            # Broadened: actor name/email, description, module, target,
            # IP address — not just description like before.
            logs = logs.filter(
                Q(description__icontains=search)   |
                Q(actor_name_snapshot__icontains=search) |
                Q(user__full_name__icontains=search) |
                Q(user__email__icontains=search)     |
                Q(module__icontains=search)          |
                Q(target_type__icontains=search)     |
                Q(target_id__icontains=search)       |
                Q(ip_address__icontains=search)
            )
        if date_from:
            logs = logs.filter(timestamp__date__gte=date_from)
        if date_to:
            logs = logs.filter(timestamp__date__lte=date_to)

        # Stats
        today = timezone.now().date()
        total_logs    = AuditLog.objects.count()
        today_events  = AuditLog.objects.filter(timestamp__date=today).count()
        failed_count  = AuditLog.objects.filter(status='FAILED').count()
        active_users  = AuditLog.objects.filter(
            timestamp__date=today
        ).values('user').distinct().count()

        paginator = AuditLogPagination()
        page      = paginator.paginate_queryset(logs, request)
        serializer = AuditLogSerializer(page, many=True)

        response = paginator.get_paginated_response(serializer.data)
        response.data['stats'] = {
            'total_logs':   total_logs,
            'today_events': today_events,
            'failed_count': failed_count,
            'active_users': active_users,
        }
        return response


class AuditLogFilterOptionsView(APIView):
    """GET /api/audit/filter-options/ — distinct values to populate the
    Action / Module / Status / User dropdowns on the Audit Trail page,
    so the frontend doesn't have to hardcode them or scan every row."""
    permission_classes = [IsAdmin]

    def get(self, request):
        modules = list(
            AuditLog.objects.exclude(module='')
                            .order_by('module')
                            .values_list('module', flat=True)
                            .distinct()
        )
        users = list(
            CustomUser.objects.filter(auditlog__isnull=False)
                              .order_by('full_name')
                              .values('id', 'full_name', 'email')
                              .distinct()
        )
        return Response({
            'actions': [{'value': v, 'label': l} for v, l in AuditLog.ACTION_CHOICES],
            'statuses': [{'value': v, 'label': l} for v, l in AuditLog.STATUS_CHOICES],
            'modules': modules,
            'users': users,
        })