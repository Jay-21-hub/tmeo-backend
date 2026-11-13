export const TREND_VIEW_OPTIONS = [
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
]

export const PERIOD_OPTIONS = [
  { label: 'Today', value: 'today' },
  { label: 'This Week', value: 'week' },
  { label: 'This Month', value: 'month' },
  { label: 'This Year', value: 'year' },
]

/** PeriodFilter presets for this page. "This week" is Monday through today in Manila. */
export const ANALYTICS_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'month', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
]

export const STATUS_COLORS = {
  pending: '#F59E0B',
  processing: '#8B5CF6',
  paid: '#10B981',
  rejected: '#EF4444',
}

export const CHART_PALETTE = [
  '#2563EB', '#7C3AED', '#0891B2', '#059669', '#D97706',
  '#DC2626', '#7C2D12', '#1D4ED8', '#0E7490', '#065F46',
]

export const YEAR_COLORS = ['#2563EB', '#7C3AED', '#059669', '#D97706', '#DC2626', '#0891B2', '#BE185D', '#65A30D']

export const DEFAULT_VISIBLE = 5
export const THIS_YEAR = new Date().getFullYear()
export const YEAR_BREAKDOWN_OPTIONS = [
  { key: 'status', label: 'Status', subtitle: 'Pending, Processing, Paid, etc.' },
  { key: 'violation_category', label: 'Violation Category', subtitle: 'Safety, Traffic, Other' },
  { key: 'vehicle_type', label: 'Vehicle Type', subtitle: 'Motorcycles, Cars, PUVs, etc.' },
  { key: 'location', label: 'Top Locations', subtitle: 'Most-cited areas' },
  { key: 'enforcer', label: 'Top Enforcers', subtitle: 'Most-active enforcers' },
]

/* ── Added for the cross-filtering analytics revamp ── */
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export const AXIS_TICK = { fontSize: 11, fill: '#9CA3AF' }
export const GRID_STROKE = '#F3F4F6'

/* Sequential blues for neutral "age" buckets — deliberately not red/amber,
   because no official TMEO payment deadline exists to justify urgency colors. */
export const AGING_COLORS = ['#BFDBFE', '#93C5FD', '#3B82F6', '#1D4ED8']
export const PAYMENT_COLORS = ['#0E7490', '#0891B2', '#2563EB', '#1D4ED8', '#1E3A8A']

export const peso = (n) => `\u20B1${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`

const h12 = (h) => `${(h % 12) || 12}:00 ${h % 24 < 12 ? 'AM' : 'PM'}`
export const hourRange = (h) => `${h12(h)}\u2013${h12((h + 1) % 24)}`
export const hourShort = (h) => `${(h % 12) || 12}${h < 12 ? 'a' : 'p'}`

/* Human labels for each filter key (used by the active-filter chips). */
export const FILTER_LABELS = {
  location: 'Location',
  category: 'Category',
  vehicle_type: 'Vehicle',
  violation_type: 'Violation',
  status: 'Status',
  weekday: 'Day',
  hour: 'Hour',
}