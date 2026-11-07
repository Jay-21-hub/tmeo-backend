"""
Personal schedule notifications (Team Scheduling -> affected enforcer only).

Run:  python manage.py test enforcers.test_schedule_notifications --settings=core.test_settings
"""
from datetime import time, timedelta
from unittest import mock

from django.utils import timezone
from django.db import transaction
from django.test import TransactionTestCase
from rest_framework.test import APIClient, APITestCase

from accounts.models import CustomUser
from enforcers.models import EnforcerSchedule
from notifications.models import Notification

BULK = '/api/enforcers/schedules/bulk-assign/'


def mk(n, role):
    return CustomUser.objects.create_user(
        email=f'sn-{role}{n}@tmeo.test', password='TmeoTest!2026',
        full_name=f'SN {role.title()} {n}', id_number=f'2026-{role[:3].upper()}-{n:04d}', role=role,
    )


def day(offset):
    return timezone.localdate() + timedelta(days=offset)


def payload(enforcers, dates, **extra):
    body = {
        'enforcer_ids': [e.id for e in enforcers], 'dates': [str(d) for d in dates],
        'shift_start': '08:00', 'shift_end': '17:00', 'assigned_area': 'Perez Park, Lucena',
    }
    body.update(extra)
    return body


class CommitClient(APIClient):
    """APITestCase wraps each test in a transaction, so on_commit callbacks never
    fire by themselves. This client runs every request inside
    captureOnCommitCallbacks(execute=True), i.e. as if the request committed."""
    case = None

    def request(self, **kwargs):
        with self.case.captureOnCommitCallbacks(execute=True):
            return super().request(**kwargs)


class ScheduleNotificationBase(APITestCase):
    def setUp(self):
        self.client = CommitClient()
        self.client.case = self
        self.admin = mk(1, 'admin')
        self.enf_a = mk(1, 'enforcer')
        self.enf_b = mk(2, 'enforcer')
        self.staff = mk(1, 'staff')
        self.client.force_authenticate(self.admin)

    def personal(self, user=None, **kw):
        qs = Notification.objects.filter(recipient_user__isnull=False, **kw)
        return qs.filter(recipient_user=user) if user else qs


class BulkAssignNotifications(ScheduleNotificationBase):
    def test_new_assignment_notifies_only_the_affected_enforcer(self):
        r = self.client.post(BULK, payload([self.enf_a], [day(1)]), format='json')
        self.assertEqual(r.status_code, 201)
        n = self.personal().get()
        self.assertEqual(n.recipient_user, self.enf_a)
        self.assertEqual(n.recipient_role, 'enforcer')
        self.assertEqual(n.notif_type, 'duty_assigned')
        self.assertEqual(n.title, 'New Duty Assignment')
        self.assertIn('Perez Park, Lucena', n.message)
        self.assertIn('8:00 AM\u20135:00 PM', n.message)
        self.assertEqual(self.personal(self.enf_b).count(), 0)
        self.assertEqual(Notification.objects.filter(recipient_user__in=[self.staff, self.admin]).count(), 0)
        # no role broadcast was created for anybody else
        self.assertFalse(Notification.objects.filter(recipient_user__isnull=True).exists())

    def test_many_dates_make_one_notification_per_enforcer(self):
        dates = [day(i) for i in range(1, 6)]
        r = self.client.post(BULK, payload([self.enf_a, self.enf_b], dates), format='json')
        self.assertEqual(r.status_code, 201)
        self.assertEqual(self.personal().count(), 2)
        self.assertEqual(self.personal(self.enf_a).count(), 1)
        self.assertIn('5 dates', self.personal(self.enf_a).get().message)

    def test_actor_is_the_admin_and_snapshot_is_frozen(self):
        self.client.post(BULK, payload([self.enf_a], [day(1)]), format='json')
        n = self.personal().get()
        self.assertEqual(n.related_user, self.admin)
        self.assertEqual(n.actor_role_snapshot, 'admin')
        self.assertEqual(n.actor_name_snapshot, self.admin.full_name)
        self.admin.full_name = 'Renamed Admin'
        self.admin.save()
        n.is_read = True
        n.save()
        n.refresh_from_db()
        self.assertEqual(n.actor_name_snapshot, 'SN Admin 1')

    def test_conflict_409_creates_nothing(self):
        self.client.post(BULK, payload([self.enf_a], [day(1)]), format='json')
        before = Notification.objects.count()
        r = self.client.post(BULK, payload([self.enf_a], [day(1)], assigned_area='Elsewhere'), format='json')
        self.assertEqual(r.status_code, 409)
        self.assertEqual(Notification.objects.count(), before)

    def test_overwrite_with_change_sends_updated(self):
        self.client.post(BULK, payload([self.enf_a], [day(1)]), format='json')
        r = self.client.post(BULK, payload([self.enf_a], [day(1)], assigned_area='Quezon Ave', overwrite=True), format='json')
        self.assertEqual(r.status_code, 201)
        n = self.personal(self.enf_a, notif_type='duty_updated').get()
        self.assertEqual(n.title, 'Duty Schedule Updated')
        self.assertIn('Quezon Ave', n.message)
        self.assertEqual(self.personal(self.enf_a, notif_type='duty_assigned').count(), 1)

    def test_overwrite_without_change_sends_nothing(self):
        self.client.post(BULK, payload([self.enf_a], [day(1)]), format='json')
        before = Notification.objects.count()
        r = self.client.post(BULK, payload([self.enf_a], [day(1)], overwrite=True), format='json')
        self.assertEqual(r.status_code, 201)
        self.assertEqual(Notification.objects.count(), before)

    def test_notes_only_change_sends_nothing(self):
        self.client.post(BULK, payload([self.enf_a], [day(1)]), format='json')
        before = Notification.objects.count()
        self.client.post(BULK, payload([self.enf_a], [day(1)], notes='bring radio', overwrite=True), format='json')
        self.assertEqual(Notification.objects.count(), before)

    def test_mixed_new_and_changed_dates_give_one_of_each(self):
        self.client.post(BULK, payload([self.enf_a], [day(1)]), format='json')
        self.client.post(BULK, payload([self.enf_a], [day(1), day(2), day(3)], assigned_area='Quezon Ave', overwrite=True), format='json')
        self.assertEqual(self.personal(self.enf_a, notif_type='duty_updated').count(), 1)
        self.assertEqual(self.personal(self.enf_a, notif_type='duty_assigned').count(), 2)  # initial + the 2 new dates

    def test_notification_failure_does_not_break_the_schedule_write(self):
        with mock.patch('notifications.models.Notification.objects.create', side_effect=RuntimeError('boom')):
            r = self.client.post(BULK, payload([self.enf_a], [day(1)]), format='json')
        self.assertEqual(r.status_code, 201)
        self.assertTrue(EnforcerSchedule.objects.filter(enforcer=self.enf_a, date=day(1)).exists())


class SinglePatchDeleteNotifications(ScheduleNotificationBase):
    def make(self, offset=1):
        return EnforcerSchedule.objects.create(
            enforcer=self.enf_a, date=day(offset), shift_start=time(8), shift_end=time(17),
            assigned_area='Perez Park, Lucena', created_by=self.admin,
        )

    def test_single_post_notifies_assigned(self):
        r = self.client.post('/api/enforcers/schedules/', {
            'enforcer': self.enf_a.id, 'date': str(day(2)), 'shift_start': '08:00',
            'shift_end': '17:00', 'assigned_area': 'Perez Park, Lucena',
        }, format='json')
        self.assertEqual(r.status_code, 201)
        self.assertEqual(self.personal(self.enf_a, notif_type='duty_assigned').count(), 1)

    def test_patch_with_change_sends_updated(self):
        s = self.make()
        r = self.client.patch(f'/api/enforcers/schedules/{s.id}/', {'shift_end': '18:00'}, format='json')
        self.assertEqual(r.status_code, 200)
        n = self.personal(self.enf_a, notif_type='duty_updated').get()
        self.assertIn('8:00 AM\u20136:00 PM', n.message)

    def test_patch_without_real_change_sends_nothing(self):
        s = self.make()
        self.client.patch(f'/api/enforcers/schedules/{s.id}/', {'shift_end': '17:00', 'notes': 'x'}, format='json')
        self.assertEqual(Notification.objects.count(), 0)

    def test_delete_future_sends_removed(self):
        s = self.make()
        r = self.client.delete(f'/api/enforcers/schedules/{s.id}/')
        self.assertEqual(r.status_code, 200)
        n = self.personal(self.enf_a, notif_type='duty_removed').get()
        self.assertEqual(n.title, 'Duty Assignment Removed')
        self.assertIn('Perez Park, Lucena', n.message)

    def test_delete_past_sends_nothing(self):
        s = self.make(offset=-3)
        self.client.delete(f'/api/enforcers/schedules/{s.id}/')
        self.assertEqual(Notification.objects.count(), 0)

    def test_existing_notification_is_untouched_by_a_later_role_change(self):
        self.client.post(BULK, payload([self.enf_a], [day(1)]), format='json')
        n = self.personal().get()
        frozen = (n.title, n.message, n.recipient_role, n.recipient_user_id)
        self.enf_a.role = 'staff'
        self.enf_a.save()
        n.refresh_from_db()
        self.assertEqual((n.title, n.message, n.recipient_role, n.recipient_user_id), frozen)


class Boom(Exception):
    pass


class TransactionalDelivery(TransactionTestCase):
    """Real commits/rollbacks (TransactionTestCase), not test-wrapped ones."""

    def setUp(self):
        self.admin, self.enf_a, self.enf_b = mk(1, 'admin'), mk(1, 'enforcer'), mk(2, 'enforcer')
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def bulk(self, enforcer, d=1, **extra):
        return self.client.post(BULK, payload([enforcer], [day(d)], **extra), format='json')

    def notifs(self):
        return Notification.objects.filter(recipient_user__isnull=False)

    def test_commit_creates_notification_and_schedule(self):
        self.assertEqual(self.bulk(self.enf_a).status_code, 201)
        self.assertEqual(EnforcerSchedule.objects.count(), 1)
        n = self.notifs().get()
        self.assertEqual((n.recipient_user, n.related_user, n.notif_type), (self.enf_a, self.admin, 'duty_assigned'))
        self.assertEqual(n.actor_role_snapshot, 'admin')

    def test_notification_waits_for_the_outermost_commit(self):
        with transaction.atomic():
            with transaction.atomic():
                self.assertEqual(self.bulk(self.enf_a).status_code, 201)
            self.assertEqual(self.notifs().count(), 0)     # inner exit is only a savepoint release
        self.assertEqual(self.notifs().count(), 1)

    def test_outer_rollback_produces_zero_notifications(self):
        with self.assertRaises(Boom):
            with transaction.atomic():
                self.assertEqual(self.bulk(self.enf_a).status_code, 201)
                raise Boom()
        self.assertEqual(EnforcerSchedule.objects.count(), 0)
        self.assertEqual(Notification.objects.count(), 0)

    def test_nested_rollback_drops_only_the_rolled_back_part(self):
        with transaction.atomic():
            with self.assertRaises(Boom):
                with transaction.atomic():
                    self.assertEqual(self.bulk(self.enf_a).status_code, 201)
                    raise Boom()                            # inner savepoint rolled back
            self.assertEqual(self.bulk(self.enf_b).status_code, 201)
        self.assertEqual(list(EnforcerSchedule.objects.values_list('enforcer_id', flat=True)), [self.enf_b.id])
        self.assertEqual(list(self.notifs().values_list('recipient_user_id', flat=True)), [self.enf_b.id])

    def test_rollback_of_delete_and_patch_sends_nothing(self):
        s = EnforcerSchedule.objects.create(
            enforcer=self.enf_a, date=day(2), shift_start=time(8), shift_end=time(17),
            assigned_area='Perez Park, Lucena', created_by=self.admin)
        with self.assertRaises(Boom):
            with transaction.atomic():
                self.client.patch(f'/api/enforcers/schedules/{s.id}/', {'shift_end': '18:00'}, format='json')
                self.client.delete(f'/api/enforcers/schedules/{s.id}/')
                raise Boom()
        self.assertTrue(EnforcerSchedule.objects.filter(pk=s.pk).exists())
        self.assertEqual(Notification.objects.count(), 0)

    def test_delivery_failure_after_commit_keeps_the_committed_schedule(self):
        with mock.patch('notifications.models.Notification.objects.create', side_effect=RuntimeError('boom')):
            r = self.bulk(self.enf_a)
        self.assertEqual(r.status_code, 201)
        self.assertEqual(EnforcerSchedule.objects.count(), 1)   # not undone
        self.assertEqual(Notification.objects.count(), 0)
        self.assertEqual(self.bulk(self.enf_b).status_code, 201)  # later requests unaffected
        self.assertEqual(self.notifs().count(), 1)

    def test_failure_for_one_enforcer_does_not_drop_the_others(self):
        real = Notification.objects.create
        def flaky(**kw):
            if kw.get('recipient_user') == self.enf_a:
                raise RuntimeError('boom')
            return real(**kw)
        with mock.patch('notifications.models.Notification.objects.create', side_effect=flaky):
            r = self.client.post(BULK, payload([self.enf_a, self.enf_b], [day(1)]), format='json')
        self.assertEqual(r.status_code, 201)
        self.assertEqual(EnforcerSchedule.objects.count(), 2)
        self.assertEqual(list(self.notifs().values_list('recipient_user_id', flat=True)), [self.enf_b.id])