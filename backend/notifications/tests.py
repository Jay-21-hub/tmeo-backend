from django.test import TestCase
from rest_framework.test import APITestCase
from accounts.models import CustomUser
from .models import Notification
from .views_sse import _initial_last_id


class SSEInitialLastIdDoesNotReplayUnread(TestCase):
    """Regression test for the duplicate-notification bug after Mark as
    Paid: an SSE connection used to start counting 'new' notifications
    from (oldest-unread-id - 1), which meant the very first poll after
    connecting re-pushed any notification that was already unread (and
    already delivered once by the initial REST fetch on mount) as if it
    were brand new. useNotifications.js prepends SSE pushes without
    de-duplicating by id, so that re-push showed up as a second, duplicate
    entry — most visibly the "Violation Paid" notification, since it's
    still unread moments after Mark as Paid completes."""

    @classmethod
    def setUpTestData(cls):
        cls.staff = CustomUser.objects.create_user(
            email='staff@t.test', password='x', full_name='Staff One',
            id_number='S-1', role='staff',
        )

    def test_does_not_rewind_before_an_unread_notification(self):
        existing = Notification.objects.create(
            recipient_role='staff', notif_type='violation_paid',
            title='Violation Paid', message='Violation #1 has been marked as paid.',
        )
        self.assertFalse(existing.is_read)

        last_id = _initial_last_id('staff')

        # The bug: last_id used to be existing.id - 1, so the very next
        # poll's `id__gt=last_id` filter would match (and re-push) this
        # already-delivered, still-unread notification a second time.
        self.assertEqual(last_id, existing.id)
        self.assertFalse(
            Notification.objects.filter(recipient_role='staff', id__gt=last_id).exists(),
            'an already-unread notification must not be replayed on a fresh SSE connect',
        )

    def test_a_genuinely_new_notification_after_connect_still_streams(self):
        last_id = _initial_last_id('staff')  # no notifications yet -> 0
        fresh = Notification.objects.create(
            recipient_role='staff', notif_type='violation_paid',
            title='Violation Paid', message='Violation #2 has been marked as paid.',
        )
        self.assertTrue(
            Notification.objects.filter(recipient_role='staff', id__gt=last_id, pk=fresh.pk).exists(),
            'a notification created after connect must still be picked up by the next poll',
        )

    def test_scoped_to_the_requested_role_only(self):
        Notification.objects.create(
            recipient_role='admin', notif_type='violation_paid',
            title='Violation Paid', message='Admin-side copy.',
        )
        # A staff connection must not be affected by an admin-role row.
        self.assertEqual(_initial_last_id('staff'), 0)


class NotificationListViewRecipientRoleVisibility(APITestCase):
    """Regression tests for Requirement #11.

    NotificationListView used to filter by
    `Q(related_user=request.user) | Q(related_user=None)` in addition to
    `recipient_role`. related_user is only ever set to the individual
    Enforcer who triggered a New Violation notification (audit/reference
    data) — it is never the notification's recipient. Because every
    Staff/Admin user shares the same 'staff'/'admin' recipient_role inbox,
    that extra clause silently hid New Violation notifications from every
    Staff/Admin user.

    The fix: recipient_role is the only visibility gate. related_user stays
    on the row for audit/reference but never restricts who can see it.
    """

    @classmethod
    def setUpTestData(cls):
        cls.enforcer = CustomUser.objects.create_user(
            email='enforcer@t.test', password='x', full_name='Enforcer One',
            id_number='E-1', role='enforcer',
        )
        cls.staff = CustomUser.objects.create_user(
            email='staff@t.test', password='x', full_name='Staff One',
            id_number='S-1', role='staff',
        )
        cls.staff2 = CustomUser.objects.create_user(
            email='staff2@t.test', password='x', full_name='Staff Two',
            id_number='S-2', role='staff',
        )
        cls.admin = CustomUser.objects.create_user(
            email='admin@t.test', password='x', full_name='Admin One',
            id_number='A-1', role='admin',
        )

    def _titles(self, res):
        return [n['title'] for n in res.data['notifications']]

    def test_staff_sees_new_violation_notification_when_related_user_is_enforcer(self):
        Notification.objects.create(
            recipient_role='staff', notif_type='new_violation',
            title='New Violation Submitted', message='Enforcer filed a violation.',
            related_user=self.enforcer, related_violation_id='1',
        )
        self.client.force_authenticate(self.staff)
        res = self.client.get('/api/notifications/')
        self.assertEqual(res.status_code, 200)
        self.assertIn('New Violation Submitted', self._titles(res))

    def test_admin_sees_new_violation_notification_when_related_user_is_enforcer(self):
        Notification.objects.create(
            recipient_role='admin', notif_type='new_violation',
            title='New Violation Submitted', message='Enforcer filed a violation.',
            related_user=self.enforcer, related_violation_id='1',
        )
        self.client.force_authenticate(self.admin)
        res = self.client.get('/api/notifications/')
        self.assertEqual(res.status_code, 200)
        self.assertIn('New Violation Submitted', self._titles(res))

    def test_recipient_role_isolation(self):
        Notification.objects.create(
            recipient_role='admin', notif_type='new_violation',
            title='Admin-Only Notice', message='For admin eyes.',
            related_user=self.enforcer,
        )
        self.client.force_authenticate(self.staff)
        res = self.client.get('/api/notifications/')
        self.assertEqual(res.status_code, 200)
        self.assertNotIn('Admin-Only Notice', self._titles(res))

        self.client.force_authenticate(self.admin)
        res = self.client.get('/api/notifications/')
        self.assertIn('Admin-Only Notice', self._titles(res))

    def test_second_staff_user_also_sees_it_not_just_the_creator(self):
        # No single user is "the recipient" — the whole staff role is.
        Notification.objects.create(
            recipient_role='staff', notif_type='new_violation',
            title='New Violation Submitted', message='Enforcer filed a violation.',
            related_user=self.enforcer,
        )
        self.client.force_authenticate(self.staff2)
        res = self.client.get('/api/notifications/')
        self.assertIn('New Violation Submitted', self._titles(res))

    def test_mark_as_paid_notification_visibility_still_works(self):
        # Mark-as-Paid notifications are created with no related_user at
        # all; this must keep working after the fix.
        Notification.objects.create(
            recipient_role='staff', notif_type='violation_paid',
            title='Violation Paid', message='Violation #7 has been marked as paid.',
        )
        self.client.force_authenticate(self.staff)
        res = self.client.get('/api/notifications/')
        self.assertIn('Violation Paid', self._titles(res))

    def test_related_user_is_preserved_as_audit_reference(self):
        notif = Notification.objects.create(
            recipient_role='staff', notif_type='new_violation',
            title='New Violation Submitted', message='Enforcer filed a violation.',
            related_user=self.enforcer,
        )
        notif.refresh_from_db()
        self.assertEqual(notif.related_user_id, self.enforcer.id)

        self.client.force_authenticate(self.staff)
        res = self.client.get('/api/notifications/')
        served = next(n for n in res.data['notifications'] if n['title'] == 'New Violation Submitted')
        self.assertEqual(served['related_user'], self.enforcer.id)

    def test_no_duplicate_notifications_returned(self):
        Notification.objects.create(
            recipient_role='staff', notif_type='new_violation',
            title='New Violation Submitted', message='Enforcer filed a violation.',
            related_user=self.enforcer, related_violation_id='42',
        )
        self.client.force_authenticate(self.staff)
        res = self.client.get('/api/notifications/')
        titles = self._titles(res)
        self.assertEqual(titles.count('New Violation Submitted'), 1)

    def test_end_to_end_violation_creation_produces_visible_notification(self):
        from django.utils import timezone
        from violations.models import Violation, ViolationType

        vtype = ViolationType.objects.create(
            code='NTF-1', name='Notification Test Violation', penalty_amount=500,
        )
        self.client.force_authenticate(self.enforcer)
        payload = {
            'violator_name': 'DELA CRUZ, JUAN',
            'license_number': 'D07-25-000928',
            'address': '123 Private Address',
            'plate_number': 'ABC1234',
            'ovr_number': 'OVR-NTF-001',
            'location': 'Test Location',
            'date_issued': timezone.now().isoformat(),
            'source': Violation.Source.ENFORCER_OVR,
            'violation_type_ids': [vtype.id],
        }
        res = self.client.post('/api/violations/create/', payload, format='json')
        self.assertEqual(res.status_code, 201, res.data)

        self.client.force_authenticate(self.staff)
        list_res = self.client.get('/api/notifications/')
        self.assertIn('New Violation Submitted', self._titles(list_res))

        self.client.force_authenticate(self.admin)
        list_res = self.client.get('/api/notifications/')
        self.assertIn('New Violation Submitted', self._titles(list_res))