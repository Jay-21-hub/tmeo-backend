from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from accounts.permissions import IsAdmin
from .models import AuditLog


class AuditLogListView(APIView):
    permission_classes = [IsAdmin]

    def get(self, request):
        logs = AuditLog.objects.select_related('user').all()

        # Optional filters
        action   = request.query_params.get('action')
        module   = request.query_params.get('module')
        user_id  = request.query_params.get('user_id')

        if action:
            logs = logs.filter(action=action)
        if module:
            logs = logs.filter(module__icontains=module)
        if user_id:
            logs = logs.filter(user__id=user_id)

        data = [
            {
                'id':          log.id,
                'user':        log.user.email if log.user else 'System',
                'action':      log.action,
                'module':      log.module,
                'description': log.description,
                'ip_address':  log.ip_address,
                'timestamp':   log.timestamp,
            }
            for log in logs
        ]
        return Response(data)