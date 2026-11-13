import { useState, useEffect, useRef } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import api from '../../../services/api'
import {
  BarChart2, TrendingUp, MapPin, Clock, RefreshCw, Activity, Shield, Users, Home, X,
  Calendar, Tag, Award, Layers, ChevronDown, Filter, FileText, Truck, Download, DollarSign,
  Hourglass, Info,
} from 'lucide-react'
import {
  BarChart, Bar, PieChart as RePieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'

import StatCard from '../../../components/ui/StatCard'
import { Card, CardHeader } from '../../../components/ui/Card'
import { ErrorState, EmptyState } from '../../../components/ui/States'
import Alert from '../../../components/ui/Alert'
import {
  ANALYTICS_PRESETS, STATUS_COLORS, CHART_PALETTE, YEAR_COLORS, THIS_YEAR, DEFAULT_VISIBLE,
  YEAR_BREAKDOWN_OPTIONS, TREND_VIEW_OPTIONS, FILTER_LABELS, WEEKDAY_NAMES, AXIS_TICK, GRID_STROKE, peso, hourRange,
} from './analytics/analyticsConfig'
import PeriodFilter from '../../../components/dashboard/PeriodFilter'
import PeriodEmpty from '../../../components/dashboard/PeriodEmpty'
import { periodParams } from '../../../components/dashboard/periodRange'
import {
  ChartTooltip, EmptyChart, ViewAllButton, Clickable, FilterChips, ChartNote,
} from './analytics/AnalyticsPrimitives'
import { rowFromChartEvent, useElementWidth } from './analytics/analyticsUtils'
import {
  TrendChart, DonutChart, RankedBarChart, CrosstabMatrix, PeakHoursChart, WeekdayChart,
  BusiestSlotsChart, AgingChart, PaymentDurationChart, RepeatDistributionChart,
} from './analytics/AnalyticsCharts'
import { DetailModal, ListModal, YearFilterModal } from './analytics/AnalyticsModals'
import AnalyticsMap from './analytics/AnalyticsMap'
import DataInsights from './analytics/DataInsights'

const EMPTY_FILTERS = { location: '', category: '', vehicle_type: '', violation_type: '', status: '', weekday: null, hour: null }
const emptyFor = (key) => (key === 'weekday' || key === 'hour' ? null : '')

/* ── Trend bucketing: daily rows come from the API; weekly/monthly are grouped by real calendar weeks/months ── */
const pad = (n) => String(n).padStart(2, '0')
function bucketTrend(rows, view) {
  if (view === 'daily' || rows.length === 0) return rows
  const buckets = new Map()
  rows.forEach(r => {
    const d = new Date(`${r.iso_date}T00:00:00`)
    let key, label
    if (view === 'monthly') {
      key = r.iso_date.slice(0, 7)
      label = d.toLocaleString('en-US', { month: 'short', year: '2-digit' })
    } else {
      const monday = new Date(d)
      monday.setDate(d.getDate() - ((d.getDay() + 6) % 7))
      key = `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`
      label = `Wk ${pad(monday.getMonth() + 1)}/${pad(monday.getDate())}`
    }
    const b = buckets.get(key) || { date: label, day: '', count: 0, first: r.iso_date, last: r.iso_date }
    b.count += r.count
    b.last = r.iso_date
    buckets.set(key, b)
  })
  return [...buckets.values()].map(b => ({ ...b, range: b.first === b.last ? b.first : `${b.first} to ${b.last}` }))
}

export default function Analytics({ scrollTo }) {
  const [preset, setPreset] = useState('today')
  const [applied, setApplied] = useState(() => periodParams('today', new Date()))
  const [scope, setScope] = useState('all')
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [typeLabel, setTypeLabel] = useState('')
  const [trendViewChoice, setTrendViewChoice] = useState(null)

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const requestId = useRef(0)
  const topEnforcersRef = useRef(null)

  const [rootEl, setRootEl] = useState(null)
  const rootWidth = useElementWidth(rootEl)
  const [modal, setModal] = useState(null)
  const [listModal, setListModal] = useState(null)

  const [compareYears, setCompareYears] = useState(null)
  const [showYearFilter, setShowYearFilter] = useState(false)
  const [yearCompareData, setYearCompareData] = useState(null)
  const [yearCompareLoading, setYearCompareLoading] = useState(false)
  const [selectedBreakdowns, setSelectedBreakdowns] = useState([])

  const availableYears = data?.available_years || [THIS_YEAR - 1, THIS_YEAR]
  /* Responsive columns follow the measured page width: wide+narrow rows stack below 900px,
     equal pairs below 700px, tiny inner grids (donut + legend) below 520px. Until measured, desktop layout. */
  const stackWide = rootWidth > 0 && rootWidth < 900
  const stackPair = rootWidth > 0 && rootWidth < 700
  const stackTiny = rootWidth > 0 && rootWidth < 520
  const kpiCols = rootWidth > 0 && rootWidth < 520 ? 1 : rootWidth > 0 && rootWidth < 900 ? 2 : 3
  const cols = (ratio, stack = stackPair) => (stack ? 'minmax(0, 1fr)' : ratio)
  const PAIR = 'minmax(0, 1fr) minmax(0, 1fr)'

  const trendView = trendViewChoice ?? (preset === 'year' ? 'monthly' : 'daily')
  const [reloadKey, setReloadKey] = useState(0)

  /* One analytics request per period, scope, or filter change. A newer request wins. */
  useEffect(() => {
    const ctrl = new AbortController()
    const id = ++requestId.current
    setRefreshing(true)
    setError(null)
    setLoading(true)
    setData(null)
    const params = { ...applied, scope }
    if (filters.location) params.location = filters.location
    if (filters.category) params.category = filters.category
    if (filters.vehicle_type) params.vehicle_type = filters.vehicle_type
    if (filters.violation_type) params.violation_type = filters.violation_type
    if (filters.status) params.status = filters.status
    if (filters.weekday) params.weekday = String(filters.weekday)
    if (filters.hour !== null) params.hour = String(filters.hour)
    api.get('/api/violations/analytics/', { params, signal: ctrl.signal })
      .then((res) => {
        if (id !== requestId.current) return
        setData(res.data)
        setLastUpdated(new Date())
      })
      .catch((err) => {
        if (id !== requestId.current) return
        if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return
        setError(err?.response?.data?.detail || 'The analytics data could not be loaded.')
      })
      .finally(() => {
        if (id !== requestId.current) return
        setLoading(false)
        setRefreshing(false)
      })
    return () => ctrl.abort()
  }, [applied, scope, filters, reloadKey])

  useEffect(() => {
    if (scrollTo === 'top-enforcers' && topEnforcersRef.current) {
      setTimeout(() => {
        topEnforcersRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
        topEnforcersRef.current.style.outline = '2px solid #2563eb'
        topEnforcersRef.current.style.outlineOffset = '4px'
        setTimeout(() => {
          if (topEnforcersRef.current) topEnforcersRef.current.style.outline = 'none'
        }, 2000)
      }, 600)
    }
  }, [scrollTo])

  /* ── Cross-filter actions ── */
  const toggleFilter = (key, value, label) => {
    const same = filters[key] === value
    setFilters(f => ({ ...f, [key]: same ? emptyFor(key) : value }))
    if (key === 'violation_type') setTypeLabel(same ? '' : (label || value))
  }
  const clearFilter = (key) => {
    setFilters(f => ({ ...f, [key]: emptyFor(key) }))
    if (key === 'violation_type') setTypeLabel('')
  }
  const clearAllFilters = () => { setFilters(EMPTY_FILTERS); setTypeLabel('') }
  /* a chart cell = a row (location / vehicle) × a violation type → applies both filters together */
  const toggleCell = (rowKey, rowValue, type) => {
    const same = filters[rowKey] === rowValue && filters.violation_type === type.code
    setFilters(f => ({ ...f, [rowKey]: same ? '' : rowValue, violation_type: same ? '' : type.code }))
    setTypeLabel(same ? '' : type.name)
  }
  const toggleTimeCell = (weekday, hour) => {
    const same = filters.weekday === weekday && filters.hour === hour
    setFilters(f => ({ ...f, weekday: same ? null : weekday, hour: same ? null : hour }))
  }
  const onPeriod = (params, id) => { setPreset(id); setApplied(params); setTrendViewChoice(null) }
  const showThisYear = () => onPeriod(periodParams('year', new Date()), 'year')
  const retry = () => setReloadKey((k) => k + 1)
  const scrollToSection = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  const statusLabel = (v) => (data?.filter_options?.statuses || []).find(x => x.value === v)?.label || (v ? v.charAt(0).toUpperCase() + v.slice(1) : '')
  const chips = [
    filters.location && { key: 'location', label: filters.location },
    filters.category && { key: 'category', label: filters.category.charAt(0).toUpperCase() + filters.category.slice(1) },
    filters.vehicle_type && { key: 'vehicle_type', label: filters.vehicle_type },
    filters.violation_type && { key: 'violation_type', label: typeLabel || filters.violation_type },
    filters.status && { key: 'status', label: statusLabel(filters.status) },
    filters.weekday && { key: 'weekday', label: WEEKDAY_NAMES[filters.weekday - 1] },
    filters.hour !== null && { key: 'hour', label: hourRange(filters.hour) },
  ].filter(Boolean)

  /* ── Year comparison ── */
  const fetchYearComparison = async (years, breakdowns = []) => {
    if (!years || years.length === 0) return
    setYearCompareLoading(true)
    try {
      const yearParams = years.map(y => `years=${y}`).join('&')
      const breakdownParams = breakdowns.map(b => `breakdown=${b}`).join('&')
      const params = [yearParams, breakdownParams].filter(Boolean).join('&')
      const res = await api.get(`/api/violations/analytics/year_comparison/?${params}`)
      setYearCompareData(res.data)
    } catch {
      setYearCompareData(null)
    } finally {
      setYearCompareLoading(false)
    }
  }
  const handleApplyYears = (years, breakdowns = []) => {
    setCompareYears(years)
    setSelectedBreakdowns(breakdowns)
    fetchYearComparison(years, breakdowns)
  }
  const clearYearFilter = () => {
    setCompareYears(null)
    setYearCompareData(null)
    setSelectedBreakdowns([])
  }

  /* ── Export (now records the filters and scope it was generated with) ── */
  const handleExportReport = () => {
    if (!data) return
    const rows = [['Metric', 'Value']]
    const windowLabel = applied.range === 'all' ? 'All time' : `${applied.date_from} to ${applied.date_to}`
    rows.push(['Period', windowLabel])
    rows.push(['Scope', data.scope?.label || scope])
    rows.push(['Filters', chips.length ? chips.map(c => `${FILTER_LABELS[c.key]}: ${c.label}`).join('; ') : 'None'])
    rows.push(['Total Violations', data.total ?? 0])
    rows.push(['Total Penalty', data.total_penalty ?? 0])
    rows.push(['Total Collected', data.total_collected ?? 0])
    rows.push([])
    rows.push(['Location', 'Violations', 'Total Fines'])
    ;(data.location_ranking?.items || data.hotspots || []).forEach(h => rows.push([h.location, h.count, h.total_penalty ?? 0]))
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const filePeriod = applied.range === 'all' ? 'all' : `${applied.date_from}_${applied.date_to}`
    a.download = `tmeo-analytics-${filePeriod}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  /* ── Derived data (aligned to backend field names) ── */
  const summary = {
    total: data?.total ?? 0,
    total_penalty: data?.total_penalty ?? 0,
    total_collected: data?.total_collected ?? 0,
    pending: data?.by_status?.pending ?? 0,
    processing: data?.by_status?.processing ?? 0,
    paid: data?.by_status?.paid ?? 0,
  }

  const trendRows = data?.by_day || []
  const groupedByMonth = data?.trend_bucket === 'month'
  const trendDisplay = groupedByMonth ? trendRows : bucketTrend(trendRows, trendView)

  const byType = (data?.by_category || []).map(item => ({
    ...item,
    label: item.violation_type__name || item.violation_type__category || 'Unknown',
    name: item.violation_type__name || item.violation_type__category || 'Unknown',
  }))
  /* Status donut: backend `status_distribution` applies every OTHER filter but not the status filter itself,
     so all statuses stay visible and comparable while one is selected. Falls back to by_status for older responses. */
  const byStatus = data?.status_distribution?.items
    ? data.status_distribution.items.map(({ status, label, count }) => ({ status, label, count }))
    : (data?.by_status ? Object.entries(data.by_status).map(([status, count]) => ({ status, label: status.charAt(0).toUpperCase() + status.slice(1), count })) : [])
  const statusTotal = byStatus.reduce((s, b) => s + b.count, 0)
  const selectedStatus = filters.status ? byStatus.find(b => b.status === filters.status) || null : null

  const typeTotal = byType.reduce((sum, t) => sum + t.count, 0)
  const selectedType = filters.violation_type ? byType.find(t => t.violation_type__code === filters.violation_type) || null : null

  const enforcers = (data?.top_enforcers || []).map(e => ({
    ...e,
    display_name: e.enforcer__full_name || 'Unknown',
    badge_number: e.enforcer__badge_number || '—',
  }))
  const hotspots = data?.hotspots || []
  const addressHotspots = data?.address_hotspots || []
  const repeatOffenders = data?.repeat_offenders || []
  const byVehicleType = data?.by_vehicle_type || []
  const mostCommonVehicleType = data?.most_common_vehicle_type || '—'
  const collectionOverview = data?.collection_overview || null
  const comparison = data?.comparison || null
  const filterOptions = data?.filter_options || { locations: [], categories: [], vehicle_types: [] }
  const mapPoints = data?.map_points || []

  const commonViolations = (data?.common_violations || []).map(v => ({
    name: v.violation_type__name || 'Unknown',
    code: v.violation_type__code || '',
    category: v.violation_type__category || '',
    count: v.count,
  }))

  const peakHours = data?.peak_hours || []
  const byWeekday = data?.by_weekday || []
  const heatmap = data?.day_hour_heatmap || null
  const hasTimeData = peakHours.some(h => h.count > 0)
  const vehicleBreakdown = data?.vehicle_type_breakdown || null
  const vehicleRows = (vehicleBreakdown?.items || []).map(v => ({ name: v.vehicle_type, count: v.count, share: v.share }))
  const locationRanking = data?.location_ranking || null
  const locationRows = (locationRanking?.items || []).map(l => ({ name: l.location, count: l.count, share: l.share, total_penalty: l.total_penalty }))
  const aging = data?.penalty_aging || null
  const repeatStats = data?.repeat_offender_stats || null
  const scopeInfo = data?.scope || null

  const rawYearComparison = yearCompareData?.year_comparison || data?.year_comparison || []
  const activeYears = compareYears && compareYears.length > 0
    ? compareYears
    : [data?.prev_year || THIS_YEAR - 1, data?.current_year || THIS_YEAR]
  const yearBreakdowns = yearCompareData?.breakdowns || {}

  const visibleEnforcers = enforcers.slice(0, DEFAULT_VISIBLE)
  const visibleAddressHotspots = addressHotspots.slice(0, DEFAULT_VISIBLE)
  const periodLabel = ANALYTICS_PRESETS.find((p) => p.id === preset)?.label || 'Today'
  const blankPeriod = Boolean(data) && Number(data.total) === 0
  const countText = (n) => (blankPeriod ? '—' : Number(n || 0).toLocaleString())
  const moneyText = (n) => (blankPeriod ? '—' : peso(n))

  /* ── Detail modal builders ── */
  const openTrendModal = (entry) => {
    if (!entry) return
    setModal({
      title: entry.range ? `Violations: ${entry.date}` : `Violations on ${entry.date}`,
      subtitle: entry.day || (entry.range ? 'Grouped by ' + trendView.replace('ly', '') : ''),
      color: '#2563EB', icon: Calendar,
      badge: `${entry.count} violation${entry.count !== 1 ? 's' : ''} recorded`,
      rows: [
        { label: entry.range ? 'Range' : 'Date', value: entry.range || entry.date, highlight: true },
        ...(entry.day ? [{ label: 'Day', value: entry.day }] : []),
        { label: 'Violations Filed', value: entry.count.toLocaleString(), highlight: true },
        { divider: true },
        { label: 'Period', value: periodLabel },
      ],
    })
  }

  const openCollectionModal = (row) => {
    if (!row) return
    const value = row.isCount ? row.value.toLocaleString() : peso(row.value)
    setModal({
      title: row.label, subtitle: 'Collection Summary Detail',
      color: row.color, icon: TrendingUp,
      badge: row.isCount ? `${value} records` : value,
      rows: [
        { label: 'Category', value: row.label, highlight: true },
        { label: 'Value', value, highlight: true },
        { divider: true },
        { label: 'Period', value: periodLabel },
      ],
    })
  }

  const openStatusModal = (item) => {
    if (!item) return
    const total = byStatus.reduce((sum, b) => sum + b.count, 0)
    const pct = total ? ((item.count / total) * 100).toFixed(1) : '0.0'
    const color = STATUS_COLORS[item.status] || '#6B7280'
    setModal({
      title: item.label || item.status, subtitle: 'Violation Status', color, icon: Layers,
      badge: `${item.count} violation${item.count !== 1 ? 's' : ''}`,
      rows: [
        { label: 'Status', value: (item.label || item.status).toUpperCase(), highlight: true, color },
        { label: 'Count', value: item.count.toLocaleString(), highlight: true },
        { label: '% of violations in selection', value: `${pct}%` },
        { divider: true },
        { label: 'Total (all statuses)', value: total.toLocaleString() },
        { label: 'Period', value: periodLabel },
      ],
    })
  }

  const openTypeModal = (t) => {
    if (!t) return
    const total = byType.reduce((sum, x) => sum + x.count, 0)
    const pct = total ? ((t.count / total) * 100).toFixed(1) : '0.0'
    setModal({
      title: t.label, subtitle: 'Violation Type', color: '#7C3AED', icon: Tag,
      badge: `${t.count.toLocaleString()} violation${t.count !== 1 ? 's' : ''} recorded`,
      rows: [
        { label: 'Violation', value: t.label, highlight: true },
        ...(t.violation_type__code ? [{ label: 'Code', value: t.violation_type__code }] : []),
        ...(t.violation_type__category ? [{ label: 'Category', value: t.violation_type__category }] : []),
        { divider: true },
        { label: 'Violations counted', value: t.count.toLocaleString(), highlight: true },
        { label: '% of all violations counted', value: `${pct}%` },
        { label: 'Fine per violation', value: peso(t.fine_per) },
        { label: 'Total penalties', value: peso(t.total_penalty), highlight: true },
        { divider: true },
        { label: 'Period', value: periodLabel },
      ],
    })
  }

  const openEnforcerModal = (e, index) => {
    if (!e) return
    const max = enforcers[0]?.count || 1
    const pct = ((e.count / max) * 100).toFixed(0)
    setModal({
      title: e.display_name, subtitle: 'Enforcer Performance',
      color: index === 0 ? '#D97706' : index === 1 ? '#6B7280' : '#B45309',
      icon: Award, badge: `Rank #${index + 1} Top Enforcer`,
      rows: [
        { label: 'Full Name', value: e.display_name, highlight: true },
        { label: 'Badge Number', value: e.badge_number },
        { label: 'Violations Issued', value: e.count.toLocaleString(), highlight: true },
        { label: 'vs. #1 Enforcer', value: `${pct}%` },
        { label: 'Rank', value: `#${index + 1} of ${enforcers.length}` },
      ],
    })
  }

  const openHotspotModal = (h, index, isAddress = false) => {
    if (!h) return
    const list = isAddress ? addressHotspots : hotspots
    const total = list.reduce((s, x) => s + x.count, 0)
    const pct = total ? ((h.count / total) * 100).toFixed(1) : 0
    setModal({
      title: isAddress ? (h.address || `Address ${index + 1}`) : (h.location || `Location ${index + 1}`),
      subtitle: isAddress ? 'Violator Address Hotspot' : 'Violation Location Hotspot',
      color: isAddress ? '#F97316' : '#2563EB',
      icon: isAddress ? Home : MapPin,
      badge: `Rank #${index + 1} Hotspot`,
      rows: [
        { label: isAddress ? 'Address' : 'Location', value: isAddress ? h.address : h.location, highlight: true },
        { label: isAddress ? 'Violators' : 'Violations', value: h.count.toLocaleString(), highlight: true },
        { label: '% of Total', value: `${pct}%` },
        { label: 'Rank', value: `#${index + 1}` },
      ],
    })
  }

  const openRepeatOffenderModal = (r, index) => {
    if (!r) return
    setModal({
      title: r.violator_name || 'Unknown Violator', subtitle: 'Repeat Offender Detail',
      color: '#DC2626', icon: Shield,
      badge: `${r.count} violations this period`,
      rows: [
        { label: 'Violator Name', value: r.violator_name || '—', highlight: true },
        { label: 'License Number', value: r.license_number, highlight: true },
        { label: 'Violations (this period)', value: `${r.count}x`, highlight: true },
        { divider: true },
        { label: 'Locations Cited', value: r.locations?.length ? r.locations.join(', ') : '—' },
        { label: 'Rank', value: `#${index + 1}` },
      ],
    })
  }

  const openRepeatOffenderListModal = () => {
    setListModal({
      title: 'All Repeat Offenders', subtitle: 'Same license number cited more than once this period',
      color: '#DC2626', icon: Shield, items: repeatOffenders,
      renderItem: (r, i, onItemClick) => (
        <Clickable key={i} onClick={() => { onItemClick(); openRepeatOffenderModal(r, i) }}>
          <div className="list-row" style={{ background: i === 0 ? '#FEF2F2' : 'var(--slate-50)', border: `1px solid ${i === 0 ? '#FECACA' : 'var(--color-border)'}` }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: i === 0 ? '#DC2626' : 'var(--slate-200)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Shield size={13} color={i === 0 ? '#fff' : '#6B7280'} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{r.violator_name || r.license_number}</div>
              <div className="text-caption">{r.locations?.length ? r.locations.slice(0, 2).join(', ') : 'No location on file'}</div>
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, color: i === 0 ? '#DC2626' : '#6B7280', background: i === 0 ? '#FEE2E2' : 'var(--slate-100)', padding: '3px 10px', borderRadius: 'var(--radius-full)' }}>
              {r.count}x
            </span>
          </div>
        </Clickable>
      ),
    })
  }

  const openYearModal = (entry) => {
    if (!entry || !compareYears || compareYears.length < 2) return
    const [yearA, yearB] = compareYears
    const curr = entry[String(yearB)] || 0
    const prev = entry[String(yearA)] || 0
    const diff = curr - prev
    setModal({
      title: entry.month, subtitle: `Year Comparison: ${yearA} vs ${yearB}`,
      color: diff >= 0 ? '#2563EB' : '#10B981', icon: BarChart2,
      badge: diff === 0 ? 'No change' : diff > 0 ? `+${diff} vs ${yearA}` : `${diff} vs ${yearA}`,
      rows: [
        { label: 'Month', value: entry.month, highlight: true },
        { label: String(yearB), value: curr.toLocaleString(), highlight: true },
        { label: String(yearA), value: prev.toLocaleString() },
        { divider: true },
        { label: 'Difference', value: diff >= 0 ? `+${diff}` : `${diff}`, color: diff >= 0 ? '#EF4444' : '#10B981', highlight: true },
        { label: 'Change', value: prev > 0 ? `${((diff / prev) * 100).toFixed(1)}%` : 'N/A' },
      ],
    })
  }

  /* ── List modal openers — logic unchanged from original ── */
  const openEnforcerListModal = () => {
    setListModal({
      title: 'All Enforcers', subtitle: 'Top Performing Enforcers',
      color: '#D97706', icon: Award, items: enforcers,
      renderItem: (e, i, onItemClick) => {
        const max = enforcers[0]?.count || 1
        const pct = Math.round((e.count / max) * 100)
        return (
          <Clickable key={i} onClick={() => { onItemClick(); openEnforcerModal(e, i) }}>
            <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', background: 'var(--slate-50)', border: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 26, height: 26, borderRadius: '50%', background: i === 0 ? '#FEF3C7' : i === 1 ? '#F3F4F6' : '#FFF7ED', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: i === 0 ? '#D97706' : i === 1 ? '#6B7280' : '#B45309' }}>{i + 1}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{e.display_name}</div>
                    <div className="text-caption">Badge: {e.badge_number}</div>
                  </div>
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--blue-600)' }}>{e.count}</span>
              </div>
              <div style={{ height: 4, background: 'var(--slate-200)', borderRadius: 'var(--radius-full)' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: i === 0 ? 'var(--blue-600)' : '#93C5FD', borderRadius: 'var(--radius-full)' }} />
              </div>
            </div>
          </Clickable>
        )
      },
    })
  }

  const openAddressListModal = () => {
    setListModal({
      title: 'All Address Hotspots', subtitle: 'Violator addresses ranked by frequency',
      color: '#F97316', icon: Home, items: addressHotspots,
      renderItem: (h, i, onItemClick) => (
        <Clickable key={i} onClick={() => { onItemClick(); openHotspotModal(h, i, true) }}>
          <div className="list-row" style={{ background: i === 0 ? '#FFF7ED' : 'var(--slate-50)', border: `1px solid ${i === 0 ? '#FED7AA' : 'var(--color-border)'}` }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: i === 0 ? '#F97316' : 'var(--slate-200)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Home size={13} color={i === 0 ? '#fff' : '#6B7280'} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{h.address || `Address ${i + 1}`}</div>
              <div className="text-caption">Rank #{i + 1}</div>
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, color: i === 0 ? '#F97316' : '#6B7280', background: i === 0 ? '#FFEDD5' : 'var(--slate-100)', padding: '3px 10px', borderRadius: 'var(--radius-full)' }}>
              {h.count} violator{h.count !== 1 ? 's' : ''}
            </span>
          </div>
        </Clickable>
      ),
    })
  }

  const openByTypeListModal = () => {
    setListModal({
      title: 'All Violation Types', subtitle: 'Select a type to filter the whole dashboard',
      color: '#7C3AED', icon: Tag, items: byType,
      renderItem: (t, i, onItemClick) => (
        <Clickable key={i} onClick={() => { onItemClick(); if (t.violation_type__code) toggleFilter('violation_type', t.violation_type__code, t.label) }}>
          <div className="list-row" style={{ background: 'var(--slate-50)', border: '1px solid var(--color-border)' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: CHART_PALETTE[i % CHART_PALETTE.length], flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--slate-700)' }}>{t.label}</span>
            <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--slate-950)' }}>{t.count}</span>
          </div>
        </Clickable>
      ),
    })
  }

  return (
    <div ref={setRootEl} aria-busy={refreshing} style={{ minWidth: 0 }}>
      <PageHeader title="Analytics" />

      {/* ── Filter Bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
        <PeriodFilter value={preset} initialPreset="today" presets={ANALYTICS_PRESETS} onChange={onPeriod} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {lastUpdated && (
            <span className="text-caption" style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <Clock size={11} /> {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button className="btn btn-secondary btn-sm" onClick={retry} disabled={refreshing}>
            <RefreshCw size={13} className={refreshing ? 'spin' : ''} /> Refresh
          </button>
          <button
            className="btn btn-sm" onClick={() => setShowYearFilter(true)}
            style={{ border: compareYears ? '1.5px solid #7C3AED' : '1px solid var(--color-border)', background: compareYears ? '#7C3AED10' : 'var(--white)', color: compareYears ? '#7C3AED' : 'var(--slate-700)', whiteSpace: 'nowrap' }}
          >
            <Filter size={13} /> {compareYears ? compareYears.join(' vs ') : 'Year Comparison'} <ChevronDown size={13} />
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleExportReport} style={{ whiteSpace: 'nowrap' }}>
            <Download size={13} /> Export Report
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <select className="select select-sm" aria-label="Filter by location" value={filters.location} onChange={e => setFilters(f => ({ ...f, location: e.target.value }))} style={{ fontSize: 12, width: 190, flex: '0 0 auto' }}>
          <option value="">All Locations</option>
          {filterOptions.locations.map(loc => <option key={loc} value={loc}>{loc}</option>)}
        </select>
        <select className="select select-sm" aria-label="Filter by category" value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))} style={{ fontSize: 12, width: 190, flex: '0 0 auto' }}>
          <option value="">All Categories</option>
          {filterOptions.categories.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
        </select>
        <select className="select select-sm" aria-label="Filter by vehicle type" value={filters.vehicle_type} onChange={e => setFilters(f => ({ ...f, vehicle_type: e.target.value }))} style={{ fontSize: 12, width: 190, flex: '0 0 auto' }}>
          <option value="">All Vehicle Types</option>
          {filterOptions.vehicle_types.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <label className="text-caption" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={scope === 'all'} onChange={e => setScope(e.target.checked ? 'all' : 'active')} />
          Include archived (paid) records
        </label>
      </div>

      <FilterChips chips={chips} onRemove={clearFilter} onClearAll={clearAllFilters} />

      {loading && !data ? (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${kpiCols}, minmax(0, 1fr))`, gap: 16, marginBottom: 24 }}>
            {[...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: 120 }} />)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 20 }}>
            <div className="skeleton" style={{ height: 320 }} />
            <div className="skeleton" style={{ height: 320 }} />
          </div>
        </div>
      ) : !data ? (
        <ErrorState title="Analytics could not be loaded" message={error || 'Please check your connection and try again.'} onRetry={retry} />
      ) : (
      <>
      {error && (
        <div style={{ marginBottom: 14 }}>
          <Alert tone="danger" title="Could not refresh the analytics">
            {error} The figures below are from the last successful load. <button type="button" className="link-chip" onClick={retry}>Retry</button>
          </Alert>
        </div>
      )}

      {scopeInfo && (
        <div className="text-caption" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 16 }}>
          <Info size={12} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
          <span>
            {scopeInfo.label}: {scopeInfo.active_count.toLocaleString()} active
            {scopeInfo.mode === 'all' ? ` + ${scopeInfo.archived_count.toLocaleString()} archived` : ''} record{(scopeInfo.active_count + scopeInfo.archived_count) !== 1 ? 's' : ''}
            {' '}issued {scopeInfo.range.start === scopeInfo.range.end ? `on ${scopeInfo.range.start}` : `from ${scopeInfo.range.start} to ${scopeInfo.range.end}`}.
            {' '}{scopeInfo.note}
          </span>
        </div>
      )}

      <div style={{ opacity: refreshing ? 0.6 : 1, transition: 'opacity var(--transition-fast)' }}>
        {/* ── KPI Cards ── */}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${kpiCols}, minmax(0, 1fr))`, gap: 16, marginBottom: 20 }}>
          <StatCard label={`Total Violations (${periodLabel})`} value={countText(summary.total)} icon={FileText} accent="var(--blue-600)" trend={comparison?.total_pct} sublabel={comparison?.label || undefined} />
          <StatCard label="Total Penalties Assessed" value={moneyText(summary.total_penalty)} icon={DollarSign} accent="#D97706" trend={comparison?.total_penalty_pct} sublabel="Assessed amounts on tickets issued in this period" />
          <StatCard label="Total Collected" value={moneyText(summary.total_collected)} icon={TrendingUp} accent="#7C3AED" trend={comparison?.total_collected_pct} sublabel="Counted by date issued, not payment date" />
          <StatCard label="Pending Violations" value={countText(summary.pending)} icon={Activity} accent="var(--warning-600)" trend={comparison?.pending_pct} sublabel="Issued in this period and still pending" />
          <StatCard label="Paid Violations" value={countText(summary.paid)} icon={Shield} accent="var(--success-600)" trend={comparison?.paid_pct} sublabel={comparison?.label || undefined} />
          <StatCard label="Most Common Vehicle Type" value={mostCommonVehicleType} icon={Truck} accent="var(--slate-700)" />
        </div>

        {summary.total === 0 ? (
          <Card style={{ marginBottom: 16 }}>
            {chips.length ? (
              <EmptyState
                icon={Layers}
                title="No data for selected filters"
                message="No records match this combination of filters. Remove a filter or clear all to return to the broader dataset."
                action={<button type="button" className="btn btn-secondary" onClick={clearAllFilters}>Clear all filters</button>}
              />
            ) : <PeriodEmpty onShowThisYear={showThisYear} />}
          </Card>
        ) : (
          <>
        {/* ── Row 1: Trend + Status ── */}
        <div style={{ display: 'grid', gridTemplateColumns: cols('minmax(0, 2fr) minmax(0, 1fr)', stackWide), gap: 16, marginBottom: 16 }}>
          <Card>
            <CardHeader
              title="Violation Trend"
              subtitle="Click a point to view details"
              action={!groupedByMonth && (
                <div style={{ display: 'flex', gap: 4 }}>
                  {TREND_VIEW_OPTIONS.map(opt => (
                    <button key={opt.value} className={`btn btn-sm ${trendView === opt.value ? 'btn-primary' : 'btn-secondary'}`} style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => setTrendViewChoice(opt.value)}>{opt.label}</button>
                  ))}
                </div>
              )}
            />
            {trendDisplay.length >= 2 ? (
              <>
                <TrendChart data={trendDisplay} onSelect={openTrendModal} />
                {groupedByMonth && <ChartNote>This range is grouped by month, the same rule as the dashboard trend.</ChartNote>}
                {!groupedByMonth && trendView !== 'daily' && <ChartNote>Weekly weeks start on Monday; the first and last groups can be partial.</ChartNote>}
              </>
            ) : (
              <EmptyChart icon={TrendingUp} message={preset === 'today' ? 'A trend needs at least two days. Choose This week or longer — see Peak Hours below for today.' : 'Not enough days of data for a trend in this selection'} />
            )}
          </Card>

          <Card>
            <CardHeader title="Violations by Status" subtitle="Select a status to filter the dashboard" />
            {statusTotal > 0 ? (
              <>
                <DonutChart
                  data={byStatus} colorFor={(d, i) => STATUS_COLORS[d.status] || CHART_PALETTE[i]}
                  isActive={(d) => d.status === filters.status}
                  centerValue={(selectedStatus ? selectedStatus.count : statusTotal).toLocaleString()}
                  centerLabel={selectedStatus ? `${selectedStatus.label} of ${statusTotal.toLocaleString()}` : 'violations'}
                  onSelect={(d) => d && toggleFilter('status', d.status, d.label)}
                />
                <div role="group" aria-label="Violations by status" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                  {byStatus.map((s, i) => {
                    const selected = filters.status === s.status
                    return (
                      <div key={s.status} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button
                          type="button" aria-pressed={selected}
                          onClick={() => toggleFilter('status', s.status, s.label)}
                          style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 8px', font: 'inherit', fontSize: 12, textAlign: 'left', cursor: 'pointer', borderRadius: 'var(--radius-md)', background: selected ? 'var(--blue-50)' : 'transparent', border: `1px solid ${selected ? 'var(--blue-100)' : 'transparent'}` }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--slate-700)' }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS[s.status] || CHART_PALETTE[i], flexShrink: 0 }} />
                            {s.label}
                          </span>
                          <span style={{ fontWeight: 700, color: 'var(--slate-950)' }}>{s.count.toLocaleString()} <span className="text-caption" style={{ fontWeight: 400 }}>({Math.round((s.count / statusTotal) * 100)}%)</span></span>
                        </button>
                        <button type="button" className="link-chip" aria-label={`View ${s.label} details`} title="View details" onClick={() => openStatusModal(s)} style={{ flexShrink: 0, padding: 6 }}>
                          <Info size={13} aria-hidden="true" />
                        </button>
                      </div>
                    )
                  })}
                </div>
                {filters.status && <ChartNote>Shows all statuses for the other active filters, so they stay comparable. The status filter itself is not applied to this chart.</ChartNote>}
              </>
            ) : <EmptyChart icon={Layers} message="No status data for this selection" />}
          </Card>
        </div>

        {/* ── Row 2: Violation types + Enforcers ── */}
        <div style={{ display: 'grid', gridTemplateColumns: cols(PAIR), gap: 16, marginBottom: 16 }}>
          <Card>
            <CardHeader title="Violation Types" subtitle="Counts violation items, not tickets. Select a bar to filter the page." />
            {byType.length > 0 ? (
              <>
                <RankedBarChart
                  data={byType.slice(0, 8)} nameWidth={170}
                  isActive={(r) => !!r.violation_type__code && r.violation_type__code === filters.violation_type}
                  onSelect={(r) => r?.violation_type__code && toggleFilter('violation_type', r.violation_type__code, r.label)}
                  extra={(r) => [`Share of all violations counted: ${typeTotal ? ((r.count / typeTotal) * 100).toFixed(1) : '0.0'}%`, r.violation_type__code ? `Code: ${r.violation_type__code}` : null, r.violation_type__category ? `Category: ${r.violation_type__category}` : null, `Penalties: ${peso(r.total_penalty)}`, 'Click to filter the dashboard'].filter(Boolean)}
                />
                {selectedType && (
                  <button type="button" className="link-chip" onClick={() => openTypeModal(selectedType)} style={{ marginTop: 8 }}>
                    <Info size={13} aria-hidden="true" /> Details: {selectedType.label}
                  </button>
                )}
                <ViewAllButton total={byType.length} visible={8} onClick={openByTypeListModal} />
                <ChartNote>Each violation on a ticket is counted separately, so a ticket with several violations is counted once for each of them.</ChartNote>
              </>
            ) : <EmptyChart icon={Tag} message="No violation type data for this selection" />}
          </Card>

          <div ref={topEnforcersRef} style={{ borderRadius: 'var(--radius-lg)' }}>
            <Card style={{ height: '100%' }}>
              <CardHeader title="Top Performing Enforcers" subtitle="Click an enforcer to view details" />
              {enforcers.length > 0 ? (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {visibleEnforcers.map((e, i) => {
                      const max = enforcers[0]?.count || 1
                      const pct = Math.round((e.count / max) * 100)
                      return (
                        <Clickable key={i} onClick={() => openEnforcerModal(e, i)} style={{ padding: '6px 8px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 26, height: 26, borderRadius: '50%', background: i === 0 ? '#FEF3C7' : i === 1 ? '#F3F4F6' : '#FFF7ED', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: i === 0 ? '#D97706' : i === 1 ? '#6B7280' : '#B45309' }}>{i + 1}</div>
                              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{e.display_name}</span>
                            </div>
                            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--blue-600)' }}>{e.count}</span>
                          </div>
                          <div style={{ height: 5, background: 'var(--slate-100)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${pct}%`, background: i === 0 ? 'var(--blue-600)' : '#93C5FD', borderRadius: 'var(--radius-full)', transition: 'width 1s ease' }} />
                          </div>
                        </Clickable>
                      )
                    })}
                  </div>
                  <ViewAllButton total={enforcers.length} visible={DEFAULT_VISIBLE} onClick={openEnforcerListModal} />
                </>
              ) : <EmptyChart icon={Users} message="No enforcer data for this selection" />}
            </Card>
          </div>
        </div>

        {/* ── Data Insights ── */}
        <DataInsights
          commonViolations={commonViolations}
          byVehicleType={byVehicleType}
          byType={byType}
          comparison={comparison}
          totalPenalty={summary.total_penalty}
          rawYearComparison={rawYearComparison}
          activeYears={activeYears}
          periodLabel={periodLabel}
          peakHours={peakHours}
          byWeekday={byWeekday}
          locationRanking={locationRanking}
          aging={aging}
          repeatStats={repeatStats}
          filters={filters}
          hasFilters={chips.length > 0}
          compact={stackPair}
          filterSummary={chips.map(ch => ch.label).join(' · ')}
          statusRows={byStatus}
          onFilter={toggleFilter}
          onScroll={scrollToSection}
          onOpenYears={() => setShowYearFilter(true)}
        />

        {/* ── Time patterns ── */}
        <div id="an-time" style={{ display: 'grid', gridTemplateColumns: cols(PAIR), gap: 16, marginBottom: 16 }}>
          <Card>
            <CardHeader title="Peak Hours" subtitle="Violations by hour of day (Philippine time) — click a bar to filter" />
            {hasTimeData ? (
              <PeakHoursChart data={peakHours} activeHour={filters.hour} onSelect={(r) => r && toggleFilter('hour', r.hour, r.label)} />
            ) : <EmptyChart icon={Clock} message="No time-of-day data for this selection" />}
          </Card>
          <Card>
            <CardHeader title="Violations by Day of Week" subtitle="Monday to Sunday — click a bar to filter" />
            {hasTimeData ? (
              <WeekdayChart data={byWeekday} activeWeekday={filters.weekday} onSelect={(r) => r && toggleFilter('weekday', r.weekday, r.name)} />
            ) : <EmptyChart icon={Calendar} message="No day-of-week data for this selection" />}
          </Card>
        </div>
        <div id="an-heatmap" style={{ marginBottom: 16 }}>
          <Card>
            <CardHeader title="Busiest Day and Hour" subtitle="Which specific day-and-hour slots are busiest — click a bar to filter that day and hour" />
            {hasTimeData ? (
              <BusiestSlotsChart heatmap={heatmap} activeWeekday={filters.weekday} activeHour={filters.hour} onSelect={toggleTimeCell} />
            ) : <EmptyChart icon={Clock} message="No time data for this selection" />}
            <ChartNote>Peak Hours shows the hour of day across the whole week. Violations by Day of Week shows the day across all hours. This chart shows the combination: the slots where both line up.</ChartNote>
          </Card>
        </div>

        {/* ── Vehicle types ── */}
        <div style={{ display: 'grid', gridTemplateColumns: cols(PAIR), gap: 16, marginBottom: 16 }}>
          <Card>
            <CardHeader title="Violations by Vehicle Type" subtitle="Click a bar to filter by vehicle type" />
            {vehicleRows.length > 0 ? (
              <>
                <RankedBarChart
                  data={vehicleRows} nameWidth={130}
                  isActive={(r) => r.name === filters.vehicle_type}
                  onSelect={(r) => r && toggleFilter('vehicle_type', r.name, r.name)}
                  extra={(r) => [`${r.share}% of all violations`]}
                />
                {(vehicleBreakdown.other_count > 0 || vehicleBreakdown.unspecified_count > 0) && (
                  <ChartNote>
                    Not shown: {vehicleBreakdown.unspecified_count.toLocaleString()} with no vehicle type
                    {vehicleBreakdown.other_count > 0 ? ` and ${vehicleBreakdown.other_count.toLocaleString()} with an unrecognised type` : ''}.
                  </ChartNote>
                )}
              </>
            ) : <EmptyChart icon={Truck} message="No vehicle type data for this selection" />}
          </Card>
          <Card>
            <CardHeader title="Vehicle Type × Violation Type" subtitle="Violation counts per vehicle type — click a cell to filter both, or a header to filter one" />
            {data.vehicle_by_type?.rows?.length > 0 ? (
              <CrosstabMatrix
                crosstab={data.vehicle_by_type} rowHeader="Vehicle type"
                isRowActive={(label) => label === filters.vehicle_type} activeType={filters.violation_type}
                onSelectCell={(type, row) => toggleCell('vehicle_type', row.label, type)}
                onSelectRow={(label) => toggleFilter('vehicle_type', label, label)}
                onSelectType={(type) => toggleFilter('violation_type', type.code, type.name)}
              />
            ) : <EmptyChart icon={Truck} message="No vehicle and violation data for this selection" />}
          </Card>
        </div>

        {/* ── Locations ── */}
        <div style={{ display: 'grid', gridTemplateColumns: cols(PAIR), gap: 16, marginBottom: 16 }}>
          <Card>
            <CardHeader title="Top Locations" subtitle="Click a bar to filter by location" />
            {locationRows.length > 0 ? (
              <>
                <RankedBarChart
                  data={locationRows} nameWidth={170}
                  isActive={(r) => r.name === filters.location}
                  onSelect={(r) => r && toggleFilter('location', r.name, r.name)}
                  extra={(r) => [`${r.share}% of all violations`, `Fines: ${peso(r.total_penalty)}`]}
                />
                <ChartNote>
                  Top {locationRows.length} of {locationRanking.distinct_locations.toLocaleString()} locations.
                  {locationRanking.excluded_invalid_count > 0 ? ` ${locationRanking.excluded_invalid_count.toLocaleString()} records with a blank or invalid location are excluded.` : ''}
                  {' '}Spellings are trimmed and case-insensitive but not merged (e.g. “Perez, Park” and “Perez Park, Lucena” stay separate).
                </ChartNote>
              </>
            ) : <EmptyChart icon={MapPin} message="No valid location data for this selection" />}
          </Card>
          <Card>
            <CardHeader title="Violation Map" subtitle="Hotspots for the selected period, by risk level" />
            <AnalyticsMap points={mapPoints} />
          </Card>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: cols('minmax(0, 1.4fr) minmax(0, 1fr)', stackWide), gap: 16, marginBottom: 16 }}>
          <Card>
            <CardHeader title="Location × Violation Type" subtitle="Violation counts per location — click a cell to filter both, or a header to filter one" />
            {data.hotspot_by_type?.rows?.length > 0 ? (
              <CrosstabMatrix
                crosstab={data.hotspot_by_type} rowHeader="Location"
                isRowActive={(label) => label === filters.location} activeType={filters.violation_type}
                onSelectCell={(type, row) => toggleCell('location', row.label, type)}
                onSelectRow={(label) => toggleFilter('location', label, label)}
                onSelectType={(type) => toggleFilter('violation_type', type.code, type.name)}
              />
            ) : <EmptyChart icon={MapPin} message="No location and violation data for this selection" />}
          </Card>

          <Card>
            <CardHeader title="Violator Address Hotspots" subtitle="Click an address to view details" />
            {addressHotspots.length > 0 ? (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {visibleAddressHotspots.map((h, i) => (
                    <Clickable key={i} onClick={() => openHotspotModal(h, i, true)}>
                      <div className="list-row" style={{ background: i === 0 ? '#FFF7ED' : 'var(--slate-50)', border: `1px solid ${i === 0 ? '#FED7AA' : 'var(--color-border)'}` }}>
                        <div style={{ width: 28, height: 28, borderRadius: 8, background: i === 0 ? '#F97316' : 'var(--slate-200)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Home size={14} color={i === 0 ? '#fff' : '#6B7280'} /></div>
                        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{h.address || `Address ${i + 1}`}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: i === 0 ? '#F97316' : '#6B7280', background: i === 0 ? '#FFEDD5' : 'var(--slate-100)', padding: '3px 10px', borderRadius: 'var(--radius-full)' }}>{h.count} violator{h.count !== 1 ? 's' : ''}</span>
                      </div>
                    </Clickable>
                  ))}
                </div>
                <ViewAllButton total={addressHotspots.length} visible={DEFAULT_VISIBLE} onClick={openAddressListModal} />
              </>
            ) : <EmptyChart icon={Home} message="No address data for this selection" />}
          </Card>
        </div>

        {/* ── Repeat Offenders ── */}
        <div id="an-repeat" style={{ marginBottom: 16 }}>
          <Card>
            <CardHeader title="Repeat Offenders" subtitle="Same license number cited more than once this period — click to view where" />
            {repeatStats && repeatStats.unique_violators > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: cols('minmax(220px, 1fr) minmax(0, 1.4fr)', stackTiny), gap: 20, alignItems: 'center', marginBottom: 14 }}>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                  <div><div className="text-display" style={{ fontSize: 28 }}>{repeatStats.rate}%</div><div className="text-caption">repeat rate</div></div>
                  <div><div className="text-display" style={{ fontSize: 28 }}>{repeatStats.repeat_violators.toLocaleString()}</div><div className="text-caption">of {repeatStats.unique_violators.toLocaleString()} violators</div></div>
                </div>
                <RepeatDistributionChart distribution={repeatStats.distribution} />
              </div>
            )}
            {repeatOffenders.length > 0 ? (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {repeatOffenders.slice(0, DEFAULT_VISIBLE).map((r, i) => (
                    <Clickable key={i} onClick={() => openRepeatOffenderModal(r, i)}>
                      <div className="list-row" style={{ background: i === 0 ? '#FEF2F2' : 'var(--slate-50)', border: `1px solid ${i === 0 ? '#FECACA' : 'var(--color-border)'}` }}>
                        <div style={{ width: 28, height: 28, borderRadius: 8, background: i === 0 ? '#DC2626' : 'var(--slate-200)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Shield size={14} color={i === 0 ? '#fff' : '#6B7280'} /></div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{r.violator_name || r.license_number}</div>
                          <div className="text-caption">{r.locations?.length ? r.locations.slice(0, 2).join(', ') : 'No location on file'}</div>
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 700, color: i === 0 ? '#DC2626' : '#6B7280', background: i === 0 ? '#FEE2E2' : 'var(--slate-100)', padding: '3px 10px', borderRadius: 'var(--radius-full)' }}>{r.count}x</span>
                      </div>
                    </Clickable>
                  ))}
                </div>
                <ViewAllButton total={repeatOffenders.length} visible={DEFAULT_VISIBLE} onClick={openRepeatOffenderListModal} />
              </>
            ) : <EmptyChart icon={Shield} message="No repeat offenders in this selection" />}
            {repeatStats && <ChartNote>Based on {repeatStats.identifier}.</ChartNote>}
          </Card>
        </div>

        {/* ── Collection Overview + Outstanding aging ── */}
        <div style={{ display: 'grid', gridTemplateColumns: cols(PAIR), gap: 16, marginBottom: 16 }}>
          <div id="an-collection">
            <Card style={{ height: '100%' }}>
              <CardHeader title="Collection Overview" subtitle="Penalties issued in this period vs. collected — click any row" />
              <div style={{ display: 'grid', gridTemplateColumns: cols('160px minmax(0, 1fr)', stackTiny || (!stackPair && rootWidth < 1000)), gap: 20, alignItems: 'center', marginBottom: 14 }}>
                <div style={{ position: 'relative', width: 160, height: 160 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <RePieChart>
                      <Pie
                        data={[
                          { name: 'Collected', value: collectionOverview?.total_collected || 0 },
                          { name: 'Outstanding', value: collectionOverview?.outstanding || 0 },
                        ]}
                        dataKey="value" innerRadius={55} outerRadius={75} startAngle={90} endAngle={-270} stroke="none"
                      >
                        <Cell fill="#10B981" />
                        <Cell fill="#E5E7EB" />
                      </Pie>
                    </RePieChart>
                  </ResponsiveContainer>
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--slate-950)' }}>{collectionOverview?.collection_rate ?? 0}%</span>
                    <span className="text-caption">Collection Rate</span>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 13, color: 'var(--slate-700)' }}>Total Penalty Assessed: <strong>{peso(collectionOverview?.total_penalty)}</strong></div>
                  <div style={{ fontSize: 13, color: 'var(--slate-700)' }}>Total Collected: <strong>{peso(collectionOverview?.total_collected)}</strong></div>
                  <div style={{ fontSize: 13, color: 'var(--slate-700)' }}>Not yet collected (this period): <strong>{peso(collectionOverview?.outstanding)}</strong></div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  { label: 'Paid Violations', value: summary.paid, color: '#2563EB', bg: '#EFF6FF', border: '#BFDBFE', isCount: true },
                  { label: 'Pending Count', value: summary.pending, color: '#F59E0B', bg: '#FFFBEB', border: '#FDE68A', isCount: true },
                  { label: 'Processing Count', value: collectionOverview?.processing ?? 0, color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE', isCount: true },
                ].map((row, i) => (
                  <Clickable key={i} onClick={() => openCollectionModal(row)}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderRadius: 'var(--radius-md)', background: row.bg, border: `1px solid ${row.border}` }}>
                      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--slate-700)' }}>{row.label}</span>
                      <span style={{ fontSize: 16, fontWeight: 600, color: row.color }}>{row.value.toLocaleString()}</span>
                    </div>
                  </Clickable>
                ))}
              </div>
            </Card>
          </div>
        </div>

          </>
        )}

        {compareYears && (
          <div style={{ marginBottom: 16 }}>
            <Card>
              <CardHeader
                title={`Year Comparison: ${compareYears.join(' vs ')}`}
                subtitle={compareYears.length >= 2 ? 'Monthly breakdown per year' : 'Select more years to compare'}
                action={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {compareYears.map((yr, i) => (
                      <span key={yr} style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 'var(--radius-full)', background: `${YEAR_COLORS[i] || '#6B7280'}22`, color: YEAR_COLORS[i] || '#6B7280' }}>{yr}</span>
                    ))}
                    <button type="button" onClick={clearYearFilter} className="btn btn-danger-ghost btn-sm" style={{ padding: '4px 10px' }}><X size={12} /> Clear comparison</button>
                  </div>
                }
              />
              <ChartNote>Compares full calendar years and does not follow the selected period.</ChartNote>
              {yearCompareLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 260, gap: 10, color: 'var(--slate-400)', fontSize: 13 }}>
                  <RefreshCw size={16} className="spin" /> Loading comparison data...
                </div>
              ) : compareYears.length === 1 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 12 }}>
                  <div style={{ width: 48, height: 48, borderRadius: 14, background: '#7C3AED15', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Filter size={22} color="#7C3AED" /></div>
                  <div style={{ textAlign: 'center' }}>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--slate-700)' }}>Add more years to compare</p>
                    <p className="text-caption" style={{ margin: '4px 0 0' }}>You've selected {compareYears[0]}. Add one or more years in the filter to compare.</p>
                  </div>
                  <button onClick={() => setShowYearFilter(true)} className="btn btn-primary btn-sm">Open Year Filter</button>
                </div>
              ) : rawYearComparison.length > 0 ? (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={rawYearComparison} margin={{ top: 4, right: 16, bottom: 0, left: 0 }} onClick={(state) => { const row = rowFromChartEvent(rawYearComparison, state); if (row) openYearModal(row) }} style={{ cursor: 'pointer' }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#9CA3AF' }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip content={<ChartTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                    {activeYears.map((yr, i) => <Bar key={yr} dataKey={String(yr)} fill={YEAR_COLORS[i] || '#6B7280'} radius={[4, 4, 0, 0]} maxBarSize={22} />)}
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyChart icon={BarChart2} message="No comparison data available for the selected years" />}
            </Card>

            {compareYears.length >= 2 && selectedBreakdowns.map(key => {
              const opt = YEAR_BREAKDOWN_OPTIONS.find(o => o.key === key)
              const rows = yearBreakdowns[key] || []
              return (
                <Card key={key} style={{ marginTop: 16 }}>
                  <CardHeader
                    title={`${opt?.label || key}: ${compareYears.join(' vs ')}`}
                    subtitle={opt?.subtitle}
                  />
                  {yearCompareLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 220, gap: 10, color: 'var(--slate-400)', fontSize: 13 }}>
                      <RefreshCw size={16} className="spin" /> Loading comparison data...
                    </div>
                  ) : rows.length > 0 ? (
                    <ResponsiveContainer width="100%" height={Math.max(220, rows.length * 40)}>
                      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 11, fill: '#9CA3AF' }} tickLine={false} axisLine={false} allowDecimals={false} />
                        <YAxis type="category" dataKey="category" width={110} tick={{ fontSize: 11, fill: '#6B7280' }} tickLine={false} axisLine={false} />
                        <Tooltip content={<ChartTooltip />} />
                        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                        {activeYears.map((yr, i) => <Bar key={yr} dataKey={String(yr)} fill={YEAR_COLORS[i] || '#6B7280'} radius={[0, 4, 4, 0]} maxBarSize={18} />)}
                      </BarChart>
                    </ResponsiveContainer>
                  ) : <EmptyChart icon={BarChart2} message={`No ${opt?.label?.toLowerCase() || 'category'} data for the selected years`} />}
                </Card>
              )
            })}
          </div>
        )}

        <div id="an-aging" style={{ display: 'grid', gridTemplateColumns: cols(PAIR), gap: 16, marginBottom: 16 }}>
          <Card>
            <CardHeader title="Outstanding Tickets by Age" subtitle="How long unpaid violations have been waiting — as of today" />
            {aging && aging.total_count > 0 ? (
              <>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 8 }}>
                  <div><div className="text-display" style={{ fontSize: 28 }}>{aging.total_count.toLocaleString()}</div><div className="text-caption">unpaid violations</div></div>
                  <div><div className="text-display" style={{ fontSize: 28 }}>{peso(aging.total_amount)}</div><div className="text-caption">outstanding</div></div>
                </div>
                <AgingChart buckets={aging.buckets} />
              </>
            ) : <EmptyChart icon={Hourglass} message="No unpaid violations are outstanding" />}
            {aging && <ChartNote>Counts active pending and processing tickets as of {aging.as_of}. It ignores the period filter. These are tickets that are not paid yet.</ChartNote>}
          </Card>
          <Card>
            <CardHeader title="Payment Duration" subtitle="How many days paid violations took from the issue date to the payment date" />
            {data?.payment_duration?.paid_count > 0 ? (
              <>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 8 }}>
                  <div><div className="text-display" style={{ fontSize: 28 }}>{data.payment_duration.average_days}</div><div className="text-caption">average days to payment</div></div>
                  <div><div className="text-display" style={{ fontSize: 28 }}>{data.payment_duration.paid_count.toLocaleString()}</div><div className="text-caption">paid with both dates</div></div>
                </div>
                <PaymentDurationChart buckets={data.payment_duration.buckets} />
              </>
            ) : <EmptyChart icon={DollarSign} message="No paid violations with both an issue date and a payment date in this selection" />}
            <ChartNote>Only violations that are paid and have both an issue timestamp and a payment date. The period filter applies. Unpaid tickets are in Outstanding Tickets by Age.</ChartNote>
          </Card>
        </div>

      </div>

      </>
      )}

      {/* ── Modals ── */}
      {modal && <DetailModal data={modal} onClose={() => setModal(null)} />}
      {listModal && <ListModal config={listModal} onClose={() => setListModal(null)} onItemClick={() => setListModal(null)} />}
      {showYearFilter && (
        <YearFilterModal onClose={() => setShowYearFilter(false)} onRemove={clearYearFilter} selectedYears={compareYears || []} onApply={handleApplyYears} availableYears={availableYears} selectedBreakdowns={selectedBreakdowns} />
      )}
    </div>
  )
}