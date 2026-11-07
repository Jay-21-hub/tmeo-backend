"""
Stage B hardening - the login throttle gets its own bucket.

Before: LoginThrottle subclassed AnonRateThrottle without its own scope, so it shared the
'anon' counter with every other anonymous request from the same IP (public pages).

Run with:  python manage.py test accounts.test_login_throttle --settings=core.test_settings
"""
from django.core.cache import cache
from rest_framework.test import APIRequestFactory, APITestCase
from rest_framework.throttling import AnonRateThrottle

from accounts.models import CustomUser
from accounts.views import LoginThrottle, LoginView


class LoginThrottleScope(APITestCase):

    def setUp(self):
        cache.clear()

    def test_login_throttle_uses_its_own_cache_key(self):
        request = APIRequestFactory().post('/api/auth/login/', REMOTE_ADDR='203.0.113.7')
        # Throttle keys are computed from the DRF Request's ident; wrap it.
        from rest_framework.request import Request
        drf_request = Request(request)
        login_key = LoginThrottle().get_cache_key(drf_request, LoginView())
        class _Anon(AnonRateThrottle):   # test settings clear DEFAULT_THROTTLE_RATES
            rate = '20/minute'

        anon_key = _Anon().get_cache_key(drf_request, LoginView())
        self.assertNotEqual(login_key, anon_key)
        self.assertIn('login', login_key)

    def test_sixth_login_attempt_in_a_minute_is_throttled(self):
        CustomUser.objects.create_user(
            email='thr@tmeo.test', password='TmeoTest!2026',
            full_name='Thr', id_number='THR-1', role='staff',
        )
        codes = [
            self.client.post('/api/auth/login/', {'id_number': 'THR-1', 'password': 'wrong'},
                             format='json', REMOTE_ADDR='203.0.113.8').status_code
            for _ in range(6)
        ]
        self.assertEqual(codes[:5], [400] * 5)
        self.assertEqual(codes[5], 429)