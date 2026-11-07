from datetime import datetime, time, timedelta, timezone as dt_timezone
from unittest import mock
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from accounts.models import CustomUser
from .models import EnforcerLocation, EnforcerSchedule
from notifications.models import Notification


class UpdateLocationViewTests(APITestCase):
    """
    Regression tests for Bug #2: POST /api/enforcers/update-location/ must
    reject invalid latitude/longitude with a controlled 4xx response
    instead of raising an unhandled HTTP 500.
    """

    def setUp(self):
        self.enforcer = CustomUser.objects.create_user(
            email='enforcer.location@example.com',
            password='TestPass123!',
            full_name='Location Test Enforcer',
            id_number='2026-ENF-9002',
            role=CustomUser.Role.ENFORCER,
        )
        self.client.force_authenticate(user=self.enforcer)
        self.url = reverse('update_location')

    def test_valid_coordinates_update_successfully(self):
        response = self.client.post(
            self.url,
            {'latitude': 13.9333, 'longitude': 121.6167},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(
            EnforcerLocation.objects.filter(enforcer=self.enforcer).exists()
        )

    def test_non_numeric_latitude_returns_400(self):
        response = self.client.post(
            self.url,
            {'latitude': 'not_a_number', 'longitude': 121.6167},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('error', response.data)

    def test_non_numeric_longitude_returns_400(self):
        response = self.client.post(
            self.url,
            {'latitude': 13.9333, 'longitude': 'also_bad'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('error', response.data)

    def test_both_coordinates_non_numeric_returns_400(self):
        response = self.client.post(
            self.url,
            {'latitude': 'not_a_number', 'longitude': 'also_bad'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_latitude_above_range_returns_400(self):
        response = self.client.post(
            self.url,
            {'latitude': 95, 'longitude': 121.6167},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_latitude_below_range_returns_400(self):
        response = self.client.post(
            self.url,
            {'latitude': -95, 'longitude': 121.6167},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_longitude_above_range_returns_400(self):
        response = self.client.post(
            self.url,
            {'latitude': 13.9333, 'longitude': 185},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_longitude_below_range_returns_400(self):
        response = self.client.post(
            self.url,
            {'latitude': 13.9333, 'longitude': -185},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_missing_latitude_returns_400(self):
        response = self.client.post(
            self.url, {'longitude': 121.6167}, format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_missing_longitude_returns_400(self):
        response = self.client.post(
            self.url, {'latitude': 13.9333}, format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_null_coordinates_returns_400(self):
        response = self.client.post(
            self.url,
            {'latitude': None, 'longitude': None},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_enforcer_forbidden(self):
        staff = CustomUser.objects.create_user(
            email='staff.location@example.com',
            password='TestPass123!',
            full_name='Staff Test User',
            id_number='2026-STF-9002',
            role=CustomUser.Role.STAFF,
        )
        self.client.force_authenticate(user=staff)

        response = self.client.post(
            self.url,
            {'latitude': 13.9333, 'longitude': 121.6167},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

class ScheduleListFilterTests(APITestCase):
    """
    Regression test: GET /api/enforcers/schedules/?enforcer=<id> used to be
    silently ignored, returning every enforcer's schedule for the month
    instead of just the requested one.
    """

    def setUp(self):
        self.admin = CustomUser.objects.create_user(
            email='admin.sched@example.com',
            password='TestPass123!',
            full_name='Admin Sched Tester',
            id_number='2026-ADM-9010',
            role=CustomUser.Role.ADMIN,
        )
        self.enforcer_a = CustomUser.objects.create_user(
            email='enforcer.a@example.com',
            password='TestPass123!',
            full_name='Enforcer A',
            id_number='2026-ENF-9010',
            role=CustomUser.Role.ENFORCER,
        )
        self.enforcer_b = CustomUser.objects.create_user(
            email='enforcer.b@example.com',
            password='TestPass123!',
            full_name='Enforcer B',
            id_number='2026-ENF-9011',
            role=CustomUser.Role.ENFORCER,
        )
        EnforcerSchedule.objects.create(
            enforcer=self.enforcer_a, date='2026-09-10',
            shift_start='08:00', shift_end='17:00', assigned_area='Quezon Ave.',
        )
        EnforcerSchedule.objects.create(
            enforcer=self.enforcer_b, date='2026-09-10',
            shift_start='08:00', shift_end='17:00', assigned_area='Merchan St.',
        )
        self.client.force_authenticate(user=self.admin)
        self.url = reverse('schedule_list')

    def test_enforcer_param_filters_results(self):
        response = self.client.get(f'{self.url}?enforcer={self.enforcer_a.id}&month=9&year=2026')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]['enforcer'], self.enforcer_a.id)

    def test_no_enforcer_param_returns_all(self):
        response = self.client.get(f'{self.url}?month=9&year=2026')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 2)

    def test_enforcers_param_filters_by_multiple(self):
        response = self.client.get(
            f'{self.url}?enforcers={self.enforcer_a.id},{self.enforcer_b.id}&month=9&year=2026'
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 2)


class BulkScheduleAssignViewTests(APITestCase):
    """
    Group scheduling: POST /api/enforcers/schedules/bulk-assign/ assigns a
    shared shift to several enforcers across several dates, with a
    warn-then-confirm flow for existing (enforcer, date) schedules.
    """

    def setUp(self):
        self.admin = CustomUser.objects.create_user(
            email='admin.bulk@example.com',
            password='TestPass123!',
            full_name='Admin Bulk Tester',
            id_number='2026-ADM-9020',
            role=CustomUser.Role.ADMIN,
        )
        self.enforcer_a = CustomUser.objects.create_user(
            email='enforcer.bulk.a@example.com',
            password='TestPass123!',
            full_name='Bulk Enforcer A',
            id_number='2026-ENF-9020',
            role=CustomUser.Role.ENFORCER,
        )
        self.enforcer_b = CustomUser.objects.create_user(
            email='enforcer.bulk.b@example.com',
            password='TestPass123!',
            full_name='Bulk Enforcer B',
            id_number='2026-ENF-9021',
            role=CustomUser.Role.ENFORCER,
        )
        self.client.force_authenticate(user=self.admin)
        self.url = reverse('schedule_bulk_assign')
        # Relative to today: the endpoint rejects past dates, so fixed
        # calendar dates would start failing as soon as they went by.
        self.d1 = str(timezone.localdate() + timedelta(days=1))
        self.d2 = str(timezone.localdate() + timedelta(days=2))
        self.payload = {
            'enforcer_ids': [],
            'dates': [self.d1, self.d2],
            'shift_start': '08:00',
            'shift_end': '17:00',
            'assigned_area': 'Quezon Ave., Brgy. 3',
        }

    def test_assigns_all_enforcers_to_all_dates(self):
        payload = {**self.payload, 'enforcer_ids': [self.enforcer_a.id, self.enforcer_b.id]}
        response = self.client.post(self.url, payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['assigned'], 4)  # 2 enforcers x 2 dates
        self.assertEqual(EnforcerSchedule.objects.count(), 4)

    def test_conflict_blocks_write_without_overwrite(self):
        EnforcerSchedule.objects.create(
            enforcer=self.enforcer_a, date=self.d1,
            shift_start='06:00', shift_end='14:00', assigned_area='Existing Area',
        )
        payload = {**self.payload, 'enforcer_ids': [self.enforcer_a.id, self.enforcer_b.id]}
        response = self.client.post(self.url, payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(response.data['status'], 'conflict')
        self.assertEqual(len(response.data['conflicts']), 1)
        # Nothing written yet — only the pre-existing row should exist.
        self.assertEqual(EnforcerSchedule.objects.count(), 1)

    def test_overwrite_true_replaces_conflicting_schedule(self):
        EnforcerSchedule.objects.create(
            enforcer=self.enforcer_a, date=self.d1,
            shift_start='06:00', shift_end='14:00', assigned_area='Existing Area',
        )
        payload = {**self.payload, 'enforcer_ids': [self.enforcer_a.id, self.enforcer_b.id], 'overwrite': True}
        response = self.client.post(self.url, payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        updated = EnforcerSchedule.objects.get(enforcer=self.enforcer_a, date=self.d1)
        self.assertEqual(updated.assigned_area, 'Quezon Ave., Brgy. 3')

    def test_unknown_enforcer_id_returns_400(self):
        payload = {**self.payload, 'enforcer_ids': [999999]}
        response = self.client.post(self.url, payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_admin_forbidden(self):
        self.client.force_authenticate(user=self.enforcer_a)
        payload = {**self.payload, 'enforcer_ids': [self.enforcer_b.id]}
        response = self.client.post(self.url, payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_invalid_shift_range_returns_400(self):
        payload = {**self.payload, 'enforcer_ids': [self.enforcer_a.id], 'shift_start': '17:00', 'shift_end': '08:00'}
        response = self.client.post(self.url, payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)


class BulkScheduleMultiDatePersistenceTests(APITestCase):
    """
    Team Scheduling multi-date correctness: the set of dates POSTed to
    /api/enforcers/schedules/bulk-assign/ must be EXACTLY the set persisted —
    no gap-filling (non-consecutive picks), no dropped dates, one row per
    (enforcer, date). Dates are relative to today so the server-side
    "no past dates" rule never interferes.
    """

    def setUp(self):
        self.admin = CustomUser.objects.create_user(
            email='admin.multi@example.com', password='TestPass123!',
            full_name='Admin Multi Tester', id_number='2026-ADM-9030',
            role=CustomUser.Role.ADMIN,
        )
        self.enforcer = CustomUser.objects.create_user(
            email='enforcer.multi@example.com', password='TestPass123!',
            full_name='Multi Enforcer', id_number='2026-ENF-9030',
            role=CustomUser.Role.ENFORCER,
        )
        self.client.force_authenticate(user=self.admin)
        self.url = reverse('schedule_bulk_assign')
        self.base = timezone.localdate() + timedelta(days=1)

    def _day(self, offset):
        return str(self.base + timedelta(days=offset))

    def _post(self, dates, **extra):
        payload = {
            'enforcer_ids': [self.enforcer.id],
            'dates': dates,
            'shift_start': '08:00:00', 'shift_end': '17:00:00',
            'break_start': '12:00:00', 'break_end': '13:00:00',
            'assigned_area': 'Domoit', 'notes': '',
            **extra,
        }
        return self.client.post(self.url, payload, format='json')

    def _persisted(self):
        return sorted(str(d) for d in EnforcerSchedule.objects.filter(enforcer=self.enforcer).values_list('date', flat=True))

    def test_single_date_creates_exactly_one_row(self):
        response = self._post([self._day(0)])
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['assigned'], 1)
        self.assertEqual(self._persisted(), [self._day(0)])

    def test_five_consecutive_dates_create_five_rows(self):
        dates = [self._day(i) for i in range(5)]
        response = self._post(dates)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['assigned'], 5)
        self.assertEqual(self._persisted(), dates)

    def test_non_consecutive_dates_do_not_fill_gaps(self):
        dates = [self._day(0), self._day(2), self._day(4)]
        response = self._post(dates)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(self._persisted(), dates)
        self.assertNotIn(self._day(1), self._persisted())
        self.assertNotIn(self._day(3), self._persisted())

    def test_deselected_date_is_not_persisted(self):
        # UI: five picked, middle one deselected -> payload carries four.
        dates = [self._day(i) for i in (0, 1, 3, 4)]
        response = self._post(dates)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(self._persisted(), dates)
        self.assertNotIn(self._day(2), self._persisted())

    def test_dates_across_a_month_boundary_all_persist(self):
        first_of_next_month = (timezone.localdate().replace(day=1) + timedelta(days=32)).replace(day=1)
        dates = [str(first_of_next_month - timedelta(days=1)), str(first_of_next_month), str(first_of_next_month + timedelta(days=1))]
        response = self._post(dates)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(self._persisted(), dates)

    def test_existing_schedule_conflict_is_reported_and_nothing_written(self):
        EnforcerSchedule.objects.create(
            enforcer=self.enforcer, date=self._day(2),
            shift_start='06:00', shift_end='14:00', assigned_area='Existing Area',
        )
        response = self._post([self._day(i) for i in range(5)])
        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual([c['date'] for c in response.data['conflicts']], [self._day(2)])
        # Nothing silently overwritten or partially written.
        self.assertEqual(self._persisted(), [self._day(2)])
        self.assertEqual(EnforcerSchedule.objects.get(enforcer=self.enforcer).assigned_area, 'Existing Area')


class TodayDutyAreaTests(APITestCase):
    """
    Dashboard duty strip and GPS Tracking both read GET /api/enforcers/today-status/.
    The operational area for TODAY is EnforcerSchedule.assigned_area (the
    Admin Team Scheduling record), never CustomUser.assigned_area (the
    profile default).
    """

    PROFILE_AREA = 'Profile Default Area'

    def setUp(self):
        self.enforcer = CustomUser.objects.create_user(
            email='enforcer.area@example.com',
            password='TestPass123!',
            full_name='Area Test Enforcer',
            id_number='2026-ENF-9030',
            role=CustomUser.Role.ENFORCER,
            assigned_area=self.PROFILE_AREA,
        )
        self.admin = CustomUser.objects.create_user(
            email='admin.area@example.com',
            password='TestPass123!',
            full_name='Area Test Admin',
            id_number='2026-ADM-9030',
            role=CustomUser.Role.ADMIN,
        )
        self.url = reverse('today_status')
        self.today = timezone.localdate()

    def _schedule(self, area, day=None):
        return EnforcerSchedule.objects.create(
            enforcer=self.enforcer, date=day or self.today,
            shift_start='00:00', shift_end='23:59', assigned_area=area,
        )

    def _today_status(self):
        self.client.force_authenticate(user=self.enforcer)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response.data

    def test_schedule_area_wins_over_different_profile_area(self):
        self._schedule('Domoit')
        data = self._today_status()
        self.assertEqual(data['schedule']['assigned_area'], 'Domoit')
        self.assertNotEqual(data['schedule']['assigned_area'], self.PROFILE_AREA)

    def test_another_schedule_area_is_returned(self):
        self._schedule('Ibabang Dupay')
        self.assertEqual(self._today_status()['schedule']['assigned_area'], 'Ibabang Dupay')

    def test_blank_schedule_area_stays_blank_and_profile_area_does_not_leak(self):
        self._schedule('')
        data = self._today_status()
        self.assertEqual(data['schedule']['assigned_area'], '')
        self.assertNotIn(self.PROFILE_AREA, str(data))

    def test_no_schedule_today_returns_null_schedule_without_stale_area(self):
        # Yesterday's and tomorrow's areas must not leak into today.
        self._schedule('Yesterday Area', self.today - timedelta(days=1))
        self._schedule('Tomorrow Area', self.today + timedelta(days=1))
        data = self._today_status()
        self.assertIsNone(data['schedule'])
        self.assertEqual(data['status'], 'off_duty')
        self.assertNotIn('Yesterday Area', str(data))
        self.assertNotIn('Tomorrow Area', str(data))
        self.assertNotIn(self.PROFILE_AREA, str(data))

    def test_admin_assignment_and_update_are_reflected_in_today_status(self):
        payload = {
            'enforcer_ids': [self.enforcer.id],
            'dates': [str(self.today)],
            'shift_start': '00:00',
            'shift_end': '23:59',
            'assigned_area': 'Domoit',
        }
        bulk_url = reverse('schedule_bulk_assign')
        self.client.force_authenticate(user=self.admin)
        self.assertEqual(self.client.post(bulk_url, payload, format='json').status_code, status.HTTP_201_CREATED)
        self.assertEqual(self._today_status()['schedule']['assigned_area'], 'Domoit')

        # Admin changes today's area (overwrite) -> same EnforcerSchedule row
        # is what today-status reads, so the new area shows up.
        self.client.force_authenticate(user=self.admin)
        response = self.client.post(bulk_url, {**payload, 'assigned_area': 'Gulang-Gulang', 'overwrite': True}, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(EnforcerSchedule.objects.filter(enforcer=self.enforcer, date=self.today).count(), 1)
        self.assertEqual(self._today_status()['schedule']['assigned_area'], 'Gulang-Gulang')


class ManilaDateBoundaryTests(APITestCase):
    """
    Asia/Manila is UTC+8. Between 00:00 and 08:00 Manila time the UTC calendar
    date is still "yesterday". Every "today's schedule" lookup must use the
    Manila date: today-status AND update-location (geofence).
    """

    # 2026-10-02 20:00 UTC == 2026-10-03 04:00 Manila
    FROZEN_UTC = datetime(2026, 10, 2, 20, 0, tzinfo=dt_timezone.utc)
    MANILA_DAY = '2026-10-03'
    UTC_DAY = '2026-10-02'
    FAR_AWAY = {'latitude': 14.5995, 'longitude': 120.9842}   # Manila, ~100 km from Lucena centre

    def setUp(self):
        self.enforcer = CustomUser.objects.create_user(
            email='enforcer.boundary@example.com',
            password='TestPass123!',
            full_name='Boundary Test Enforcer',
            id_number='2026-ENF-9031',
            role=CustomUser.Role.ENFORCER,
        )
        self.client.force_authenticate(user=self.enforcer)

    def _schedule(self, day, area):
        return EnforcerSchedule.objects.create(
            enforcer=self.enforcer, date=day,
            shift_start='00:00', shift_end='23:59', assigned_area=area,
        )

    def test_frozen_instant_really_straddles_two_dates(self):
        with mock.patch('django.utils.timezone.now', return_value=self.FROZEN_UTC):
            self.assertEqual(str(timezone.localdate()), self.MANILA_DAY)
            self.assertEqual(str(timezone.now().date()), self.UTC_DAY)

    def test_today_status_and_update_location_resolve_the_same_manila_schedule(self):
        self._schedule(self.UTC_DAY, 'UTC-Date Area')
        self._schedule(self.MANILA_DAY, 'Manila-Date Area')
        with mock.patch('django.utils.timezone.now', return_value=self.FROZEN_UTC), \
             mock.patch('enforcers.views.send_geofence_alert') as alert:
            data = self.client.get(reverse('today_status')).data
            self.assertEqual(data['schedule']['assigned_area'], 'Manila-Date Area')

            response = self.client.post(reverse('update_location'), self.FAR_AWAY, format='json')
            self.assertEqual(response.status_code, status.HTTP_200_OK)
            self.assertTrue(response.data['geofence_triggered'])
            alert.assert_called_once()

    def test_geofence_uses_manila_date_when_only_the_manila_day_is_scheduled(self):
        # Before the fix this looked up the UTC date, found nothing, and the
        # alert was silently skipped.
        self._schedule(self.MANILA_DAY, 'Manila-Date Area')
        with mock.patch('django.utils.timezone.now', return_value=self.FROZEN_UTC), \
             mock.patch('enforcers.views.send_geofence_alert') as alert:
            response = self.client.post(reverse('update_location'), self.FAR_AWAY, format='json')
            self.assertTrue(response.data['geofence_triggered'])
            alert.assert_called_once()

    def test_geofence_ignores_a_schedule_that_exists_only_on_the_utc_date(self):
        # The UTC "today" is yesterday in Manila: no schedule today -> no alert.
        self._schedule(self.UTC_DAY, 'UTC-Date Area')
        with mock.patch('django.utils.timezone.now', return_value=self.FROZEN_UTC), \
             mock.patch('enforcers.views.send_geofence_alert') as alert:
            self.assertIsNone(self.client.get(reverse('today_status')).data['schedule'])
            response = self.client.post(reverse('update_location'), self.FAR_AWAY, format='json')
            self.assertFalse(response.data['geofence_triggered'])
            alert.assert_not_called()

    def test_geofence_checks_distance_from_lucena_centre_not_the_scheduled_area(self):
        # Documents the real algorithm: with a schedule today, a position
        # inside the 5 km Lucena radius never triggers an alert regardless of
        # what the free-text assigned_area says, and one outside always does.
        self._schedule(self.MANILA_DAY, 'Domoit')
        with mock.patch('django.utils.timezone.now', return_value=self.FROZEN_UTC), \
             mock.patch('enforcers.views.send_geofence_alert') as alert:
            inside = self.client.post(reverse('update_location'), {'latitude': 13.9373, 'longitude': 121.6144}, format='json')
            self.assertFalse(inside.data['geofence_triggered'])
            alert.assert_not_called()
            outside = self.client.post(reverse('update_location'), self.FAR_AWAY, format='json')
            self.assertTrue(outside.data['geofence_triggered'])


class _DutyTestBase(APITestCase):
    """Helpers: an enforcer, an admin, and 'now' pinned to a Manila wall-clock time today."""

    def setUp(self):
        self.enforcer = CustomUser.objects.create_user(
            email='enforcer.duty@example.com', password='TestPass123!',
            full_name='Duty Test Enforcer', id_number='2026-ENF-9040',
            role=CustomUser.Role.ENFORCER, assigned_area='Profile Default Area',
        )
        self.admin = CustomUser.objects.create_user(
            email='admin.duty@example.com', password='TestPass123!',
            full_name='Duty Test Admin', id_number='2026-ADM-9040',
            role=CustomUser.Role.ADMIN,
        )
        self.today = timezone.localdate()
        self.client.force_authenticate(user=self.enforcer)

    def schedule(self, start='08:00', end='17:00', area='Domoit', brk=None, enforcer=None):
        s = EnforcerSchedule.objects.create(
            enforcer=enforcer or self.enforcer, date=self.today,
            shift_start=start, shift_end=end, assigned_area=area,
            break_start=brk[0] if brk else None, break_end=brk[1] if brk else None,
        )
        return s

    def at(self, hour, minute=0):
        """Patch the clock to HH:MM on today's local (configured-TZ) date."""
        aware = timezone.make_aware(datetime.combine(self.today, time(hour, minute)))
        return mock.patch('django.utils.timezone.now', return_value=aware)

    def today_status(self, hour, minute=0):
        with self.at(hour, minute):
            response = self.client.get(reverse('today_status'))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response.data

    def post_location(self, hour, minute=0, **body):
        payload = {'latitude': 13.9373, 'longitude': 121.6144, **body}
        with self.at(hour, minute), mock.patch('enforcers.views.send_geofence_alert') as alert:
            response = self.client.post(reverse('update_location'), payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        response.alert = alert
        return response

    def mirror(self):
        self.enforcer.refresh_from_db()
        return self.enforcer.duty_status

    def set_persisted_duty(self, value):
        """Simulate a stale/previous mirror value exactly as it would be in the DB at request time."""
        CustomUser.objects.filter(pk=self.enforcer.pk).update(duty_status=value)
        self.enforcer.refresh_from_db()    # force_authenticate reuses this instance

    def started_duty_notifications(self):
        return Notification.objects.filter(notif_type='enforcer_on_duty', related_user=self.enforcer).count()


class DutyComputationTests(_DutyTestBase):
    """today-status: one server-computed rule (schedule + local time)."""

    def test_login_without_schedule_is_off_duty_no_schedule(self):
        data = self.today_status(10)
        self.assertEqual((data['status'], data['state'], data['has_schedule']), ('off_duty', 'no_schedule', False))
        self.assertIsNone(data['schedule'])
        self.assertEqual(data['reason'], 'No schedule for today.')

    def test_stale_persisted_on_duty_is_corrected_when_no_schedule(self):
        self.set_persisted_duty('on_duty')
        self.assertEqual(self.mirror(), 'on_duty')            # stale
        data = self.today_status(10)
        self.assertEqual((data['status'], data['state']), ('off_duty', 'no_schedule'))
        self.assertEqual(self.mirror(), 'off_duty')            # mirror now correct

    def test_before_shift(self):
        self.schedule()
        data = self.today_status(7, 59)
        self.assertEqual((data['status'], data['state'], data['has_schedule']), ('off_duty', 'before_shift', True))
        self.assertEqual(data['reason'], 'Outside shift hours.')     # legacy text preserved
        self.assertEqual(self.mirror(), 'off_duty')

    def test_active_shift(self):
        self.schedule()
        data = self.today_status(10)
        self.assertEqual((data['status'], data['state']), ('on_duty', 'on_duty'))
        self.assertEqual(data['reason'], 'Currently on shift.')
        self.assertEqual(self.mirror(), 'on_duty')

    def test_shift_boundaries_are_inclusive_as_before(self):
        self.schedule()
        self.assertEqual(self.today_status(8, 0)['state'], 'on_duty')
        self.assertEqual(self.today_status(17, 0)['state'], 'on_duty')

    def test_break(self):
        self.schedule(brk=('12:00', '13:00'))
        data = self.today_status(12, 30)
        self.assertEqual((data['status'], data['state']), ('on_break', 'on_break'))
        self.assertEqual(self.mirror(), 'on_break')
        self.enforcer.refresh_from_db()
        self.assertIsNotNone(self.enforcer.break_started_at)
        self.assertEqual(self.today_status(13, 30)['state'], 'on_duty')   # back on duty after the break
        self.enforcer.refresh_from_db()
        self.assertIsNone(self.enforcer.break_started_at)

    def test_finished_shift(self):
        self.schedule()
        self.today_status(10)                                   # mirror -> on_duty
        data = self.today_status(18)
        self.assertEqual((data['status'], data['state']), ('off_duty', 'after_shift'))
        self.assertEqual(data['reason'], 'Outside shift hours.')
        self.assertEqual(self.mirror(), 'off_duty')

    def test_schedule_with_area_returns_that_area(self):
        self.schedule(area='Domoit')
        self.assertEqual(self.today_status(10)['schedule']['assigned_area'], 'Domoit')

    def test_schedule_with_blank_area_does_not_leak_profile_area(self):
        self.schedule(area='')
        data = self.today_status(10)
        self.assertTrue(data['has_schedule'])
        self.assertEqual(data['schedule']['assigned_area'], '')
        self.assertNotIn('Profile Default Area', str(data))

    def test_admin_schedule_change_is_picked_up_on_next_read(self):
        self.assertEqual(self.today_status(10)['state'], 'no_schedule')
        self.schedule(area='Gulang-Gulang')
        data = self.today_status(10)
        self.assertEqual((data['state'], data['schedule']['assigned_area']), ('on_duty', 'Gulang-Gulang'))

    def test_non_enforcer_read_does_not_touch_any_mirror(self):
        self.client.force_authenticate(user=self.admin)
        before = CustomUser.objects.get(pk=self.admin.pk).duty_status
        data = self.today_status(10)
        self.assertEqual(data['state'], 'no_schedule')
        self.assertEqual(CustomUser.objects.get(pk=self.admin.pk).duty_status, before)


class DutyStatusEndpointTests(_DutyTestBase):
    """POST /api/auth/duty-status/ is no longer client-authoritative."""

    def post_status(self, value, hour=10):
        with self.at(hour):
            return self.client.post(reverse('duty_status'), {'duty_status': value}, format='json')

    def test_client_cannot_put_unscheduled_enforcer_on_duty(self):
        response = self.post_status('on_duty')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['duty_status'], 'off_duty')
        self.assertEqual(response.data['state'], 'no_schedule')
        self.assertTrue(response.data['overridden'])
        self.assertEqual(self.mirror(), 'off_duty')

    def test_stale_on_duty_can_transition_to_off_duty(self):
        # Previously a 400 ("Cannot set to Off Duty while on shift").
        self.set_persisted_duty('on_duty')
        response = self.post_status('off_duty')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(self.mirror(), 'off_duty')

    def test_client_cannot_go_off_duty_during_a_real_shift(self):
        self.schedule()
        response = self.post_status('off_duty')
        self.assertEqual(response.data['duty_status'], 'on_duty')
        self.assertEqual(self.mirror(), 'on_duty')

    def test_client_cannot_claim_a_break_outside_the_break_window(self):
        self.schedule(brk=('12:00', '13:00'))
        self.assertEqual(self.post_status('on_break', hour=10).data['duty_status'], 'on_duty')

    def test_empty_body_just_synchronizes(self):
        self.schedule()
        with self.at(10):
            response = self.client.post(reverse('duty_status'), {}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['duty_status'], 'on_duty')

    def test_invalid_value_still_rejected(self):
        self.assertEqual(self.post_status('flying').status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_enforcer_forbidden(self):
        self.client.force_authenticate(user=self.admin)
        self.assertEqual(self.post_status('on_duty').status_code, status.HTTP_403_FORBIDDEN)


class LocationDutyTests(_DutyTestBase):
    """update-location: location is not duty; duty is server-computed."""

    def test_location_with_no_schedule_does_not_put_enforcer_on_duty(self):
        response = self.post_location(10, duty_status='on_duty')    # client lies / old client default
        self.assertEqual(response.data['duty_status'], 'off_duty')
        self.assertEqual(response.data['state'], 'no_schedule')
        self.assertEqual(self.mirror(), 'off_duty')
        self.assertEqual(EnforcerLocation.objects.get(enforcer=self.enforcer).status, 'inactive')

    def test_location_without_duty_status_key_no_longer_defaults_to_on_duty(self):
        self.post_location(10)
        self.assertEqual(self.mirror(), 'off_duty')

    def test_location_during_shift_mirrors_on_duty(self):
        self.schedule()
        response = self.post_location(10)
        self.assertEqual(response.data['duty_status'], 'on_duty')
        self.assertEqual(self.mirror(), 'on_duty')
        self.assertEqual(EnforcerLocation.objects.get(enforcer=self.enforcer).status, 'active')

    def test_location_during_break_and_after_shift(self):
        self.schedule(brk=('12:00', '13:00'))
        self.post_location(12, 30)
        self.assertEqual(self.mirror(), 'on_break')
        self.assertEqual(EnforcerLocation.objects.get(enforcer=self.enforcer).status, 'on_break')
        self.post_location(18)
        self.assertEqual(self.mirror(), 'off_duty')

    def test_stale_on_duty_is_corrected_by_a_location_update(self):
        self.set_persisted_duty('on_duty')
        self.post_location(10)
        self.assertEqual(self.mirror(), 'off_duty')

    # ---- "started duty" notification ------------------------------------
    def test_first_location_with_no_schedule_creates_no_started_duty_notification(self):
        self.post_location(10)
        self.assertEqual(self.started_duty_notifications(), 0)

    def test_no_started_duty_notification_before_break_or_after_shift(self):
        self.schedule(brk=('12:00', '13:00'))
        self.post_location(7)        # before shift (also the first-ever location row)
        self.post_location(12, 30)   # on break
        self.post_location(18)       # after shift
        self.assertEqual(self.started_duty_notifications(), 0)

    def test_legitimate_on_duty_location_creates_one_notification_not_one_per_sync(self):
        self.schedule(brk=('12:00', '13:00'))
        self.post_location(9)
        for minute in range(1, 6):    # simulated 15s syncs, plus a break and a return
            self.post_location(9, minute)
        self.post_location(12, 30)
        self.post_location(13, 30)
        self.assertEqual(self.started_duty_notifications(), 1)
        note = Notification.objects.get(notif_type='enforcer_on_duty', related_user=self.enforcer)
        self.assertEqual(note.recipient_role, 'admin')
        self.assertIn('has started duty', note.message)

    def test_first_location_row_creation_alone_no_longer_notifies(self):
        # The old post_save(created) signal fired for the very first row regardless of schedule.
        EnforcerLocation.objects.create(enforcer=self.enforcer, latitude=13.9, longitude=121.6)
        self.assertEqual(self.started_duty_notifications(), 0)

    # ---- logout sentinel -------------------------------------------------
    def _sign_off_setup(self):
        self.schedule(start='00:00', end='23:59')
        self.post_location(10)                                     # a real fix inside Lucena
        return EnforcerLocation.objects.get(enforcer=self.enforcer)

    def test_legacy_logout_zero_zero_payload_triggers_no_geofence_and_keeps_last_real_fix(self):
        real = self._sign_off_setup()
        response = self.post_location(11, latitude=0, longitude=0, duty_status='off_duty')
        response.alert.assert_not_called()
        self.assertFalse(response.data['geofence_triggered'])
        self.assertTrue(response.data['signed_off'])
        loc = EnforcerLocation.objects.get(enforcer=self.enforcer)
        self.assertEqual((loc.latitude, loc.longitude), (real.latitude, real.longitude))   # (0,0) never stored
        self.assertEqual(loc.status, 'inactive')

    def test_explicit_sign_off_flag_triggers_no_geofence(self):
        self._sign_off_setup()
        response = self.post_location(11, latitude=0, longitude=0, sign_off=True)
        response.alert.assert_not_called()
        self.assertFalse(response.data['geofence_triggered'])

    def test_sign_off_without_any_location_row_creates_none(self):
        self.schedule(start='00:00', end='23:59')
        response = self.post_location(11, latitude=0, longitude=0, sign_off=True)
        self.assertEqual(response.data['signed_off'], True)
        self.assertFalse(EnforcerLocation.objects.filter(enforcer=self.enforcer).exists())

    def test_real_out_of_city_position_still_triggers_geofence_with_schedule(self):
        self.schedule(start='00:00', end='23:59')
        response = self.post_location(10, latitude=14.5995, longitude=120.9842)
        response.alert.assert_called_once()
        self.assertTrue(response.data['geofence_triggered'])

    # ---- local-date boundary ---------------------------------------------
    def test_duty_uses_the_configured_local_date_across_the_utc_boundary(self):
        # 04:00 Manila on D == 20:00 UTC on D-1.
        frozen = datetime(2026, 10, 2, 20, 0, tzinfo=dt_timezone.utc)
        EnforcerSchedule.objects.create(enforcer=self.enforcer, date='2026-10-02',
                                        shift_start='00:00', shift_end='23:59', assigned_area='UTC-Date Area')
        with mock.patch('django.utils.timezone.now', return_value=frozen):
            self.assertEqual(self.client.get(reverse('today_status')).data['state'], 'no_schedule')
        EnforcerSchedule.objects.create(enforcer=self.enforcer, date='2026-10-03',
                                        shift_start='00:00', shift_end='23:59', assigned_area='Manila-Date Area')
        with mock.patch('django.utils.timezone.now', return_value=frozen):
            data = self.client.get(reverse('today_status')).data
        self.assertEqual((data['state'], data['schedule']['assigned_area']), ('on_duty', 'Manila-Date Area'))


class AdminDutyMirrorTests(_DutyTestBase):
    """Admin screens read the persisted mirror; it must be correct when they read it."""

    def setUp(self):
        super().setUp()
        self.other = CustomUser.objects.create_user(
            email='other.duty@example.com', password='TestPass123!', full_name='Other Enforcer',
            id_number='2026-ENF-9041', role=CustomUser.Role.ENFORCER,
        )

    def test_manage_enforcers_and_gps_list_counts_follow_schedule_not_stale_profile(self):
        # `enforcer`: stale on_duty, NO schedule.  `other`: on shift but mirror still off_duty.
        self.set_persisted_duty('on_duty')
        self.schedule(enforcer=self.other)
        self.client.force_authenticate(user=self.admin)
        with self.at(10):
            response = self.client.get(reverse('enforcer_list'))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['stats']['active_on_duty'], 1)
        by_id = {r['id']: r['duty_status'] for r in response.data['results']}
        self.assertEqual(by_id[self.enforcer.id], 'off_duty')
        self.assertEqual(by_id[self.other.id], 'on_duty')

    def test_shift_that_ended_while_app_closed_leaves_admin_list(self):
        self.schedule()
        self.set_persisted_duty('on_duty')
        self.client.force_authenticate(user=self.admin)
        with self.at(18):
            response = self.client.get(reverse('enforcer_list'))
        self.assertEqual(response.data['stats']['active_on_duty'], 0)

    def test_dashboard_on_duty_count_uses_the_mirror(self):
        self.set_persisted_duty('on_duty')   # stale
        self.schedule(enforcer=self.other)
        self.client.force_authenticate(user=self.admin)
        with self.at(10):
            response = self.client.get(reverse('violation-stats'))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['on_duty_enforcers'], 1)

    def test_live_locations_lists_only_actively_on_duty_enforcers(self):
        self.schedule()                                   # enforcer scheduled; other has no schedule
        self.post_location(10)
        self.client.force_authenticate(user=self.other)
        self.post_location(10)
        self.client.force_authenticate(user=self.admin)
        # Read at the same pinned instant: live-locations applies a 2-minute
        # freshness cutoff against the (patched) clock, so a read on the real
        # clock would be hours away from these fixes.
        with self.at(10):
            response = self.client.get(reverse('live_locations'))
        self.assertEqual([r['enforcer'] for r in response.data], [self.enforcer.id])


# ───────────────────────────────────────────────────────────────────────────
# GPS lifecycle / live-location freshness / geofence episodes
# ───────────────────────────────────────────────────────────────────────────

OUTSIDE = {'latitude': 14.5995, 'longitude': 120.9842}   # Manila, far outside the 5 km Lucena radius
INSIDE  = {'latitude': 13.9373, 'longitude': 121.6144}   # Lucena centre


class _GpsBase(_DutyTestBase):
    """Adds second-level clock control, admin reads, and a shared alert mock."""

    def at_s(self, hour, minute=0, second=0):
        aware = timezone.make_aware(datetime.combine(self.today, time(hour, minute, second)))
        return mock.patch('django.utils.timezone.now', return_value=aware)

    def fix(self, hour, minute=0, second=0, coords=INSIDE, alert=None, **body):
        """POST one location fix at a pinned instant. Pass `alert` to share one mock across many fixes."""
        alert = alert if alert is not None else mock.MagicMock()
        with self.at_s(hour, minute, second), mock.patch('enforcers.views.send_geofence_alert', alert):
            response = self.client.post(reverse('update_location'), {**coords, **body}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response

    def live(self, hour, minute=0, second=0):
        """Admin's live-locations at a pinned instant -> {enforcer_id: row}."""
        self.client.force_authenticate(user=self.admin)
        try:
            with self.at_s(hour, minute, second):
                response = self.client.get(reverse('live_locations'))
        finally:
            self.client.force_authenticate(user=self.enforcer)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return {r['enforcer']: r for r in response.data}

    def row(self):
        return EnforcerLocation.objects.get(enforcer=self.enforcer)


class LiveLocationStateTests(_GpsBase):
    """Which duty states / ages may appear on the Admin live map."""

    def test_no_schedule_is_never_live(self):
        r = self.fix(10)
        self.assertFalse(r.data['tracking_allowed'])
        self.assertEqual(self.row().status, 'inactive')
        self.assertNotIn(self.enforcer.id, self.live(10))

    def test_before_shift_is_never_live(self):
        self.schedule()
        r = self.fix(7, 30)
        self.assertFalse(r.data['tracking_allowed'])
        self.assertEqual(self.row().status, 'inactive')
        self.assertNotIn(self.enforcer.id, self.live(7, 30))

    def test_on_duty_fresh_fix_is_live_as_active(self):
        self.schedule()
        r = self.fix(10)
        self.assertTrue(r.data['tracking_allowed'])
        live = self.live(10, 0, 30)
        self.assertIn(self.enforcer.id, live)
        self.assertEqual(live[self.enforcer.id]['status'], 'active')

    def test_on_break_fresh_fix_stays_visible_as_on_break_not_on_duty(self):
        self.schedule(brk=('12:00', '13:00'))
        r = self.fix(12, 30)
        self.assertTrue(r.data['tracking_allowed'])
        live = self.live(12, 30, 30)
        self.assertIn(self.enforcer.id, live)
        self.assertEqual(live[self.enforcer.id]['status'], 'on_break')

    def test_after_shift_is_not_live(self):
        self.schedule()
        r = self.fix(18)
        self.assertFalse(r.data['tracking_allowed'])
        self.assertEqual(self.row().status, 'inactive')
        self.assertNotIn(self.enforcer.id, self.live(18))

    def test_sign_off_is_not_live_and_a_duty_heartbeat_does_not_revive_it(self):
        self.schedule()
        self.fix(10)
        self.assertIn(self.enforcer.id, self.live(10, 0, 20))
        r = self.fix(10, 0, 30, coords={'latitude': 0, 'longitude': 0}, sign_off=True)
        self.assertTrue(r.data['signed_off'])
        self.assertNotIn(self.enforcer.id, self.live(10, 0, 40))
        # today-status is the app's heartbeat and re-syncs duty; the row must stay inactive.
        self.today_status(10, 1)
        self.assertNotIn(self.enforcer.id, self.live(10, 1, 10))
        self.assertEqual(self.row().status, 'inactive')

    def test_on_duty_row_older_than_two_minutes_is_not_live_but_coordinates_are_kept(self):
        self.schedule()
        self.fix(10)
        self.assertIn(self.enforcer.id, self.live(10, 1, 59))
        self.assertIn(self.enforcer.id, self.live(10, 2, 0))          # exactly 2:00 is still within the cutoff
        self.assertNotIn(self.enforcer.id, self.live(10, 2, 1))
        loc = self.row()
        self.assertEqual(loc.status, 'active')                         # stored value says active ...
        self.assertEqual((loc.latitude, loc.longitude), (INSIDE['latitude'], INSIDE['longitude']))   # ... nothing deleted

    def test_on_break_row_older_than_two_minutes_is_not_live(self):
        self.schedule(brk=('12:00', '13:00'))
        self.fix(12, 30)
        self.assertIn(self.enforcer.id, self.live(12, 31))
        self.assertNotIn(self.enforcer.id, self.live(12, 33))
        self.assertEqual(self.row().status, 'on_break')

    def test_stored_active_but_stale_row_from_a_vanished_device_is_not_live(self):
        # Ghost marker: posts stopped without a sign-off, schedule still says on duty.
        self.schedule()
        self.fix(10)
        self.assertEqual(self.row().status, 'active')
        self.assertNotIn(self.enforcer.id, self.live(10, 30))
        self.assertNotIn(self.enforcer.id, self.live(16, 30))

    def test_shift_end_downgrades_a_still_fresh_row_without_another_post(self):
        self.schedule()
        self.fix(16, 59)
        self.assertIn(self.enforcer.id, self.live(16, 59, 30))
        # 17:01 is after shift; the fix is only 2 minutes old (still fresh) but duty is over.
        self.assertNotIn(self.enforcer.id, self.live(17, 1))
        self.assertEqual(self.row().status, 'inactive')

    def test_break_start_relabels_a_fresh_row_without_another_post(self):
        self.schedule(brk=('12:00', '13:00'))
        self.fix(11, 59)
        live = self.live(12, 0, 30)           # break began, device has not posted again
        self.assertEqual(live[self.enforcer.id]['status'], 'on_break')
        live = self.live(12, 0, 55)
        self.assertEqual(live[self.enforcer.id]['status'], 'on_break')

    def test_internal_geofence_fields_are_not_serialized(self):
        self.schedule()
        self.fix(10)
        row = self.live(10)[self.enforcer.id]
        self.assertNotIn('geofence_outside_since', row)
        self.assertNotIn('geofence_last_alert_at', row)
        self.assertIn('age_seconds', row)

    def test_duty_headcount_stays_schedule_based_when_gps_is_stale(self):
        self.schedule()
        self.fix(10)
        self.client.force_authenticate(user=self.admin)
        with self.at(10, 30):                       # GPS is 30 minutes stale
            self.assertEqual(self.client.get(reverse('enforcer_list')).data['stats']['active_on_duty'], 1)
        self.assertNotIn(self.enforcer.id, self.live(10, 30))


class GeofenceStateTests(_GpsBase):
    """Alerts are allowed ONLY while the computed state is on_duty."""

    def test_no_schedule_outside_no_alert(self):
        alert = mock.MagicMock()
        r = self.fix(10, coords=OUTSIDE, alert=alert)
        alert.assert_not_called()
        self.assertFalse(r.data['geofence_triggered'])
        self.assertIsNone(r.data['outside_geofence'])

    def test_before_shift_outside_no_alert(self):
        self.schedule()
        alert = mock.MagicMock()
        r = self.fix(7, 30, coords=OUTSIDE, alert=alert)
        alert.assert_not_called()
        self.assertFalse(r.data['geofence_triggered'])
        self.assertIsNone(r.data['outside_geofence'])

    def test_on_duty_outside_alerts(self):
        self.schedule()
        alert = mock.MagicMock()
        r = self.fix(10, coords=OUTSIDE, alert=alert)
        alert.assert_called_once()
        self.assertTrue(r.data['geofence_triggered'])
        self.assertTrue(r.data['outside_geofence'])

    def test_on_break_outside_no_alert(self):
        self.schedule(brk=('12:00', '13:00'))
        alert = mock.MagicMock()
        r = self.fix(12, 30, coords=OUTSIDE, alert=alert)
        alert.assert_not_called()
        self.assertFalse(r.data['geofence_triggered'])
        self.assertIsNone(r.data['outside_geofence'])
        self.assertEqual(self.row().status, 'on_break')           # still reporting as On Break

    def test_after_shift_outside_no_alert(self):
        self.schedule()
        alert = mock.MagicMock()
        self.fix(18, coords=OUTSIDE, alert=alert)
        alert.assert_not_called()

    def test_sign_off_never_alerts_and_never_stores_zero_zero(self):
        self.schedule()
        self.fix(10)
        alert = mock.MagicMock()
        r = self.fix(10, 5, coords={'latitude': 0, 'longitude': 0}, alert=alert, sign_off=True)
        alert.assert_not_called()
        self.assertFalse(r.data['geofence_triggered'])
        loc = self.row()
        self.assertEqual((loc.latitude, loc.longitude), (INSIDE['latitude'], INSIDE['longitude']))

    def test_inside_never_alerts(self):
        self.schedule()
        alert = mock.MagicMock()
        for m in range(0, 5):
            r = self.fix(10, m, coords=INSIDE, alert=alert)
            self.assertFalse(r.data['outside_geofence'])
        alert.assert_not_called()


class GeofenceEpisodeTests(_GpsBase):
    """One alert per outside episode; 15-minute cooldown is only jitter protection."""

    def setUp(self):
        super().setUp()
        self.schedule(brk=('12:00', '13:00'))
        self.alert = mock.MagicMock()

    def go(self, hour, minute, coords, second=0):
        return self.fix(hour, minute, second, coords=coords, alert=self.alert)

    def test_inside_to_outside_sends_exactly_one_alert(self):
        self.go(9, 0, INSIDE)
        r = self.go(9, 1, OUTSIDE)
        self.assertTrue(r.data['geofence_triggered'])
        self.assertEqual(self.alert.call_count, 1)

    def test_twenty_repeated_outside_updates_do_not_storm(self):
        self.go(9, 0, INSIDE)
        triggered = [self.go(9, 1, OUTSIDE, second=s).data['geofence_triggered'] for s in range(0, 60, 3)]
        self.assertEqual(len(triggered), 20)
        self.assertEqual(triggered.count(True), 1)
        self.assertEqual(self.alert.call_count, 1)

    def test_staying_outside_for_hours_does_not_re_alert_every_fifteen_minutes(self):
        self.go(9, 0, OUTSIDE)
        for hour, minute in [(9, 20), (9, 40), (10, 0), (10, 30), (11, 0), (11, 45)]:
            self.go(hour, minute, OUTSIDE)
        self.assertEqual(self.alert.call_count, 1)

    def test_return_inside_closes_the_episode(self):
        self.go(9, 0, OUTSIDE)
        self.assertIsNotNone(self.row().geofence_outside_since)
        self.go(9, 1, INSIDE)
        self.assertIsNone(self.row().geofence_outside_since)
        self.assertEqual(self.alert.call_count, 1)                # reset is silent: no "returned" alert

    def test_new_outside_episode_inside_cooldown_is_suppressed_as_jitter(self):
        self.go(9, 0, OUTSIDE)         # alert
        self.go(9, 1, INSIDE)
        self.go(9, 2, OUTSIDE)         # new episode, but only 2 minutes after the last alert
        self.go(9, 3, INSIDE)
        self.go(9, 4, OUTSIDE)
        self.assertEqual(self.alert.call_count, 1)

    def test_new_outside_episode_after_cooldown_alerts_again(self):
        self.go(9, 0, OUTSIDE)         # alert
        self.go(9, 5, INSIDE)
        r = self.go(9, 16, OUTSIDE)    # 16 minutes after the first alert, new episode
        self.assertTrue(r.data['geofence_triggered'])
        self.assertEqual(self.alert.call_count, 2)

    def test_cooldown_is_exactly_fifteen_minutes(self):
        self.go(9, 0, OUTSIDE)
        self.go(9, 1, INSIDE)
        self.go(9, 14, OUTSIDE)        # 14 min -> suppressed
        self.assertEqual(self.alert.call_count, 1)
        self.go(9, 15, INSIDE)
        self.go(9, 15, OUTSIDE, second=30)   # 15:30 after the first alert -> eligible
        self.assertEqual(self.alert.call_count, 2)

    def test_break_pauses_geofence_without_closing_or_reopening_the_episode(self):
        self.go(11, 50, OUTSIDE)       # on duty, alert
        self.go(12, 10, OUTSIDE)       # on break, paused
        self.go(12, 40, INSIDE)        # on break, still paused (does not "reset" either)
        self.assertEqual(self.alert.call_count, 1)
        self.assertIsNotNone(self.row().geofence_outside_since)
        self.go(13, 10, OUTSIDE)       # back on duty, episode still open -> no repeat
        self.assertEqual(self.alert.call_count, 1)

    def test_sign_off_closes_the_episode_so_a_later_outing_can_alert(self):
        self.go(9, 0, OUTSIDE)
        self.fix(9, 5, coords={'latitude': 0, 'longitude': 0}, alert=self.alert, sign_off=True)
        self.assertIsNone(self.row().geofence_outside_since)
        self.go(9, 30, OUTSIDE)        # > 15 min after the first alert
        self.assertEqual(self.alert.call_count, 2)

    def test_end_of_shift_closes_the_episode(self):
        self.go(16, 30, OUTSIDE)
        self.go(17, 30, OUTSIDE)       # after shift: ignored, and the episode is closed
        self.assertIsNone(self.row().geofence_outside_since)
        self.assertEqual(self.alert.call_count, 1)

    def test_episode_left_open_from_a_previous_local_day_does_not_suppress_today(self):
        self.go(9, 0, OUTSIDE)
        EnforcerLocation.objects.filter(enforcer=self.enforcer).update(
            geofence_outside_since=timezone.make_aware(datetime.combine(self.today - timedelta(days=1), time(9, 0))),
            geofence_last_alert_at=timezone.make_aware(datetime.combine(self.today - timedelta(days=1), time(9, 0))),
        )
        r = self.go(9, 30, OUTSIDE)
        self.assertTrue(r.data['geofence_triggered'])
        self.assertEqual(self.alert.call_count, 2)


class GeofenceAlertContentTests(_GpsBase):
    """The alert states what is really checked (distance from Lucena centre)."""

    def _send(self, area='Domoit'):
        from django.core import mail
        self.schedule(area=area)
        with self.at(10):
            response = self.client.post(reverse('update_location'), OUTSIDE, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data['geofence_triggered'])
        self.assertEqual(len(mail.outbox), 1)
        return mail.outbox[0]

    def test_email_describes_the_lucena_center_radius_not_an_assigned_area(self):
        msg = self._send()
        body = msg.body
        self.assertIn('outside the configured Lucena City center geofence', body)
        self.assertIn('5000 m', body)
        self.assertIn('Distance from Lucena center', body)
        self.assertNotIn('designated area', body)
        self.assertNotIn('outside their assigned area', body)
        self.assertNotIn('Distance from Area', body)

    def test_scheduled_area_is_labelled_informational_and_is_not_the_profile_area(self):
        msg = self._send(area='Domoit')
        self.assertIn('Scheduled Area (informational only, boundary not checked): Domoit', msg.body)
        self.assertNotIn('Profile Default Area', msg.body)

    def test_blank_schedule_area_omits_the_area_line(self):
        msg = self._send(area='')
        self.assertNotIn('Scheduled Area', msg.body)
        self.assertNotIn('Profile Default Area', msg.body)

    def test_view_passes_schedule_area_and_radius_to_the_alert(self):
        self.schedule(area='Domoit')
        alert = mock.MagicMock()
        self.fix(10, coords=OUTSIDE, alert=alert)
        kwargs = alert.call_args.kwargs
        self.assertEqual(kwargs['scheduled_area'], 'Domoit')
        self.assertEqual(kwargs['radius_meters'], 5000)
        self.assertEqual((kwargs['center_lat'], kwargs['center_lon']), (13.9373, 121.6144))