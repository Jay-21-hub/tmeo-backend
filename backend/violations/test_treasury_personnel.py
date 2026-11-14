"""
Treasury Personnel ("Received by" pick-list) tests.

Run with:  python manage.py test violations.test_treasury_personnel
"""
from audit.models import AuditLog
from violations.models import Assessment, TreasuryPersonnel
from violations.test_assessment_payment import PaymentBase

LIST_URL = '/api/violations/treasury-personnel/'


def detail_url(pk):
    return f'{LIST_URL}{pk}/'


class TreasuryPersonnelEndpoints(PaymentBase):

    def make(self, name='Maria Cruz', position='City Treasurer', **kw):
        return TreasuryPersonnel.objects.create(full_name=name, position=position, **kw)

    # ── permissions ────────────────────────────────────────────────────
    def test_admin_can_create(self):
        res = self.as_user(self.admin).post(
            LIST_URL, {'full_name': '  Maria   Cruz ', 'position': 'Cashier'}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()['full_name'], 'Maria Cruz')
        self.assertTrue(AuditLog.objects.filter(module='Treasury Personnel', action='CREATE').exists())

    def test_staff_and_enforcer_cannot_create(self):
        for user in (self.staff, self.enforcer_a):
            res = self.as_user(user).post(LIST_URL, {'full_name': 'X'}, format='json')
            self.assertEqual(res.status_code, 403)
        self.assertEqual(TreasuryPersonnel.objects.count(), 0)

    def test_staff_and_enforcer_cannot_edit_or_delete(self):
        p = self.make()
        for user in (self.staff, self.enforcer_a):
            self.assertEqual(
                self.as_user(user).patch(detail_url(p.id), {'full_name': 'Hack'}, format='json').status_code, 403)
            self.assertEqual(self.as_user(user).delete(detail_url(p.id)).status_code, 403)
        p.refresh_from_db()
        self.assertEqual(p.full_name, 'Maria Cruz')

    def test_enforcer_cannot_list(self):
        self.assertEqual(self.as_user(self.enforcer_a).get(LIST_URL).status_code, 403)

    def test_staff_list_shows_active_only_admin_sees_all(self):
        self.make('Active One')
        self.make('Gone Two', is_active=False)
        staff_names = [r['full_name'] for r in self.as_user(self.staff).get(LIST_URL).json()]
        admin_names = [r['full_name'] for r in self.as_user(self.admin).get(LIST_URL).json()]
        self.assertEqual(staff_names, ['Active One'])
        self.assertEqual(sorted(admin_names), ['Active One', 'Gone Two'])

    def test_duplicate_name_rejected_case_insensitive(self):
        self.make('Maria Cruz')
        res = self.as_user(self.admin).post(LIST_URL, {'full_name': 'maria cruz'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('full_name', res.json())

    def test_blank_name_rejected(self):
        res = self.as_user(self.admin).post(LIST_URL, {'full_name': '   '}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_edit_is_audited_with_before_after(self):
        p = self.make()
        res = self.as_user(self.admin).patch(
            detail_url(p.id), {'position': 'Head Cashier', 'is_active': False}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        log = AuditLog.objects.filter(module='Treasury Personnel', action='UPDATE').latest('timestamp')
        self.assertIn('position', str(log.changes))
        self.assertIn('Head Cashier', str(log.changes))

    def test_delete_unused_ok_but_used_is_refused(self):
        unused = self.make('Unused Person')
        self.assertEqual(self.as_user(self.admin).delete(detail_url(unused.id)).status_code, 204)
        used = self.make('Used Person')
        v = self.processing_violation()
        self.assertEqual(self.confirm(v, received_by_personnel=used.id).status_code, 200)
        self.assertEqual(self.as_user(self.admin).delete(detail_url(used.id)).status_code, 409)
        self.assertTrue(TreasuryPersonnel.objects.filter(pk=used.pk).exists())


class ConfirmPaymentReceivedBy(PaymentBase):

    def make(self, name='Maria Cruz', position='City Treasurer', **kw):
        return TreasuryPersonnel.objects.create(full_name=name, position=position, **kw)

    def test_chosen_personnel_is_recorded_with_snapshot(self):
        p = self.make()
        v = self.processing_violation()
        res = self.confirm(v, received_by_personnel=p.id)
        self.assertEqual(res.status_code, 200, res.content)
        a = Assessment.objects.get(violation=v)
        self.assertEqual(a.received_by_personnel_id, p.id)
        self.assertEqual(a.received_by, 'Maria Cruz')
        self.assertEqual(a.received_by_position, 'City Treasurer')

    def test_snapshot_survives_rename_and_deactivation(self):
        p = self.make()
        v = self.processing_violation()
        self.confirm(v, received_by_personnel=p.id)
        p.full_name, p.position, p.is_active = 'Renamed Person', 'Other', False
        p.save()
        a = Assessment.objects.get(violation=v)
        self.assertEqual(a.received_by, 'Maria Cruz')
        self.assertEqual(a.received_by_position, 'City Treasurer')

    def test_omitted_stays_blank_and_never_the_staff_or_assessor(self):
        v = self.processing_violation()
        self.assertEqual(self.confirm(v).status_code, 200)
        a = Assessment.objects.get(violation=v)
        self.assertEqual((a.received_by, a.received_by_position), ('', ''))
        self.assertIsNone(a.received_by_personnel_id)

    def test_free_text_received_by_is_ignored(self):
        v = self.processing_violation()
        self.confirm(v, received_by='Front Desk Clerk', received_by_position='Boss')
        a = Assessment.objects.get(violation=v)
        self.assertEqual((a.received_by, a.received_by_position), ('', ''))

    def test_inactive_personnel_rejected_and_nothing_changes(self):
        p = self.make(is_active=False)
        v = self.processing_violation()
        res = self.confirm(v, received_by_personnel=p.id)
        self.assertEqual(res.status_code, 400)
        self.assertIn('received_by_personnel', res.json())
        v.refresh_from_db()
        self.assertEqual(v.status, 'processing')

    def test_unknown_or_garbage_id_rejected(self):
        v = self.processing_violation()
        for bad in (999999, 'abc'):
            res = self.confirm(v, received_by_personnel=bad)
            self.assertEqual(res.status_code, 400)
        v.refresh_from_db()
        self.assertEqual(v.status, 'processing')

    def test_assessor_is_not_overwritten_by_received_by(self):
        p = self.make()
        v = self.processing_violation()
        before = Assessment.objects.get(violation=v).assessed_by_id
        self.confirm(v, received_by_personnel=p.id)
        self.assertEqual(Assessment.objects.get(violation=v).assessed_by_id, before)

    def test_audit_event_names_the_chosen_person(self):
        p = self.make()
        v = self.processing_violation()
        self.confirm(v, received_by_personnel=p.id)
        log = AuditLog.objects.filter(module='Payment', target_id=str(v.id)).latest('timestamp')
        self.assertEqual(log.details['received_by_name'], 'Maria Cruz')

    def test_assessment_patch_cannot_set_received_by_personnel(self):
        p = self.make()
        v = self.processing_violation()
        res = self.as_user(self.staff).patch(
            f'/api/violations/{v.id}/assessment/', {'received_by_personnel': p.id}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_list_and_record_endpoints_expose_received_by(self):
        p = self.make()
        v = self.processing_violation()
        self.confirm(v, received_by_personnel=p.id)
        rec = self.as_user(self.staff).get(f'/api/violations/{v.id}/assessment/').json()
        self.assertEqual(rec['received_by'], 'Maria Cruz')
        self.assertEqual(rec['received_by_personnel'], p.id)
        rows = self.as_user(self.admin).get('/api/violations/?status=paid').json()
        rows = rows['results'] if isinstance(rows, dict) else rows
        row = next(r for r in rows if r['id'] == v.id)
        self.assertEqual(row['received_by'], 'Maria Cruz')
        self.assertEqual(row['received_by_position'], 'City Treasurer')