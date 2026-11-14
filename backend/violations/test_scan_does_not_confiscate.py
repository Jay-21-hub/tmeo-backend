"""A license number never opens custody. Only an explicit Confiscated status qualifies.

Run: python manage.py test violations.test_scan_does_not_confiscate --settings=core.test_settings_pg
"""
from django.utils import timezone

from violations.custody import violation_qualifies
from violations.custody_models import LicenseCustody
from violations.models import Violation
from violations.tests import BaseRoleTestCase


class ScanDoesNotConfiscate(BaseRoleTestCase):

    def _post(self, **over):
        payload = {
            'violator_name': 'DELA CRUZ, JUAN',
            'plate_number': 'XYZ9876',
            'vehicle_type': 'car',
            'date_issued': timezone.now().isoformat(),
            'location': 'Quezon Avenue',
            'violation_type_ids': [str(self.vtype.id)],
            'ovr_number': over.pop('ovr_number', 'OVR-SCAN-1'),
            'license_number': 'N01-23-456789',
        }
        payload.update(over)
        return self.as_user(self.enforcer_a).post('/api/violations/create/', payload, format='json')

    def test_license_number_with_not_confiscated_creates_no_custody(self):
        res = self._post(license_status='not_confiscated', ovr_number='OVR-SCAN-NC')
        self.assertEqual(res.status_code, 201, res.content)
        v = Violation.objects.get(pk=res.json()['id'])
        self.assertEqual(v.license_number, 'N01-23-456789')
        self.assertEqual(v.license_status, 'not_confiscated')
        self.assertFalse(violation_qualifies(v))
        self.assertFalse(LicenseCustody.objects.filter(original_violation_id=v.id).exists())

    def test_explicit_confiscated_still_qualifies_for_custody(self):
        res = self._post(license_status='confiscated', ovr_number='OVR-SCAN-C')
        self.assertEqual(res.status_code, 201, res.content)
        v = Violation.objects.get(pk=res.json()['id'])
        self.assertEqual(v.license_status, 'confiscated')
        self.assertEqual(v.license_number, 'N01-23-456789')
        self.assertTrue(violation_qualifies(v))
        # Create still does not insert the ledger row. The custody service
        # opens it later, and only because the status is Confiscated.
        self.assertFalse(LicenseCustody.objects.filter(original_violation_id=v.id).exists())
