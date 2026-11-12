"""
Fine history (Option A): an offline-synced Enforcer OVR is priced with the fine
in force at its date_issued; everything else uses the current fine.

Run with:  python manage.py test violations.test_fine_history
"""
from datetime import timedelta
from decimal import Decimal

from django.utils import timezone

from violations.models import Violation, ViolationType, ViolationTypeFine
from violations.tests import BaseRoleTestCase

CREATE = '/api/violations/create/'


class FineHistoryTests(BaseRoleTestCase):

    def setUp(self):
        super().setUp()
        ViolationType.objects.filter(pk=self.vtype.pk).update(penalty_amount=Decimal('500.00'))
        self.vtype.refresh_from_db()
        self.url = f'/api/violations/types/{self.vtype.id}/'

    def _admin_sets_fine(self, amount='900.00'):
        res = self.as_user(self.admin).patch(self.url, {'penalty_amount': amount}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        return ViolationTypeFine.objects.filter(violation_type=self.vtype).order_by('-effective_from', '-id').first()

    def _payload(self, offline_id, issued, ovr='OVR-FH-001'):
        data = {
            'violator_name': 'DELA CRUZ, JUAN',
            'ovr_number': ovr,
            'location': 'ML Tagarao Street',
            'date_issued': issued.isoformat(),
            'violation_type_ids': [str(self.vtype.id)],
            'status': 'pending',
            'source': 'enforcer_ovr',
        }
        if offline_id:
            data['client_offline_id'] = offline_id
        return data

    def test_admin_fine_edit_writes_baseline_and_new_row(self):
        newest = self._admin_sets_fine('900.00')
        rows = list(ViolationTypeFine.objects.filter(violation_type=self.vtype).order_by('effective_from', 'id'))
        self.assertEqual([r.penalty_amount for r in rows], [Decimal('500.00'), Decimal('900.00')])
        self.assertEqual(newest.changed_by_id, self.admin.id)

    def test_offline_ovr_dated_before_the_edit_keeps_the_old_fine(self):
        edit = self._admin_sets_fine('900.00')
        issued = edit.effective_from - timedelta(minutes=1)
        res = self.as_user(self.enforcer_a).post(CREATE, self._payload('off_before', issued), format='json')
        self.assertEqual(res.status_code, 201, res.data)
        v = Violation.objects.get(client_offline_id='off_before')
        self.assertEqual(v.items.get().penalty_amount_snapshot, Decimal('500.00'))
        self.assertEqual(v.penalty_amount, Decimal('500.00'))

    def test_offline_ovr_dated_after_the_edit_gets_the_new_fine(self):
        edit = self._admin_sets_fine('900.00')
        issued = edit.effective_from + timedelta(seconds=1)
        res = self.as_user(self.enforcer_a).post(CREATE, self._payload('off_after', issued), format='json')
        self.assertEqual(res.status_code, 201, res.data)
        v = Violation.objects.get(client_offline_id='off_after')
        self.assertEqual(v.items.get().penalty_amount_snapshot, Decimal('900.00'))

    def test_online_ovr_without_offline_id_uses_the_current_fine(self):
        edit = self._admin_sets_fine('900.00')
        issued = edit.effective_from - timedelta(minutes=1)
        res = self.as_user(self.enforcer_a).post(CREATE, self._payload('', issued, ovr='OVR-FH-002'), format='json')
        self.assertEqual(res.status_code, 201, res.data)
        v = Violation.objects.get(pk=res.data['id'])
        self.assertEqual(v.items.get().penalty_amount_snapshot, Decimal('900.00'))

    def test_staff_cannot_change_a_fine(self):
        res = self.as_user(self.staff).patch(self.url, {'penalty_amount': '1.00'}, format='json')
        self.assertEqual(res.status_code, 403)
        self.vtype.refresh_from_db()
        self.assertEqual(self.vtype.penalty_amount, Decimal('500.00'))
        self.assertFalse(ViolationTypeFine.objects.filter(violation_type=self.vtype).exists())

    def test_staff_can_still_edit_other_fields(self):
        res = self.as_user(self.staff).patch(self.url, {'name': 'Renamed by staff'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.vtype.refresh_from_db()
        self.assertEqual(self.vtype.name, 'Renamed by staff')

    def test_negative_fine_is_rejected(self):
        res = self.as_user(self.admin).patch(self.url, {'penalty_amount': '-5.00'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.vtype.refresh_from_db()
        self.assertEqual(self.vtype.penalty_amount, Decimal('500.00'))
