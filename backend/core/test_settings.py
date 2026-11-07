"""
TEST-ONLY settings. Never used in production (production keeps core.settings
with PostgreSQL). Supplies dummy env values so core.settings can be imported
without a .env file, swaps PostgreSQL for in-memory SQLite, and uses local
file storage so tests never touch Cloudinary.

Run:  python manage.py test --settings=core.test_settings
"""
import os

for _k, _v in {
    'SECRET_KEY': 'test-only-secret-key',
    'DB_NAME': 'x', 'DB_USER': 'x', 'DB_PASSWORD': 'x', 'DB_HOST': 'x',
    'CLOUDINARY_CLOUD_NAME': 'x', 'CLOUDINARY_API_KEY': 'x', 'CLOUDINARY_API_SECRET': 'x',
}.items():
    os.environ.setdefault(_k, _v)

from .settings import *  # noqa: E402,F401,F403

DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}
STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'},
}
MEDIA_ROOT = '/tmp/tmeo_test_media'
PASSWORD_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher']
REST_FRAMEWORK = {**REST_FRAMEWORK, 'DEFAULT_THROTTLE_CLASSES': [], 'DEFAULT_THROTTLE_RATES': {}}
SECURE_SSL_REDIRECT = False
SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False