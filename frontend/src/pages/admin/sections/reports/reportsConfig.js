import { Activity, BarChart3, Clock, MapPin, Tag, Truck, UserCheck } from 'lucide-react'

/* ── Formatting ─────────────────────────────────────────────────────────
 * Money arrives from the API as 2-decimal STRINGS ("1500.00"), or null when
 * the amount is UNAVAILABLE. null is never shown as 0 — see fmtMoney().
 */
export const fmt = (v) => (v == null || v === '' ? '—' : v)
export const fmtInt = (v) => (v == null ? '—' : Number(v).toLocaleString('en-PH'))
export const fmtPercent = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`)
const num = (v) => Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const UNAVAILABLE = 'Unavailable'
/** On-screen money. null → "Unavailable" (never "₱0.00"). */
export const fmtMoney = (v) => (v == null ? UNAVAILABLE : `₱${num(v)}`)
/** PDF money. jsPDF's built-in Helvetica has no ₱ glyph, so use "PHP ". */
export const fmtMoneyPdf = (v) => (v == null ? UNAVAILABLE : `PHP ${num(v)}`)

// A date-only ISO string ("2026-05-05") parsed as LOCAL calendar date,
// never via new Date('2026-05-05') (which is UTC and can show the day before).
export const parseISODate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '')
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}
export const fmtDate = (s) => {
  const d = parseISODate(s)
  return d ? d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'
}
export const fmtDateTime = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/* ── Local-calendar date helpers (Philippines time = the user's local time).
 * toISOString() converts to UTC and returns the PREVIOUS day for anyone
 * east of UTC before 08:00, so it is never used for date-only values.   */
export const toISODate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const today = () => toISODate(new Date())
export const startOfMonth = () => { const d = new Date(); d.setDate(1); return toISODate(d) }
/** Monday of the current week (Mon–Sun weeks). */
export const startOfWeek = () => {
  const d = new Date()
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return toISODate(d)
}
export const endOfWeek = () => {
  const d = parseISODate(startOfWeek())
  d.setDate(d.getDate() + 6)
  return toISODate(d)
}

/* ── Report catalogue. `filters` mirrors the backend SUPPORTED_FILTERS;
 *   the UI also trusts payload.meta.supported_filters once data is loaded. */
export const REPORT_TYPES = [
  { id: 'status', title: 'Violations by Status', desc: 'Tickets and penalty value per processing status.', icon: Activity, accent: 'var(--blue-600)', iconBg: 'var(--blue-50)', filters: [] },
  { id: 'monthly', title: 'Monthly Violations', desc: 'Tickets, paid/unpaid split and penalties by month.', icon: BarChart3, accent: '#7c3aed', iconBg: '#f5f3ff', filters: ['status'] },
  { id: 'by_type', title: 'Violations by Type', desc: 'Ticket counts and item-level fines per violation type.', icon: Tag, accent: 'var(--warning-600)', iconBg: 'var(--warning-50)', filters: ['status', 'category', 'vehicle_type'] },
  { id: 'enforcer', title: 'Enforcer Activity', desc: 'Tickets issued per enforcer. Imports and walk-ins excluded.', icon: UserCheck, accent: 'var(--success-600)', iconBg: 'var(--success-50)', filters: ['status'] },
  { id: 'outstanding', title: 'Outstanding Penalties', desc: 'Unpaid tickets with age in days and aging buckets.', icon: Clock, accent: 'var(--danger-600)', iconBg: 'var(--danger-50)', filters: ['vehicle_type'] },
  { id: 'location', title: 'Violations by Location', desc: 'Where violations occur, with duplicate spellings combined.', icon: MapPin, accent: 'var(--blue-600)', iconBg: 'var(--blue-50)', filters: ['status'] },
  { id: 'vehicle_type', title: 'Violations by Vehicle Type', desc: 'Tickets and penalties by vehicle type.', icon: Truck, accent: '#7c3aed', iconBg: '#f5f3ff', filters: ['status'] },
]

export const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'processing', label: 'Processing' },
  { value: 'paid', label: 'Paid' },
]
export const CATEGORY_OPTIONS = [
  { value: 'traffic', label: 'Traffic Violation' },
  { value: 'safety', label: 'Safety Violation' },
  { value: 'other', label: 'Other' },
]

/* Human labels for the "applied filters" line (screen + PDF). */
export const FILTER_LABELS = {
  date_from: 'From', date_to: 'To', status: 'Status', category: 'Category', vehicle_type: 'Vehicle type',
}
export const describeFilter = (key, value) => {
  if (key === 'date_from' || key === 'date_to') return fmtDate(value)
  if (key === 'status') return STATUS_OPTIONS.find(o => o.value === value)?.label || value
  if (key === 'category') return CATEGORY_OPTIONS.find(o => o.value === value)?.label || value
  return value
}
export const appliedFilterPairs = (applied = {}) =>
  Object.keys(FILTER_LABELS).filter(k => applied[k]).map(k => [FILTER_LABELS[k], describeFilter(k, applied[k])])

/* ── Summary tiles per report: [label, summary key, kind] ─────────────── */
export const SUMMARY_DEFS = {
  status: [['Total Tickets', 'total_tickets', 'int'], ['Paid', 'paid_tickets', 'int'], ['Unpaid', 'unpaid_tickets', 'int'], ['Total Penalty', 'total_penalty', 'money']],
  monthly: [['Months', 'months', 'int'], ['Total Violations', 'total_violations', 'int'], ['Paid', 'paid', 'int'], ['Unpaid', 'unpaid', 'int'], ['Total Penalty', 'total_penalty', 'money']],
  by_type: [['Tickets', 'total_tickets', 'int'], ['Violation Items', 'total_items', 'int'], ['Violation Types', 'violation_types', 'int'], ['Fines (item-level)', 'fines_known_total', 'money_coverage']],
  enforcer: [['Enforcers', 'enforcers', 'int'], ['Tickets Issued', 'tickets_issued', 'int'], ['Value of Tickets Issued', 'total_fines_issued', 'money']],
  outstanding: [['Outstanding Tickets', 'tickets', 'int'], ['Total Outstanding', 'total_outstanding', 'money']],
  location: [['Locations', 'locations', 'int'], ['Total Tickets', 'total_tickets', 'int'], ['Total Penalty', 'total_penalty', 'money']],
  vehicle_type: [['Vehicle Types', 'vehicle_types', 'int'], ['Total Tickets', 'total_tickets', 'int'], ['Total Penalty', 'total_penalty', 'money']],
}

/** Formats one table cell → plain text (used by PDF and as the screen fallback). */
export function cellText(col, row, { pdf = false } = {}) {
  const v = row[col.key]
  const money = pdf ? fmtMoneyPdf : fmtMoney
  switch (col.type) {
    case 'int': return fmtInt(v)
    case 'percent': return fmtPercent(v)
    case 'date': return fmtDate(v)
    case 'money': return money(v)
    case 'money_coverage': {
      if (v == null) return UNAVAILABLE
      return row.fines_coverage === 'partial' ? `${money(v)}*` : money(v)
    }
    default: return fmt(v)
  }
}

export const summaryText = (def, summary, { pdf = false } = {}) => {
  const [, key, kind] = def
  const v = summary?.[key]
  if (kind === 'int') return fmtInt(v)
  const money = pdf ? fmtMoneyPdf : fmtMoney
  if (kind === 'money') return money(v)
  if (kind === 'money_coverage') {
    if (v == null) return UNAVAILABLE
    return summary.fines_coverage === 'partial' ? `${money(v)}*` : money(v)
  }
  return fmt(v)
}

/** Mirrors VehicleBrandModel.Category labels (backend violations/models.py) —
 *  the same list Analytics filters on. The backend match is case-insensitive
 *  exact, so free-text legacy values (e.g. "Sedan") will not match a filter. */
export const VEHICLE_TYPE_OPTIONS = ['Motorcycles', 'Cars', 'Public Utility Vehicles', 'Trucks & Heavy Vehicles', 'Special / Other']

/** Page numbers with ellipses: 1 … 4 5 [6] 7 8 … 20 */
export function pageWindow(page, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
  const set = new Set([1, totalPages, page - 1, page, page + 1])
  if (page <= 3) { set.add(2); set.add(3); set.add(4) }
  if (page >= totalPages - 2) { set.add(totalPages - 1); set.add(totalPages - 2); set.add(totalPages - 3) }
  const nums = [...set].filter(n => n >= 1 && n <= totalPages).sort((a, b) => a - b)
  const out = []
  nums.forEach((n, i) => { if (i && n - nums[i - 1] > 1) out.push('…'); out.push(n) })
  return out
}