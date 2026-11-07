from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from .models import Notification
from .serializers import NotificationSerializer
from .visibility import visible_to


class NotificationListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        # recipient_role is the sole visibility gate for notifications.
        # related_user is stored purely for audit/reference (e.g. which
        # enforcer triggered a New Violation notification) and must never
        # be used to restrict which Staff/Admin users can see it — every
        # Staff/Admin user shares the same 'staff'/'admin' recipient_role
        # inbox regardless of who related_user points to.
        # Personal rows (recipient_user set) are the one exception: they are
        # visible only to that account. See notifications.visibility.
        notifs = Notification.objects.filter(
            visible_to(request.user.pk, request.user.role)
        ).order_by('-created_at')

        data   = notifs[:20]
        unread = notifs.filter(is_read=False).count()  
        return Response({
            'notifications': NotificationSerializer(data, many=True).data,
            'unread_count':  unread
        })


class NotificationMarkReadView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk=None):
        visible = visible_to(request.user.pk, request.user.role)
        if pk:
            Notification.objects.filter(visible, id=pk).update(is_read=True)
        else:
            # Mark all as read: role broadcasts (shared state, as before) plus
            # this account's own personal rows - never another user's.
            Notification.objects.filter(visible, is_read=False).update(is_read=True)
        return Response({'status': 'ok'})