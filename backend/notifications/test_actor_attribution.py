"""
Notification actor / role attribution tests.

The notification must describe WHO PERFORMED the event (stored actor +
authoritative role), never who is viewing it.

Run with:  python manage.py test notifications.test_actor_attribution
"""
from decimal import Decimal
from unittest import mock

from django.utils import timezone

from notifications.models import Notification
from violations import tests as base
from violations.models import Assessment, Violation


class ActorBase(base.BaseRoleTestCase):

    def enforcer_submits(self, ovr='OVR-N-001'):
        res = self.as_user(self.enforcer_a).post('/api/violations/create/', {
            'violator_name': 'DELA CRUZ, JUAN', 'plate_number': 'XYZ9876',
            'vehicle_type': 'car', 'date_issued': timezone.now().isoformat(),
            'location': 'Quezon Avenue', 'violation_type_ids': [str(self.vtype.id)],
            'ovr_number': ovr,
        }, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return Violation.objects.get(pk=res.json()['id'])

    def staff_walk_in(self):
        res = self.as_user(self.staff).post('/api/violations/create/', {
            'source': 'staff_walk_in', 'violator_name': 'WALK IN',
            'date_issued': timezone.now().isoformat(),
            'violation_type_ids': [str(self.vtype.id)],
        }, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return Violation.objects.get(pk=res.json()['id'])

    def assess(self, v):
        res = self.as_user(self.staff).patch(
            f'/api/violations/{v.id}/assess/', {'status': 'processing'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)

    def confirm(self, v, **body):
        return self.as_user(self.staff).post(
            f'/api/violations/{v.id}/confirm-payment/', body, format='json')

    def notifs(self, v, notif_type=None, role=None):
        qs = Notification.objects.filter(related_violation_id=str(v.id))
        if notif_type:
            qs = qs.filter(notif_type=notif_type)
        if role:
            qs = qs.filter(recipient_role=role)
        return qs

    def listing(self, user):
        res = self.as_user(user).get('/api/notifications/')
        self.assertEqual(res.status_code, 200)
        return res.json()


class SubmissionNotification(ActorBase):

    def test_1_enforcer_submission_identifies_the_actual_enforcer(self):
        v = self.enforcer_submits()
        for role in ('staff', 'admin'):
            n = self.notifs(v, 'new_violation', role).get()
            self.assertIn(f'Enforcer {self.enforcer_a.full_name}', n.message)
            self.assertEqual(n.related_user, self.enforcer_a)

    def test_staff_walk_in_is_never_called_an_enforcer(self):
        v = self.staff_walk_in()
        for role in ('staff', 'admin'):
            n = self.notifs(v, 'new_violation', role).get()
            self.assertNotIn('Enforcer', n.message)
            self.assertIn(f'Assessment Staff {self.staff.full_name}', n.message)
            self.assertEqual(n.related_user, self.staff)

    def test_2_staff_viewing_does_not_change_submission_actor(self):
        v = self.enforcer_submits()
        before = list(self.notifs(v, 'new_violation').values_list('id', 'message', 'related_user_id'))
        self.as_user(self.staff).get(f'/api/violations/{v.id}/')
        self.listing(self.staff)
        after = list(self.notifs(v, 'new_violation').values_list('id', 'message', 'related_user_id'))
        self.assertEqual(before, after)

    def test_3_staff_assessing_is_not_relabelled_as_enforcer(self):
        v = self.enforcer_submits()
        self.assess(v)
        assessed = self.notifs(v, 'new_violation').filter(title='Violation Assessed').get()
        self.assertIn(f'Assessment Staff {self.staff.full_name}', assessed.message)
        self.assertNotIn('Enforcer', assessed.message)
        sub = self.notifs(v, 'new_violation', 'staff').get(title='New Violation Submitted')
        self.assertIn(f'Enforcer {self.enforcer_a.full_name}', sub.message)


class PaymentNotification(ActorBase):

    def paid(self):
        v = self.enforcer_submits()
        self.assess(v)
        self.assertEqual(self.confirm(v, or_number='OR-1').status_code, 200)
        return v

    def test_4_confirm_payment_creates_violation_paid(self):
        v = self.paid()
        for role in ('staff', 'admin'):
            n = self.notifs(v, 'violation_paid', role).get()
            self.assertEqual(n.title, 'Violation Paid')
            self.assertIn(f'Violation #{v.id}', n.message)
            self.assertIn(v.violator_name, n.message)

    def test_5_payment_is_not_a_new_violation_submitted(self):
        v = self.paid()
        self.assertFalse(self.notifs(v, 'violation_paid').filter(title='New Violation Submitted').exists())
        self.assertFalse(self.notifs(v, 'violation_paid').filter(message__icontains='submitted').exists())

    def test_6_payment_actor_is_authenticated_staff(self):
        v = self.paid()
        for n in self.notifs(v, 'violation_paid'):
            self.assertEqual(n.related_user, self.staff)
            self.assertIn(f'Assessment Staff {self.staff.full_name}', n.message)
            self.assertNotIn(f'Enforcer {self.staff.full_name}', n.message)

    def test_7_amount_comes_from_persisted_amount_paid(self):
        v = self.enforcer_submits()
        self.assess(v)
        ViolationTypeSnapshotGuard = Violation.objects.filter(pk=v.pk)
        self.confirm(v)
        a = Assessment.objects.get(violation=v)
        self.assertEqual(a.amount_paid, Decimal('500.00'))
        # Make the ticket-level penalty disagree AFTER payment: the message
        # was built from the persisted payment, not from penalty_amount.
        ViolationTypeSnapshotGuard.update(penalty_amount=Decimal('1.00'))
        n = self.notifs(v, 'violation_paid', 'admin').get()
        self.assertIn('\u20b1500.00', n.message)
        self.assertNotIn('\u20b11.00', n.message)

    def test_10_confirm_payment_creates_no_submission_notification(self):
        v = self.enforcer_submits()
        self.assess(v)
        before = self.notifs(v, 'new_violation').count()
        self.confirm(v)
        self.assertEqual(self.notifs(v, 'new_violation').count(), before)

    def test_walk_in_flow_one_submission_per_recipient_one_paid_per_recipient(self):
        v = self.staff_walk_in()
        self.assess(v)
        self.confirm(v)
        for role in ('staff', 'admin'):
            self.assertEqual(self.notifs(v, 'new_violation', role).filter(title='New Violation Submitted').count(), 1)
            self.assertEqual(self.notifs(v, 'violation_paid', role).count(), 1)
        for n in self.notifs(v):
            self.assertNotIn('Enforcer', n.message)

    def test_11_single_confirm_creates_exactly_one_paid_per_recipient(self):
        v = self.paid()
        self.assertEqual(self.notifs(v, 'violation_paid').count(), 2)   # staff + admin, once each

    def test_12_repeated_or_failed_confirm_creates_no_extra_payment_notification(self):
        v = self.paid()
        count = self.notifs(v, 'violation_paid').count()
        self.assertEqual(self.confirm(v).status_code, 409)               # repeat
        self.assertEqual(self.notifs(v, 'violation_paid').count(), count)

        w = self.enforcer_submits('OVR-N-002')
        self.assess(w)
        with mock.patch('violations.views.log_action', side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                self.confirm(w)
        self.assertEqual(self.notifs(w, 'violation_paid').count(), 0)
        w.refresh_from_db()
        self.assertEqual(w.status, 'processing')

    def test_confirm_on_unassessed_violation_creates_no_paid_notification(self):
        v = self.enforcer_submits('OVR-N-003')
        self.assertEqual(self.confirm(v).status_code, 400)
        self.assertEqual(self.notifs(v, 'violation_paid').count(), 0)


class ViewerIsNotActor(ActorBase):

    def snapshot(self, v):
        return list(self.notifs(v).order_by('id').values_list(
            'id', 'title', 'message', 'related_user_id', 'is_read'))

    def setUp(self):
        self.v = self.enforcer_submits()
        self.assess(self.v)
        self.confirm(self.v)

    def test_8_admin_viewing_does_not_alter_actor(self):
        before = [r[:4] for r in self.snapshot(self.v)]
        data = self.listing(self.admin)
        self.assertEqual([r[:4] for r in self.snapshot(self.v)], before)
        by_title = {n['title']: n for n in data['notifications'] if n['related_violation_id'] == str(self.v.id)}
        self.assertEqual(by_title['New Violation Submitted']['actor_role'], 'enforcer')
        self.assertEqual(by_title['New Violation Submitted']['actor_name'], self.enforcer_a.full_name)
        self.assertEqual(by_title['Violation Paid']['actor_role'], 'staff')
        self.assertEqual(by_title['Violation Paid']['actor_name'], self.staff.full_name)

    def test_9_staff_viewing_does_not_alter_actor(self):
        before = [r[:4] for r in self.snapshot(self.v)]
        data = self.listing(self.staff)
        self.as_user(self.staff).post('/api/notifications/read/')
        self.assertEqual([r[:4] for r in self.snapshot(self.v)], before)
        sub = [n for n in data['notifications']
               if n['title'] == 'New Violation Submitted' and n['related_violation_id'] == str(self.v.id)][0]
        self.assertEqual(sub['actor_role'], 'enforcer')
        self.assertNotEqual(sub['actor_name'], self.staff.full_name)


class ReadStateAndApiCompat(ActorBase):

    def setUp(self):
        self.v = self.enforcer_submits()
        self.assess(self.v)
        self.confirm(self.v)

    def test_13_mark_all_read_still_works(self):
        self.assertGreater(self.listing(self.staff)['unread_count'], 0)
        self.assertEqual(self.as_user(self.staff).post('/api/notifications/read/').status_code, 200)
        self.assertEqual(self.listing(self.staff)['unread_count'], 0)
        self.assertGreater(self.listing(self.admin)['unread_count'], 0)    # other inbox untouched

    def test_14_individual_read_still_works(self):
        items = self.listing(self.staff)['notifications']
        first, unread_before = items[0], self.listing(self.staff)['unread_count']
        self.as_user(self.staff).post(f"/api/notifications/{first['id']}/read/")
        self.assertEqual(self.listing(self.staff)['unread_count'], unread_before - 1)
        now = {n['id']: n for n in self.listing(self.staff)['notifications']}
        self.assertTrue(now[first['id']]['is_read'])
        others = [n for i, n in now.items() if i != first['id']]
        self.assertTrue(any(not n['is_read'] for n in others))

    def test_15_api_response_is_backward_compatible(self):
        data = self.listing(self.staff)
        self.assertEqual(set(data), {'notifications', 'unread_count'})
        old = {'id', 'notif_type', 'title', 'message', 'is_read', 'related_user',
               'related_violation_id', 'created_at', 'time_ago'}
        for n in data['notifications']:
            self.assertTrue(old <= set(n))
            self.assertEqual(set(n) - old, {'actor_name', 'actor_role', 'actor_certainty'})   # additive only (Phase 3 adds actor_certainty)