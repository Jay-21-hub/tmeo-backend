"""
Fine history of a ViolationType (Option A).

An Admin edit of a violation type's fine writes a ViolationTypeFine row with
the moment it takes effect. An OFFLINE-synced Enforcer OVR is priced with the
fine that was in force at its date_issued, not the fine at sync time.

Everything else keeps today's behaviour: online OVRs and Staff walk-ins take
the CURRENT fine, and an existing item never changes once created.
"""
import datetime

from django.utils import timezone

from .models import Violation, ViolationTypeFine

# Baseline row: "this fine has applied since forever".
EPOCH = datetime.datetime(2000, 1, 1, tzinfo=datetime.timezone.utc)


def fine_as_of(vtype, when):
    """The fine of `vtype` in force at `when`."""
    rows = ViolationTypeFine.objects.filter(violation_type=vtype)
    row = rows.filter(effective_from__lte=when).order_by('-effective_from', '-id').first()
    if row is None:
        # `when` is older than the oldest entry: use the oldest known fine.
        row = rows.order_by('effective_from', 'id').first()
    if row is None:
        return vtype.penalty_amount
    if not rows.filter(effective_from__gt=row.effective_from).exists():
        # Newest entry: the live value is the truth (also covers a fine that
        # was changed outside the API, e.g. Django admin).
        return vtype.penalty_amount
    return row.penalty_amount


def item_fine(vtype, violation):
    """Fine to snapshot on a NEW item of `violation`."""
    if (violation.source == Violation.Source.ENFORCER_OVR
            and violation.client_offline_id
            and violation.date_issued):
        return fine_as_of(vtype, violation.date_issued)
    return vtype.penalty_amount


def record_initial_fine(vtype, user=None):
    """First history row of a newly created violation type."""
    if not ViolationTypeFine.objects.filter(violation_type=vtype).exists():
        ViolationTypeFine.objects.create(
            violation_type=vtype, penalty_amount=vtype.penalty_amount,
            effective_from=EPOCH, changed_by=user,
        )


def record_fine_change(vtype, old_amount, user=None):
    """Call right after the new fine was saved. Adds the baseline (old fine)
    first if this type has no history yet, then the new fine effective now."""
    if not ViolationTypeFine.objects.filter(violation_type=vtype).exists():
        ViolationTypeFine.objects.create(
            violation_type=vtype, penalty_amount=old_amount,
            effective_from=EPOCH, changed_by=None,
        )
    ViolationTypeFine.objects.create(
        violation_type=vtype, penalty_amount=vtype.penalty_amount,
        effective_from=timezone.now(), changed_by=user,
    )
