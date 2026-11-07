"""
Ticket loading for reports: ACTIVE `Violation` rows + ARCHIVED snapshots.

An archive run MOVES a paid ticket out of the active table (it is deleted
there), so a ticket normally exists in exactly one place. As a defence, the
shared helper database_management.historical.deduped_archived() drops an
archived snapshot that denotes the SAME original violation as an active row
(identity = original id + created_at, not the id alone), so nothing can ever
be double counted while a different violation that merely reuses an id is kept.

Each ticket is normalised to a plain dict with identical keys, whatever its
origin. One lean `.values()` query per source (no per-row queries / N+1).
Grouping is done in Python because archived rows keep their items in a JSON
array that the ORM cannot GROUP BY.
"""
from decimal import Decimal

from django.utils import timezone

from database_management.historical import deduped_archived
from database_management.models import ArchivedViolation
from violations.models import Violation, ViolationItem

from .filters import VALID_STATUS

IMPORTED = Violation.Source.IMPORTED
ENFORCER_OVR = Violation.Source.ENFORCER_OVR


def D(v):
    """Decimal from DB decimal / JSON float / str / None (None -> 0)."""
    if v is None or v == '':
        return Decimal('0')
    return v if isinstance(v, Decimal) else Decimal(str(v))


def _local_date(dt):
    return timezone.localtime(dt).date() if timezone.is_aware(dt) else dt.date()


def _active_qs(f):
    qs = Violation.objects.all()
    if f.date_from:
        qs = qs.filter(date_issued__date__gte=f.date_from)
    if f.date_to:
        qs = qs.filter(date_issued__date__lte=f.date_to)
    if f.status:
        qs = qs.filter(status=f.status)
    if f.vehicle_type:
        qs = qs.filter(vehicle_type__iexact=f.vehicle_type)
    return qs


def _trusted(src):
    return src in ('event', 'derived')


def _active_ticket(r):
    trusted = _trusted(r['enforcer_snapshot_source'])
    snap_name = (r['enforcer_name_snapshot'] or '').strip() if trusted else ''
    snap_badge = (r['enforcer_badge_snapshot'] or '').strip() if trusted else ''
    return {
        'origin': 'active', 'id': r['id'],
        'date': _local_date(r['date_issued']),
        'status': r['status'], 'penalty': D(r['penalty_amount']),
        'source': r['source'],
        'enforcer_id': r['enforcer_id'],
        # Phase 3: event-time name first; the live NAME is only a fallback
        # (enforcer_live_name). The badge is snapshot-only — never the live one.
        'enforcer_name': snap_name or (r['enforcer__full_name'] or ''),
        'enforcer_live_name': r['enforcer__full_name'] or '',
        'enforcer_badge': snap_badge,
        'enforcer_trusted': bool(snap_name),
        'location': r['location'] or '', 'vehicle_type': r['vehicle_type'] or '',
        'plate': r['plate_number'] or '', 'violator': r['violator_name'] or '',
        'ovr_number': r['ovr_number'] or '',
        '_sort': (r['date_issued'], r['id']),
    }


_ACTIVE_FIELDS = (
    'id', 'date_issued', 'status', 'penalty_amount', 'source', 'enforcer_id',
    'enforcer__full_name', 'enforcer_name_snapshot', 'enforcer_badge_snapshot',
    'enforcer_snapshot_source', 'location', 'vehicle_type',
    'plate_number', 'violator_name', 'ovr_number',
)


def _archived_ticket(av):
    d = av.data or {}
    trusted = _trusted(d.get('enforcer_snapshot_source'))
    snap_name = (d.get('enforcer_name_snapshot') or '').strip() if trusted else ''
    snap_badge = (d.get('enforcer_badge_snapshot') or '').strip() if trusted else ''
    status = (d.get('status') or '').strip().lower()
    if status not in VALID_STATUS:
        status = 'paid' if av.settlement_status == 'settled' else 'pending'
    return {
        'origin': 'archived', 'id': av.original_violation_id,
        'date': _local_date(av.date_issued),
        'status': status, 'penalty': D(d.get('penalty_amount')),
        'source': d.get('source') or ENFORCER_OVR,
        # Phase 3: archives written after this phase carry the stable id;
        # older ones do not (matched by name only when unambiguous, see
        # build_enforcer). Event-time snapshot name/badge win when trusted.
        'enforcer_id': d.get('enforcer_user_id') or None,
        'enforcer_name': snap_name or (d.get('enforcer_name') or ''),
        'enforcer_live_name': d.get('enforcer_name') or '',
        'enforcer_badge': snap_badge,
        'enforcer_trusted': bool(snap_name),
        '_sort': (av.date_issued, av.original_violation_id or 0),
        'location': d.get('location') or '', 'vehicle_type': d.get('vehicle_type') or '',
        'plate': d.get('plate_number') or av.plate_number or '',
        'violator': d.get('violator_name') or av.violator_name or '',
        'ovr_number': d.get('ovr_number') or '',
        '_items': d.get('items') or [],
    }


def load_tickets(f, include_archived=True):
    """Return (tickets, items_by_key_fn_ready) — tickets is a list of dicts."""
    tickets = [_active_ticket(r) for r in _active_qs(f).values(*_ACTIVE_FIELDS).iterator(chunk_size=2000)]

    if include_archived:
        aq = ArchivedViolation.objects.all()
        if f.date_from:
            aq = aq.filter(date_issued__date__gte=f.date_from)
        if f.date_to:
            aq = aq.filter(date_issued__date__lte=f.date_to)
        archived = list(deduped_archived(aq).iterator(chunk_size=2000))

        for av in archived:
            t = _archived_ticket(av)
            if f.status and t['status'] != f.status:
                continue
            if f.vehicle_type and t['vehicle_type'].strip().casefold() != f.vehicle_type.strip().casefold():
                continue
            tickets.append(t)
    return tickets


def item_penalty_is_authoritative(source):
    """Imported tickets carry only a ticket-level penalty; their items hold a
    0 PLACEHOLDER snapshot that is *unknown*, not a real zero."""
    return source != IMPORTED


def attach_items(f, tickets):
    """Adds t['items'] = [{code,name,category,penalty(Decimal|None)}] to every
    ticket. penalty is None when the item-level amount is unavailable."""
    active_ids = {t['id'] for t in tickets if t['origin'] == 'active'}
    by_id = {}
    if active_ids:
        # Sub-select on the SAME filtered queryset (no huge IN list).
        rows = (ViolationItem.objects
                .filter(violation__in=_active_qs(f).values('pk'))
                .values('violation_id', 'violation_type__code', 'violation_type__name',
                        'violation_type__category', 'penalty_amount_snapshot'))
        for r in rows.iterator(chunk_size=5000):
            by_id.setdefault(r['violation_id'], []).append({
                'code': r['violation_type__code'], 'name': r['violation_type__name'],
                'category': r['violation_type__category'],
                'penalty': D(r['penalty_amount_snapshot']),
            })
    for t in tickets:
        if t['origin'] == 'active':
            raw = by_id.get(t['id'], [])
        else:
            raw = [{
                'code': i.get('code') or '', 'name': i.get('name') or '',
                'category': i.get('category') or '',
                'penalty': D(i.get('penalty_amount')),
            } for i in t.pop('_items', [])]
        if not item_penalty_is_authoritative(t['source']):
            raw = [{**i, 'penalty': None} for i in raw]
        t['items'] = raw
    return tickets