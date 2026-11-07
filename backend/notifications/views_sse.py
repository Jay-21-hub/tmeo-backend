import json
import time
from django.http import StreamingHttpResponse, HttpResponse
from django.views import View
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from rest_framework_simplejwt.authentication import JWTAuthentication
from accounts.authentication import TMEOJWTAuthentication, account_still_matches
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError


def _initial_last_id(role, user_id=None):
    """Where an SSE connection starts counting 'new' notifications from.

    Must be the CURRENT latest id for this role, full stop. The REST
    fetch the frontend does on mount (NotificationListView) already
    returns every notification that exists at connect time, so SSE's
    only job afterward is to push ones created *after* that snapshot.

    This used to instead rewind to (oldest unread id - 1) "to not miss
    it" — but the frontend's initial fetch had *already* delivered that
    same unread notification, so the very first SSE poll re-pushed it a
    second time and useNotifications.js's onmessage handler prepends
    without de-duplicating by id, producing a visible duplicate for any
    notification that was unread at connect time (most visibly: the one
    from a Mark-as-Paid action moments earlier, since it's still unread).
    Starting from the true latest id trades that guaranteed duplicate for
    a sub-second race window (a notification created in the instant
    between the REST fetch and this connect could be missed) — the
    caller already has a 15s poll fallback and a full refetch on next
    mount for that edge case.
    """
    from notifications.models import Notification
    from notifications.visibility import visible_to
    # user_id=None keeps the legacy role-only scope (broadcast rows only).
    scope = visible_to(user_id, role)
    return (
        Notification.objects
        .filter(scope)
        .order_by('-id')
        .values_list('id', flat=True)
        .first()
    ) or 0


@method_decorator(csrf_exempt, name='dispatch')
class NotificationSSEView(View):
    """
    GET /api/notifications/sse/?token=<access_token>

    Polls the DB every 4 seconds for new notifications and pushes them
    to the connected client via SSE. Works across multiple processes/workers
    without requiring Redis or Django Channels.
    """

    def get(self, request):
        raw_token = request.GET.get('token', '')
        if not raw_token:
            return HttpResponse('Unauthorized', status=401)

        try:
            validated = JWTAuthentication().get_validated_token(raw_token)
            user = TMEOJWTAuthentication().get_user(validated)
        except (InvalidToken, TokenError, AuthenticationFailed):
            return HttpResponse('Unauthorized', status=401)

        if not user or not user.is_authenticated:
            return HttpResponse('Unauthorized', status=401)

        role = getattr(user, 'role', None)
        if role not in ('admin', 'staff', 'enforcer'):
            return HttpResponse('Forbidden', status=403)
        connect_id_number = user.id_number

        def event_stream():
            from notifications.models import Notification
            from notifications.visibility import visible_to

            # Send connected handshake
            yield f"data: {json.dumps({'type': 'connected', 'user_id': user.id, 'role': role})}\n\n"

            try:
                last_id = _initial_last_id(role, user.id)
            except Exception:
                last_id = 0

            poll_interval = 4  # seconds
            heartbeat_every = 5  # send heartbeat every N polls

            poll_count = 0
            while True:
                time.sleep(poll_interval)
                poll_count += 1

                # Phase 5: a role/ID change (or deactivation) ends this stream so it
                # cannot keep delivering the previous role's notifications.
                if not account_still_matches(user.id, role, connect_id_number):
                    return

                try:
                    new_notifs = (
                        Notification.objects
                        .filter(visible_to(user.id, role), id__gt=last_id)
                        .order_by('id')
                        .values('id', 'title', 'message', 'notif_type', 'related_violation_id')[:10]
                    )

                    for notif in new_notifs:
                        payload = json.dumps({
                            'type':         'new_notification',
                            'id':           notif['id'],
                            'notif_type':   notif['notif_type'],
                            'title':        notif['title'],
                            'message':      notif['message'],
                            'violation_id': notif['related_violation_id'],
                            'timestamp':    time.time(),
                        })
                        yield f"data: {payload}\n\n"
                        last_id = notif['id']

                except Exception:
                    pass

                # Heartbeat to keep connection alive
                if poll_count % heartbeat_every == 0:
                    yield ": heartbeat\n\n"

        response = StreamingHttpResponse(
            event_stream(),
            content_type='text/event-stream',
        )
        response['Cache-Control'] = 'no-cache'
        response['X-Accel-Buffering'] = 'no'
        return response


def broadcast_notification(role, title, message, notif_type, violation_id=None):
    """
    No-op stub — kept for import compatibility with violations/views.py.
    Actual delivery is handled by SSE polling the DB directly.
    Notifications are created in the DB by perform_create() — SSE picks them up automatically.
    """
    pass