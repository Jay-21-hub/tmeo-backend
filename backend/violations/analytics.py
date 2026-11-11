"""
Analytics aggregation service for GET /api/violations/analytics/.

SCOPE SEMANTICS (read this before changing anything)
----------------------------------------------------
An archive run (database_management.archive_utils.run_archive) moves only
records whose staff processing is finished (status == paid) out of the
active `Violation` table into `ArchivedViolation` (JSON snapshot).
Pending/processing records are NEVER archived.  Archiving is a storage
housekeeping step, not a business event: a ticket issued this month is
still a violation of this month after it was archived.  Therefore:

  A. OPERATIONAL (active table only)
       - Outstanding penalty aging  (unpaid records are always active)
  B. HISTORICAL (archive only)
       - nothing on its own; only used as part of C
  C. COMBINED (active + archived, by date_issued)  <- default
       (archived duplicates of an active/other snapshot are removed by
        database_management.historical.deduped_archived; years are the
        Asia/Manila year of date_issued, never the stored UTC-era column)
       - every period-based figure: totals, penalties, status split, trend,
         categories, vehicle types, locations, hours/weekdays/heatmap,
         cross-tabs, repeat offenders, comparison vs previous period.

`scope=active` restores the legacy behaviour (active table only).

Everything numeric comes from database aggregation.  The only Python-side
tallies are (1) JSON `items` of archived rows (a JSON array cannot be
GROUP BY'ed with the ORM) and (2) merging the small per-source result
sets.  Nothing is estimated or fabricated.
"""
import copy
import datetime
import re
from decimal import Decimal

from django.db.models import (
    Count, DecimalField, F, Func, Max, Q, Sum, TextField, Value,
)
from django.db.models.fields.json import KeyTextTransform
from django.db.models.functions import (
    Cast, ExtractHour, ExtractIsoWeekDay, ExtractMonth, ExtractYear,
    Lower, Trim, TruncDate, Upper,
)
from django.utils import timezone

from accounts.identity import latest_enforcer_snapshots
from database_management.historical import archived_for_year, deduped_archived
from database_management.models import ArchivedViolation

from .models import VehicleBrandModel, Violation, ViolationItem, ViolationType

VALID_VEHICLE_TYPES = [label for _, label in VehicleBrandModel.Category.choices]
# Real status values come from the model (never hard-coded here).
VALID_STATUSES = [value for value, _ in Violation.Status.choices]
WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
_HAS_ALNUM = re.compile(r'[^\W_]', re.UNICODE)
_WS = re.compile(r'\s+')

AGING_BUCKETS = [
    # key, label, min_age_days, max_age_days (None = open ended)
    ('0_7',   '0–7 days',   0,  7),
    ('8_30',  '8–30 days',  8,  30),
    ('31_60', '31–60 days', 31, 60),
    ('61_plus', '61+ days', 61, None),
]


# ─── helpers ─────────────────────────────────────────────────────────────

def clean_location(value):
    """Trim + collapse whitespace. Returns '' for blank/punctuation-only."""
    if not value:
        return ''
    v = _WS.sub(' ', str(value)).strip()
    return v if _HAS_ALNUM.search(v) else ''


def location_key(value):
    return clean_location(value).casefold()


def _f(v):
    return float(v or 0)


def hour_label(h):
    def fmt(x):
        x %= 24
        return f"{(x % 12) or 12}:00 {'AM' if x < 12 else 'PM'}"
    return f"{fmt(h)}–{fmt(h + 1)}"


def _sql_clean(field):
    """Trim(regexp_replace(field, '\\s+', ' ', 'g')) — PostgreSQL."""
    return Trim(Func(F(field), Value(r'\s+'), Value(' '), Value('g'),
                     function='regexp_replace', output_field=TextField()))


def _source_querysets(scope, dup_pks=None):
    """Returns [(kind, queryset)] with identical `x_*` annotations so every
    aggregation below is written once."""
    active = Violation.objects.annotate(
        x_location=F('location'),
        x_vehicle=F('vehicle_type'),
        x_status=F('status'),
        x_penalty=F('penalty_amount'),
        x_license=F('license_number'),
        x_address=F('address'),
        x_enforcer=F('enforcer__full_name'),
        x_date=F('date_issued'),
    )
    sources = [('active', active)]
    if scope != 'active':
        archived = deduped_archived(ArchivedViolation.objects.all(), dup_pks).annotate(
            x_location=KeyTextTransform('location', 'data'),
            x_vehicle=KeyTextTransform('vehicle_type', 'data'),
            # snapshot stores the display label ("Paid") → lower-case key
            x_status=Lower(KeyTextTransform('status', 'data')),
            x_penalty=Cast(KeyTextTransform('penalty_amount', 'data'),
                           DecimalField(max_digits=12, decimal_places=2)),
            x_license=F('license_number'),
            x_address=KeyTextTransform('address', 'data'),
            x_enforcer=KeyTextTransform('enforcer_name', 'data'),
            # Phase 3: stable person id + event-time snapshot, when archived
            x_enf_uid=KeyTextTransform('enforcer_user_id', 'data'),
            x_enf_snap=KeyTextTransform('enforcer_name_snapshot', 'data'),
            x_enf_badge=KeyTextTransform('enforcer_badge_snapshot', 'data'),
            x_enf_src=KeyTextTransform('enforcer_snapshot_source', 'data'),
            x_date=F('date_issued'),
        )
        sources.append(('archived', archived))
    return sources


def _with_location_cols(qs):
    return qs.annotate(x_loc_clean=_sql_clean('x_location')).annotate(
        x_loc_key=Lower(F('x_loc_clean')))


class Filters:
    def __init__(self, params):
        g = lambda k: (params.get(k) or '').strip()
        self.location = g('location')
        self.category = g('category')
        self.vehicle_type = g('vehicle_type')
        self.violation_type = g('violation_type')   # ViolationType.code
        # optional; anything that is not a real Violation.Status value is ignored
        st = g('status').lower()
        self.status = st if st in VALID_STATUSES else ''
        self.weekday = self._int(g('weekday'), 1, 7)
        self.hour = self._int(g('hour'), 0, 23)

    @staticmethod
    def _int(v, lo, hi):
        try:
            n = int(v)
        except (TypeError, ValueError):
            return None
        return n if lo <= n <= hi else None

    def as_dict(self):
        return {
            'location': self.location, 'category': self.category,
            'vehicle_type': self.vehicle_type, 'violation_type': self.violation_type,
            'weekday': self.weekday, 'hour': self.hour, 'status': self.status,
        }


def _apply_filters(kind, qs, f, include_time=True):
    qs = _with_location_cols(qs)
    if f.location:
        qs = qs.filter(x_loc_key=location_key(f.location))
    if f.vehicle_type:
        qs = qs.filter(x_vehicle=f.vehicle_type)
    if f.status:
        # archived snapshots are always paid, so pending/processing simply match none of them
        qs = qs.filter(x_status=f.status)
    if f.category:
        if kind == 'active':
            qs = qs.filter(id__in=ViolationItem.objects.filter(
                violation_type__category=f.category).values('violation_id'))
        else:
            qs = qs.filter(data__items__contains=[{'category': f.category}])
    if f.violation_type:
        if kind == 'active':
            qs = qs.filter(id__in=ViolationItem.objects.filter(
                violation_type__code=f.violation_type).values('violation_id'))
        else:
            qs = qs.filter(data__items__contains=[{'code': f.violation_type}])
    if include_time and (f.weekday or f.hour is not None):
        qs = qs.annotate(x_wd=ExtractIsoWeekDay('x_date'), x_hr=ExtractHour('x_date'))
        if f.weekday:
            qs = qs.filter(x_wd=f.weekday)
        if f.hour is not None:
            qs = qs.filter(x_hr=f.hour)
    return qs


def _in_period(qs, start, end):
    return qs.filter(x_date__date__gte=start, x_date__date__lte=end)


def _window_cut(qs, start, end, bounds):
    """No bounds: the existing inclusive calendar filter.

    A ``(start, end)`` pair is the half-open result of ``views._manila_bounds``.
    ``'all'`` applies no date cut.
    """
    if bounds == 'all':
        return qs
    if bounds is None:
        return _in_period(qs, start, end)
    lo, hi = bounds
    return qs.filter(x_date__gte=lo, x_date__lt=hi)


def _merge(counter, key, n):
    counter[key] = counter.get(key, 0) + n


# ─── item-level ("cells") aggregation ────────────────────────────────────

def _item_cells(kind, qs):
    """Yield dicts {loc, loc_key, vehicle, code, name, category, count, penalty}
    at the (location, vehicle, violation type) grain."""
    if kind == 'active':
        rows = (qs.values('x_loc_clean', 'x_loc_key', 'x_vehicle',
                          'items__violation_type__code',
                          'items__violation_type__name',
                          'items__violation_type__category')
                  .annotate(c=Count('items'), pen=Sum('items__penalty_amount_snapshot'))
                  .filter(c__gt=0))
        for r in rows:
            yield {
                'loc': r['x_loc_clean'], 'loc_key': r['x_loc_key'],
                'vehicle': r['x_vehicle'],
                'code': r['items__violation_type__code'],
                'name': r['items__violation_type__name'],
                'category': r['items__violation_type__category'],
                'count': r['c'], 'penalty': _f(r['pen']),
            }
    else:
        tally = {}
        for loc, vehicle, items in qs.values_list(
                'x_loc_clean', 'x_vehicle', 'data__items').iterator(chunk_size=2000):
            for it in (items or []):
                k = (loc or '', (loc or '').casefold(), vehicle or '',
                     it.get('code') or '', it.get('name') or '', it.get('category') or '')
                c = tally.setdefault(k, [0, 0.0])
                c[0] += 1
                c[1] += float(it.get('penalty_amount') or 0)
        for (loc, lk, vehicle, code, name, cat), (n, pen) in tally.items():
            yield {'loc': loc, 'loc_key': lk, 'vehicle': vehicle, 'code': code,
                   'name': name, 'category': cat, 'count': n, 'penalty': pen}


def _crosstab(cells, row_field, valid_rows, top_rows, top_cols):
    """Generic Row × ViolationType matrix from cells."""
    row_tot, col_tot, grid = {}, {}, {}
    col_meta = {}
    for c in cells:
        rk = valid_rows(c)
        if not rk:
            continue
        cn = c['name'] or 'Unknown'
        _merge(row_tot, rk, c['count'])
        _merge(col_tot, cn, c['count'])
        _merge(grid, (rk, cn), c['count'])
        col_meta.setdefault(cn, {'code': c['code'], 'category': c['category']})
    rows = sorted(row_tot, key=lambda k: (-row_tot[k], k))[:top_rows]
    cols = sorted(col_tot, key=lambda k: (-col_tot[k], k))[:top_cols]
    others = set(col_tot) - set(cols)
    out_rows = []
    for r in rows:
        types = [{'name': cn, 'code': col_meta[cn]['code'], 'count': grid.get((r, cn), 0)}
                 for cn in cols]
        other = sum(grid.get((r, cn), 0) for cn in others)
        out_rows.append({'label': r, 'total': row_tot[r], 'types': types, 'other': other})
    return {
        'rows': out_rows,
        'type_names': cols,
        'type_codes': {cn: col_meta[cn]['code'] for cn in cols},
        'has_other': bool(others),
        'unit': 'violation_items',
        'max_cell': max([t['count'] for r in out_rows for t in r['types']] or [0]),
    }


# ─── main entry ──────────────────────────────────────────────────────────

def _period_bounds(period, today):
    if period == 'today':
        return today, today
    if period == 'week':
        return today - datetime.timedelta(days=today.weekday()), today
    if period == 'year':
        return datetime.date(today.year, 1, 1), today
    return today.replace(day=1), today


def _totals(sources, f, start, end, bounds=None):
    tot = {'total': 0, 'total_penalty': Decimal(0), 'total_collected': Decimal(0),
           'pending': 0, 'processing': 0, 'paid': 0}
    for kind, base in sources:
        qs = _window_cut(_apply_filters(kind, base, f), start, end, bounds)
        a = qs.aggregate(
            total=Count('id'), pen=Sum('x_penalty'),
            col=Sum('x_penalty', filter=Q(x_status='paid')),
            pending=Count('id', filter=Q(x_status='pending')),
            processing=Count('id', filter=Q(x_status='processing')),
            paid=Count('id', filter=Q(x_status='paid')),
        )
        tot['total'] += a['total'] or 0
        tot['total_penalty'] += a['pen'] or 0
        tot['total_collected'] += a['col'] or 0
        for s in ('pending', 'processing', 'paid'):
            tot[s] += a[s] or 0
    return tot


def _pct_change(curr, prev):
    curr, prev = _f(curr), _f(prev)
    if prev == 0:
        return 100.0 if curr > 0 else 0.0
    return round(((curr - prev) / prev) * 100, 1)


def compute_analytics(params, spec=None):
    """``spec`` is the result of ``views.parse_stats_range``.

    None keeps ``period`` exactly as before. ``range=all`` or a date pair
    replaces that window. ``period`` does not override them.
    """
    today = timezone.localdate()
    current_year, prev_year = today.year, today.year - 1
    period = params.get('period', 'month')
    scope = 'active' if params.get('scope') == 'active' else 'all'
    f = Filters(params)
    bounds = None
    bucket = None
    if spec is not None:
        from violations.views import _TREND_DAY_LIMIT, _earliest_manila_date, _manila_bounds
        if spec[0] == 'all':
            bounds = 'all'
            bucket = 'month'
            sources = _source_querysets(scope)
            prepared = [(k, _apply_filters(k, qs, f)) for k, qs in sources]
            found = [d for d in (_earliest_manila_date(qs) for _k, qs in prepared) if d is not None]
            start = min(found).replace(day=1) if found else today.replace(day=1)
            end = today
            scoped = prepared
        else:
            start, end = spec[1], spec[2]
            bounds = _manila_bounds(start, end)
            span = (end - start).days + 1
            bucket = 'day' if span <= _TREND_DAY_LIMIT else 'month'
            sources = _source_querysets(scope)
            scoped = [(k, _window_cut(_apply_filters(k, qs, f), start, end, bounds))
                      for k, qs in sources]
    else:
        start, end = _period_bounds(period, today)
        sources = _source_querysets(scope)
        scoped = [(k, _window_cut(_apply_filters(k, qs, f), start, end, None))
                  for k, qs in sources]
    delta = (end - start).days + 1

    # ---- totals / status / comparison ---------------------------------
    totals = _totals(sources, f, start, end, bounds)
    by_status = {s: totals[s] for s in ('pending', 'processing', 'paid')}
    # Status chart: every OTHER filter applies, the status filter itself does not,
    # so the donut keeps showing all statuses and the selected one can be highlighted.
    if f.status:
        f_any_status = copy.copy(f)
        f_any_status.status = ''
        status_totals = _totals(sources, f_any_status, start, end, bounds)
    else:
        status_totals = totals
    status_distribution = {
        'items': [{'status': s, 'label': lbl, 'count': status_totals[s]}
                  for s, lbl in Violation.Status.choices],
        'total': sum(status_totals[s] for s in VALID_STATUSES),
        'selected': f.status or None,
        'basis': 'all other filters applied; the status filter itself is not applied here',
    }
    if bounds == 'all':
        comparison = {
            'label': None, 'total_pct': None, 'total_penalty_pct': None,
            'total_collected_pct': None, 'pending_pct': None, 'paid_pct': None,
        }
    else:
        prev_end = start - datetime.timedelta(days=1)
        prev_start = prev_end - datetime.timedelta(days=delta - 1)
        if bounds is None:
            prev = _totals(sources, f, prev_start, prev_end)
            labels = {'today': 'vs yesterday', 'week': 'vs last week',
                      'month': 'vs previous month', 'year': 'vs previous year'}
            compare_label = labels.get(period, 'vs previous period')
        else:
            from violations.views import _manila_bounds
            prev = _totals(sources, f, prev_start, prev_end, _manila_bounds(prev_start, prev_end))
            compare_label = 'vs previous period'
        comparison = {
            'label': compare_label,
            'total_pct': _pct_change(totals['total'], prev['total']),
            'total_penalty_pct': _pct_change(totals['total_penalty'], prev['total_penalty']),
            'total_collected_pct': _pct_change(totals['total_collected'], prev['total_collected']),
            'pending_pct': _pct_change(by_status['pending'], prev['pending']),
            'paid_pct': _pct_change(by_status['paid'], prev['paid']),
        }
    total_penalty, total_collected = _f(totals['total_penalty']), _f(totals['total_collected'])
    collection_overview = {
        'total_penalty': total_penalty,
        'total_collected': total_collected,
        'outstanding': total_penalty - total_collected,
        'collection_rate': round(total_collected / total_penalty * 100, 1) if total_penalty else 0,
        'paid': by_status['paid'], 'pending': by_status['pending'],
        'processing': by_status['processing'],
    }

    # ---- per-day trend --------------------------------------------------
    day_counts = {}
    trunc_kw = {}
    if spec is not None:
        from zoneinfo import ZoneInfo
        trunc_kw['tzinfo'] = ZoneInfo('Asia/Manila')
    for kind, qs in scoped:
        for r in qs.annotate(day=TruncDate('x_date', **trunc_kw)).values('day').annotate(c=Count('id')):
            day = r['day']
            if isinstance(day, datetime.datetime):
                day = day.date()
            _merge(day_counts, day, r['c'])
    if bucket == 'month':
        from violations.views import _MONTH_ABBR
        by_day = []
        year, month = start.year, start.month
        while (year, month) <= (end.year, end.month):
            count = sum(n for day, n in day_counts.items()
                        if day is not None and day.year == year and day.month == month)
            label = _MONTH_ABBR[month - 1]
            by_day.append({
                'date': f'{label} {year}', 'day': label,
                'iso_date': datetime.date(year, month, 1).isoformat(), 'count': count,
            })
            month += 1
            if month == 13:
                month = 1
                year += 1
    else:
        by_day = []
        for i in range(delta - 1, -1, -1):
            d = end - datetime.timedelta(days=i)
            by_day.append({'date': d.strftime('%m/%d'), 'day': d.strftime('%a'),
                           'iso_date': d.isoformat(), 'count': day_counts.get(d, 0)})

    # ---- hour / weekday / heatmap ------------------------------------
    hw = {}
    for kind, qs in scoped:
        for r in (qs.annotate(wd=ExtractIsoWeekDay('x_date'), hr=ExtractHour('x_date'))
                    .values('wd', 'hr').annotate(c=Count('id'))):
            _merge(hw, (r['wd'], r['hr']), r['c'])
    peak_hours = [{'hour': h, 'label': hour_label(h),
                   'count': sum(hw.get((w, h), 0) for w in range(1, 8))} for h in range(24)]
    by_weekday = [{'weekday': w, 'name': WEEKDAY_NAMES[w - 1],
                   'count': sum(hw.get((w, h), 0) for h in range(24))} for w in range(1, 8)]
    heat_cells = [{'weekday': w, 'hour': h, 'count': hw.get((w, h), 0)}
                  for w in range(1, 8) for h in range(24)]
    day_hour_heatmap = {'cells': heat_cells, 'max': max([c['count'] for c in heat_cells] or [0]),
                        'weekday_names': WEEKDAY_NAMES, 'timezone': 'Asia/Manila'}

    # ---- vehicle types ------------------------------------------------------
    veh = {}
    other_vehicle = unspecified_vehicle = 0
    for kind, qs in scoped:
        for r in qs.values('x_vehicle').annotate(c=Count('id')):
            v = (r['x_vehicle'] or '').strip()
            if not v:
                unspecified_vehicle += r['c']
            elif v in VALID_VEHICLE_TYPES:
                _merge(veh, v, r['c'])
            else:
                other_vehicle += r['c']
    by_vehicle_type = [{'vehicle_type': k, 'count': v}
                       for k, v in sorted(veh.items(), key=lambda kv: (-kv[1], kv[0]))][:8]
    total_n = totals['total']
    vehicle_type_breakdown = {
        'items': [{'vehicle_type': k, 'count': v,
                   'share': round(v / total_n * 100, 1) if total_n else 0}
                  for k, v in sorted(veh.items(), key=lambda kv: (-kv[1], kv[0]))],
        'total_violations': total_n,
        'other_count': other_vehicle,
        'unspecified_count': unspecified_vehicle,
        'share_basis': 'all violations in the selected scope',
    }
    most_common_vehicle_type = by_vehicle_type[0]['vehicle_type'] if by_vehicle_type else None

    # ---- item-grain data (categories, top violations, cross-tabs) ----
    cells = []
    for kind, qs in scoped:
        cells.extend(_item_cells(kind, qs))
    fine_by_code = dict(ViolationType.objects.values_list('code', 'penalty_amount'))

    cat_map = {}
    for c in cells:
        k = (c['category'] or '', c['name'])
        e = cat_map.setdefault(k, {'code': c['code'], 'count': 0, 'penalty': 0.0})
        e['count'] += c['count']
        e['penalty'] += c['penalty']
    by_category = [{
        'violation_type__category': k[0] or None,
        'violation_type__name': k[1],
        'violation_type__code': e['code'],
        'count': e['count'],
        'fine_per': _f(fine_by_code.get(e['code'])),
        'total_penalty': e['penalty'],
    } for k, e in sorted(cat_map.items(), key=lambda kv: (-kv[1]['count'], kv[0]))]

    common_violations = [{
        'violation_type__name': r['violation_type__name'],
        'violation_type__code': r['violation_type__code'],
        'violation_type__category': r['violation_type__category'],
        'count': r['count'],
    } for r in sorted(by_category, key=lambda r: (-r['count'], r['violation_type__name']))[:10]]

    valid_veh = lambda c: c['vehicle'] if c['vehicle'] in VALID_VEHICLE_TYPES else None
    vehicle_by_type = _crosstab(cells, 'vehicle', valid_veh, 10, 8)

    # ---- locations (normalised, blanks/punctuation removed) ---------------
    loc_variants, loc_count, loc_pen, invalid_locations = {}, {}, {}, 0
    for kind, qs in scoped:
        for r in (qs.values('x_loc_clean', 'x_loc_key')
                    .annotate(c=Count('id'), pen=Sum('x_penalty'))):
            clean = clean_location(r['x_loc_clean'])
            if not clean:
                invalid_locations += r['c']
                continue
            key = clean.casefold()
            _merge(loc_count, key, r['c'])
            loc_pen[key] = loc_pen.get(key, 0.0) + _f(r['pen'])
            v = loc_variants.setdefault(key, {})
            _merge(v, clean, r['c'])
    def display(key):
        v = loc_variants[key]
        return sorted(v, key=lambda s: (-v[s], s))[0]
    ranked = sorted(loc_count, key=lambda k: (-loc_count[k], k))
    hotspots = [{'location': display(k), 'count': loc_count[k], 'total_penalty': loc_pen[k]}
                for k in ranked[:8]]
    location_ranking = {
        'items': [{'location': display(k), 'count': loc_count[k],
                   'share': round(loc_count[k] / total_n * 100, 1) if total_n else 0,
                   'total_penalty': loc_pen[k]} for k in ranked[:10]],
        'distinct_locations': len(ranked),
        'excluded_invalid_count': invalid_locations,
        'normalization': 'trim, collapse whitespace, case-insensitive; blank and '
                         'punctuation-only values excluded; different spellings '
                         '(e.g. "Perez, Park" vs "Perez Park, Lucena") are NOT merged.',
    }

    def valid_loc(c):
        k = clean_location(c['loc']).casefold()
        return display(k) if k in loc_variants else None
    hotspot_by_type = _crosstab(cells, 'loc', valid_loc, 8, 6)

    # ---- address hotspots ---------------------------------------------------
    addr = {}
    for kind, qs in scoped:
        for r in (qs.exclude(x_address__isnull=True).exclude(x_address__exact='')
                    .values('x_address').annotate(c=Count('id'))):
            _merge(addr, r['x_address'], r['c'])
    address_hotspots = [{'address': k, 'count': v}
                        for k, v in sorted(addr.items(), key=lambda kv: (-kv[1], kv[0]))[:8]]

    # ---- enforcers ---------------------------------------------------------
    # Phase 3: grouped on the STABLE person id. Label = latest EVENT-TIME name
    # (snapshot), live name only as an unverified fallback; badge = latest
    # snapshot badge only (never the live badge). Archived rows written before
    # this phase have no id: they join a person only when exactly one active
    # person carries that name, otherwise they stay their own name-keyed row.
    act_rows = []
    arch_rows = []
    for kind, qs in scoped:
        if kind == 'active':
            act_rows += list(qs.values('enforcer__id', 'x_enforcer')
                               .annotate(c=Count('id'), pen=Sum('x_penalty')))
        else:
            arch_rows += list(qs.values('x_enforcer', 'x_enf_uid', 'x_enf_snap',
                                        'x_enf_badge', 'x_enf_src')
                                .annotate(c=Count('id'), pen=Sum('x_penalty'), last=Max('x_date')))

    snaps = latest_enforcer_snapshots({r['enforcer__id'] for r in act_rows if r['enforcer__id']})
    live_name = {r['enforcer__id']: (r['x_enforcer'] or '') for r in act_rows if r['enforcer__id']}
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

    enf = {}
    def _grp(key):
        return enf.setdefault(key, {'count': 0, 'pen': 0.0, 'name': None, 'live': '',
                                    'a_name': None, 'a_at': None, 'a_badge': '', 'a_badge_at': None})

    for r in act_rows:
        uid = r['enforcer__id']
        key = ('id', uid) if uid else ('name', (r['x_enforcer'] or '').casefold())
        g = _grp(key)
        g['count'] += r['c']; g['pen'] += _f(r['pen'])
        g['live'] = g['live'] or (r['x_enforcer'] or '')
    for r in arch_rows:
        uid = _uid(r['x_enf_uid'])
        name = r['x_enforcer'] or ''
        if uid is None:
            ids = name_to_ids.get(name.casefold(), set())
            uid = next(iter(ids)) if len(ids) == 1 else None
        key = ('id', uid) if uid else ('name', name.casefold())
        g = _grp(key)
        g['count'] += r['c']; g['pen'] += _f(r['pen'])
        g['live'] = g['live'] or name
        if r['x_enf_src'] in ('event', 'derived'):
            last = r['last']
            if (r['x_enf_snap'] or '').strip() and (g['a_at'] is None or last > g['a_at']):
                g['a_name'], g['a_at'] = r['x_enf_snap'].strip(), last
            if (r['x_enf_badge'] or '').strip() and (g['a_badge_at'] is None or last > g['a_badge_at']):
                g['a_badge'], g['a_badge_at'] = r['x_enf_badge'].strip(), last

    top_enforcers = []
    for key, e in enf.items():
        uid = key[1] if key[0] == 'id' else None
        snap = snaps.get(uid) or {}
        label = snap.get('name') or e['a_name'] or e['live'] or None
        badge = snap.get('badge') or e['a_badge'] or ''
        top_enforcers.append({'enforcer__id': uid, 'enforcer__full_name': label,
                              'enforcer__badge_number': badge or None,
                              'count': e['count'], 'total_penalty': e['pen']})
    top_enforcers.sort(key=lambda d: (-d['count'], d['enforcer__full_name'] or ''))
    top_enforcers = top_enforcers[:5]

    # ---- map points ------------------------------------------------------------
    map_points = []
    for kind, qs in scoped:
        if kind == 'active':
            rows = (qs.exclude(latitude__isnull=True).exclude(longitude__isnull=True)
                      .values('id', 'latitude', 'longitude', 'location', 'status'))
            map_points.extend(rows)
        else:
            for r in qs.values('original_violation_id', 'x_status', 'x_location',
                               'data__latitude', 'data__longitude'):
                lat, lng = r['data__latitude'], r['data__longitude']
                if lat is None or lng is None:
                    continue
                map_points.append({'id': r['original_violation_id'], 'latitude': lat,
                                   'longitude': lng, 'location': r['x_location'] or '',
                                   'status': r['x_status'] or '', 'archived': True})

    # ---- repeat offenders (combined, keyed by normalised license number) ----
    lic = {}
    for kind, qs in scoped:
        for r in (qs.exclude(x_license__exact='')
                    .annotate(lk=Upper(Trim('x_license'))).values('lk').annotate(c=Count('id'))):
            if r['lk']:
                _merge(lic, r['lk'], r['c'])
    unique_violators = len(lic)
    repeat_lic = {k: v for k, v in lic.items() if v > 1}
    dist = {'2': 0, '3': 0, '4+': 0}
    for v in repeat_lic.values():
        dist['2' if v == 2 else '3' if v == 3 else '4+'] += 1
    repeat_stats = {
        'unique_violators': unique_violators,
        'repeat_violators': len(repeat_lic),
        'rate': round(len(repeat_lic) / unique_violators * 100, 1) if unique_violators else 0,
        'distribution': [{'bucket': k, 'label': f'{k} violations', 'violators': v}
                         for k, v in dist.items()],
        'identifier': 'license_number (records without a license number are excluded)',
        'period_scoped': True,
    }
    top_rep = sorted(repeat_lic, key=lambda k: (-repeat_lic[k], k))[:10]
    names, locs = {}, {}
    if top_rep:
        for kind, qs in scoped:
            rows = (qs.annotate(lk=Upper(Trim('x_license'))).filter(lk__in=top_rep)
                      .order_by('-x_date').values('lk', 'violator_name', 'x_loc_clean'))
            for r in rows:
                names.setdefault(r['lk'], r['violator_name'])
                l = clean_location(r['x_loc_clean'])
                if l:
                    arr = locs.setdefault(r['lk'], [])
                    if l not in arr:
                        arr.append(l)
    repeat_offenders = [{'license_number': k, 'violator_name': names.get(k, ''),
                         'count': repeat_lic[k], 'locations': locs.get(k, [])[:5]}
                        for k in top_rep]

    # ---- outstanding aging (OPERATIONAL, active only, ignores period) ----
    aging_qs = _apply_filters('active', sources[0][1], f, include_time=False).exclude(x_status='paid')
    kwargs = {}
    for key, _, lo, hi in AGING_BUCKETS:
        q = Q(x_date__date__lte=today - datetime.timedelta(days=lo))
        if hi is not None:
            q &= Q(x_date__date__gte=today - datetime.timedelta(days=hi))
        kwargs[f'n_{key}'] = Count('id', filter=q)
        kwargs[f'a_{key}'] = Sum('x_penalty', filter=q)
    # records dated in the future (clock/timezone edge) count as 0–7 days old
    kwargs['n_future'] = Count('id', filter=Q(x_date__date__gt=today))
    kwargs['a_future'] = Sum('x_penalty', filter=Q(x_date__date__gt=today))
    kwargs['n_all'] = Count('id')
    kwargs['a_all'] = Sum('x_penalty')
    ag = aging_qs.aggregate(**kwargs)
    aging_buckets = []
    for key, label, lo, hi in AGING_BUCKETS:
        n, a = ag[f'n_{key}'] or 0, _f(ag[f'a_{key}'])
        if key == '0_7':
            n += ag['n_future'] or 0
            a += _f(ag['a_future'])
        aging_buckets.append({'key': key, 'label': label, 'min_days': lo, 'max_days': hi,
                              'count': n, 'amount': a})
    penalty_aging = {
        'as_of': today.isoformat(),
        'basis': 'days since date_issued, records not yet paid',
        'scope': 'active (operational) records; pending/processing are never archived; '
                 'the period filter is ignored',
        'buckets': aging_buckets,
        'total_count': ag['n_all'] or 0,
        'total_amount': _f(ag['a_all']),
        'note': 'Buckets are neutral age ranges; no official TMEO payment deadline is assumed.',
    }

    # ---- filter options -------------------------------------------------------
    loc_opts = {}
    for kind, qs in sources:
        for r in (_with_location_cols(qs).values('x_loc_clean').annotate(c=Count('id'))):
            cl = clean_location(r['x_loc_clean'])
            if cl:
                v = loc_opts.setdefault(cl.casefold(), {})
                _merge(v, cl, r['c'])
    filter_options = {
        'locations': sorted((sorted(v, key=lambda s: (-v[s], s))[0] for v in loc_opts.values()),
                            key=str.casefold),
        'categories': [c[0] for c in ViolationType.Category.choices],
        'vehicle_types': VALID_VEHICLE_TYPES,
        'statuses': [{'value': v, 'label': l} for v, l in Violation.Status.choices],
    }

    # ---- year comparison (unchanged semantics: active + archived) -------------
    def month_counts(year):
        counts = {}
        rows = (Violation.objects.filter(date_issued__year=year)
                .annotate(m=ExtractMonth('date_issued')).values('m').annotate(c=Count('id')))
        for r in rows:
            _merge(counts, r['m'], r['c'])
        # Manila year from date_issued + duplicate snapshots removed.
        for r in (archived_for_year(year)
                  .annotate(m=ExtractMonth('date_issued')).values('m').annotate(c=Count('id'))):
            _merge(counts, r['m'], r['c'])
        return counts
    cur_counts, prv_counts = month_counts(current_year), month_counts(prev_year)
    year_comparison = [{
        'month': datetime.date(current_year, m, 1).strftime('%b'),
        str(current_year): cur_counts.get(m, 0),
        str(prev_year): prv_counts.get(m, 0),
    } for m in range(1, 13)]
    years = set(Violation.objects.annotate(y=ExtractYear('date_issued'))
                .values_list('y', flat=True).distinct())
    years |= set(deduped_archived().annotate(y=ExtractYear('date_issued'))
                 .values_list('y', flat=True).distinct())
    years.add(current_year)

    counts_by_kind = {k: qs.count() for k, qs in scoped}
    return {
        'total': totals['total'],
        'total_penalty': total_penalty,
        'total_collected': total_collected,
        'comparison': comparison,
        'by_status': by_status,
        'status_distribution': status_distribution,
        'by_day': by_day,
        'by_category': by_category,
        'by_vehicle_type': by_vehicle_type,
        'most_common_vehicle_type': most_common_vehicle_type,
        'top_enforcers': top_enforcers,
        'hotspots': hotspots,
        'address_hotspots': address_hotspots,
        'common_violations': common_violations,
        'repeat_offenders': repeat_offenders,
        'year_comparison': year_comparison,
        'current_year': current_year,
        'prev_year': prev_year,
        'available_years': sorted(years),
        'period': period,
        **({'trend_bucket': bucket} if bucket else {}),
        'collection_overview': collection_overview,
        'map_points': map_points,
        'filter_options': filter_options,
        'applied_filters': f.as_dict(),
        # ── new, additive ─────────────────────────────────────────────
        'scope': {
            'mode': scope,
            'label': 'Active + archived records' if scope == 'all' else 'Active records only',
            'active_count': counts_by_kind.get('active', 0),
            'archived_count': counts_by_kind.get('archived', 0),
            'range': {'start': start.isoformat(), 'end': end.isoformat()},
            'note': 'Archived records are paid tickets moved out of the active table; '
                    'they still count toward the period they were issued in.'
                    if scope == 'all' else 'Archived (paid) records are excluded.',
        },
        'vehicle_type_breakdown': vehicle_type_breakdown,
        'peak_hours': peak_hours,
        'by_weekday': by_weekday,
        'day_hour_heatmap': day_hour_heatmap,
        'hotspot_by_type': hotspot_by_type,
        'vehicle_by_type': vehicle_by_type,
        'location_ranking': location_ranking,
        'penalty_aging': penalty_aging,
        'repeat_offender_stats': repeat_stats,
        'unsupported_analytics': [{
            'key': 'resolution_time',
            'label': 'Assessment / payment resolution time',
            'reason': 'No status-transition history exists. Violation.assessed_at is only the '
                      'latest assessment time, Assessment.date_paid is a date without a time, '
                      'and settled records are deleted from the active table on archive.',
            'required': [
                'A status-history/audit event per transition (violation, from_status, to_status, '
                'changed_at datetime, changed_by), written on every status change',
                'A payment datetime (e.g. Assessment.paid_at DateTimeField) instead of only date_paid',
                'Copy the history into the ArchivedViolation snapshot before deleting the active row',
            ],
        }],
    }