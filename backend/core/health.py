"""
Health checks for Render (and any uptime monitor).

  GET /healthz      LIVENESS for the platform. Answered by middleware BEFORE host
                    validation, HTTPS redirect, CORS, sessions and the database, so a
                    probe (plain HTTP, internal Host header) can never be rejected for
                    the wrong reason and a database blip never restarts the web
                    service. Use this as the Render "Health Check Path".
  GET /api/health/  LIVENESS (application level). Goes through the normal Django stack
                    (host validation, HTTPS) but never touches the database.
                    200 {"status":"ok"}.
  GET /api/ready/   READINESS. Runs a read-only `SELECT 1` on the configured database.
                    200 {"status":"ok"} or 503 {"status":"degraded"}; no internal
                    detail is returned (errors are logged server-side only).
                    For uptime monitors / manual checks, not for Render restarts.

All three: no authentication, GET/HEAD only, no secrets, no database writes.
"""
import logging

from django.db import connection
from django.http import HttpResponse, JsonResponse

logger = logging.getLogger(__name__)

LIVENESS_PATH = '/healthz'


class HealthCheckMiddleware:
    """Must be FIRST in MIDDLEWARE."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path == LIVENESS_PATH and request.method in ('GET', 'HEAD'):
            return HttpResponse('ok', content_type='text/plain')
        return self.get_response(request)


def liveness(request):
    return JsonResponse({'status': 'ok'})


def readiness(request):
    try:
        with connection.cursor() as cursor:
            cursor.execute('SELECT 1')
            cursor.fetchone()
    except Exception:
        logger.exception('Readiness check failed: database unreachable')
        return JsonResponse({'status': 'degraded'}, status=503)
    return JsonResponse({'status': 'ok'})