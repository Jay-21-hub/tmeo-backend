"""
The seven Reports-module reports. Every builder returns
    {'columns': [...], 'summary': {...}, 'rows': [...], 'notes': [...]}
Money is returned as 2-decimal STRINGS ("1500.00") — never floats. A money
value of None means UNAVAILABLE (not zero); see build_by_type.
"""
import calendar
from collections import Counter, defaultdict
from decimal import Decimal

from django.utils import timezone

from violations.analytics import AGING_BUCKETS, clean_location
from violations.models import Violation, ViolationType

from .filters import UNPAID_STATUS
from .locations import UNSPECIFIED, canonical_location
from .sources import ENFORCER_OVR, IMPORTED, attach_items, load_tickets

STATUS_LABELS = dict(Violation.Status.choices)
CATEGORY_LABELS = dict(ViolationType.Category.choices)
ZERO = Decimal('0')
MAX_FILLED_MONTHS = 120


def m(v):
    return None if v is None else str(Decimal(v).quantize(Decimal('0.01')))


def pct(n, total):
    return round(n * 100 / total, 1) if total else 0.0


def _col(key, label, kind='text', align='left'):
    return {'key': key, 'label': label, 'type': kind, 'align': align}


def _label_variants(counter_by_key):
    """key -> display: most frequent cleaned spelling; ties prefer Title Case,
    then alphabetical (deterministic)."""
    return {k: sorted(c.items(), key=lambda kv: (-kv[1], kv[0] != kv[0].title(), kv[0]))[0][0]
            for k, c in counter_by_key.items()}


# ── 1. Violations by Status ──────────────────────────────────────────────
def build_status(f):
    tickets = load_tickets(f)
    agg = {s: {'tickets': 0, 'fines': ZERO} for s in STATUS_LABELS}
    for t in tickets:
        agg[t['status']]['tickets'] += 1
        agg[t['status']]['fines'] += t['penalty']
    total = len(tickets)
    rows = [{'status': s, 'status_label': STATUS_LABELS[s], 'tickets': a['tickets'],
             'percent': pct(a['tickets'], total), 'fines': m(a['fines'])}
            for s, a in agg.items()]
    return {
        'columns': [_col('status', 'Status', 'status'), _col('tickets', 'Tickets', 'int', 'right'),
                    _col('percent', '% of Tickets', 'percent', 'right'),
                    _col('fines', 'Total Penalty', 'money', 'right')],
        'summary': {'total_tickets': total, 'total_penalty': m(sum((a['fines'] for a in agg.values()), ZERO)),
                    'paid_tickets': agg['paid']['tickets'],
                    'unpaid_tickets': agg['pending']['tickets'] + agg['processing']['tickets']},
        'rows': rows, 'notes': [],
    }


# ── 2. Monthly ───────────────────────────────────────────────────────────
def _month_span(a, b):
    y, mo = a
    while (y, mo) <= b:
        yield (y, mo)
        y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)


def build_monthly(f):
    tickets = load_tickets(f)
    agg = defaultdict(lambda: {'tickets': 0, 'paid': 0, 'fines': ZERO})
    for t in tickets:
        k = (t['date'].year, t['date'].month)
        agg[k]['tickets'] += 1
        agg[k]['paid'] += t['status'] == 'paid'
        agg[k]['fines'] += t['penalty']
    keys = sorted(agg)
    if f.date_from and f.date_to:
        span = list(_month_span((f.date_from.year, f.date_from.month), (f.date_to.year, f.date_to.month)))
        if len(span) <= MAX_FILLED_MONTHS:
            keys = span  # zero months are real zeros here (no tickets that month)
    rows = [{'month_key': f'{y}-{mo:02d}', 'month': f'{calendar.month_abbr[mo]} {y}',
             'total_violations': agg[(y, mo)]['tickets'], 'paid': agg[(y, mo)]['paid'],
             'unpaid': agg[(y, mo)]['tickets'] - agg[(y, mo)]['paid'],
             'total_fines': m(agg[(y, mo)]['fines'])} for (y, mo) in keys]
    return {
        'columns': [_col('month', 'Month'), _col('total_violations', 'Total Violations', 'int', 'right'),
                    _col('paid', 'Paid', 'int', 'right'), _col('unpaid', 'Unpaid', 'int', 'right'),
                    _col('total_fines', 'Total Penalty', 'money', 'right')],
        'summary': {'months': len(rows), 'total_violations': len(tickets),
                    'paid': sum(r['paid'] for r in rows), 'unpaid': sum(r['unpaid'] for r in rows),
                    'total_penalty': m(sum((a['fines'] for a in agg.values()), ZERO))},
        'rows': rows, 'notes': [],
    }


# ── 3. Violations by Type ────────────────────────────────────────────────
def build_by_type(f):
    tickets = attach_items(f, load_tickets(f))
    agg = {}
    ticket_ids = set()
    items_total = unknown_items = 0
    known_total = ZERO
    without_items = 0
    for t in tickets:
        included = [i for i in t['items'] if not f.category or i['category'] == f.category]
        if not t['items']:
            without_items += 1
        if not included:
            continue
        ticket_ids.add((t['origin'], t['id']))
        for i in included:
            a = agg.setdefault(i['code'], {'name': i['name'], 'category': i['category'],
                                           'tickets': 0, 'known': ZERO, 'unknown': 0})
            a['tickets'] += 1
            items_total += 1
            if i['penalty'] is None:
                a['unknown'] += 1
                unknown_items += 1
            else:
                a['known'] += i['penalty']
                known_total += i['penalty']

    rows = []
    for code, a in sorted(agg.items(), key=lambda kv: (-kv[1]['tickets'], kv[0])):
        if a['unknown'] == 0:
            cov = 'complete'
        elif a['unknown'] == a['tickets']:
            cov = 'unavailable'
        else:
            cov = 'partial'
        rows.append({
            'code': code, 'violation_name': a['name'],
            'category': a['category'], 'category_label': CATEGORY_LABELS.get(a['category'], a['category'] or '—'),
            'tickets': a['tickets'],
            # None = UNAVAILABLE (never a silent 0.00)
            'fines': None if cov == 'unavailable' else m(a['known']),
            'fines_unknown_items': a['unknown'], 'fines_coverage': cov,
        })

    overall = 'complete' if unknown_items == 0 else ('unavailable' if unknown_items == items_total else 'partial')
    notes = []
    if unknown_items:
        notes.append(
            f'{unknown_items} imported violation item(s) have no item-level penalty on record. '
            'Their fines are UNAVAILABLE (not PHP 0.00) and are excluded from the fine totals below; '
            'ticket counts are unaffected. Ticket-level penalties remain available in the Status, '
            'Monthly, Location and Vehicle Type reports.')
    notes.append('A ticket with several violation types is counted once under each type, so row counts '
                 'add up to the total number of violation items, not the number of tickets.')
    return {
        'columns': [_col('code', 'Code'), _col('violation_name', 'Violation'),
                    _col('category_label', 'Category'), _col('tickets', 'Tickets', 'int', 'right'),
                    _col('fines', 'Fines (item-level)', 'money_coverage', 'right')],
        'summary': {'total_tickets': len(ticket_ids), 'total_items': items_total,
                    'violation_types': len(rows),
                    'fines_known_total': m(known_total) if overall != 'unavailable' else None,
                    'items_with_unavailable_fines': unknown_items,
                    'fines_coverage': overall, 'tickets_without_items': without_items},
        'rows': rows, 'notes': notes,
    }


# ── 4. Enforcer Activity ─────────────────────────────────────────────────
def _has_issuing_enforcer(t):
    """Only genuine enforcer-issued OVRs are enforcement activity. Walk-ins
    and Admin imports never are; imported_by is deliberately not even loaded."""
    return t['source'] == ENFORCER_OVR and bool(t['enforcer_id'] or t['enforcer_name'])


def build_enforcer(f):
    tickets = load_tickets(f)
    # Legacy archives carry no user id: they match an active person by NAME,
    # and only when exactly one active account has that name (event-time or
    # live). Anything ambiguous stays its own name-keyed row.
    active_name_to_ids = defaultdict(set)
    for t in tickets:
        if t['origin'] == 'active' and t['enforcer_id']:
            for nm in (t['enforcer_name'], t['enforcer_live_name']):
                if nm:
                    active_name_to_ids[nm.casefold()].add(t['enforcer_id'])

    agg, excluded = {}, 0
    for t in tickets:
        if not _has_issuing_enforcer(t):
            excluded += 1
            continue
        if t['enforcer_id']:
            key = ('id', t['enforcer_id'])
        else:
            ids = active_name_to_ids.get(t['enforcer_name'].casefold(), set())
            key = ('id', next(iter(ids))) if len(ids) == 1 else ('name', t['enforcer_name'].casefold())
        a = agg.setdefault(key, {'name': None, 'name_at': None, 'fallback': '',
                                 'badge': '', 'badge_at': None,
                                 'tickets': 0, 'paid': 0, 'fines': ZERO})
        # Grouped on the stable person. Label = latest EVENT-TIME name; badge
        # = latest snapshot badge (snapshot-only, never the live account's).
        if t['enforcer_trusted'] and (a['name_at'] is None or t['_sort'] > a['name_at']):
            a['name'], a['name_at'] = t['enforcer_name'], t['_sort']
        if t['enforcer_badge'] and (a['badge_at'] is None or t['_sort'] > a['badge_at']):
            a['badge'], a['badge_at'] = t['enforcer_badge'], t['_sort']
        a['fallback'] = a['fallback'] or t['enforcer_name']
        a['tickets'] += 1
        a['paid'] += t['status'] == 'paid'
        a['fines'] += t['penalty']
    for a in agg.values():
        a['name'] = a['name'] or a['fallback'] or '—'

    rows = [{'enforcer': a['name'], 'badge_number': a['badge'] or None,
             'tickets_issued': a['tickets'], 'paid': a['paid'], 'unpaid': a['tickets'] - a['paid'],
             'total_fines_issued': m(a['fines'])}
            for a in sorted(agg.values(), key=lambda a: (-a['tickets'], a['name']))]
    notes = ['Fines shown are the value of tickets issued, not money collected.']
    if excluded:
        notes.append(f'{excluded} ticket(s) with no issuing enforcer (staff walk-in or Admin Excel import) '
                     'are not counted as enforcement activity.')
    return {
        'columns': [_col('enforcer', 'Enforcer'), _col('badge_number', 'Badge No.'),
                    _col('tickets_issued', 'Tickets Issued', 'int', 'right'),
                    _col('paid', 'Paid', 'int', 'right'), _col('unpaid', 'Unpaid', 'int', 'right'),
                    _col('total_fines_issued', 'Value of Tickets Issued', 'money', 'right')],
        'summary': {'enforcers': len(rows), 'tickets_issued': sum(r['tickets_issued'] for r in rows),
                    'total_fines_issued': m(sum((a['fines'] for a in agg.values()), ZERO)),
                    'tickets_without_enforcer': excluded},
        'rows': rows, 'notes': notes,
    }


# ── 5. Outstanding Penalties ─────────────────────────────────────────────
def build_outstanding(f):
    # Unpaid tickets are never archived (only paid ones are) → active only.
    today = timezone.localdate()
    tickets = [t for t in load_tickets(f, include_archived=False) if t['status'] in UNPAID_STATUS]
    tickets.sort(key=lambda t: (t['date'], t['id']))
    buckets = {k: {'label': label, 'tickets': 0, 'amount': ZERO} for k, label, _, _ in AGING_BUCKETS}
    rows = []
    for t in tickets:
        age = max((today - t['date']).days, 0)
        for k, _, lo, hi in AGING_BUCKETS:
            if age >= lo and (hi is None or age <= hi):
                buckets[k]['tickets'] += 1
                buckets[k]['amount'] += t['penalty']
                break
        rows.append({
            'ovr_number': t['ovr_number'] or None, 'date': t['date'].isoformat(),
            'plate_no': t['plate'] or None, 'violator': t['violator'] or None,
            'location': canonical_location(t['location'])[1],
            'status': t['status'], 'status_label': STATUS_LABELS[t['status']],
            'age_days': age, 'penalty': m(t['penalty']),
        })
    rows.sort(key=lambda r: (-r['age_days'], r['date']))
    return {
        'columns': [_col('ovr_number', 'OVR No.'), _col('date', 'Date Issued', 'date'),
                    _col('plate_no', 'Plate No.'), _col('violator', 'Violator'),
                    _col('location', 'Location'), _col('status', 'Status', 'status'),
                    _col('age_days', 'Age (days)', 'int', 'right'),
                    _col('penalty', 'Penalty', 'money', 'right')],
        'summary': {'tickets': len(rows), 'total_outstanding': m(sum((t['penalty'] for t in tickets), ZERO)),
                    'aging': [{'key': k, 'label': b['label'], 'tickets': b['tickets'], 'amount': m(b['amount'])}
                              for k, b in buckets.items()],
                    'as_of': today.isoformat()},
        'rows': rows,
        'notes': ['Outstanding = pending or processing tickets. Age is counted in days from the date issued '
                  'up to the generation date.'],
    }


# ── 6/7. Location and Vehicle Type ───────────────────────────────────────
def _group_report(f, keyfn, label_key, label_title, first_col):
    tickets = load_tickets(f)
    counts = defaultdict(Counter)
    agg = defaultdict(lambda: {'tickets': 0, 'paid': 0, 'fines': ZERO})
    for t in tickets:
        key, display = keyfn(t)
        counts[key][display] += 1
        a = agg[key]
        a['tickets'] += 1
        a['paid'] += t['status'] == 'paid'
        a['fines'] += t['penalty']
    names = _label_variants(counts)
    total = len(tickets)
    rows = [{label_key: UNSPECIFIED if k == '' else names[k], 'tickets': a['tickets'],
             'percent': pct(a['tickets'], total), 'paid': a['paid'], 'unpaid': a['tickets'] - a['paid'],
             'total_fines': m(a['fines'])}
            for k, a in agg.items()]
    rows.sort(key=lambda r: (r[label_key] == UNSPECIFIED, -r['tickets'], r[label_key]))
    return {
        'columns': [_col(label_key, label_title), _col('tickets', 'Tickets', 'int', 'right'),
                    _col('percent', '% of Tickets', 'percent', 'right'),
                    _col('paid', 'Paid', 'int', 'right'), _col('unpaid', 'Unpaid', 'int', 'right'),
                    _col('total_fines', 'Total Penalty', 'money', 'right')],
        'summary': {first_col: len(rows), 'total_tickets': total,
                    'total_penalty': m(sum((a['fines'] for a in agg.values()), ZERO))},
        'rows': rows, 'notes': [],
    }


def build_location(f):
    r = _group_report(f, lambda t: canonical_location(t['location']), 'location', 'Location', 'locations')
    r['notes'].append('Known duplicate spellings of the same place (e.g. "Perez Park" and "Perez Park, Lucena") '
                      'are combined. Tickets with no usable location are listed as "Unspecified".')
    return r


def _vehicle_key(t):
    v = clean_location(t['vehicle_type'])   # trim + collapse whitespace; '' if blank
    return (v.casefold(), v) if v else ('', UNSPECIFIED)


def build_vehicle_type(f):
    r = _group_report(f, _vehicle_key, 'vehicle_type', 'Vehicle Type', 'vehicle_types')
    r['notes'].append('Spellings that differ only by letter case or spacing are combined. '
                      'Tickets with no vehicle type are listed as "Unspecified".')
    return r