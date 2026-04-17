from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework.pagination import PageNumberPagination
from accounts.permissions import IsAdmin
from .models import AuditLog


class AuditLogPagination(PageNumberPagination):
    page_size            = 20
    page_size_query_param = 'page_size'
    max_page_size        = 100


class AuditLogListView(APIView):
    permission_classes = [IsAdmin]

    def get(self, request):
        logs = AuditLog.objects.select_related('user').all()

        # Filters
        action     = request.query_params.get('action')
        module     = request.query_params.get('module')
        user_id    = request.query_params.get('user_id')
        date_from  = request.query_params.get('date_from')   # e.g. 2026-04-01
        date_to    = request.query_params.get('date_to')     # e.g. 2026-04-30

        if action:
            logs = logs.filter(action=action)
        if module:
            logs = logs.filter(module__icontains=module)
        if user_id:
            logs = logs.filter(user__id=user_id)
        if date_from:
            logs = logs.filter(timestamp__date__gte=date_from)
        if date_to:
            logs = logs.filter(timestamp__date__lte=date_to)

        # Paginate
        paginator = AuditLogPagination()
        page      = paginator.paginate_queryset(logs, request)

        data = [
            {
                'id':          log.id,
                'user_email':  log.user.email      if log.user else 'System',
                'user_name':   log.user.full_name  if log.user else 'System',
                'action':      log.action,
                'module':      log.module,
                'description': log.description,
                'ip_address':  log.ip_address,
                'timestamp':   log.timestamp,
            }
            for log in page
        ]

        return paginator.get_paginated_response(data)