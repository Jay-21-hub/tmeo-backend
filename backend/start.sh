#!/usr/bin/env bash
set -o errexit

python manage.py migrate --noinput
python manage.py collectstatic --noinput

# Concurrency is env-tunable. DEFAULTS ARE UNCHANGED (1 worker x 4 threads).
# Do NOT raise these blindly: every open SSE stream (/api/notifications/sse/,
# /api/violations/sse/) occupies one thread for as long as the browser tab is open.
# See TMEO-SSE-SUPABASE-RENDER-DECISIONS.md before changing them.
#
# Gunicorn access logging is intentionally OFF: the SSE endpoints receive the access
# token in the query string and it must not end up in logs.
exec gunicorn core.wsgi:application \
  --bind 0.0.0.0:${PORT:-8000} \
  --workers ${GUNICORN_WORKERS:-1} \
  --worker-class gthread \
  --threads ${GUNICORN_THREADS:-4} \
  --timeout ${GUNICORN_TIMEOUT:-120} \
  --error-logfile - \
  --log-level ${GUNICORN_LOG_LEVEL:-info}