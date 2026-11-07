"""
Assessment workflow tests: Step 1 confiscation, Step 3 Confirm Payment,
and print / reprint integrity.

Run with:  python manage.py test violations.test_assessment_payment
"""
import datetime
from decimal import Decimal
from unittest import mock

from django.utils import timezone

from audit.models import AuditLog
from violations import tests as base
from violations.models import Assessment, Violation, ViolationItem, ViolationType


def walk_in_payload(**over):
    payload = {
        'source': 'staff_walk_in',
        'violator_name': 'SANTOS, MARIA',
        'address': '1 Rizal St',
        'plate_number': 'XYZ 987',
        'vehicle_type': 'Cars',
        'location': 'Quezon Avenue',
        'date_issued': '2026-09-01T10:30:00+08:00',
        'violation_type_ids': [],
    }
    payload.update(over)
    return payload


class ConfiscationRules(base.BaseRoleTestCase):

    def create(self, **over):
        over.setdefault('violation_type_ids', [self.vtype.id])
        return self.as_user(self.staff).post(
            '/api/violations/create/', walk_in_payload(**over), format='json')

    def test_not_confiscated_without_document_details_succeeds(self):
        res = self.create(license_status='not_confiscated')
        self.assertEqual(res.status_code, 201, res.content)

    def test_license_number_not_globally_required(self):
        res = self.create(license_status='not_confiscated', license_number='')
        self.assertEqual(res.status_code, 201, res.content)

    def test_confiscated_requires_document_type(self):
        res = self.create(license_status='confiscated')
        self.assertEqual(res.status_code, 400)
        self.assertIn('confiscated_document_type', res.json())

    def test_drivers_license_path(self):
        res = self.create(license_status='confiscated',
                          confiscated_document_type='drivers_license',
                          license_number='N01-23-456789')
        self.assertEqual(res.status_code, 201, res.content)
        v = Violation.objects.get(pk=res.json()['id'])
        self.assertEqual(v.license_number, 'N01-23-456789')
        self.assertEqual(v.confiscated_document_number, '')

    def test_drivers_license_requires_license_number(self):
        res = self.create(license_status='confiscated',
                          confiscated_document_type='drivers_license')
        self.assertEqual(res.status_code, 400)
        self.assertIn('license_number', res.json())

    def test_non_license_documents_persist_reference_number(self):
        for doc in ('bir', 'umid', 'company_id', 'philhealth'):
            with self.subTest(doc=doc):
                res = self.create(license_status='confiscated',
                                  confiscated_document_type=doc,
                                  confiscated_document_number=f'{doc}-123')
                self.assertEqual(res.status_code, 201, res.content)
                v = Violation.objects.get(pk=res.json()['id'])
                self.assertEqual(v.confiscated_document_type, doc)
                self.assertEqual(v.confiscated_document_number, f'{doc}-123')

    def test_non_license_document_requires_reference_number(self):
        res = self.create(license_status='confiscated', confiscated_document_type='umid')
        self.assertEqual(res.status_code, 400)
        self.assertIn('confiscated_document_number', res.json())

    def test_others_requires_custom_name(self):
        res = self.create(license_status='confiscated',
                          confiscated_document_type='others',
                          confiscated_document_number='REF-1')
        self.assertEqual(res.status_code, 400)
        self.assertIn('confiscated_document_name', res.json())

    def test_others_with_name_and_number_persists(self):
        res = self.create(license_status='confiscated',
                          confiscated_document_type='others',
                          confiscated_document_name='Postal ID',
                          confiscated_document_number='PST-55')
        self.assertEqual(res.status_code, 201, res.content)
        v = Violation.objects.get(pk=res.json()['id'])
        self.assertEqual((v.confiscated_document_name, v.confiscated_document_number),
                         ('Postal ID', 'PST-55'))

    def test_switching_to_not_confiscated_clears_stale_values(self):
        res = self.create(license_status='confiscated',
                          confiscated_document_type='umid',
                          confiscated_document_number='U-1')
        vid = res.json()['id']
        res = self.as_user(self.staff).patch(
            f'/api/violations/{vid}/', {'license_status': 'not_confiscated'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        v = Violation.objects.get(pk=vid)
        self.assertEqual((v.confiscated_document_type, v.confiscated_document_name,
                          v.confiscated_document_number), ('', '', ''))

    def test_direct_api_cannot_leave_stale_data_when_not_confiscated(self):
        res = self.create(license_status='not_confiscated',
                          confiscated_document_type='umid',
                          confiscated_document_number='U-9')
        self.assertEqual(res.status_code, 201)
        v = Violation.objects.get(pk=res.json()['id'])
        self.assertEqual(v.confiscated_document_type, '')
        self.assertEqual(v.confiscated_document_number, '')

    def test_direct_api_bypass_of_confiscation_validation_fails_on_update(self):
        vid = self.create().json()['id']
        res = self.as_user(self.staff).patch(
            f'/api/violations/{vid}/', {'license_status': 'confiscated'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(Violation.objects.get(pk=vid).license_status, 'not_confiscated')

    def test_historical_confiscated_record_unrelated_patch_still_works(self):
        v = self._make_violation(self.enforcer_a, 'OVR-A-900')
        Violation.objects.filter(pk=v.pk).update(license_status='confiscated')
        res = self.as_user(self.staff).patch(
            f'/api/violations/{v.id}/', {'remarks': 'note'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)


class PaymentBase(base.BaseRoleTestCase):

    def processing_violation(self, ovr='OVR-A-500'):
        v = self._make_violation(self.enforcer_a, ovr)
        res = self.as_user(self.staff).patch(
            f'/api/violations/{v.id}/assess/', {'status': 'processing'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        v.refresh_from_db()
        return v

    def confirm(self, v, user=None, **body):
        return self.as_user(user or self.staff).post(
            f'/api/violations/{v.id}/confirm-payment/', body, format='json')


class ConfirmPayment(PaymentBase):

    def test_succeeds_with_blank_or_number(self):
        v = self.processing_violation()
        res = self.confirm(v)
        self.assertEqual(res.status_code, 200, res.content)
        v.refresh_from_db()
        self.assertEqual(v.status, 'paid')
        self.assertEqual(v.assessment.or_number, '')

    def test_succeeds_with_supplied_or_number(self):
        v = self.processing_violation()
        self.assertEqual(self.confirm(v, or_number='OR-777').status_code, 200)
        v.refresh_from_db()
        self.assertEqual(v.assessment.or_number, 'OR-777')

    def test_or_number_is_optional_not_required(self):
        v = self.processing_violation()
        res = self.confirm(v, or_number='   ')
        self.assertEqual(res.status_code, 200)
        v.refresh_from_db()
        self.assertEqual(v.assessment.or_number, '')

    def test_received_by_stays_blank_and_is_never_auto_filled(self):
        v = self.processing_violation()
        self.confirm(v, received_by='Front Desk Clerk')
        v.refresh_from_db()
        self.assertEqual(v.assessment.received_by, '')
        self.assertNotEqual(v.assessment.received_by, self.staff.full_name)

    def test_amount_paid_persisted_from_authoritative_penalty(self):
        v = self.processing_violation()
        self.confirm(v)
        v.refresh_from_db()
        self.assertEqual(v.assessment.amount_paid, Decimal('500.00'))
        self.assertEqual(v.assessment.penalty, Decimal('500.00'))

    def test_client_cannot_tamper_with_amount(self):
        v = self.processing_violation()
        self.confirm(v, amount_paid='1.00', penalty='1.00', penalty_amount='1.00')
        v.refresh_from_db()
        self.assertEqual(v.assessment.amount_paid, Decimal('500.00'))
        self.assertEqual(v.penalty_amount, Decimal('500.00'))

    def test_assess_ignores_client_penalty_amount(self):
        v = self._make_violation(self.enforcer_a, 'OVR-A-501')
        res = self.as_user(self.staff).patch(
            f'/api/violations/{v.id}/assess/',
            {'status': 'processing', 'penalty_amount': '1.00'}, format='json')
        self.assertEqual(res.status_code, 200)
        v.refresh_from_db()
        self.assertEqual(v.penalty_amount, Decimal('500.00'))

    def test_uses_snapshot_not_todays_violation_type_price(self):
        v = self.processing_violation()
        ViolationType.objects.filter(pk=self.vtype.pk).update(penalty_amount=9999)
        self.confirm(v)
        v.refresh_from_db()
        self.assertEqual(v.assessment.amount_paid, Decimal('500.00'))

    def test_date_paid_is_server_generated(self):
        v = self.processing_violation()
        self.confirm(v)
        v.refresh_from_db()
        self.assertEqual(v.assessment.date_paid, timezone.localdate())

    def test_client_cannot_override_date_paid(self):
        v = self.processing_violation()
        self.confirm(v, date_paid='2001-01-01')
        v.refresh_from_db()
        self.assertEqual(v.assessment.date_paid, timezone.localdate())

    def test_assessed_by_is_authenticated_staff(self):
        v = self.processing_violation()
        self.confirm(v, assessed_by=self.admin.id)
        v.refresh_from_db()
        self.assertEqual(v.assessment.assessed_by, self.staff)
        self.assertEqual(v.assessed_by, self.staff)

    def test_status_becomes_paid(self):
        v = self.processing_violation()
        self.assertEqual(self.confirm(v).json()['status'], 'paid')

    def test_cannot_confirm_twice(self):
        v = self.processing_violation()
        self.confirm(v, or_number='A')
        first_date = Assessment.objects.get(violation=v).date_paid
        res = self.confirm(v, or_number='B')
        self.assertEqual(res.status_code, 409)
        a = Assessment.objects.get(violation=v)
        self.assertEqual(a.or_number, 'A')
        self.assertEqual(a.date_paid, first_date)

    def test_requires_processing_status(self):
        v = self._make_violation(self.enforcer_a, 'OVR-A-502')
        self.assertEqual(self.confirm(v).status_code, 400)
        v.refresh_from_db()
        self.assertEqual(v.status, 'pending')

    def test_rolls_back_atomically_on_failure(self):
        v = self.processing_violation()
        with mock.patch('violations.views.log_action', side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                self.confirm(v)
        v.refresh_from_db()
        self.assertEqual(v.status, 'processing')
        a = Assessment.objects.filter(violation=v).first()
        self.assertTrue(a is None or (a.amount_paid is None and a.date_paid is None))

    def test_enforcer_cannot_confirm_payment(self):
        v = self.processing_violation()
        res = self.confirm(v, user=self.enforcer_a)
        self.assertEqual(res.status_code, 403)
        v.refresh_from_db()
        self.assertEqual(v.status, 'processing')

    def test_payment_audit_event_has_relevant_values(self):
        v = self.processing_violation()
        self.confirm(v, or_number='OR-9')
        log = AuditLog.objects.filter(module='Payment', target_id=str(v.id)).latest('timestamp')
        self.assertEqual(log.details['event'], 'PAYMENT_CONFIRMED')
        self.assertEqual(log.details['amount_paid'], '500.00')
        self.assertEqual(log.details['or_number'], 'OR-9')
        self.assertEqual(log.details['date_paid'], timezone.localdate().isoformat())
        self.assertNotIn('received_by', log.details)


class StatusPaidBypassClosed(PaymentBase):

    def test_assess_cannot_set_paid(self):
        v = self.processing_violation()
        res = self.as_user(self.staff).patch(
            f'/api/violations/{v.id}/assess/', {'status': 'paid'}, format='json')
        self.assertEqual(res.status_code, 400)
        v.refresh_from_db()
        self.assertEqual(v.status, 'processing')

    def test_generic_patch_cannot_set_paid(self):
        v = self.processing_violation()
        for user in (self.staff, self.admin):
            res = self.as_user(user).patch(
                f'/api/violations/{v.id}/', {'status': 'paid'}, format='json')
            self.assertEqual(res.status_code, 400)
        v.refresh_from_db()
        self.assertEqual(v.status, 'processing')

    def test_create_cannot_set_paid(self):
        res = self.as_user(self.staff).post(
            '/api/violations/create/',
            walk_in_payload(violation_type_ids=[self.vtype.id], status='paid'), format='json')
        self.assertEqual(res.status_code, 400)

    def test_assessment_patch_cannot_bypass_payment(self):
        v = self.processing_violation()
        res = self.as_user(self.staff).patch(
            f'/api/violations/{v.id}/assessment/',
            {'amount_paid': '500', 'date_paid': '2026-01-01', 'or_number': 'X',
             'received_by': 'Me'}, format='json')
        self.assertEqual(res.status_code, 400)
        v.refresh_from_db()
        a = Assessment.objects.get(violation=v)
        self.assertIsNone(a.amount_paid)
        self.assertEqual(v.status, 'processing')

    def test_assessment_patch_still_accepts_notes(self):
        v = self.processing_violation()
        res = self.as_user(self.staff).patch(
            f'/api/violations/{v.id}/assessment/', {'notes': 'checked'}, format='json')
        self.assertEqual(res.status_code, 200)

    def test_enforcer_cannot_mutate_paid_record(self):
        v = self.processing_violation()
        self.confirm(v)
        res = self.as_user(self.enforcer_a).patch(
            f'/api/violations/{v.id}/', {'remarks': 'edited', 'violator_name': 'X'}, format='json')
        self.assertEqual(res.status_code, 403)
        v.refresh_from_db()
        self.assertNotEqual(v.violator_name, 'X')

    def test_paid_record_violation_types_cannot_be_swapped(self):
        v = self.processing_violation()
        self.confirm(v)
        other = ViolationType.objects.create(code='TST-2', name='Other', penalty_amount=50)
        res = self.as_user(self.staff).patch(
            f'/api/violations/{v.id}/', {'violation_type_ids': [other.id]}, format='json')
        self.assertEqual(res.status_code, 400)


class PrintAndReprint(PaymentBase):

    def paid(self):
        v = self.processing_violation()
        self.confirm(v, or_number='OR-5')
        v.refresh_from_db()
        return v

    def snapshot(self, v):
        a = Assessment.objects.get(violation=v)
        v.refresh_from_db()
        return (v.status, a.amount_paid, a.date_paid, a.assessed_by_id, a.or_number,
                a.received_by, a.penalty)

    def payload(self, v):
        return self.as_user(self.staff).post(
            f'/api/violations/{v.id}/generate-ticket/', format='json').json()

    def test_payload_carries_persisted_amount_paid(self):
        v = self.paid()
        a = self.payload(v)['assessment']
        self.assertEqual(Decimal(a['amount_paid']), Decimal('500.00'))
        self.assertEqual(a['or_number'], 'OR-5')
        self.assertEqual(a['received_by'], '')
        self.assertEqual(a['date_paid'], timezone.localdate().isoformat())
        self.assertEqual(a['assessed_by_name'], self.staff.full_name)

    def test_blank_or_number_stays_blank_in_payload(self):
        v = self.processing_violation('OVR-A-520')
        self.confirm(v)
        self.assertEqual(self.payload(v)['assessment']['or_number'], '')

    def test_historical_paid_without_amount_is_not_fabricated(self):
        v = self._make_violation(self.enforcer_a, 'OVR-A-530', status='paid')
        Assessment.objects.create(violation=v, or_number='OLD-1')
        a = self.payload(v)['assessment']
        self.assertIsNone(a['amount_paid'])

    def test_print_then_reprint_do_not_change_payment_state(self):
        v = self.paid()
        before = self.snapshot(v)
        c = self.as_user(self.staff)
        r1 = c.patch(f'/api/violations/tickets/{v.id}/mark-printed/')
        r2 = c.patch(f'/api/violations/tickets/{v.id}/mark-printed/')
        self.assertEqual((r1.json()['print_event'], r2.json()['print_event']),
                         ('printed', 'reprinted'))
        self.assertEqual(self.snapshot(v), before)
        self.assertEqual(Assessment.objects.filter(violation=v).count(), 1)

    def test_print_audit_events_are_distinguishable(self):
        v = self.paid()
        c = self.as_user(self.staff)
        c.patch(f'/api/violations/tickets/{v.id}/mark-printed/')
        c.patch(f'/api/violations/tickets/{v.id}/mark-printed/')
        events = list(AuditLog.objects.filter(module='Assessment', target_id=str(v.id),
                                              details__event__startswith='ASSESSMENT_FORM')
                      .order_by('timestamp').values_list('details__event', flat=True))
        self.assertEqual(events, ['ASSESSMENT_FORM_PRINTED', 'ASSESSMENT_FORM_REPRINTED'])
        self.assertEqual(AuditLog.objects.filter(
            module='Payment', target_id=str(v.id)).count(), 1)

    def test_mark_printed_requires_paid(self):
        v = self.processing_violation('OVR-A-540')
        res = self.as_user(self.staff).patch(f'/api/violations/tickets/{v.id}/mark-printed/')
        self.assertEqual(res.status_code, 409)
        v.refresh_from_db()
        self.assertFalse(v.is_printed)

    def test_generate_ticket_does_not_write_payment_or_create_rows(self):
        v = self.paid()
        before = (self.snapshot(v), AuditLog.objects.count())
        self.payload(v)
        self.assertEqual((self.snapshot(v), AuditLog.objects.count()), before)