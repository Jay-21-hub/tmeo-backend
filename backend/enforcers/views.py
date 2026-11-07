from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status, permissions, serializers
from django.db import transaction
from django.utils import timezone
from accounts.models import CustomUser
from accounts.serializers import UserSerializer
from accounts.permissions import IsAdmin          # ← bagong linya
from audit.utils import log_action, build_changes, snapshot
from .models import EnforcerLocation, EnforcerSchedule
from .notifications import send_deployment_notification, send_geofence_alert
from . import schedule_notifications as sched_notify
from .duty import (
    compute_duty, sync_duty_status, sync_all_enforcers_duty,
    notify_started_duty, LOCATION_STATUS_BY_DUTY,
    TRACKING_STATES, GEOFENCE_STATES, LIVE_FRESHNESS,
    GEOFENCE_COOLDOWN, LIVE_LOCATION_STATUSES,
)
import calendar
from datetime import date

# Geofence: distance from the Lucena City centre. This is NOT a boundary check
# of EnforcerSchedule.assigned_area (free text, no geometry).
LUCENA_LAT         = 13.9373
LUCENA_LNG         = 121.6144
CITY_RADIUS_METERS = 5000


# Serializers

class EnforcerLocationSerializer(serializers.ModelSerializer):
    enforcer_detail = UserSerializer(source='enforcer', read_only=True)
    # Additive: seconds since the last fix, so clients can show "last seen"
    # without guessing. Live-locations only ever returns rows <= LIVE_FRESHNESS.
    age_seconds     = serializers.SerializerMethodField()

    class Meta:
        model   = EnforcerLocation
        # Geofence episode bookkeeping is internal and never serialized.
        exclude = ('geofence_outside_since', 'geofence_last_alert_at')

    def get_age_seconds(self, obj):
        if not obj.updated_at:
            return None
        return max(0, int((timezone.now() - obj.updated_at).total_seconds()))


class EnforcerScheduleSerializer(serializers.ModelSerializer):
    enforcer_name      = serializers.CharField(source='enforcer.full_name',   read_only=True)
    enforcer_id_number = serializers.CharField(source='enforcer.id_number',   read_only=True)
    created_by_name    = serializers.CharField(source='created_by.full_name', read_only=True)

    class Meta:
        model  = EnforcerSchedule
        fields = [
            'id', 'enforcer', 'enforcer_name', 'enforcer_id_number',
            'date',
            'shift_start', 'shift_end', 'break_start', 'break_end',
            'assigned_area', 'notes',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_by', 'created_at', 'updated_at']


class BulkScheduleAssignSerializer(serializers.Serializer):
    """
    Validates a group-assignment request: N enforcers × M dates, one shared
    shift/area/notes payload. Does not touch the database — DB writes and the
    conflict-detection pass happen in the view, since a serializer here only
    needs to validate shape and cross-field consistency.
    """
    enforcer_ids  = serializers.ListField(child=serializers.IntegerField(), allow_empty=False)
    dates         = serializers.ListField(child=serializers.DateField(), allow_empty=False)
    shift_start   = serializers.TimeField()
    shift_end     = serializers.TimeField()
    break_start   = serializers.TimeField(required=False, allow_null=True)
    break_end     = serializers.TimeField(required=False, allow_null=True)
    assigned_area = serializers.CharField(max_length=200)
    notes         = serializers.CharField(required=False, allow_blank=True, default='')
    overwrite     = serializers.BooleanField(required=False, default=False)

    def validate(self, data):
        if data['shift_end'] <= data['shift_start']:
            raise serializers.ValidationError('Shift end must be after shift start.')
        b_start, b_end = data.get('break_start'), data.get('break_end')
        if bool(b_start) != bool(b_end):
            raise serializers.ValidationError('Provide both break start and break end, or neither.')
        if b_start and b_end and b_end <= b_start:
            raise serializers.ValidationError('Break end must be after break start.')
        if not data['assigned_area'].strip():
            raise serializers.ValidationError('Assigned area is required.')
        # Server-side backstop for the same rule the calendar UI enforces: past
        # dates are locked out of scheduling entirely, since a client that
        # bypasses the UI (or calls this endpoint directly) could otherwise
        # backdate an enforcer's schedule — a record-integrity issue, not just
        # a UX one.
        past_dates = sorted(d for d in data['dates'] if d < timezone.localdate())
        if past_dates:
            raise serializers.ValidationError(
                f'Cannot schedule past date(s): {", ".join(str(d) for d in past_dates)}.'
            )
        return data


# Enforcer Management

class EnforcerListView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        # Admin screens (Manage Enforcers, GPS Tracking) read the persisted
        # duty_status mirror; refresh it from schedule + local time first.
        sync_all_enforcers_duty()
        enforcers = CustomUser.objects.filter(role='enforcer', is_active=True)
        all_enforcers = CustomUser.objects.filter(role='enforcer')
        return Response({
            'results': UserSerializer(enforcers, many=True).data,
            'stats': {
                'total':              all_enforcers.count(),
                'active_on_duty':     all_enforcers.filter(duty_status='on_duty').count(),
                'on_leave_suspended': all_enforcers.filter(employment_status__in=['on_leave','suspended']).count(),
                'resigned_retired':   all_enforcers.filter(employment_status__in=['resigned','retired']).count(),
            }
        })


class DeployEnforcerView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request):
        enforcer_id = request.data.get('enforcer_id')
        area        = request.data.get('area')

        if not enforcer_id or not area:
            return Response(
                {'error': 'enforcer_id and area are required.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            enforcer = CustomUser.objects.get(
                id=enforcer_id, role='enforcer', is_active=True
            )
        except CustomUser.DoesNotExist:
            return Response(
                {'error': 'Enforcer not found.'},
                status=status.HTTP_404_NOT_FOUND
            )

        try:
            send_deployment_notification(
                enforcer    = enforcer,
                area        = area,
                deployed_by = request.user,
            )
            email_status = 'sent'
        except Exception as e:
            email_status = f'failed: {str(e)}'

        log_action(
            user        = request.user,
            action      = 'DEPLOY',
            module      = 'Enforcers',
            description = f'Deployed {enforcer.full_name} to {area}',
            request     = request,
            target_type = 'User',
            target_id   = enforcer.id,
            details     = {
                'enforcer':      enforcer.full_name,
                'badge_no':      enforcer.badge_number or None,
                'area':          area,
                'deployed_by':   request.user.full_name,
                'email_status':  email_status,
            },
        )

        return Response({
            'message':      f'{enforcer.full_name} deployed to {area}.',
            'email_status': email_status,
            'enforcer':     UserSerializer(enforcer).data,
        })


# GPS Location

class LiveLocationsView(APIView):
    """
    Enforcers who are CURRENTLY reporting a location.

    A row qualifies only when BOTH hold:
      * its status is 'active' (on duty) or 'on_break' -- the status keeps its
        explicit value, an on-break enforcer is never relabelled On Duty; and
      * its last fix is no older than LIVE_FRESHNESS (2 minutes).
    A stored 'active' therefore never means "live forever": if the device
    stops posting before a clean sign-off the row drops out of this list after
    two minutes. Stale coordinates are NOT deleted, they are just not live.

    This is GPS presence only. Duty headcounts (EnforcerListView stats, the
    dashboard) stay schedule-based and are not derived from this list.
    """
    permission_classes = [IsAdmin]

    def get(self, request):
        # Bring each row's status in step with the computed duty first, so a
        # shift that ended while the device was silent is not shown as live.
        sync_all_enforcers_duty()
        cutoff = timezone.now() - LIVE_FRESHNESS
        locations = EnforcerLocation.objects.select_related(
            'enforcer'
        ).filter(status__in=LIVE_LOCATION_STATUSES, updated_at__gte=cutoff)
        return Response(EnforcerLocationSerializer(locations, many=True).data)


def _advance_geofence_episode(location_id, outside, now):
    """
    Event-based geofence ledger for ONE on-duty fix. Returns True only when an
    alert should be sent for this fix.

        inside                      -> close any open episode, no alert
        inside  -> outside          -> open an episode, ONE alert (if eligible)
        outside -> outside          -> episode already open, NO alert
        outside -> inside -> outside-> new episode, alert only if the 15-minute
                                       jitter cooldown since the last alert passed

    The cooldown is secondary jitter protection, never a "re-alert every 15
    minutes while still outside" timer. An episode left open from a previous
    local day is treated as stale and starts a new one. The row is locked so
    two overlapping posts (interval + Sync Now) cannot both alert.
    """
    with transaction.atomic():
        row = EnforcerLocation.objects.select_for_update().get(pk=location_id)
        today = timezone.localtime(now).date()
        since = row.geofence_outside_since
        episode_open = since is not None and timezone.localtime(since).date() == today

        if not outside:
            if since is not None:
                EnforcerLocation.objects.filter(pk=row.pk).update(geofence_outside_since=None)
            return False

        if episode_open:
            return False

        last = row.geofence_last_alert_at
        eligible = last is None or (now - last) >= GEOFENCE_COOLDOWN
        EnforcerLocation.objects.filter(pk=row.pk).update(
            geofence_outside_since=now,
            geofence_last_alert_at=now if eligible else last,
        )
        return eligible


class UpdateLocationView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        if not request.user.is_enforcer:
            return Response(
                {'error': 'Only enforcers can update location.'},
                status=status.HTTP_403_FORBIDDEN
            )

        lat         = request.data.get('latitude')
        lng         = request.data.get('longitude')
        accuracy = request.data.get('accuracy')
        # NOTE: a client-supplied `duty_status` is intentionally ignored. Duty
        # is computed server-side from today's schedule + local time
        # (enforcers/duty.py); location submission never decides it.

        if lat is None or lng is None:
            return Response(
                {'error': 'latitude and longitude are required.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            lat = float(lat)
            lng = float(lng)
        except (TypeError, ValueError):
            return Response(
                {'error': 'latitude and longitude must be numeric.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if not (-90 <= lat <= 90):
            return Response(
                {'error': 'latitude must be between -90 and 90.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if not (-180 <= lng <= 180):
            return Response(
                {'error': 'longitude must be between -180 and 180.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Logout / pause sign-off: not a physical GPS observation. Sent by the
        # app's logout (and by the shared tracker when tracking stops after a
        # duty transition) as {sign_off: true, latitude: 0, longitude: 0}. Exact
        # (0, 0) is also treated as the sentinel so older cached clients that
        # sent the bare (0, 0) payload behave the same. Mark the existing
        # location row inactive (so the enforcer leaves the live map) and close
        # any open geofence episode WITHOUT overwriting the last real
        # coordinates, and run no distance/geofence logic. Idempotent.
        sign_off_flag = str(request.data.get('sign_off', '')).lower() in ('true', '1')
        if sign_off_flag or (lat == 0 and lng == 0):
            EnforcerLocation.objects.filter(enforcer=request.user).update(
                status='inactive', geofence_outside_since=None,
            )
            duty = sync_duty_status(request.user)
            existing = EnforcerLocation.objects.filter(enforcer=request.user).first()
            return Response({
                **(EnforcerLocationSerializer(existing).data if existing else {}),
                'signed_off':         True,
                'tracking_allowed':   False,
                'geofence_triggered': False,
                'outside_geofence':   None,
                'duty_status':        duty['status'],
                'state':              duty['state'],
                'has_schedule':       duty['has_schedule'],
            })

        # Authoritative duty for this instant (schedule + local time), mirrored
        # to CustomUser.duty_status for the Admin screens that read it. This
        # also brings the location row's status in step with the duty.
        duty = sync_duty_status(request.user)
        state = duty['state']
        now = timezone.now()

        # The row's status follows the computed duty, so a fix posted outside
        # on_duty / on_break (e.g. by an older cached client) is stored as
        # 'inactive' and can never appear on the live map.
        loc, _ = EnforcerLocation.objects.update_or_create(
            enforcer=request.user,
            defaults={
                'latitude':  lat,
                'longitude': lng,
                'status':    LOCATION_STATUS_BY_DUTY[duty['status']],
            }
        )

        notify_started_duty(request.user, duty)

        # Geofence. What is verified: the reported position's distance from the
        # Lucena City centre. It does NOT test the scheduled/assigned area
        # (EnforcerSchedule.assigned_area is free text with no boundary).
        # Evaluated ONLY while the computed state is on_duty:
        #   no_schedule / before_shift / on_break / after_shift -> never alerts.
        # "Today" is the configured local date (settings.TIME_ZONE), the same
        # one compute_duty() resolves.
        geofence_triggered = False
        outside_geofence = None
        if state in GEOFENCE_STATES:
            from .notifications import calculate_distance_meters
            distance = calculate_distance_meters(lat, lng, LUCENA_LAT, LUCENA_LNG)
            outside_geofence = distance > CITY_RADIUS_METERS

            if _advance_geofence_episode(loc.pk, outside_geofence, now):
                geofence_triggered = True
                try:
                    send_geofence_alert(
                        enforcer        = request.user,
                        current_lat     = lat,
                        current_lon     = lng,
                        center_lat      = LUCENA_LAT,
                        center_lon      = LUCENA_LNG,
                        distance_meters = distance,
                        radius_meters   = CITY_RADIUS_METERS,
                        # Informational only (today's schedule), never the
                        # profile assigned_area.
                        scheduled_area  = (duty['schedule'] or {}).get('assigned_area') or None,
                    )
                except Exception as exc:
                    import logging
                    logging.getLogger(__name__).warning('Geofence alert failed: %s', exc)

        return Response({
            **EnforcerLocationSerializer(loc).data,
            # True only when an alert was actually dispatched for THIS fix
            # (one per outside episode), not for every outside fix.
            'geofence_triggered': geofence_triggered,
            # Additive: where the fix is relative to the radius. None when the
            # geofence was not evaluated (any state other than on_duty).
            'outside_geofence':   outside_geofence,
            # Additive: whether the server considers foreground tracking
            # allowed right now (on_duty / on_break). Lets the client pause.
            'tracking_allowed':   state in TRACKING_STATES,
            'duty_status':        duty['status'],
            'state':              state,
            'has_schedule':       duty['has_schedule'],
        })


# Today's Duty Status (auto-computed from schedule)

class TodayDutyStatusView(APIView):
    """
    Authoritative current duty for the signed-in user, computed from today's
    EnforcerSchedule + current local time by enforcers.duty.compute_duty().

    Response (existing keys preserved, two added):
        status        'on_duty' | 'on_break' | 'off_duty'
        reason        human text (unchanged strings)
        schedule      null, or {shift_start, shift_end, assigned_area, break_*}
        state         'no_schedule' | 'before_shift' | 'on_duty' | 'on_break' | 'after_shift'
        has_schedule  bool
    """
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        duty = compute_duty(request.user)
        # This is the enforcer app's regular heartbeat (open, every 5 min,
        # tab-visible, reconnect), so it also keeps the persisted
        # CustomUser.duty_status mirror correct for the Admin screens.
        if request.user.is_enforcer:
            sync_duty_status(request.user, duty)
        return Response(duty)


# Schedule — Admin

class ScheduleListView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        if not request.user.is_admin:
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )

        month = request.query_params.get('month', date.today().month)
        year  = request.query_params.get('year',  date.today().year)

        try:
            month = int(month)
            year  = int(year)
        except ValueError:
            return Response(
                {'error': 'Invalid month or year.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        _, last_day = calendar.monthrange(year, month)
        start_date  = date(year, month, 1)
        end_date    = date(year, month, last_day)

        schedules = EnforcerSchedule.objects.filter(
            date__range=[start_date, end_date]
        ).select_related('enforcer', 'created_by').order_by('date', 'shift_start')

        # Bug fix: `?enforcer=<id>` was silently ignored — the queryset was
        # never filtered by it, so every request for the month returned every
        # enforcer's schedule. `enforcers=<id1>,<id2>,...` filters by several
        # enforcers at once (used by the group-scheduling view).
        enforcer_id = request.query_params.get('enforcer')
        if enforcer_id:
            schedules = schedules.filter(enforcer_id=enforcer_id)

        enforcer_ids = request.query_params.get('enforcers')
        if enforcer_ids:
            id_list = [v for v in enforcer_ids.split(',') if v.strip()]
            schedules = schedules.filter(enforcer_id__in=id_list)

        return Response(EnforcerScheduleSerializer(schedules, many=True).data)

    def post(self, request):
        if not request.user.is_admin:
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )

        serializer = EnforcerScheduleSerializer(data=request.data)
        if serializer.is_valid():
            schedule = serializer.save(created_by=request.user)
            sched_notify.notify_schedule_assigned(
                request.user, schedule.enforcer, [schedule.date],
                schedule.assigned_area, schedule.shift_start, schedule.shift_end,
            )
            log_action(
                user        = request.user,
                action      = 'CREATE',
                module      = 'Enforcers',
                description = (
                    f'Created schedule for {schedule.enforcer.full_name} '
                    f'on {schedule.date}'
                ),
                request     = request,
                target_type = 'Schedule',
                target_id   = schedule.id,
                details     = {
                    'enforcer':      schedule.enforcer.full_name,
                    'date':          str(schedule.date),
                    'shift_start':   str(schedule.shift_start) if schedule.shift_start else None,
                    'shift_end':     str(schedule.shift_end) if schedule.shift_end else None,
                    'assigned_area': schedule.assigned_area or None,
                    'created_by':    request.user.full_name,
                },
            )
            return Response(
                EnforcerScheduleSerializer(schedule).data,
                status=status.HTTP_201_CREATED
            )
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class BulkScheduleAssignView(APIView):
    """
    Group scheduling: assign a shared shift/area to N enforcers across M
    dates in one request. Two-phase confirm — if `overwrite` is false and
    some (enforcer, date) pairs already have a schedule, nothing is written;
    the response instead lists those pairs as `conflicts` so the UI can ask
    the admin to confirm before resending with `overwrite: true`.
    """
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        if not request.user.is_admin:
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )

        serializer = BulkScheduleAssignSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        data = serializer.validated_data

        enforcer_ids = list(dict.fromkeys(data['enforcer_ids']))  # de-dupe, keep order
        dates = list(dict.fromkeys(data['dates']))

        enforcers = list(
            CustomUser.objects.filter(id__in=enforcer_ids, role=CustomUser.Role.ENFORCER)
        )
        found_ids = {e.id for e in enforcers}
        missing_ids = [eid for eid in enforcer_ids if eid not in found_ids]
        if missing_ids:
            return Response(
                {'error': f'Unknown or non-enforcer user id(s): {missing_ids}'},
                status=status.HTTP_400_BAD_REQUEST
            )

        existing = EnforcerSchedule.objects.filter(
            enforcer_id__in=enforcer_ids, date__in=dates
        ).select_related('enforcer')
        existing_map = {(s.enforcer_id, s.date): s for s in existing}

        if existing_map and not data['overwrite']:
            conflicts = [
                {
                    'enforcer': eid,
                    'enforcer_name': sched.enforcer.full_name,
                    'date': str(d),
                    'current_shift': f'{sched.shift_start} - {sched.shift_end}',
                    'current_area': sched.assigned_area,
                }
                for (eid, d), sched in existing_map.items()
            ]
            return Response({
                'status': 'conflict',
                'conflicts': conflicts,
                'message': (
                    f'{len(conflicts)} of the selected (enforcer, date) pairs already '
                    'have a schedule. Resend with overwrite: true to replace them.'
                ),
            }, status=status.HTTP_409_CONFLICT)

        defaults = {
            'shift_start':   data['shift_start'],
            'shift_end':     data['shift_end'],
            'break_start':   data.get('break_start'),
            'break_end':     data.get('break_end'),
            'assigned_area': data['assigned_area'],
            'notes':         data.get('notes', ''),
            'created_by':    request.user,
        }

        saved = []
        for enforcer in enforcers:
            for d in dates:
                schedule, _ = EnforcerSchedule.objects.update_or_create(
                    enforcer=enforcer, date=d, defaults=defaults
                )
                saved.append(schedule)

        # Personal notification: one per enforcer per request (not per date),
        # and none for (enforcer, date) pairs whose values did not change.
        sched_notify.notify_bulk_assign(
            request.user, enforcers, dates, existing_map,
            {k: defaults[k] for k in sched_notify.WATCHED_FIELDS},
        )

        log_action(
            user        = request.user,
            action      = 'CREATE',
            module      = 'Enforcers',
            description = (
                f'Group-assigned {len(enforcers)} enforcer(s) to {len(dates)} date(s) '
                f'at {data["assigned_area"]}'
            ),
            request     = request,
            target_type = 'Schedule',
            target_id   = None,
            details     = {
                'enforcers':     [e.full_name for e in enforcers],
                'dates':         [str(d) for d in dates],
                'shift_start':   str(data['shift_start']),
                'shift_end':     str(data['shift_end']),
                'assigned_area': data['assigned_area'],
                'overwrite':     data['overwrite'],
                'created_by':    request.user.full_name,
            },
        )

        return Response({
            'status': 'ok',
            'assigned': len(saved),
            'schedules': EnforcerScheduleSerializer(saved, many=True).data,
        }, status=status.HTTP_201_CREATED)


class ScheduleDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self, pk):
        try:
            return EnforcerSchedule.objects.select_related(
                'enforcer', 'created_by'
            ).get(pk=pk)
        except EnforcerSchedule.DoesNotExist:
            return None

    def get(self, request, pk):
        schedule = self.get_object(pk)
        if not schedule:
            return Response({'error': 'Schedule not found.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(EnforcerScheduleSerializer(schedule).data)

    def patch(self, request, pk):
        if not request.user.is_admin:
            return Response({'error': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)
        schedule = self.get_object(pk)
        if not schedule:
            return Response({'error': 'Schedule not found.'}, status=status.HTTP_404_NOT_FOUND)
        mutable_data = {k: v for k, v in request.data.items() if k not in ('enforcer', 'date', 'created_by')}
        before = snapshot(schedule, ('shift_start', 'shift_end', 'break_start', 'break_end', 'assigned_area', 'notes'))
        serializer = EnforcerScheduleSerializer(schedule, data=mutable_data, partial=True)
        if serializer.is_valid():
            old_values = {f: getattr(schedule, f) for f in sched_notify.WATCHED_FIELDS}
            updated = serializer.save()
            if sched_notify.has_meaningful_change(old_values, updated):
                sched_notify.notify_schedule_updated(
                    request.user, updated.enforcer, [updated.date],
                    updated.assigned_area, updated.shift_start, updated.shift_end,
                )
            after = snapshot(updated, ('shift_start', 'shift_end', 'break_start', 'break_end', 'assigned_area', 'notes'))
            log_action(
                user        = request.user,
                action      = 'UPDATE',
                module      = 'Enforcers',
                description = f'Updated schedule for {schedule.enforcer.full_name} on {schedule.date}',
                request     = request,
                target_type = 'Schedule',
                target_id   = schedule.id,
                changes     = build_changes(before, after),
            )
            return Response(EnforcerScheduleSerializer(updated).data)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def delete(self, request, pk):
        if not request.user.is_admin:
            return Response({'error': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)
        schedule = self.get_object(pk)
        if not schedule:
            return Response({'error': 'Schedule not found.'}, status=status.HTTP_404_NOT_FOUND)
        name = schedule.enforcer.full_name
        day  = schedule.date
        target_id = schedule.id
        enforcer, area = schedule.enforcer, schedule.assigned_area
        schedule.delete()
        # Removing a duty that already passed changes nothing for the enforcer.
        if day >= timezone.localdate():
            sched_notify.notify_schedule_removed(request.user, enforcer, [day], area)
        log_action(
            user        = request.user,
            action      = 'DELETE',
            module      = 'Enforcers',
            description = f'Deleted schedule for {name} on {day}',
            request     = request,
            target_type = 'Schedule',
            target_id   = target_id,
        )
        return Response({'message': 'Schedule deleted.'})


# Schedule — Enforcer (own schedule)

class MyScheduleView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        if not request.user.is_enforcer:
            return Response(
                {'error': 'Only enforcers can view their schedule.'},
                status=status.HTTP_403_FORBIDDEN
            )

        month = request.query_params.get('month', date.today().month)
        year  = request.query_params.get('year',  date.today().year)

        try:
            month = int(month)
            year  = int(year)
        except ValueError:
            return Response(
                {'error': 'Invalid month or year.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        _, last_day = calendar.monthrange(year, month)
        start_date  = date(year, month, 1)
        end_date    = date(year, month, last_day)

        schedules = EnforcerSchedule.objects.filter(
            enforcer    = request.user,
            date__range = [start_date, end_date]
        ).order_by('date', 'shift_start')

        return Response(EnforcerScheduleSerializer(schedules, many=True).data)