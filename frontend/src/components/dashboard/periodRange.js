/** Asia/Manila calendar ranges for GET /api/violations/stats/.
 *  `now` is an absolute instant. The calendar day is Manila, never the
 *  browser's local getters and never UTC. */

export const MANILA_TZ = 'Asia/Manila'

export const PERIOD_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'month', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
]

export const DEFAULT_PRESET = 'month'

export function manilaYmd(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

function partsOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number)
  return { y, m, d }
}

function ymdOf({ y, m, d }) {
  const p = (n) => String(n).padStart(2, '0')
  return `${y}-${p(m)}-${p(d)}`
}

/** Shift a Manila Y-M-D by whole days. Date.UTC is a pure calendar, not a timezone. */
function addDays(parts, days) {
  const shifted = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + days))
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  }
}

/** Last calendar day of month `m` (1–12). Day 0 of the next month. */
function lastDay(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** 'incomplete' | 'order' | null. YYYY-MM-DD strings compare in calendar order. */
export function customRangeIssue(dateFrom, dateTo) {
  if (!dateFrom || !dateTo) return 'incomplete'
  if (dateFrom > dateTo) return 'order'
  return null
}

/**
 * Params for /api/violations/stats/.
 * All time → { range: 'all' }. Every other preset → { date_from, date_to }.
 * Custom reads `custom.date_from` / `custom.date_to` and does not use `now`.
 */
export function periodParams(preset, now, custom) {
  if (preset === 'all') return { range: 'all' }
  if (preset === 'custom') {
    return { date_from: custom?.date_from || '', date_to: custom?.date_to || '' }
  }

  const today = partsOf(manilaYmd(now))
  let from = today
  let to = today

  if (preset === 'today') {
    from = today
  } else if (preset === 'last7') {
    from = addDays(today, -6)
  } else if (preset === 'month') {
    from = { y: today.y, m: today.m, d: 1 }
  } else if (preset === 'lastMonth') {
    const y = today.m === 1 ? today.y - 1 : today.y
    const m = today.m === 1 ? 12 : today.m - 1
    from = { y, m, d: 1 }
    to = { y, m, d: lastDay(y, m) }
  } else if (preset === 'year') {
    from = { y: today.y, m: 1, d: 1 }
  } else {
    throw new Error(`Unknown period preset: ${preset}`)
  }

  return { date_from: ymdOf(from), date_to: ymdOf(to) }
}
