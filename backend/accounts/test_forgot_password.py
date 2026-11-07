"""
Stage B hardening - forgot-password.

Before: an unknown ID answered 200 but a real account WITHOUT an email answered 400
("No email linked..."), so anyone could enumerate valid ID numbers; and an SMTP failure
(or a blocked SMTP port) surfaced as HTTP 500.

Run with:  python manage.py test accounts.test_forgot_password --settings=core.test_settings
"""
import smtplib
import time
from unittest import mock

from django.core import mail
from django.core.cache import cache
from rest_framework.test import APITestCase

from accounts.models import CustomUser

URL = '/api/auth/forgot-password/'


class _SyncThread:
    """Stand-in for threading.Thread that runs the target immediately (deterministic tests)."""

    def __init__(self, target=None, args=(), daemon=None, **kwargs):
        self._target, self._args = target, args

    def start(self):
        self._target(*self._args)


def sync_threads():
    return mock.patch('accounts.views.threading.Thread', _SyncThread)


class ForgotPasswordHardening(APITestCase):

    def setUp(self):
        cache.clear()   # the forgot-password endpoint now has its own per-IP rate limit

    @classmethod
    def setUpTestData(cls):
        cls.with_email = CustomUser.objects.create_user(
            email='has.email@tmeo.test', password='TmeoTest!2026',
            full_name='Has Email', id_number='FP-001', role='staff',
        )
        cls.no_email = CustomUser.objects.create_user(
            email='temp@tmeo.test', password='TmeoTest!2026',
            full_name='No Email', id_number='FP-002', role='staff',
        )
        CustomUser.objects.filter(pk=cls.no_email.pk).update(email='')

    def test_unknown_account_returns_generic_sent(self):
        res = self.client.post(URL, {'username': 'DOES-NOT-EXIST'}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {'detail': 'sent'})
        self.assertEqual(len(mail.outbox), 0)

    def test_account_with_email_gets_mail_and_generic_sent(self):
        with sync_threads():
            res = self.client.post(URL, {'username': 'FP-001'}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {'detail': 'sent'})
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, ['has.email@tmeo.test'])
        self.assertIn('/reset-password/', mail.outbox[0].body)

    def test_mail_is_really_sent_from_a_background_thread(self):
        res = self.client.post(URL, {'username': 'FP-001'}, format='json')   # real Thread
        self.assertEqual(res.status_code, 200)
        deadline = time.time() + 3
        while not mail.outbox and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(len(mail.outbox), 1)

    def test_slow_smtp_does_not_delay_the_response(self):
        # Timing oracle / thread-pinning guard: response must not wait for SMTP.
        with mock.patch('accounts.views.send_mail', side_effect=lambda *a, **k: time.sleep(1.5)):
            t0 = time.time()
            res = self.client.post(URL, {'username': 'FP-001'}, format='json')
            elapsed = time.time() - t0
        self.assertEqual(res.status_code, 200)
        self.assertLess(elapsed, 1.0)

    def test_account_without_email_is_indistinguishable_from_unknown(self):
        with sync_threads():
            res = self.client.post(URL, {'username': 'FP-002'}, format='json')
            unknown = self.client.post(URL, {'username': 'DOES-NOT-EXIST'}, format='json')
        self.assertEqual(res.status_code, 200)          # was 400 -> enumeration oracle
        self.assertEqual(res.json(), unknown.json())
        self.assertEqual(len(mail.outbox), 0)

    def test_smtp_failure_is_not_a_500_and_logs_only_class_and_user_id(self):
        with sync_threads(), mock.patch(
                'accounts.views.send_mail',
                side_effect=smtplib.SMTPRecipientsRefused({'has.email@tmeo.test': (550, b'no')})):
            with self.assertLogs('accounts.views', level='ERROR') as logs:
                res = self.client.post(URL, {'username': 'FP-001'}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {'detail': 'sent'})
        text = '\n'.join(logs.output)
        self.assertIn('SMTPRecipientsRefused', text)
        self.assertNotIn('has.email@tmeo.test', text)       # no recipient address in logs

    def test_network_error_blocked_port_is_not_a_500(self):
        # Render FREE web services block outbound SMTP: connect fails with OSError.
        with sync_threads(), mock.patch('accounts.views.send_mail',
                                         side_effect=OSError(101, 'Network is unreachable')):
            with self.assertLogs('accounts.views', level='ERROR'):
                res = self.client.post(URL, {'username': 'FP-001'}, format='json')
        self.assertEqual(res.status_code, 200)

    def test_malformed_input_still_400_not_500(self):
        for body in ({}, {'username': ''}, {'username': '   '}, {'username': 12345}, {'username': ['a']}):
            res = self.client.post(URL, body, format='json')
            self.assertEqual(res.status_code, 400, body)
            self.assertEqual(res.json(), {'detail': 'Username is required.'})