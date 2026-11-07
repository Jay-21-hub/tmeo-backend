import { useState } from 'react'
import { TrendingUp, TrendingDown, Minus, Hash, DollarSign, Truck, Calendar, Clock, CalendarDays, MapPin, Hourglass, Shield, ChevronRight, Layers } from 'lucide-react'
import { Card, CardHeader } from '../../../../components/ui/Card'
import { peso } from './analyticsConfig'

/* ── Pure helpers: derive insight *state* from data already on the page ──
   Nothing here invents a number — every value comes from props that were
   themselves built from the existing Analytics/YearComparison API
   responses. Each builder returns a small state object; the component
   turns that state into copy, so the "no data" / "tie" / "n/a" wording
   lives in exactly one place per insight. */

function sumMonthly(rows, year) {
  const key = String(year)
  return (rows || []).reduce((s, row) => s + (Number(row[key]) || 0), 0)
}

function buildTrendInsight(rawYearComparison, activeYears) {
  const years = [...new Set((activeYears || []).filter(y => y !== null && y !== undefined))]
    .sort((a, b) => a - b)

  if (years.length < 2) {
    return { state: 'insufficient', years }
  }

  const prevYear = years[years.length - 2]
  const currYear = years[years.length - 1]

  if (!rawYearComparison || rawYearComparison.length === 0) {
    return { state: 'no-data', prevYear, currYear }
  }

  const prevTotal = sumMonthly(rawYearComparison, prevYear)
  const currTotal = sumMonthly(rawYearComparison, currYear)

  if (prevTotal === 0 && currTotal === 0) {
    return { state: 'both-zero', prevYear, currYear }
  }
  if (prevTotal === 0) {
    return { state: 'new-activity', prevYear, currYear, currTotal }
  }
  if (currTotal === prevTotal) {
    return { state: 'same', prevYear, currYear, currTotal }
  }

  const pct = Math.round(((currTotal - prevTotal) / prevTotal) * 1000) / 10
  return {
    state: currTotal > prevTotal ? 'up' : 'down',
    prevYear, currYear, prevTotal, currTotal, pct,
  }
}

function buildTopViolationInsight(commonViolations) {
  if (!commonViolations || commonViolations.length === 0) return { state: 'empty' }
  const top = commonViolations[0].count
  const tied = commonViolations.filter(v => v.count === top)
  if (tied.length > 1) return { state: 'tie', items: tied, count: top }
  return { state: 'single', item: commonViolations[0] }
}

function buildPenaltyInsight(totalPenalty, comparison, byType) {
  if (!totalPenalty) return { state: 'empty' }

  const ranked = [...(byType || [])]
    .filter(t => Number(t.total_penalty || 0) > 0)
    .sort((a, b) => (b.total_penalty || 0) - (a.total_penalty || 0))
  const top = ranked[0] || null
  const tied = top ? ranked.filter(t => t.total_penalty === top.total_penalty) : []

  return {
    state: 'ok',
    totalPenalty,
    pct: typeof comparison?.total_penalty_pct === 'number' ? comparison.total_penalty_pct : null,
    label: comparison?.label || 'vs previous period',
    top,
    tied: tied.length > 1 ? tied : null,
  }
}

function buildVehicleInsight(byVehicleType) {
  if (!byVehicleType || byVehicleType.length === 0) return { state: 'empty' }
  const top = byVehicleType[0]
  const tied = byVehicleType.filter(v => v.count === top.count)
  if (tied.length > 1) return { state: 'tie', items: tied, count: top.count }
  return { state: 'single', item: top }
}

function buildPeakMonthInsight(rawYearComparison, activeYears) {
  const years = [...new Set((activeYears || []).filter(y => y !== null && y !== undefined))]
    .sort((a, b) => a - b)
  const year = years[years.length - 1]

  if (!rawYearComparison || rawYearComparison.length === 0 || year === undefined) {
    return { state: 'empty' }
  }
  const key = String(year)
  const rows = rawYearComparison.filter(r => typeof r[key] === 'number')
  if (rows.length === 0) return { state: 'empty' }

  const max = Math.max(...rows.map(r => r[key] || 0))
  if (max <= 0) return { state: 'no-activity', year }

  const top = rows.filter(r => (r[key] || 0) === max)
  if (top.length > 1) return { state: 'tie', months: top.map(r => r.month), count: max, year }
  return { state: 'single', month: top[0].month, count: max, year }
}

const pctText = (n) => `${n > 0 ? '+' : ''}${n}%`

function trendCopy(t) {
  switch (t.state) {
    case 'insufficient':
      return 'Only one year of data is currently available — select another year in Year Comparison to see a trend.'
    case 'no-data':
      return `No year-over-year data available for ${t.prevYear} vs ${t.currYear}.`
    case 'both-zero':
      return `No violations recorded in either ${t.prevYear} or ${t.currYear}.`
    case 'new-activity':
      return `${t.currTotal.toLocaleString()} violation${t.currTotal !== 1 ? 's' : ''} recorded in ${t.currYear} — no ${t.prevYear} data to compare against.`
    case 'same':
      return `Violations remained the same as ${t.prevYear}, at ${t.currTotal.toLocaleString()} for both years.`
    case 'up':
      return `Violations increased by ${Math.abs(t.pct)}% in ${t.currYear} compared with ${t.prevYear} (${t.prevTotal.toLocaleString()} → ${t.currTotal.toLocaleString()}).`
    case 'down':
      return `Violations decreased by ${Math.abs(t.pct)}% in ${t.currYear} compared with ${t.prevYear} (${t.prevTotal.toLocaleString()} → ${t.currTotal.toLocaleString()}).`
    default:
      return 'Not enough data to determine a trend.'
  }
}

function topViolationCopy(v, periodLabel) {
  if (v.state === 'empty') return `No violation data available for ${periodLabel}.`
  if (v.state === 'tie') {
    const names = v.items.map(i => i.name).join(', ')
    return `${v.items.length} violation types are tied for the most recorded, each with ${v.count.toLocaleString()} case${v.count !== 1 ? 's' : ''}: ${names}.`
  }
  return `${v.item.name} was the most recorded violation with ${v.item.count.toLocaleString()} case${v.item.count !== 1 ? 's' : ''}.`
}

function penaltyCopy(p, periodLabel) {
  if (p.state === 'empty') return `No penalty data recorded for ${periodLabel}.`
  let text = `${peso(p.totalPenalty)} in total penalties assessed for ${periodLabel}`
  if (typeof p.pct === 'number') text += ` (${pctText(p.pct)} ${p.label})`
  text += '.'
  if (p.tied) {
    text += ` ${p.tied.length} violation categories are tied for the largest penalty contribution.`
  } else if (p.top) {
    text += ` ${p.top.label} contributed the most, at ${peso(p.top.total_penalty)}.`
  }
  return text
}

function vehicleCopy(v, periodLabel) {
  if (v.state === 'empty') return `No vehicle type data available for ${periodLabel}.`
  if (v.state === 'tie') {
    const names = v.items.map(i => i.vehicle_type).join(', ')
    return `${v.items.length} vehicle types are tied for the most violations, each with ${v.count.toLocaleString()} case${v.count !== 1 ? 's' : ''}: ${names}.`
  }
  return `${v.item.vehicle_type} recorded the most violations among vehicle types, with ${v.item.count.toLocaleString()} case${v.item.count !== 1 ? 's' : ''}.`
}

function peakMonthCopy(m) {
  if (m.state === 'empty') return 'Not enough monthly data available to determine peak activity.'
  if (m.state === 'no-activity') return `No violations recorded in ${m.year}.`
  if (m.state === 'tie') {
    return `${m.months.join(', ')} are tied for the highest activity in ${m.year}, each with ${m.count.toLocaleString()} case${m.count !== 1 ? 's' : ''}.`
  }
  return `${m.month} recorded the highest number of violations in ${m.year}, with ${m.count.toLocaleString()} case${m.count !== 1 ? 's' : ''}.`
}


/* ── New insights (time patterns, locations, aging, repeat offenders) ── */

function buildPeakInsight(rows, keyField) {
  const list = rows || []
  const total = list.reduce((s, r) => s + r.count, 0)
  if (total === 0) return { state: 'empty' }
  const max = Math.max(...list.map(r => r.count))
  const tied = list.filter(r => r.count === max)
  if (tied.length > 1) return { state: 'tie', items: tied, count: max, keyField }
  return { state: 'single', item: tied[0], count: max, share: Math.round((max / total) * 1000) / 10 }
}

function buildLocationInsight(locationRanking) {
  const items = locationRanking?.items || []
  if (items.length === 0) return { state: 'empty' }
  const top = items[0]
  const tied = items.filter(i => i.count === top.count)
  if (tied.length > 1) return { state: 'tie', items: tied, count: top.count }
  return { state: 'single', item: top }
}

function buildAgingInsight(aging) {
  if (!aging) return { state: 'empty' }
  if (!aging.total_count) return { state: 'none' }
  const old = (aging.buckets || []).find(b => b.key === '61_plus')
  return { state: 'ok', total: aging.total_count, amount: aging.total_amount, old }
}

function buildRepeatInsight(stats) {
  if (!stats || !stats.unique_violators) return { state: 'empty' }
  if (!stats.repeat_violators) return { state: 'none', unique: stats.unique_violators }
  return { state: 'ok', ...stats }
}

function buildStatusInsight(rows) {
  const list = rows || []
  const total = list.reduce((sum, r) => sum + r.count, 0)
  if (total === 0) return { state: 'empty' }
  const max = Math.max(...list.map(r => r.count))
  const tied = list.filter(r => r.count === max)
  if (tied.length > 1) return { state: 'tie', items: tied, count: max, total }
  return { state: 'single', item: tied[0], count: max, total, share: Math.round((max / total) * 1000) / 10 }
}

const COMPACT_COUNT = 6 // insights shown on narrow screens before "Show all"

const plural = (n, w) => `${n.toLocaleString()} ${w}${n !== 1 ? 's' : ''}`

function peakHourCopy(p) {
  if (p.state === 'empty') return 'No time-of-day data for the current selection.'
  if (p.state === 'tie') return `${p.items.length} hours are tied for the most violations (${plural(p.count, 'case')} each): ${p.items.slice(0, 3).map(i => i.label).join('; ')}${p.items.length > 3 ? '…' : ''}.`
  return `${p.item.label} is the busiest hour, with ${plural(p.count, 'violation')} (${p.share}% of the total).`
}

function peakDayCopy(p) {
  if (p.state === 'empty') return 'No day-of-week data for the current selection.'
  if (p.state === 'tie') return `${p.items.map(i => i.name).join(', ')} are tied for the most violations (${plural(p.count, 'case')} each).`
  return `${p.item.name} is the busiest day of the week, with ${plural(p.count, 'violation')} (${p.share}% of the total).`
}

function locationCopy(l) {
  if (l.state === 'empty') return 'No valid location data for the current selection.'
  if (l.state === 'tie') return `${l.items.length} locations are tied for the most violations (${plural(l.count, 'case')} each): ${l.items.slice(0, 3).map(i => i.location).join('; ')}${l.items.length > 3 ? '…' : ''}.`
  return `${l.item.location} has the most violations, with ${plural(l.item.count, 'case')} (${l.item.share}% of the total).`
}

function statusCopy(st) {
  if (st.state === 'empty') return 'No status data for the current selection.'
  if (st.state === 'tie') return `${st.items.map(i => i.label).join(', ')} are tied as the most common status (${plural(st.count, 'violation')} each of ${st.total.toLocaleString()}).`
  return `${st.item.label} is the most common status, covering ${plural(st.count, 'violation')} of ${st.total.toLocaleString()} (${st.share}%).`
}

function agingCopy(a) {
  if (a.state === 'empty') return 'Outstanding-ticket data is not available.'
  if (a.state === 'none') return 'No unpaid violations are outstanding.'
  let text = `${plural(a.total, 'violation')} (${peso(a.amount)}) are still unpaid.`
  if (a.old && a.old.count > 0) text += ` ${a.old.count.toLocaleString()} of them (${peso(a.old.amount)}) were issued more than 60 days ago.`
  return text
}

function repeatCopy(r) {
  if (r.state === 'empty') return 'No violators with a license number in the current selection.'
  if (r.state === 'none') return `None of the ${r.unique.toLocaleString()} violators with a license number were cited more than once.`
  return `${r.repeat_violators.toLocaleString()} of ${r.unique_violators.toLocaleString()} violators (${r.rate}%) were cited more than once in this period.`
}

/* Each insight can carry an `action` that drives the rest of the dashboard:
     { kind: 'filter', key, value, label } → cross-filter every chart
     { kind: 'scroll', target }            → jump to the related section
     { kind: 'years' }                     → open the Year Comparison picker
   Ties have no single value to filter by, so they get no action. */

export default function DataInsights({
  commonViolations, byVehicleType, byType, comparison,
  totalPenalty, rawYearComparison, activeYears, periodLabel,
  peakHours, byWeekday, locationRanking, aging, repeatStats,
  filters = {}, hasFilters = false, filterSummary = '', statusRows = [], compact = false, onFilter, onScroll, onOpenYears,
}) {
  const [expanded, setExpanded] = useState(false)
  const trend = buildTrendInsight(rawYearComparison, activeYears)
  const topViolation = buildTopViolationInsight(commonViolations)
  const penalty = buildPenaltyInsight(totalPenalty, comparison, byType)
  const vehicle = buildVehicleInsight(byVehicleType)
  const peakMonth = buildPeakMonthInsight(rawYearComparison, activeYears)
  const peakHour = buildPeakInsight(peakHours)
  const peakDay = buildPeakInsight(byWeekday)
  const location = buildLocationInsight(locationRanking)
  const agingInsight = buildAgingInsight(aging)
  const repeat = buildRepeatInsight(repeatStats)
  const statusInsight = buildStatusInsight(statusRows)

  const TrendIcon = trend.state === 'up' ? TrendingUp : trend.state === 'down' ? TrendingDown : Minus
  const trendColor = trend.state === 'up' ? '#DC2626' : trend.state === 'down' ? '#059669' : '#6B7280'

  const items = [
    {
      key: 'trend', icon: TrendIcon, color: trendColor, title: 'Violation Trend', body: trendCopy(trend),
      tag: 'All records — ignores filters', action: { kind: 'years', label: 'Compare years' },
    },
    {
      key: 'top-violation', icon: Hash, color: '#2563EB', title: 'Most Recorded Violation', body: topViolationCopy(topViolation, periodLabel),
      action: topViolation.state === 'single' && topViolation.item.code
        ? { kind: 'filter', key: 'violation_type', value: topViolation.item.code, label: topViolation.item.name }
        : null,
      active: topViolation.state === 'single' && filters.violation_type === topViolation.item.code,
    },
    {
      key: 'penalty', icon: DollarSign, color: '#D97706', title: 'Penalty Insight', body: penaltyCopy(penalty, periodLabel),
      action: penalty.state === 'ok' ? { kind: 'scroll', target: 'an-collection', label: 'Collection overview' } : null,
    },
    {
      key: 'vehicle', icon: Truck, color: '#7C3AED', title: 'Highest Vehicle Type', body: vehicleCopy(vehicle, periodLabel),
      action: vehicle.state === 'single' ? { kind: 'filter', key: 'vehicle_type', value: vehicle.item.vehicle_type, label: vehicle.item.vehicle_type } : null,
      active: vehicle.state === 'single' && filters.vehicle_type === vehicle.item.vehicle_type,
    },
    {
      key: 'peak-month', icon: Calendar, color: '#0891B2', title: 'Highest Activity Period', body: peakMonthCopy(peakMonth),
      tag: 'All records — ignores filters',
    },
    {
      key: 'peak-hour', icon: Clock, color: '#2563EB', title: 'Busiest Hour', body: peakHourCopy(peakHour),
      action: peakHour.state === 'single' ? { kind: 'filter', key: 'hour', value: peakHour.item.hour, label: peakHour.item.label } : null,
      active: peakHour.state === 'single' && filters.hour === peakHour.item.hour,
    },
    {
      key: 'peak-day', icon: CalendarDays, color: '#0E7490', title: 'Busiest Day', body: peakDayCopy(peakDay),
      action: peakDay.state === 'single' ? { kind: 'filter', key: 'weekday', value: peakDay.item.weekday, label: peakDay.item.name } : null,
      active: peakDay.state === 'single' && filters.weekday === peakDay.item.weekday,
    },
    {
      key: 'location', icon: MapPin, color: '#059669', title: 'Top Location', body: locationCopy(location),
      action: location.state === 'single' ? { kind: 'filter', key: 'location', value: location.item.location, label: location.item.location } : null,
      active: location.state === 'single' && filters.location === location.item.location,
    },
    {
      key: 'status', icon: Layers, color: '#8B5CF6', title: 'Settlement Status', body: statusCopy(statusInsight),
      tag: 'Ignores the Status filter, so statuses stay comparable',
      action: statusInsight.state === 'single' ? { kind: 'filter', key: 'status', value: statusInsight.item.status, label: statusInsight.item.label } : null,
      active: statusInsight.state === 'single' && filters.status === statusInsight.item.status,
    },
    {
      key: 'aging', icon: Hourglass, color: '#4B5563', title: 'Outstanding Tickets', body: agingCopy(agingInsight),
      tag: 'Active unpaid records — ignores period',
      action: agingInsight.state === 'ok' ? { kind: 'scroll', target: 'an-aging', label: 'View aging' } : null,
    },
    {
      key: 'repeat', icon: Shield, color: '#DC2626', title: 'Repeat Violators', body: repeatCopy(repeat),
      action: repeat.state === 'ok' ? { kind: 'scroll', target: 'an-repeat', label: 'View repeat violators' } : null,
    },
  ]

  const run = (action) => {
    if (!action) return
    if (action.kind === 'filter') onFilter?.(action.key, action.value, action.label)
    else if (action.kind === 'scroll') onScroll?.(action.target)
    else if (action.kind === 'years') onOpenYears?.()
  }

  return (
    <Card style={{ marginBottom: 16 }}>
      <CardHeader
        title="Data Insights"
        subtitle={`Calculated from ${periodLabel} analytics data${hasFilters && filterSummary ? ` for the selected subset (${filterSummary})` : hasFilters ? ' with your current filters' : ''} — select an insight to explore it`}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 10 }}>
        {(compact && !expanded ? items.slice(0, COMPACT_COUNT) : items).map(item => {
          const Row = item.action ? 'button' : 'div'
          const rowProps = item.action
            ? { type: 'button', onClick: () => run(item.action), 'aria-pressed': item.action.kind === 'filter' ? !!item.active : undefined }
            : {}
          return (
            <Row
              key={item.key}
              {...rowProps}
              className="list-row"
              style={{
                alignItems: 'flex-start', textAlign: 'left', width: '100%', font: 'inherit',
                background: item.active ? 'var(--blue-50)' : 'var(--slate-50)',
                border: `1px solid ${item.active ? 'var(--blue-100)' : 'var(--color-border)'}`,
                cursor: item.action ? 'pointer' : 'default',
              }}
            >
              <div style={{ width: 30, height: 30, borderRadius: 8, background: `${item.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <item.icon size={15} color={item.color} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--slate-950)', marginBottom: 2 }}>{item.title}</div>
                <div className="text-caption" style={{ lineHeight: 1.5 }}>{item.body}</div>
                {item.tag && <div className="text-caption" style={{ fontSize: 10, marginTop: 4, fontStyle: 'italic' }}>{item.tag}</div>}
                {item.action && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginTop: 6, fontSize: 11, fontWeight: 700, color: 'var(--blue-600)' }}>
                    {item.action.kind === 'filter'
                      ? (item.active ? 'Filter applied — click to clear' : 'Filter dashboard to this')
                      : item.action.label}
                    <ChevronRight size={12} aria-hidden="true" />
                  </div>
                )}
              </div>
            </Row>
          )
        })}
      </div>
      {compact && items.length > COMPACT_COUNT && (
        <button type="button" className="link-chip" aria-expanded={expanded} onClick={() => setExpanded(v => !v)} style={{ marginTop: 10 }}>
          {expanded ? 'Show fewer insights' : `Show all ${items.length} insights`}
        </button>
      )}
    </Card>
  )
}