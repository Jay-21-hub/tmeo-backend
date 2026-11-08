import os
from pathlib import Path
from datetime import timedelta
from decouple import config


def _int_env(name, default=None):
    """Integer env var: unset/empty -> default; junk -> a clear startup error (not a bare ValueError)."""
    raw = str(config(name, default='')).strip()
    if raw == '':
        return default
    try:
        return int(raw)
    except ValueError:
        from django.core.exceptions import ImproperlyConfigured
        raise ImproperlyConfigured(f'Environment variable {name} must be an integer, got {raw!r}.')


def _origin_list(raw):
    """Comma-separated origins -> clean list. Tolerates a missing scheme (assumes https://)
    and a trailing slash, the two most common typos that otherwise abort `migrate`/boot."""
    out = []
    for o in str(raw).split(','):
        o = o.strip().rstrip('/')
        if not o:
            continue
        if '://' not in o:
            o = 'https://' + o
        out.append(o)
    return out

CLOUDINARY_STORAGE = {
    'CLOUD_NAME': config('CLOUDINARY_CLOUD_NAME'),
    'API_KEY':    config('CLOUDINARY_API_KEY'),
    'API_SECRET': config('CLOUDINARY_API_SECRET'),
}

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = config('SECRET_KEY')
DEBUG = config('DEBUG', default=False, cast=bool)

# Archive Management — individual archived-record deletion (beta/dev feature).
# Must default to OFF in production; the backend is the enforcement point,
# not just the frontend button visibility.
ARCHIVE_DELETE_ENABLED = config('ARCHIVE_DELETE_ENABLED', default=False, cast=bool)

ALLOWED_HOSTS_ENV = config('ALLOWED_HOSTS', default='')
ALLOWED_HOSTS = (
    [h.strip() for h in ALLOWED_HOSTS_ENV.split(',') if h.strip()]
    if ALLOWED_HOSTS_ENV
    else ['localhost', '127.0.0.1']
)
if DEBUG:
    ALLOWED_HOSTS += ['localhost', '127.0.0.1', '0.0.0.0']

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    'rest_framework_simplejwt',
    'rest_framework_simplejwt.token_blacklist',
    'corsheaders',
    'django_filters',
    'accounts',
    'violations',
    'enforcers',
    'reports',
    'drf_spectacular',
    'audit',
    'notifications',
    'cloudinary_storage',
    'cloudinary',
    'database_management',
]

MIDDLEWARE = [
    'core.health.HealthCheckMiddleware',            # liveness probe, must stay first
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',   # ← added, right after SecurityMiddleware
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'core.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'core.wsgi.application'

DATABASES = {
    'default': {
        'ENGINE':   'django.db.backends.postgresql',
        'NAME':     config('DB_NAME'),
        'USER':     config('DB_USER'),
        'PASSWORD': config('DB_PASSWORD'),
        'HOST':     config('DB_HOST'),
        'PORT':     config('DB_PORT', default='5432'),
        'OPTIONS': {
            'sslmode': 'require',
        },
        # Connection behaviour is env-tunable; DEFAULTS KEEP THE PREVIOUS BEHAVIOUR
        # (new connection per request, server-side cursors on). Set these only after
        # choosing the Supabase connection mode — see TMEO-RENDER-VERCEL-DEPLOYMENT.md:
        #   DB_CONN_MAX_AGE=<seconds>                (persistent connections)
        #   DB_DISABLE_SERVER_SIDE_CURSORS=True      (REQUIRED for Supavisor *transaction* mode, port 6543)
        'CONN_MAX_AGE': _int_env('DB_CONN_MAX_AGE', 0),
        'DISABLE_SERVER_SIDE_CURSORS': config('DB_DISABLE_SERVER_SIDE_CURSORS', default=False, cast=bool),
    }
}

AUTH_USER_MODEL = 'accounts.CustomUser'

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    'OPTIONS': {'min_length': 8}},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# How many trusted proxies sit between the internet and Django. Used by DRF throttling
# AND by audit-log IP attribution (core.network.get_client_ip). Leave unset until you have
# run the 2-minute check in TMEO-RENDER-VERCEL-DEPLOYMENT.md, section "Client IP / proxies".
NUM_PROXIES = _int_env('NUM_PROXIES', None)

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'accounts.authentication.TMEOJWTAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    'DEFAULT_FILTER_BACKENDS': [
        'django_filters.rest_framework.DjangoFilterBackend',
        'rest_framework.filters.SearchFilter',
        'rest_framework.filters.OrderingFilter',
    ],
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': 20,
    'DEFAULT_SCHEMA_CLASS': 'drf_spectacular.openapi.AutoSchema',
    'DEFAULT_THROTTLE_CLASSES': [
        'rest_framework.throttling.AnonRateThrottle',
        'rest_framework.throttling.UserRateThrottle',
    ],
    'DEFAULT_THROTTLE_RATES': {
        'anon':  '600/minute',
        'user':  '200/minute',
        'login': '300/minute',
    },
    # Number of trusted reverse proxies in front of Django (Render). None keeps the
    # legacy behaviour; see NUM_PROXIES below and the deployment guide.
    'NUM_PROXIES': NUM_PROXIES,
}

SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME':    timedelta(hours=8),
    'REFRESH_TOKEN_LIFETIME':   timedelta(days=7),
    'ROTATE_REFRESH_TOKENS':    True,
    'BLACKLIST_AFTER_ROTATION': True,
    'AUTH_HEADER_TYPES':        ('Bearer',),
}

CORS_ALLOWED_ORIGINS = _origin_list(config(
    'CORS_ALLOWED_ORIGINS',
    default='http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173',
))
CORS_ALLOW_CREDENTIALS = True
# Optional: regexes for e.g. Vercel preview deployments (comma-separated). Empty by default.
CORS_ALLOWED_ORIGIN_REGEXES = [
    r.strip() for r in config('CORS_ALLOWED_ORIGIN_REGEXES', default='').split(',') if r.strip()
]
# The API uses Bearer JWTs (not cookies), so CSRF only matters for /admin/ (session login).
# Add the exact https origin(s) of the backend / any custom domain, comma-separated.
CSRF_TRUSTED_ORIGINS = _origin_list(config('CSRF_TRUSTED_ORIGINS', default=''))

LANGUAGE_CODE = 'en-us'
TIME_ZONE     = 'Asia/Manila'
USE_I18N      = True
USE_TZ        = True

STATIC_URL  = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STORAGES = {
    "default": {
        "BACKEND": "cloudinary_storage.storage.MediaCloudinaryStorage",
    },
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    }
}
MEDIA_URL   = '/media/'
MEDIA_ROOT  = BASE_DIR / 'media'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

EMAIL_BACKEND       = 'django.core.mail.backends.smtp.EmailBackend'
EMAIL_HOST          = 'smtp.gmail.com'
EMAIL_PORT          = 587
EMAIL_USE_TLS       = True
# smtplib has NO default timeout; without this a blocked SMTP port hangs a worker thread.
# NOTE: Render FREE web services block outbound SMTP (25/465/587) — see deployment guide.
EMAIL_TIMEOUT       = _int_env('EMAIL_TIMEOUT', 10)
EMAIL_HOST_USER     = config('EMAIL_HOST_USER', default='')
EMAIL_HOST_PASSWORD = config('EMAIL_HOST_PASSWORD', default='')
DEFAULT_FROM_EMAIL  = config('EMAIL_HOST_USER', default='')
FRONTEND_URL        = config('FRONTEND_URL', default='http://localhost:5173')
# The reset e-mail promises 24 hours; Django's default would keep the link valid for 3 days.
PASSWORD_RESET_TIMEOUT = 24 * 60 * 60

FIREBASE_CREDENTIALS_PATH = config(
    'FIREBASE_CREDENTIALS_PATH',
    default=str(BASE_DIR / 'firebase-credentials.json'),
)
FIREBASE_DATABASE_URL = config(
    'FIREBASE_DATABASE_URL',
    default='https://tmeo-backend-default-rtdb.firebaseio.com',
)

SPECTACULAR_SETTINGS = {
    'TITLE': 'TMEO API',
    'DESCRIPTION': 'Traffic Management Enforcement Operations API',
    'VERSION': '1.0.0',
    'SERVE_INCLUDE_SCHEMA': False,
    'SERVE_PERMISSIONS': (
        ['rest_framework.permissions.AllowAny']
        if DEBUG
        else ['rest_framework.permissions.IsAdminUser']
    ),
}

if not DEBUG:
    SECURE_PROXY_SSL_HEADER         = ('HTTP_X_FORWARDED_PROTO', 'https')
    SECURE_SSL_REDIRECT             = True
    SECURE_HSTS_SECONDS             = 31536000
    SECURE_HSTS_INCLUDE_SUBDOMAINS  = True
    SECURE_HSTS_PRELOAD             = True
    SECURE_CONTENT_TYPE_NOSNIFF     = True
    SECURE_BROWSER_XSS_FILTER       = True
    X_FRAME_OPTIONS                 = 'DENY'
    SESSION_COOKIE_SECURE           = True
    CSRF_COOKIE_SECURE              = True

# ── Logging ──────────────────────────────────────────────────────────────────
# Everything goes to stdout/stderr (Render collects it). No request bodies, tokens or
# query strings are logged by these settings.
LOG_LEVEL = config('LOG_LEVEL', default='INFO').upper()
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'standard': {'format': '%(asctime)s %(levelname)s %(name)s: %(message)s'},
    },
    'handlers': {
        'console': {'class': 'logging.StreamHandler', 'formatter': 'standard'},
    },
    'root': {'handlers': ['console'], 'level': LOG_LEVEL},
    'loggers': {
        'django.request': {'handlers': ['console'], 'level': 'WARNING', 'propagate': False},
        # Internet scanners hitting the service with a random Host header — noise, not signal.
        'django.security.DisallowedHost': {'handlers': ['console'], 'level': 'CRITICAL', 'propagate': False},
    },
}

# Local Stage B testing only — never use for production
import os

if os.environ.get("TMEO_LOCAL_TEST") == "1":
    DATABASES["default"].update({
        "NAME": "tmeo_stage_b_test",
        "USER": "postgres",
        "PASSWORD": os.environ["TMEO_LOCAL_DB_PASSWORD"],
        "HOST": "127.0.0.1",
        "PORT": "5432",
        "OPTIONS": {"sslmode": "disable"},
        "TEST": {
            "NAME": "test_tmeo_stage_b",
        },
    })