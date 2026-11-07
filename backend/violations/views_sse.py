import json
import time
import threading
from django.http import StreamingHttpResponse, HttpResponse
from django.views import View
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from rest_framework_simplejwt.authentication import JWTAuthentication
from accounts.authentication import TMEOJWTAuthentication, account_still_matches
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from django.contrib.auth import get_user_model

User = get_user_model()

# ── In-memory subscriber registry ─────────────────────────────────────────────
_lock = threading.Lock()
_subscribers: dict = {}


def _subscribe(client_id: str) -> dict:
    sub = {'queue': [], 'event': threading.Event()}
    with _lock:
        _subscribers[client_id] = sub
    return sub


def _unsubscribe(client_id: str):
    with _lock:
        _subscribers.pop(client_id, None)


def broadcast_lock_event(violation_id: int, status: str, locked_by_id, locked_by_name):
    """
    Call this from views.py whenever a violation lock/status changes.
    Wakes all connected SSE clients immediately.
    """
    payload = json.dumps({
        'type': 'lock_update',
        'violation_id': violation_id,
        'status': status,
        'locked_by_id': locked_by_id,
        'locked_by_name': locked_by_name,
    })
    msg = f"data: {payload}\n\n"
    with _lock:
        subs = list(_subscribers.values())
    for sub in subs:
        sub['queue'].append(msg)
        sub['event'].set()


# ── SSE View — plain Django View, NOT DRF APIView ─────────────────────────────
@method_decorator(csrf_exempt, name='dispatch')
class ViolationSSEView(View):
    """
    GET /api/violations/sse/?token=<access_token>

    Uses a plain Django View (not DRF APIView) to avoid DRF's content
    negotiation which returns 406 for text/event-stream responses.
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

        if user.role not in ('staff', 'admin'):
            return HttpResponse('Forbidden', status=403)

        connect_role, connect_id_number = user.role, user.id_number
        client_id = f"{user.id}-{time.time()}"
        sub = _subscribe(client_id)
        queue = sub['queue']
        event = sub['event']

        def event_stream():
            try:
                # Handshake — confirms connection to frontend
                yield f"data: {json.dumps({'type': 'connected', 'user_id': user.id})}\n\n"
                while True:
                    # Wait up to 20s; wakes immediately when broadcast fires
                    triggered = event.wait(timeout=20)
                    event.clear()

                    # Phase 5: end the stream once the account's role/ID changed.
                    if not account_still_matches(user.id, connect_role, connect_id_number):
                        return

                    if queue:
                        while queue:
                            yield queue.pop(0)
                    elif not triggered:
                        # Heartbeat to keep connection alive
                        yield ": heartbeat\n\n"
            except GeneratorExit:
                pass
            finally:
                _unsubscribe(client_id)

        response = StreamingHttpResponse(
            event_stream(),
            content_type='text/event-stream',
        )
        response['Cache-Control'] = 'no-cache'
        response['X-Accel-Buffering'] = 'no'
        # Cross-origin handled by CorsMiddleware (CORS_ALLOWED_ORIGINS in settings) —
        # no manual override needed, and '*' here would bypass the allowlist.
        return response