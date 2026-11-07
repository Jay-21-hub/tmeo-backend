"""
Personal in-app notifications for Team Scheduling.

Called by the schedule write views AFTER a successful write. Rules:

  * Recipient is ONLY the affected enforcer (Notification.recipient_user, the
    stable CustomUser.pk). Never a role broadcast.
  * The admin who made the change is the actor (related_user), so the actor
    snapshot is captured centrally by Notification.save().
  * One notification per enforcer per request per event kind: a bulk request
    for several dates is summarised, never one row per date.
  * No notification when nothing the enforcer cares about changed.
  * Delivery is transactional: every notification is created via
    transaction.on_commit, i.e. only after the OUTERMOST enclosing transaction
    commits (immediately when there is none). A schedule operation that is
    rolled back - outer atomic, or a nested savepoint - therefore produces zero
    notifications (Django discards callbacks registered inside a rolled-back
    savepoint).
  * What to send is decided at call time (from the pre-write state), only the
    row creation is deferred.
  * A delivery failure runs after the schedule change is already committed: it
    is logged and swallowed and can never undo or fail that change.
"""
import logging

from django.db import transaction

logger = logging.getLogger(__name__)

# Fields whose change is meaningful to the enforcer. `notes` is admin-facing
# and deliberately does not trigger an "updated" notification.
WATCHED_FIELDS = ('shift_start', 'shift_end', 'break_start', 'break_end', 'assigned_area')

_MONTHS = {
    1: 'Jan.', 2: 'Feb.', 3: 'March', 4: 'April', 5: 'May', 6: 'June',
    7: 'July', 8: 'Aug.', 9: 'Sept.', 10: 'Oct.', 11: 'Nov.', 12: 'Dec.',
}


def fmt_date(d):
    return f'{_MONTHS[d.month]} {d.day}, {d.year}'


def fmt_time(t):
    return f'{t.hour % 12 or 12}:{t.minute:02d} {"AM" if t.hour < 12 else "PM"}'


def fmt_shift(start, end):
    return f'{fmt_time(start)}\u2013{fmt_time(end)}'


def fmt_dates(dates):
    """'Oct. 7, 2026' | up to 3 listed | 'N dates (first \u2013 last)'."""
    dates = sorted(set(dates))
    if len(dates) == 1:
        return fmt_date(dates[0])
    if len(dates) <= 3:
        return ', '.join(fmt_date(d) for d in dates)
    return f'{len(dates)} dates ({fmt_date(dates[0])} \u2013 {fmt_date(dates[-1])})'


def watched_values(obj):
    return tuple(getattr(obj, f) for f in WATCHED_FIELDS)


def has_meaningful_change(before, after):
    """before/after: objects or dicts exposing WATCHED_FIELDS."""
    def vals(x):
        return tuple(x[f] if isinstance(x, dict) else getattr(x, f) for f in WATCHED_FIELDS)
    return vals(before) != vals(after)


def _create(actor, enforcer, notif_type, title, message):
    from notifications.models import Notification  # local: avoid app-load cycle
    Notification.objects.create(
        recipient_role='enforcer',
        recipient_user=enforcer,
        notif_type=notif_type,
        title=title,
        message=message,
        related_user=actor,
    )


# --- single-event builders ---------------------------------------------------

def _assigned(actor, enforcer, dates, area, start, end):
    _create(
        actor, enforcer, 'duty_assigned', 'New Duty Assignment',
        f'You have been assigned to {area} on {fmt_dates(dates)}, {fmt_shift(start, end)}.',
    )


def _updated(actor, enforcer, dates, area, start, end):
    _create(
        actor, enforcer, 'duty_updated', 'Duty Schedule Updated',
        f'Your duty on {fmt_dates(dates)} was updated: area is now {area}; '
        f'shift {fmt_shift(start, end)}.',
    )


def _removed(actor, enforcer, dates, area):
    where = f' ({area})' if area else ''
    _create(
        actor, enforcer, 'duty_removed', 'Duty Assignment Removed',
        f'Your duty assignment on {fmt_dates(dates)}{where} was removed.',
    )


def _deliver(fn, *args):
    """Runs after commit. Own savepoint + catch-all: never raises."""
    try:
        with transaction.atomic():
            fn(*args)
        return True
    except Exception:
        logger.warning('Schedule notification failed', exc_info=True)
        return False


def _after_commit(fn, *args):
    # robust=True: even an unexpected error here cannot propagate out of the
    # (already successful) transaction.
    transaction.on_commit(lambda: _deliver(fn, *args), robust=True)
    return True


# --- public API (all failure-safe, all deferred to commit) -------------------

def notify_schedule_assigned(actor, enforcer, dates, area, start, end):
    return _after_commit(_assigned, actor, enforcer, list(dates), area, start, end)


def notify_schedule_updated(actor, enforcer, dates, area, start, end):
    return _after_commit(_updated, actor, enforcer, list(dates), area, start, end)


def notify_schedule_removed(actor, enforcer, dates, area):
    return _after_commit(_removed, actor, enforcer, list(dates), area)


def notify_bulk_assign(actor, enforcers, dates, existing_map, new_values):
    """
    One request -> at most one 'assigned' and one 'updated' notification per
    enforcer. `existing_map` is {(enforcer_id, date): schedule-as-it-was-BEFORE-
    the-write}; `new_values` is the dict of watched values just written.
    Pairs that already held identical values produce nothing. The plan is
    computed now; each enforcer's rows are created after commit.
    """
    try:
        a, s, e = new_values['assigned_area'], new_values['shift_start'], new_values['shift_end']
        for enforcer in enforcers:
            new_dates, changed_dates = [], []
            for d in dates:
                old = existing_map.get((enforcer.id, d))
                if old is None:
                    new_dates.append(d)
                elif has_meaningful_change(old, new_values):
                    changed_dates.append(d)
            if new_dates:
                _after_commit(_assigned, actor, enforcer, new_dates, a, s, e)
            if changed_dates:
                _after_commit(_updated, actor, enforcer, changed_dates, a, s, e)
        return True
    except Exception:
        logger.warning('Schedule notification planning failed', exc_info=True)
        return False