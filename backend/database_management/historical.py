"""
Shared helpers for reading ACTIVE + ARCHIVED violations together.

Two rules live here so every consumer (archive, analytics, Year Comparison,
public stats, reports) applies them identically:

1. YEAR = Asia/Manila calendar year of ``date_issued``.
   ``date_issued`` is stored in UTC.  A ticket issued 2025-12-31 20:00 UTC is
   2026-01-01 04:00 in Manila and therefore belongs to 2026.  Never use
   ``dt.year`` on the raw UTC value.

2. NEVER COUNT THE SAME ORIGINAL VIOLATION TWICE.
   Archiving MOVES a ticket (the active row is deleted), so normally a
   ticket exists in exactly one place.  Duplicates can still appear (restore
   from backup, a manual re-import, an interrupted older archive).  The
   identity of an original violation is NOT its id alone — ids are only
   unique inside one table lifetime, and wrongly dropping a legitimate
   record is worse than a rare double count that the inspection command
   reports.  Identity is therefore:

       (original id, created_at)          when the snapshot carries created_at
       (original id, date_issued)         fallback for very old snapshots

   Two rows with the same id but a DIFFERENT created_at are two different
   violations: both are kept.

   Known, reported ambiguities (never resolved by silently dropping a record):
     * created_at is compared as an exact instant (microsecond precision,
       offset-independent: +00:00 and +08:00 spellings of one instant match).
     * A snapshot with no created_at, or a naive one, falls back to
       (id, date_issued). That is the weakest identity: a different violation
       that reuses the id AND has the identical date_issued would be treated
       as the same one. inspect_archive_duplicates lists every row that relies
       on this fallback so it can be reviewed.
"""
from datetime import datetime, timezone as dt_timezone

from django.db.models import Count
from django.db.models.functions import ExtractYear
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from violations.models import Violation

from .models import ArchivedViolation


def manila_year(dt):
    """Asia/Manila calendar year of an aware (or naive-UTC-assumed) datetime."""
    if dt is None:
        return timezone.localdate().year
    if timezone.is_naive(dt):
        dt = timezone.make_aware(dt, dt_timezone.utc)
    return timezone.localtime(dt).year


def _parse_snapshot_dt(value):
    if not value:
        return None
    if hasattr(value, 'isoformat'):
        dt = value
    else:
        try:
            dt = parse_datetime(str(value))
        except (TypeError, ValueError):
            return None
    # A timestamp without an offset is ambiguous (UTC? Manila?) — never guess:
    # treat it as "not usable" so the weaker (id, date_issued) identity is used
    # and the case is reported by inspect_archive_duplicates.
    if dt is None or timezone.is_naive(dt):
        return None
    return dt


def has_strong_identity(snapshot_created_at):
    """True when the snapshot carries a usable, offset-aware created_at."""
    return _parse_snapshot_dt(snapshot_created_at) is not None


def archived_identity(original_id, snapshot_created_at, date_issued):
    """Identity tuple of one ARCHIVED row."""
    created = _parse_snapshot_dt(snapshot_created_at)
    if created is not None:
        return (original_id, 'created_at', created)
    return (original_id, 'date_issued', date_issued)


def active_identity_matches(archived_ident, active_created_at, active_date_issued):
    """True when an archived identity denotes the same violation as an active row."""
    _id, kind, value = archived_ident
    if kind == 'created_at':
        return value == active_created_at
    return value == active_date_issued


def duplicate_archived_pks():
    """Primary keys of ArchivedViolation rows that must be EXCLUDED from any
    aggregation because the same original violation is already counted
    elsewhere:

      * an archived snapshot whose original is still in the active table
        (same identity)  -> the ACTIVE row wins, the snapshot is excluded;
      * several archived snapshots of the same original (same identity)
        -> the first (lowest pk) wins, later ones are excluded.

    Rows that merely share an id but have a different identity are kept.
    The common case (no duplicates) costs two tiny queries.
    """
    dup = set()

    # (a) archived vs active
    active_ids = Violation.objects.values('id')
    clash = list(
        ArchivedViolation.objects
        .filter(original_violation_id__in=active_ids)
        .values_list('pk', 'original_violation_id', 'date_issued', 'data__created_at')
    )
    if clash:
        active = {
            vid: (created, issued)
            for vid, created, issued in Violation.objects
            .filter(id__in={c[1] for c in clash})
            .values_list('id', 'created_at', 'date_issued')
        }
        for pk, oid, issued, snap_created in clash:
            ident = archived_identity(oid, snap_created, issued)
            a_created, a_issued = active[oid]
            if active_identity_matches(ident, a_created, a_issued):
                dup.add(pk)

    # (b) archived vs archived
    repeated = list(
        ArchivedViolation.objects.values('original_violation_id')
        .annotate(n=Count('id')).filter(n__gt=1)
        .values_list('original_violation_id', flat=True)
    )
    if repeated:
        seen = set()
        for pk, oid, issued, snap_created in (
            ArchivedViolation.objects.filter(original_violation_id__in=repeated)
            .order_by('pk')
            .values_list('pk', 'original_violation_id', 'date_issued', 'data__created_at')
        ):
            ident = archived_identity(oid, snap_created, issued)
            if ident in seen:
                dup.add(pk)
            else:
                seen.add(ident)
    return dup


def deduped_archived(qs=None, dup_pks=None):
    """ArchivedViolation queryset with duplicate snapshots removed.

    ``dup_pks`` lets a caller that builds several querysets in one request
    (the Admin dashboard) compute ``duplicate_archived_pks()`` ONCE and share
    it; omitted, it is computed here exactly as before."""
    if qs is None:
        qs = ArchivedViolation.objects.all()
    dup = duplicate_archived_pks() if dup_pks is None else dup_pks
    return qs.exclude(pk__in=dup) if dup else qs


def archived_for_year(year, qs=None):
    """Deduped archived rows of one Asia/Manila year, derived from
    ``date_issued`` (never from the stored ``violation_year`` column, which
    older archive runs computed in UTC)."""
    return deduped_archived(qs).filter(date_issued__year=year)

# ── Checkpoint 2: Asia/Manila year / month for archive browsing + exports ──
#
# The stored ``ArchivedViolation.violation_year`` column was computed in UTC by
# older archive runs, so it can disagree with the Manila year of ``date_issued``
# near New Year.  Browsing, filtering and exporting therefore derive year and
# month from ``date_issued`` (the same rule as analytics) and never from that
# column.  The column itself is left untouched (no data repair).

def manila_period_bounds(year, month=None):
    """[start, end) as aware datetimes in the current (Asia/Manila) time zone
    for one calendar year, or one month of it.  Range filters on
    ``date_issued`` are index-friendly and DST-free (Manila has no DST)."""
    tz = timezone.get_current_timezone()
    if month:
        start = datetime(year, month, 1)
        end = datetime(year + (1 if month == 12 else 0), (month % 12) + 1, 1)
    else:
        start, end = datetime(year, 1, 1), datetime(year + 1, 1, 1)
    return timezone.make_aware(start, tz), timezone.make_aware(end, tz)


def archived_in_period(qs, year=None, month=None):
    """Narrow an ArchivedViolation queryset to a Manila year and/or month of
    ``date_issued``.  A month with no year matches that month of any year."""
    if year:
        lo, hi = manila_period_bounds(int(year), int(month) if month else None)
        return qs.filter(date_issued__gte=lo, date_issued__lt=hi)
    if month:
        return qs.filter(date_issued__month=int(month))   # evaluated in Manila time
    return qs


def archived_years():
    """Distinct Manila years that have at least one (deduplicated) archived
    record, newest first.  Derived from ``date_issued``, never hardcoded."""
    return list(
        deduped_archived()
        .annotate(yr=ExtractYear('date_issued'))
        .order_by('-yr').values_list('yr', flat=True).distinct()
    )