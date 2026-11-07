"""
BATCH 0 (D7) - offline sync identity safety.

Covers the backend half of the fix: an offline-keyed create
(client_offline_id present) is accepted only from an Enforcer, the role
check runs before the replay lookup, and a replay is only honoured for the
enforcer who created the record. Every refusal uses the same generic 403
so client_offline_id ownership cannot be probed.

Run with:  python manage.py test violations.test_offline_sync --settings=core.test_settings
"""
from django.utils import timezone

from violations.models import Violation
from violations.tests import BaseRoleTestCase
from violations.views import OFFLINE_SYNC_DENIED_MSG

URL = '/api/violations/create/'


class OfflineSyncIdentitySafety(BaseRoleTestCase):

    def _payload(self, offline_id, **extra):
        data = {
            'violator_name': 'DELA CRUZ, JUAN',
            'ovr_number': 'OVR-OFF-001',
            'location': 'ML Tagarao Street',
            'date_issued': timezone.now().isoformat(),
            'violation_type_ids': [str(self.vtype.id)],
            'status': 'pending',
            'source': 'enforcer_ovr',
            'client_offline_id': offline_id,
        }
        data.update(extra)
        return data

    def test_enforcer_offline_create_succeeds_and_is_attributed_to_them(self):
        res = self.as_user(self.enforcer_a).post(URL, self._payload('offline_1'), format='json')
        self.assertEqual(res.status_code, 201, res.data)
        v = Violation.objects.get(client_offline_id='offline_1')
        self.assertEqual(v.enforcer_id, self.enforcer_a.id)

    def test_staff_offline_keyed_create_is_403_and_creates_nothing(self):
        res = self.as_user(self.staff).post(URL, self._payload('offline_2'), format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data['detail'], OFFLINE_SYNC_DENIED_MSG)
        self.assertFalse(Violation.objects.filter(client_offline_id='offline_2').exists())

    def test_admin_offline_keyed_create_is_403_and_creates_nothing(self):
        res = self.as_user(self.admin).post(URL, self._payload('offline_3'), format='json')
        self.assertEqual(res.status_code, 403)
        self.assertFalse(Violation.objects.filter(client_offline_id='offline_3').exists())

    def test_staff_forging_enforcer_ovr_source_is_403(self):
        res = self.as_user(self.staff).post(
            URL, self._payload('offline_4', source='enforcer_ovr'), format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(Violation.objects.filter(client_offline_id='offline_4').count(), 0)

    def test_staff_cannot_replay_an_existing_offline_id(self):
        self.as_user(self.enforcer_a).post(URL, self._payload('offline_5'), format='json')
        res = self.as_user(self.staff).post(URL, self._payload('offline_5'), format='json')
        self.assertEqual(res.status_code, 403)
        self.assertNotIn('violator_name', res.data)
        self.assertNotIn('id', res.data)

    def test_same_enforcer_replay_is_idempotent(self):
        first = self.as_user(self.enforcer_a).post(URL, self._payload('offline_6'), format='json')
        again = self.as_user(self.enforcer_a).post(URL, self._payload('offline_6'), format='json')
        self.assertEqual(first.status_code, 201)
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.data['id'], first.data['id'])
        self.assertEqual(Violation.objects.filter(client_offline_id='offline_6').count(), 1)

    def test_other_enforcer_replay_gets_generic_403_with_no_detail_leak(self):
        first = self.as_user(self.enforcer_a).post(URL, self._payload('offline_7'), format='json')
        res = self.as_user(self.enforcer_b).post(URL, self._payload('offline_7'), format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data['detail'], OFFLINE_SYNC_DENIED_MSG)
        self.assertNotIn('violator_name', res.data)
        v = Violation.objects.get(pk=first.data['id'])
        self.assertEqual(v.enforcer_id, self.enforcer_a.id)

    def test_refusals_are_indistinguishable(self):
        """Unknown id vs someone-else's id must not be distinguishable to a non-enforcer."""
        self.as_user(self.enforcer_a).post(URL, self._payload('offline_8'), format='json')
        known = self.as_user(self.staff).post(URL, self._payload('offline_8'), format='json')
        unknown = self.as_user(self.staff).post(URL, self._payload('offline_nope'), format='json')
        self.assertEqual(known.status_code, unknown.status_code)
        self.assertEqual(known.data, unknown.data)

    def test_staff_walk_in_without_offline_id_still_works(self):
        data = self._payload('', source='staff_walk_in')
        data.pop('client_offline_id')
        data.pop('ovr_number')
        res = self.as_user(self.staff).post(URL, data, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        self.assertIsNone(Violation.objects.get(pk=res.data['id']).enforcer_id)

    def test_online_enforcer_create_without_offline_id_still_works(self):
        data = self._payload('')
        data.pop('client_offline_id')
        res = self.as_user(self.enforcer_a).post(URL, data, format='json')
        self.assertEqual(res.status_code, 201, res.data)