"""
Stage B final audit - password-reset hardening.

Confirmed on the pre-fix code:
  * reset links stayed valid for 72 h (Django default) although the e-mail says 24 h
  * a non-string uid/token in the JSON body raised AttributeError -> HTTP 500
  * forgot/reset only had the global 20/min anonymous limit (mail-bombing a single account)
Also pins behaviour that was already correct: links are single-use.

Run with:  python manage.py test accounts.test_password_reset_security --settings=core.test_settings
"""
from datetime import datetime, timedelta
from unittest import mock

from django.conf import settings
from django.contrib.auth.tokens import default_token_generator
from django.core.cache import cache
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from rest_framework.test import APITestCase

from accounts.models import CustomUser
from accounts.views import ForgotPasswordThrottle, LoginThrottle, ResetPasswordThrottle

RESET_URL = '/api/auth/reset-password/'
FORGOT_URL = '/api/auth/forgot-password/'
NEW_PW = 'Brand-New-Pass-456!'


def _body(uid, token):
    return {'uid': uid, 'token': token, 'new_password': NEW_PW, 'confirm_password': NEW_PW}


class ResetLinkLifetimeAndReuse(APITestCase):

    def setUp(self):
        cache.clear()
        self.user = CustomUser.objects.create_user(
            email='reset@tmeo.test', password='Old-Pass-123!',
            full_name='Reset User', id_number='RST-1', role='staff',
        )
        self.uid = urlsafe_base64_encode(force_bytes(self.user.pk))
        self.token = default_token_generator.make_token(self.user)

    def test_timeout_matches_the_24_hours_promised_in_the_email(self):
        self.assertEqual(settings.PASSWORD_RESET_TIMEOUT, 24 * 60 * 60)

    def _post_at(self, delta):
        later = datetime.now() + delta
        with mock.patch.object(default_token_generator, '_now', return_value=later):
            return self.client.post(RESET_URL, _body(self.uid, self.token), format='json',
                                    REMOTE_ADDR='198.51.100.10')

    def test_link_works_inside_24_hours(self):
        self.assertEqual(self._post_at(timedelta(hours=23)).status_code, 200)

    def test_link_is_rejected_after_24_hours(self):
        res = self._post_at(timedelta(hours=25))
        self.assertEqual(res.status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('Old-Pass-123!'))

    def test_link_is_single_use(self):
        first = self.client.post(RESET_URL, _body(self.uid, self.token), format='json', REMOTE_ADDR='198.51.100.11')
        again = self.client.post(RESET_URL, _body(self.uid, self.token), format='json', REMOTE_ADDR='198.51.100.11')
        self.assertEqual(first.status_code, 200)
        self.assertEqual(again.status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(NEW_PW))

    def test_wrong_token_is_rejected_and_password_unchanged(self):
        res = self.client.post(RESET_URL, _body(self.uid, 'abc-0123456789abcdef'), format='json', REMOTE_ADDR='198.51.100.12')
        self.assertEqual(res.status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('Old-Pass-123!'))


class ResetMalformedInput(APITestCase):

    def setUp(self):
        cache.clear()

    def test_non_string_uid_or_token_is_a_400_not_a_500(self):
        cases = [
            {'uid': 5, 'token': 'x'},            # number
            {'uid': [1], 'token': 'x'},          # list
            {'uid': {'a': 1}, 'token': 'x'},     # object
            {'uid': 'MQ', 'token': 5},           # token as number
            {'uid': 'MQ', 'token': ['x']},       # token as list
            {'token': 'x'},                      # uid missing
            {'uid': '!!!not-base64!!!', 'token': 'x'},
            {'uid': 'MQ', 'token': 'x'},         # decodes to pk 1 which does not exist
        ]
        for n, extra in enumerate(cases):
            with self.subTest(extra=extra):
                payload = {'new_password': NEW_PW, 'confirm_password': NEW_PW, **extra}
                res = self.client.post(RESET_URL, payload, format='json', REMOTE_ADDR=f'198.51.100.{20 + n}')
                self.assertEqual(res.status_code, 400)


class ResetThrottles(APITestCase):

    def setUp(self):
        cache.clear()

    def test_own_scopes_not_shared_with_login_or_anon(self):
        scopes = {ForgotPasswordThrottle.scope, ResetPasswordThrottle.scope, LoginThrottle.scope}
        self.assertEqual(len(scopes), 3)
        self.assertNotIn('anon', scopes)

    def test_forgot_password_is_limited_to_10_per_hour_per_ip(self):
        codes = [
            self.client.post(FORGOT_URL, {'username': 'nobody'}, format='json', REMOTE_ADDR='203.0.113.40').status_code
            for _ in range(11)
        ]
        self.assertEqual(codes[:10], [200] * 10)
        self.assertEqual(codes[10], 429)

    def test_forgot_password_limit_is_per_ip(self):
        for _ in range(10):
            self.client.post(FORGOT_URL, {'username': 'nobody'}, format='json', REMOTE_ADDR='203.0.113.41')
        other = self.client.post(FORGOT_URL, {'username': 'nobody'}, format='json', REMOTE_ADDR='203.0.113.42')
        self.assertEqual(other.status_code, 200)

    def test_reset_password_is_limited_to_20_per_hour_per_ip(self):
        payload = {'uid': 'MQ', 'token': 'x', 'new_password': NEW_PW, 'confirm_password': NEW_PW}
        codes = [
            self.client.post(RESET_URL, payload, format='json', REMOTE_ADDR='203.0.113.43').status_code
            for _ in range(21)
        ]
        self.assertEqual(set(codes[:20]), {400})
        self.assertEqual(codes[20], 429)