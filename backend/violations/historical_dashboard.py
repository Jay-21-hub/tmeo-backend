"""
Admin-dashboard HISTORICAL panels (Checkpoint 2).

Adds three archived-inclusive panels to ``stats['historical']`` (Admin only).
Every rule is reused from the existing analytics / historical modules so the
dashboard, Analytics and the archive can never disagree:

  * SOURCES   active ``Violation`` + ``deduped_archived()`` snapshots
              (violations.analytics._source_querysets).  A ticket that exists
              in both places, or in two snapshots, is counted once.
  * DATES     Asia/Manila calendar dates of ``date_issued`` (``__date`` is
              evaluated in the project time zone, exactly like analytics).
  * ENFORCER  grouped on the stable user id; label = latest event-time name
              snapshot, badge = snapshot badge only (same rules as
              analytics.compute_analytics and accounts.identity).

Semantics per panel (also returned in ``period`` so a client can label them):

  type_data      ALL-TIME, active + archived.  Unit: violation items
                 (one ticket with 2 offences counts 2) — same unit as the
                 existing active-only ``type_data``.  Top 5 + "Other".
  hotspots       ALL-TIME, active + archived.  Unit: tickets.  Locations are
                 trimmed / whitespace-collapsed and compared case-insensitively;
                 blank and punctuation-only locations are ignored.
  top_enforcers  THIS MONTH (Manila), active + archived.  Unit: tickets.
                 Tickets with no enforcer (staff walk-in) are not a person and
                 are never ranked.  ``period`` is extensible
                 (month | year | all) but the UI only uses 'month'.

Read-only.  Nothing here writes, deletes or alters any row.
"""
import datetime

from django.db import connection
from django.db.models import Count, Max
from django.utils import timezone

from accounts.identity import latest_enforcer_snapshots
from database_management.historical import duplicate_archived_pks
from database_management.models import ArchivedViolation

from .analytics import (
    _in_period, _source_querysets, clean_location, location_key,
)
from .models import ViolationItem

TOP_N = 5
ENFORCER_PERIODS = ('month', 'year', 'all')
LABEL_ALL_TIME = 'Cumulative · includes archived'
LABEL_MONTH = 'This month · includes archived'
LABEL_YEAR = 'This year · includes archived'


def _merge(d, k, n):
    d[k] = d.get(k, 0) + n


# Archived snapshots keep their offences as a JSON list (``data.items``).  Counting
# them by unnesting that list INSIDE PostgreSQL (instead of streaming every
# snapshot into Python) keeps the dashboard flat as the archive grows: measured
# ~0.6 s -> see the Checkpoint 2 performance note.  Rules are unchanged:
#   * duplicate snapshots are excluded (``duplicate_archived_pks``);
#   * a missing / empty offence name is counted as 'Unknown';
#   * one list entry = one violation item (same unit as the active table);
#   * a non-list ``items`` value or a non-object entry contributes nothing.
_ARCHIVED_TYPE_SQL = """
    SELECT COALESCE(NULLIF(it.item ->> 'name', ''), 'Unknown') AS name, COUNT(*) AS n
      FROM {table} AS a
      CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(a.data -> 'items') = 'array'
                 THEN a.data -> 'items' ELSE '[]'::jsonb END) AS it(item)
     WHERE jsonb_typeof(it.item) = 'object'
       AND NOT (a.id = ANY(%s))
       {issued_window}
     GROUP BY 1
"""


def _issued_window(qs, start, end, field):
    """Half-open range from views._manila_bounds. None means no date cut."""
    if start is None:
        return qs
    return qs.filter(**{f'{field}__gte': start, f'{field}__lt': end})


def _archived_type_counts(dup_pks, start=None, end=None):
    window = ''
    params = [sorted(dup_pks)]
    if start is not None:
        window = 'AND a.date_issued >= %s AND a.date_issued < %s'
        params.extend([start, end])
    sql = _ARCHIVED_TYPE_SQL.format(
        table=connection.ops.quote_name(ArchivedViolation._meta.db_table),
        issued_window=window,
    )
    with connection.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def violations_by_type(dup_pks=None, start=None, end=None):
    """[{'name', 'count'}] top 5 + 'Other', active + archived.

    Unit stays violation items. ``start``/``end`` are the Manila bounds from
    ``_manila_bounds``; omitted, the panel stays all-time.
    """
    tally = {}
    items = _issued_window(ViolationItem.objects.all(), start, end, 'violation__date_issued')
    # ACTIVE: one row per (violation type) over every active ticket's items.
    for row in (items.values('violation_type__name')
                .annotate(c=Count('id')).order_by()):
        _merge(tally, row['violation_type__name'] or 'Unknown', row['c'])
    # ARCHIVED (deduplicated), aggregated inside PostgreSQL.
    if dup_pks is None:
        dup_pks = duplicate_archived_pks()
    for name, n in _archived_type_counts(dup_pks, start, end):
        _merge(tally, name, n)
    ranked = sorted(tally.items(), key=lambda kv: (-kv[1], kv[0]))
    out = [{'name': n, 'count': c} for n, c in ranked[:TOP_N]]
    other = sum(c for _n, c in ranked[TOP_N:])
    if other:
        out.append({'name': 'Other', 'count': other})
    return out


def top_locations(dup_pks=None, start=None, end=None):
    """[{'area', 'count', 'trend': None}] top 5, active + archived.

    Locations stay on clean_location / location_key. "Perez Park" and
    "Perez Park, Lucena" stay separate. ``start``/``end`` optional Manila bounds.
    """
    counts = {}      # location_key -> total tickets
    spellings = {}   # location_key -> {display spelling: tickets}
    for _kind, base in _source_querysets('all', dup_pks):
        base = _issued_window(base, start, end, 'x_date')
        # Group on the RAW stored value inside PostgreSQL (cheap: one row per
        # distinct spelling) and normalise in Python with the same
        # ``clean_location`` analytics applies, instead of running a regexp over
        # every ticket row.
        rows = base.values('x_location').annotate(c=Count('id')).order_by()
        for r in rows:
            display = clean_location(r['x_location'])
            if not display:
                continue
            key = location_key(display)
            _merge(counts, key, r['c'])
            _merge(spellings.setdefault(key, {}), display, r['c'])
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_N]
    out = []
    for key, c in ranked:
        # most frequent spelling wins; ties -> alphabetical (deterministic)
        area = sorted(spellings[key].items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        out.append({'area': area, 'count': c, 'trend': None})
    return out


def _period_bounds(period, today):
    if period == 'all':
        return None, None
    if period == 'year':
        return datetime.date(today.year, 1, 1), today
    return today.replace(day=1), today


def top_enforcers(period='month', today=None, dup_pks=None, window=None):
    """Top 5 enforcers by tickets for the period, active + archived.

    Tickets with no enforcer are never ranked. ``window`` is the Manila
    ``_manila_bounds`` pair and replaces ``period`` when the stats request
    sent a date range. Omitted, ``period`` (month | year | all) is unchanged.
    """
    today = today or timezone.localdate()
    if window is not None:
        start, end = window

        def narrow(qs):
            return _issued_window(qs, start, end, 'x_date')
    else:
        start, end = _period_bounds(period, today)

        def narrow(qs):
            return qs if start is None else _in_period(qs, start, end)

    act_rows, arch_rows = [], []
    for kind, base in _source_querysets('all', dup_pks):
        qs = narrow(base)
        if kind == 'active':
            act_rows += list(qs.filter(enforcer__isnull=False)
                             .values('enforcer__id', 'x_enforcer')
                             .annotate(c=Count('id')).order_by())
        else:
            arch_rows += list(qs.values('x_enforcer', 'x_enf_uid', 'x_enf_snap',
                                        'x_enf_badge', 'x_enf_src')
                              .annotate(c=Count('id'), last=Max('x_date')).order_by())

    snaps = latest_enforcer_snapshots({r['enforcer__id'] for r in act_rows})
    live_name = {r['enforcer__id']: (r['x_enforcer'] or '') for r in act_rows}
    name_to_ids = {}
    for uid, nm in live_name.items():
        for n in (nm, (snaps.get(uid) or {}).get('name') or ''):
            if n:
                name_to_ids.setdefault(n.casefold(), set()).add(uid)

    def _uid(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    # A person who has ONLY archived tickets in the period can still be known by
    # id: rows archived after Phase 3 carry ``enforcer_user_id``.  Learn
    # name -> id from those rows too, so a legacy name-only snapshot of the same
    # person joins that id instead of being ranked as a second "person".  A name
    # shared by two different ids stays ambiguous and is never merged.
    for r in arch_rows:
        uid = _uid(r['x_enf_uid'])
        if uid is None:
            continue
        names = [(r['x_enforcer'] or '').strip()]
        if r['x_enf_src'] in ('event', 'derived'):
            names.append((r['x_enf_snap'] or '').strip())
        for n in names:
            if n:
                name_to_ids.setdefault(n.casefold(), set()).add(uid)

    groups = {}

    def grp(key):
        return groups.setdefault(key, {'count': 0, 'live': '', 'a_name': None, 'a_at': None,
                                       'a_badge': '', 'a_badge_at': None})

    for r in act_rows:
        g = grp(('id', r['enforcer__id']))
        g['count'] += r['c']
        g['live'] = g['live'] or (r['x_enforcer'] or '')
    for r in arch_rows:
        uid = _uid(r['x_enf_uid'])
        name = (r['x_enforcer'] or '').strip()
        if uid is None:
            ids = name_to_ids.get(name.casefold(), set())
            uid = next(iter(ids)) if len(ids) == 1 else None
        if uid is None and not name:
            continue                       # no person recorded -> never ranked
        g = grp(('id', uid) if uid else ('name', name.casefold()))
        g['count'] += r['c']
        g['live'] = g['live'] or name
        if r['x_enf_src'] in ('event', 'derived'):
            last = r['last']
            if (r['x_enf_snap'] or '').strip() and (g['a_at'] is None or last > g['a_at']):
                g['a_name'], g['a_at'] = r['x_enf_snap'].strip(), last
            if (r['x_enf_badge'] or '').strip() and (g['a_badge_at'] is None or last > g['a_badge_at']):
                g['a_badge'], g['a_badge_at'] = r['x_enf_badge'].strip(), last

    people = []
    for key, g in groups.items():
        uid = key[1] if key[0] == 'id' else None
        snap = snaps.get(uid) or {}
        people.append({
            'id': uid,
            'name': snap.get('name') or g['a_name'] or g['live'] or '—',
            'badge': snap.get('badge') or g['a_badge'] or '',
            'tickets': g['count'],
        })
    people.sort(key=lambda p: (-p['tickets'], p['name']))
    people = people[:TOP_N]
    top = people[0]['tickets'] if people else 0
    for p in people:
        p['rate'] = round((p['tickets'] / top) * 100) if top else 0
    return people


def historical_breakdowns(enforcer_period='month', today=None, window=None):
    """The additive keys merged into ``stats['historical']`` for Admins.

    ``window`` is ``(start, end)`` from ``views._manila_bounds``. When it is
    set, all three panels use that half-open range and ``enforcer_period``
    is ignored. When it is omitted, type/locations stay all-time and
    top enforcers follow ``enforcer_period`` (default month).
    """
    today = today or timezone.localdate()
    if enforcer_period not in ENFORCER_PERIODS:
        enforcer_period = 'month'
    dup_pks = duplicate_archived_pks()      # computed ONCE, shared by all three panels
    if window is not None:
        start, end = window
        return {
            'type_data': violations_by_type(dup_pks, start, end),
            'hotspots': top_locations(dup_pks, start, end),
            'top_enforcers': top_enforcers('all', today, dup_pks, window=(start, end)),
            'period': _window_period(start, end),
        }
    start, end = _period_bounds(enforcer_period, today)
    label = {'month': LABEL_MONTH, 'year': LABEL_YEAR, 'all': LABEL_ALL_TIME}[enforcer_period]
    return {
        'type_data': violations_by_type(dup_pks),
        'hotspots': top_locations(dup_pks),
        'top_enforcers': top_enforcers(enforcer_period, today, dup_pks),
        'period': {
            'type_data': {'scope': 'all_time', 'includes_archived': True, 'label': LABEL_ALL_TIME},
            'hotspots': {'scope': 'all_time', 'includes_archived': True, 'label': LABEL_ALL_TIME},
            'top_enforcers': {
                'scope': enforcer_period, 'includes_archived': True, 'label': label,
                'start': start.isoformat() if start else None,
                'end': end.isoformat() if end else None,
                'timezone': 'Asia/Manila',
            },
        },
    }


def _window_period(start, end):
    """Metadata for a _manila_bounds window. ``end`` is the next Manila midnight."""
    block = {
        'scope': 'date_range', 'includes_archived': True,
        'label': 'Selected period · includes archived',
        'start': start.isoformat(), 'end': end.isoformat(),
        'timezone': 'Asia/Manila',
    }
    return {
        'type_data': {**block, 'unit': 'violation_items'},
        'hotspots': {**block, 'unit': 'tickets'},
        'top_enforcers': {**block, 'unit': 'tickets'},
    }