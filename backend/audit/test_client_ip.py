"""
Stage B hardening - client IP attribution (core.network.get_client_ip) and audit log.

Before: audit.utils.log_action stored the FIRST X-Forwarded-For entry verbatim. That value
is client-controlled (forgeable), and because AuditLog.ip_address is a GenericIPAddressField
a non-IP value made the INSERT fail on PostgreSQL (HTTP 500 on any audited action).

Run with:  python manage.py test audit.test_client_ip --settings=core.test_settings_pg
(the invalid-IP case only fails on PostgreSQL; SQLite stores any string)
"""
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings

from accounts.models import CustomUser
from audit.models import AuditLog
from audit.utils import log_action
from core.network import get_client_ip


def _req(xff=None, remote='10.0.0.1'):
    meta = {'REMOTE_ADDR': remote}
    if xff is not None:
        meta['HTTP_X_FORWARDED_FOR'] = xff
    return RequestFactory().get('/', **meta)


class GetClientIp(SimpleTestCase):

    @override_settings(NUM_PROXIES=None)
    def test_legacy_mode_first_valid_entry(self):
        self.assertEqual(get_client_ip(_req('1.2.3.4, 10.0.0.9')), '1.2.3.4')

    @override_settings(NUM_PROXIES=None)
    def test_no_header_uses_remote_addr(self):
        self.assertEqual(get_client_ip(_req()), '10.0.0.1')

    @override_settings(NUM_PROXIES=1)
    def test_one_proxy_uses_rightmost_not_forgeable_left_side(self):
        # client forged "6.6.6.6"; our single trusted proxy appended the real peer.
        self.assertEqual(get_client_ip(_req('6.6.6.6, 198.51.100.20')), '198.51.100.20')

    @override_settings(NUM_PROXIES=2)
    def test_two_proxies_uses_second_from_right(self):
        self.assertEqual(get_client_ip(_req('6.6.6.6, 198.51.100.20, 172.16.0.5')), '198.51.100.20')

    @override_settings(NUM_PROXIES=3)
    def test_more_proxies_than_entries_uses_leftmost(self):
        self.assertEqual(get_client_ip(_req('198.51.100.20')), '198.51.100.20')

    @override_settings(NUM_PROXIES=0)
    def test_zero_proxies_ignores_header(self):
        self.assertEqual(get_client_ip(_req('6.6.6.6')), '10.0.0.1')

    @override_settings(NUM_PROXIES=None)
    def test_garbage_falls_back_to_remote_addr(self):
        for bad in ('not-an-ip', "1.2.3.4'; DROP TABLE x;--", '999.999.1.1', '<script>', ' , '):
            self.assertEqual(get_client_ip(_req(bad)), '10.0.0.1', bad)

    @override_settings(NUM_PROXIES=None)
    def test_ipv6_is_accepted(self):
        self.assertEqual(get_client_ip(_req('2001:db8::1')), '2001:db8::1')

    @override_settings(NUM_PROXIES=None)
    def test_scoped_ipv6_is_rejected(self):
        # Valid for Python, but PostgreSQL `inet` refuses it -> would 500 the audit insert.
        self.assertEqual(get_client_ip(_req('fe80::1%eth0')), '10.0.0.1')

    @override_settings(NUM_PROXIES=None)
    def test_port_suffixed_and_bracketed_forms_are_understood(self):
        self.assertEqual(get_client_ip(_req('203.0.113.9:51234')), '203.0.113.9')
        self.assertEqual(get_client_ip(_req('[2001:db8::7]:443')), '2001:db8::7')
        self.assertEqual(get_client_ip(_req('[2001:db8::7]')), '2001:db8::7')
        self.assertEqual(get_client_ip(_req('[broken')), '10.0.0.1')

    @override_settings(NUM_PROXIES=None)
    def test_no_usable_address_returns_none(self):
        self.assertIsNone(get_client_ip(_req('garbage', remote='')))


class AuditLogUsesValidatedIp(TestCase):

    @classmethod
    def setUpTestData(cls):
        cls.user = CustomUser.objects.create_user(
            email='aud@tmeo.test', password='TmeoTest!2026',
            full_name='Aud', id_number='AUD-1', role='admin',
        )

    @override_settings(NUM_PROXIES=None)
    def test_scoped_ipv6_does_not_break_audit_insert(self):
        log_action(self.user, 'CREATE', 'Test', 'scoped', request=_req('fe80::1%eth0'))
        self.assertEqual(AuditLog.objects.latest('id').ip_address, '10.0.0.1')

    @override_settings(NUM_PROXIES=None)
    def test_forged_non_ip_header_does_not_break_audit_insert(self):
        # Pre-fix on PostgreSQL: DataError (invalid input syntax for type inet).
        log_action(self.user, 'CREATE', 'Test', 'spoof attempt', request=_req('not-an-ip, 1.1.1.1'))
        row = AuditLog.objects.latest('id')
        self.assertEqual(row.ip_address, '10.0.0.1')

    @override_settings(NUM_PROXIES=1)
    def test_forged_left_entry_is_not_recorded(self):
        log_action(self.user, 'CREATE', 'Test', 'forged', request=_req('6.6.6.6, 198.51.100.20'))
        self.assertEqual(AuditLog.objects.latest('id').ip_address, '198.51.100.20')

    def test_no_request_still_works(self):
        log_action(self.user, 'CREATE', 'Test', 'no request')
        self.assertIsNone(AuditLog.objects.latest('id').ip_address)