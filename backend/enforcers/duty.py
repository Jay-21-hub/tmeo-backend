"""
Single authoritative computation of an Enforcer's CURRENT duty status.

    today's EnforcerSchedule  +  current local time (settings.TIME_ZONE)
                    |
              compute_duty()          <- the only place the rule lives
                    |
        sync_duty_status()  ->  CustomUser.duty_status  (a MIRROR, kept only so
                                existing Admin screens that read the profile
                                field keep working; never client-controlled)

Authentication is NOT duty: an enforcer can be logged in with no schedule, and
that resolves to status='off_duty', state='no_schedule'.

The date and time come from Django's configured timezone (timezone.localtime),
never from a hard-coded zone.

Business rule (unchanged from the original TodayDutyStatusView):
    no schedule today                       -> off_duty  / no_schedule
    now <  shift_start                      -> off_duty  / before_shift
    now >  shift_end                        -> off_duty  / after_shift
    break_start <= now <= break_end         -> on_break  / on_break
    otherwise (shift_start <= now <= end)   -> on_duty   / on_duty
Boundaries are inclusive, as before. There is no overnight-shift support
(the scheduling serializer requires shift_end > shift_start).
"""
from datetime import timedelta

from django.utils import timezone

from accounts.models import CustomUser
from .models import EnforcerLocation, EnforcerSchedule

NO_SCHEDULE  = 'no_schedule'
BEFORE_SHIFT = 'before_shift'
ON_DUTY      = 'on_duty'
ON_BREAK     = 'on_break'
AFTER_SHIFT  = 'after_shift'

# Kept identical to the pre-existing API strings for backward compatibility.
REASON_NO_SCHEDULE = 'No schedule for today.'
REASON_OUTSIDE     = 'Outside shift hours.'      # same text for before AND after (use `state` to tell apart)
REASON_ON_BREAK    = 'Currently within break time.'
REASON_ON_DUTY     = 'Currently on shift.'

_STATUS_BY_STATE = {
    NO_SCHEDULE:  CustomUser.DutyStatus.OFF_DUTY.value,
    BEFORE_SHIFT: CustomUser.DutyStatus.OFF_DUTY.value,
    AFTER_SHIFT:  CustomUser.DutyStatus.OFF_DUTY.value,
    ON_DUTY:      CustomUser.DutyStatus.ON_DUTY.value,
    ON_BREAK:     CustomUser.DutyStatus.ON_BREAK.value,
}

# EnforcerLocation.status for each computed duty status.
LOCATION_STATUS_BY_DUTY = {
    'on_duty':  'active',
    'on_break': 'on_break',
    'off_duty': 'inactive',
}


# --- GPS presence / geofence policy (approved business rules) ---------------
# These are three separate concepts and must not be collapsed:
#   duty status  (schedule + local time)           -> compute_duty()
#   GPS presence (recent successful location sync) -> LIVE_FRESHNESS
#   authentication                                 -> not handled here
#
# Foreground GPS tracking runs only while the computed state is one of these.
TRACKING_STATES = (ON_DUTY, ON_BREAK)
# Geofence alerts are evaluated ONLY while on duty (never on break / off duty).
GEOFENCE_STATES = (ON_DUTY,)
# Normal sync cadence is ~15 s. This is NOT that: it is the maximum age of a
# fix that may still be presented as LIVE.
LIVE_FRESHNESS = timedelta(minutes=2)
# Jitter guard only. The rule is one alert per outside episode; this stops
# inside/outside/inside/outside GPS noise from re-alerting within 15 minutes.
GEOFENCE_COOLDOWN = timedelta(minutes=15)
# EnforcerLocation.status values that can qualify for the live map (if fresh).
LIVE_LOCATION_STATUSES = ('active', 'on_break')


def _schedule_payload(schedule):
    return {
        'shift_start':   str(schedule.shift_start),
        'shift_end':     str(schedule.shift_end),
        'assigned_area': schedule.assigned_area,
        'break_start':   str(schedule.break_start) if schedule.break_start else None,
        'break_end':     str(schedule.break_end)   if schedule.break_end   else None,
    }


def resolve_duty(schedule, now_time):
    """Pure function: (today's schedule or None, local time-of-day) -> duty dict."""
    if schedule is None:
        state, reason, payload = NO_SCHEDULE, REASON_NO_SCHEDULE, None
    else:
        payload = _schedule_payload(schedule)
        if now_time < schedule.shift_start:
            state, reason = BEFORE_SHIFT, REASON_OUTSIDE
        elif now_time > schedule.shift_end:
            state, reason = AFTER_SHIFT, REASON_OUTSIDE
        elif (schedule.break_start and schedule.break_end
              and schedule.break_start <= now_time <= schedule.break_end):
            state, reason = ON_BREAK, REASON_ON_BREAK
        else:
            state, reason = ON_DUTY, REASON_ON_DUTY
    return {
        'status':       _STATUS_BY_STATE[state],
        'state':        state,
        'reason':       reason,
        'has_schedule': schedule is not None,
        'schedule':     payload,
    }


def compute_duty(user):
    """Authoritative current duty for `user` (reads, never writes)."""
    now_local = timezone.localtime()
    schedule = EnforcerSchedule.objects.filter(
        enforcer=user, date=now_local.date(),
    ).first()
    return resolve_duty(schedule, now_local.time())


def _apply_mirror(user, new_status, now):
    """Mutate `user` in memory; return the update_fields needed, or []."""
    if user.duty_status == new_status:
        return []
    user.duty_status = new_status
    user.duty_status_updated_at = now
    fields = ['duty_status', 'duty_status_updated_at']
    if new_status == CustomUser.DutyStatus.ON_BREAK:
        user.break_started_at = now
        fields.append('break_started_at')
    elif new_status == CustomUser.DutyStatus.ON_DUTY:
        user.break_started_at = None
        fields.append('break_started_at')
    return fields


def sync_location_status(user_ids, duty_status):
    """
    Keep EnforcerLocation.status in step with the authoritative duty status
    without waiting for the device to post again (it may have stopped).

      off_duty -> inactive (and the geofence episode is closed)
      on_break -> rows that were 'active' become 'on_break'
      on_duty  -> rows that were 'on_break' become 'active'

    Rows that are already 'inactive' are NEVER reactivated here: a logout
    sign-off (or a paused tracker) must stay off the live map even while the
    schedule still says on duty. Only a real fix posted while tracking is
    allowed can make a row live again. QuerySet.update() is used on purpose so
    `updated_at` (auto_now) is untouched: this is a status correction, not a
    location sync, and must never make a stale row look fresh.
    """
    ids = list(user_ids)
    if not ids:
        return 0
    rows = EnforcerLocation.objects.filter(enforcer_id__in=ids)
    if duty_status == CustomUser.DutyStatus.OFF_DUTY.value:
        return rows.exclude(status='inactive').update(status='inactive', geofence_outside_since=None)
    if duty_status == CustomUser.DutyStatus.ON_BREAK.value:
        return rows.filter(status='active').update(status='on_break')
    if duty_status == CustomUser.DutyStatus.ON_DUTY.value:
        return rows.filter(status='on_break').update(status='active')
    return 0


def sync_duty_status(user, duty=None):
    """
    Mirror the computed status onto CustomUser.duty_status (only when it
    differs) and bring the user's EnforcerLocation.status in step with it.
    Returns the duty dict that was mirrored.
    """
    duty = duty or compute_duty(user)
    fields = _apply_mirror(user, duty['status'], timezone.now())
    if fields:
        user.save(update_fields=fields)
    sync_location_status([user.id], duty['status'])
    return duty


def sync_all_enforcers_duty():
    """
    Refresh the mirror for every active enforcer in one pass. There is no
    background scheduler, so Admin read paths that count/list duty status call
    this to avoid showing a stale mirror (e.g. a shift that ended while the
    enforcer's app was closed). Returns the number of rows changed.
    """
    now_local = timezone.localtime()
    enforcers = list(CustomUser.objects.filter(
        role=CustomUser.Role.ENFORCER,
        is_active=True,
        employment_status=CustomUser.EmploymentStatus.ACTIVE,
    ))
    schedules = {
        s.enforcer_id: s
        for s in EnforcerSchedule.objects.filter(
            date=now_local.date(), enforcer_id__in=[e.id for e in enforcers],
        )
    }
    now = timezone.now()
    changed, all_fields = [], set()
    ids_by_status = {}
    for e in enforcers:
        duty = resolve_duty(schedules.get(e.id), now_local.time())
        ids_by_status.setdefault(duty['status'], []).append(e.id)
        fields = _apply_mirror(e, duty['status'], now)
        if fields:
            changed.append(e)
            all_fields.update(fields)
    if changed:
        CustomUser.objects.bulk_update(changed, sorted(all_fields))
    # Location rows follow the computed duty even when the device stopped
    # posting (shift ended, app closed). One UPDATE per duty status.
    for duty_status, ids in ids_by_status.items():
        sync_location_status(ids, duty_status)
    return len(changed)


def notify_started_duty(user, duty):
    """
    Admin "Enforcer On Duty" notification. Created ONLY when the authoritative
    computed state is on_duty (so never for no schedule / before shift / on
    break / after shift), and at most once per enforcer per local day, so the
    15-second location sync cannot spam it.
    """
    if duty['state'] != ON_DUTY:
        return False
    from notifications.models import Notification   # local import: avoid app-load cycle
    start_of_day = timezone.localtime().replace(hour=0, minute=0, second=0, microsecond=0)
    if Notification.objects.filter(
        notif_type='enforcer_on_duty', related_user=user, created_at__gte=start_of_day,
    ).exists():
        return False
    Notification.objects.create(
        recipient_role='admin',
        notif_type='enforcer_on_duty',
        title='Enforcer On Duty',
        message=f'{user.full_name} has started duty and is now sharing their location.',
        related_user=user,
    )
    return True