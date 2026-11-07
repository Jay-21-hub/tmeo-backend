"""
WSGI config for core project.

It exposes the WSGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/6.0/howto/deployment/wsgi/
"""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'core.settings')

application = get_wsgi_application()

# Production reminder: without NUM_PROXIES, login throttling and audit-log IPs trust a
# client-controllable X-Forwarded-For. (Logged once at boot; see the deployment guide.)
import logging  # noqa: E402
from django.conf import settings  # noqa: E402

if not settings.DEBUG and getattr(settings, 'NUM_PROXIES', None) is None:
    logging.getLogger('tmeo.startup').warning(
        'NUM_PROXIES is not set: client IP for throttling/audit uses the client-controllable '
        'X-Forwarded-For header. Set NUM_PROXIES after verifying your proxy chain.'
    )