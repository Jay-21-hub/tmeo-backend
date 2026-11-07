"""
Personal (recipient_user) notifications: visibility, read state, SSE scope,
history guard. Run:
    python manage.py test notifications.test_personal_notifications --settings=core.test_settings
"""
from rest_framework.test import APITestCase

from accounts.history_guard import get_user_historical_references
from accounts.models import CustomUser
from notifications.models import Notification
from notifications.views_sse import _initial_last_id
from notifications.visibility import visible_to


def mk(n, role):
    return CustomUser.objects.create_user(
        email=f'pn-{role}{n}@tmeo.test', password='TmeoTest!2026',
        full_name=f'PN {role.title()} {n}', id_number=f'2026-{role[:3].upper()}-{n:04d}', role=role,
    )


def personal_for(user, title='New Duty Assignment'):
    return Notification.objects.create(
        recipient_role='enforcer', recipient_user=user, notif_type='duty_assigned',
        title=title, message='personal',
    )


class PersonalVisibility(APITestCase):
    def setUp(self):
        self.a, self.b = mk(1, 'enforcer'), mk(2, 'enforcer')
        self.staff, self.admin = mk(1, 'staff'), mk(1, 'admin')
        self.mine = personal_for(self.a)

    def ids(self, user):
        self.client.force_authenticate(user)
        d = self.client.get('/api/notifications/').json()
        return {n['id'] for n in d['notifications']}, d['unread_count']

    def test_only_recipient_sees_it_with_unread_count(self):
        self.assertEqual(self.ids(self.a), ({self.mine.id}, 1))
        for other in (self.b, self.staff, self.admin):
            self.assertEqual(self.ids(other), (set(), 0))

    def test_mark_read_is_per_user_and_cannot_touch_others(self):
        self.client.force_authenticate(self.b)
        self.client.post(f'/api/notifications/{self.mine.id}/read/')
        self.mine.refresh_from_db()
        self.assertFalse(self.mine.is_read)
        self.client.force_authenticate(self.a)
        self.client.post(f'/api/notifications/{self.mine.id}/read/')
        self.mine.refresh_from_db()
        self.assertTrue(self.mine.is_read)

    def test_mark_all_only_affects_own_rows(self):
        theirs = personal_for(self.b)
        self.client.force_authenticate(self.a)
        self.client.post('/api/notifications/read/')
        self.mine.refresh_from_db(); theirs.refresh_from_db()
        self.assertTrue(self.mine.is_read)
        self.assertFalse(theirs.is_read)

    def test_role_broadcast_is_still_shared(self):
        Notification.objects.create(recipient_role='admin', notif_type='violation_paid', title='Paid', message='m')
        admin2 = mk(2, 'admin')
        self.assertEqual(self.ids(self.admin)[1], 1)
        self.assertEqual(self.ids(admin2)[1], 1)
        self.client.force_authenticate(self.admin)
        self.client.post('/api/notifications/read/')
        self.assertEqual(self.ids(admin2)[1], 0)   # legacy shared read state preserved

    def test_converted_account_keeps_own_personal_but_others_still_cannot_see(self):
        self.a.role = 'staff'; self.a.save()
        self.assertEqual(self.ids(self.a)[0], {self.mine.id})
        self.assertEqual(self.ids(self.staff)[0], set())


class SseScope(APITestCase):
    def setUp(self):
        self.a, self.b = mk(1, 'enforcer'), mk(2, 'enforcer')

    def test_poll_filter_does_not_leak_personal_rows(self):
        last_a = _initial_last_id('enforcer', self.a.id)
        last_b = _initial_last_id('enforcer', self.b.id)
        n = personal_for(self.a)
        a_feed = Notification.objects.filter(visible_to(self.a.id, 'enforcer'), id__gt=last_a)
        b_feed = Notification.objects.filter(visible_to(self.b.id, 'enforcer'), id__gt=last_b)
        self.assertEqual(list(a_feed), [n])
        self.assertEqual(list(b_feed), [])

    def test_initial_last_id_counts_own_personal_rows_only(self):
        n = personal_for(self.a)
        self.assertEqual(_initial_last_id('enforcer', self.a.id), n.id)
        self.assertEqual(_initial_last_id('enforcer', self.b.id), 0)
        self.assertEqual(_initial_last_id('enforcer'), 0)   # legacy role-only call


class HistoryGuard(APITestCase):
    def test_received_notification_counts_as_history(self):
        u = mk(1, 'enforcer')
        self.assertFalse(get_user_historical_references(u)['has_history'])
        personal_for(u)
        ref = get_user_historical_references(u)
        self.assertTrue(ref['has_history'])
        self.assertIn('notifications_received', ref['categories'])


class VisibleToGuards(APITestCase):
    def test_none_user_id_never_matches_other_roles_broadcasts(self):
        Notification.objects.create(recipient_role='admin', notif_type='violation_paid', title='T', message='m')
        self.assertFalse(Notification.objects.filter(visible_to(None, 'staff')).exists())