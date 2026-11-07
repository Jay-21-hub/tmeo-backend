import { useState, useEffect } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import { createPortal } from 'react-dom'
import { FileText, Clock, Banknote, Search, Inbox, SlidersHorizontal, X, Loader } from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { StatusBadge } from '../../../components/ui/Badge'
import Modal from '../../../components/ui/Modal'
import Button from '../../../components/ui/Button'
import { EmptyState } from '../../../components/ui/States'
import { ReviewSection, ReviewRow } from '../../../components/ui/ReviewRow'

const STATUS_NOTES = {
  pending:    { tone: 'alert-warning', text: '⏳ This report is awaiting review by the Assessment Staff.' },
  processing: { tone: 'alert-warning', text: '🔄 This report is currently being assessed by staff.' },
  paid:       { tone: 'alert-success', text: '💰 Penalty has been paid and settled.' },
}

const FILTER_OPTIONS = ['all', 'pending', 'processing', 'paid']

/* ── Detail bottom sheet ──
   Uses the .ef-sheet* classes from EnforcerShell.css (same sheet used for
   the profile/logout sheet) instead of the AppShell's centered Modal —
   keeps the whole enforcer flow consistently app-like. On phones it's a
   bottom sheet; at >=640px it becomes a compact centered dialog.
   The extra `ef-sheet--report-detail` class opts into a dedicated set of
   rules (content-sized dynamic width, explicit header/body/footer regions,
   no drag handle once centered, compact footer button) without touching
   the plain .ef-sheet / .ef-sheet--scrollable rules the Profile and More
   options sheets still rely on. */
function ReportDetailModal({ report, onClose }) {
  const note = STATUS_NOTES[report.status]
  const types = report.violation_types || (report.violation_type ? [report.violation_type] : [])
  const penaltyValue = report.penalty_amount
    ? `₱${parseFloat(report.penalty_amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`
    : 'TBD (Pending Assessment)'
  const violationTypeBadges = types.length > 0
    ? (
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
        {types.map((t, i) => (
          <span key={i} className="badge" style={{ background: '#ede9fe', color: '#5b21b6' }} dot={false}>{typeof t === 'object' ? t.name : t}</span>
        ))}
      </span>
    )
    : null

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.body.style.overflow = prevOverflow; document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Rendered via a portal straight into <body> — MyReports lives several
  // layers deep inside AppShell (.app-shell-main > .app-shell-content >
  // .page-shell-inner, the last of which mounts with a translateY(...)
  // animation on page change). Any of those ancestors briefly having a
  // non-none `transform` makes it a new containing block for descendants
  // with `position: fixed`, which silently confines this overlay to the
  // content pane instead of the real viewport (Sidebar/Topbar staying
  // untouched, header looking "clipped off"). A portal sidesteps that
  // entirely regardless of which ancestor is the actual culprit.
  return createPortal(
    <div className="ef-sheet-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ef-sheet ef-sheet--scrollable ef-sheet--report-detail" role="dialog" aria-modal="true" aria-label="Report details">
        <div className="ef-sheet-handle" />
        <button className="ef-sheet-close" onClick={onClose} aria-label="Close"><X size={18} /></button>

        <div className="ef-sheet-header">
          <div>
            <p className="text-h3">Report Details</p>
            <p className="text-caption" style={{ marginTop: 2 }}>ID: <span className="mono" style={{ fontWeight: 700, color: 'var(--navy-700)' }}>{report.ticket_number || `#${report.id}`}</span></p>
          </div>
          <StatusBadge status={report.status} />
        </div>

        <div className="ef-sheet-body">
          {note && <div className={`alert ${note.tone}`} style={{ marginBottom: 16 }}>{note.text}</div>}

          {/* Grouped like Issue OVR's Review & Submit step, using the same
              shared ReviewSection/ReviewRow primitive instead of a flat
              label/value grid — related fields now read as one record
              instead of a loose pile of rows. */}
          <ReviewSection title="Violation Information">
            <ReviewRow label="Violator Name" value={report.violator_name} />
            <ReviewRow label="License Number" value={report.license_number} />
            <ReviewRow label="Plate Number" value={report.plate_number} />
            <ReviewRow label="Vehicle Type" value={report.vehicle_type} />
            <ReviewRow label="Violation Type(s)" value={violationTypeBadges} />
            <ReviewRow label="Place of Violation" value={report.location} />
          </ReviewSection>

          <ReviewSection title="Assessment & Payment">
            <ReviewRow label="Penalty Amount" value={penaltyValue} emphasis />
            <ReviewRow label="O.R. Number" value={report.or_number} />
            <ReviewRow label="Assessed By" value={report.assessed_by_name} />
          </ReviewSection>

          <ReviewSection title="Record Information">
            <ReviewRow label="Date & Time" value={report.date_issued ? new Date(report.date_issued).toLocaleString('en-PH') : null} />
          </ReviewSection>

          {report.remarks && (
            <div style={{ marginTop: 16 }}>
              <p className="text-label" style={{ marginBottom: 6 }}>Remarks</p>
              <p style={{ fontSize: 13, color: 'var(--slate-700)', background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', padding: '10px 12px', border: '1px solid var(--color-border)', lineHeight: 1.6, margin: 0 }}>{report.remarks}</p>
            </div>
          )}

          {report.image && (
            <div style={{ marginTop: 16 }}>
              <p className="text-label" style={{ marginBottom: 8 }}>Photo Evidence</p>
              <img src={report.image} alt="Evidence" style={{ width: '100%', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', maxHeight: 220, objectFit: 'cover' }} />
            </div>
          )}
        </div>

        <div className="ef-sheet-footer">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/* ── Filter sheet (mobile) ── */
function FilterSheet({ open, onClose, search, setSearch, statusFilter, setStatus, dateFrom, setDateFrom, dateTo, setDateTo }) {
  if (!open) return null
  return (
    <Modal open={open} onClose={onClose} title="Filter Reports" width={420}
      footer={<Button variant="primary" onClick={onClose} fullWidth style={{ background: 'var(--warning-500)', color: 'var(--slate-950)' }}>Apply</Button>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="search-input-wrap">
          <Search size={14} className="search-input-icon" />
          <input className="input" placeholder="Violator name or plate number..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div>
          <label className="field-label" style={{ marginBottom: 6, display: 'block' }}>Status</label>
          <select className="select" value={statusFilter} onChange={e => setStatus(e.target.value)}>
            {FILTER_OPTIONS.map(o => <option key={o} value={o}>{o === 'all' ? 'All Status' : o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label className="field-label" style={{ marginBottom: 6, display: 'block' }}>From</label>
            <input type="date" className="input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label className="field-label" style={{ marginBottom: 6, display: 'block' }}>To</label>
            <input type="date" className="input" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
        </div>
      </div>
    </Modal>
  )
}

/* ── Mobile report card ── */
function ReportCard({ v, onView }) {
  const types = v.violation_types || (v.violation_type ? [v.violation_type] : [])
  return (
    <button onClick={() => onView(v)} className="card" style={{
      width: '100%', textAlign: 'left', padding: '13px 14px', display: 'flex',
      flexDirection: 'column', gap: 6, cursor: 'pointer', border: '1px solid var(--slate-100)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--slate-950)' }}>{v.violator_name || '—'}</div>
          <div className="mono" style={{ fontSize: 11.5, color: 'var(--slate-500)', marginTop: 1 }}>{v.plate_number || '—'}</div>
        </div>
        <StatusBadge status={v.status} />
      </div>

      {types.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {types.slice(0, 2).map((t, ti) => (
            <span key={ti} className="badge badge-neutral" dot={false}>{typeof t === 'object' ? t.name : t}</span>
          ))}
          {types.length > 2 && <span className="text-caption">+{types.length - 2} more</span>}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--slate-950)' }}>
          {v.penalty_amount ? `₱${parseFloat(v.penalty_amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })}` : <span style={{ color: 'var(--slate-400)', fontWeight: 400 }}>TBD</span>}
        </span>
        <span className="text-caption">
          {v.date_issued ? new Date(v.date_issued).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }) : '—'}
        </span>
      </div>
    </button>
  )
}

/* ══════════════════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════════════════ */
export default function MyReports() {
  const user = JSON.parse(localStorage.getItem('user') || '{}')

  const [violations, setViolations] = useState([])
  const [total, setTotal]           = useState(0)
  const [loading, setLoading]       = useState(true)
  const [search, setSearch]         = useState('')
  const [page, setCurrentPage]      = useState(1)
  const [pageSize]                  = useState(10)
  const [statusFilter, setStatus]   = useState('all')
  // No default date range — show every one of the enforcer's reports by
  // default. The previous default (today-only) used
  // `new Date().toISOString().slice(0, 10)`, which is the UTC calendar
  // date, not the Philippine local date the backend filters against
  // (Asia/Manila via `date_issued__date`). Between 12:00am-7:59am Manila
  // time those two dates disagree, silently hiding a same-day report.
  // Date filtering is still available — just opt-in via the Filters sheet.
  const [dateFrom, setDateFrom]     = useState('')
  const [dateTo, setDateTo]         = useState('')
  const [selected, setSelected]     = useState(null)
  const [showFilters, setShowFilters] = useState(false)
  const [stats, setStats]           = useState({ total: 0, pending: 0, processing: 0, paid: 0 })

  const fetchReports = () => {
    setLoading(true)
    const params = new URLSearchParams({ page, page_size: pageSize })
    if (search)                  params.append('search', search)
    if (statusFilter !== 'all')  params.append('status', statusFilter)
    if (dateFrom)                params.append('date_from', dateFrom)
    if (dateTo)                  params.append('date_to', dateTo)
    if (user?.id)                params.append('enforcer', user.id)

    api.get(`${API.VIOLATIONS}?${params}`)
      .then(res => {
        const data    = res.data
        const results = Array.isArray(data) ? data : data.results || []
        setViolations(results)
        setTotal(data.count || results.length)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  const fetchStats = () => {
    const enforcerParam = user?.id ? `&enforcer=${user.id}` : ''
    Promise.all([
      api.get(`${API.VIOLATIONS}?page_size=1${enforcerParam}`),
      api.get(`${API.VIOLATIONS}?page_size=1&status=pending${enforcerParam}`),
      api.get(`${API.VIOLATIONS}?page_size=1&status=processing${enforcerParam}`),
      api.get(`${API.VIOLATIONS}?page_size=1&status=paid${enforcerParam}`),
    ])
      .then(([totalRes, pendingRes, processingRes, paidRes]) => {
        setStats({
          total:      totalRes.data.count ?? 0,
          pending:    pendingRes.data.count ?? 0,
          processing: processingRes.data.count ?? 0,
          paid:       paidRes.data.count ?? 0,
        })
      })
      .catch(() => {})
  }

  useEffect(() => {
    fetchStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-filter-change pattern, matches existing codebase convention
    fetchReports()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, search, statusFilter, dateFrom, dateTo])

  const totalPages = Math.ceil(total / pageSize)
  const activeFilterCount = (statusFilter !== 'all' ? 1 : 0) + (search ? 1 : 0) + (dateFrom || dateTo ? 1 : 0)

  const summaryCards = [
    { label: 'Total',      value: stats.total,      accent: '#475569', icon: FileText, key: 'all' },
    { label: 'Pending',    value: stats.pending,    accent: '#d97706', icon: Clock, key: 'pending' },
    { label: 'Processing', value: stats.processing, accent: '#2563eb', icon: Loader, key: 'processing' },
    { label: 'Paid',       value: stats.paid,       accent: '#16a34a', icon: Banknote, key: 'paid' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PageHeader title="My Reports" />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p className="text-caption" style={{ margin: 0 }}>{total} report{total !== 1 ? 's' : ''} found</p>
        <Button size="sm" variant="secondary" onClick={() => setShowFilters(true)} icon={SlidersHorizontal}>
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </Button>
      </div>

      {/* Summary chips */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {summaryCards.map(s => {
          const Icon = s.icon
          return (
            <button key={s.label} onClick={() => { setStatus(s.key); setCurrentPage(1) }} className="card" style={{
              padding: '10px 6px', textAlign: 'center', cursor: 'pointer',
              border: statusFilter === s.key ? `1.5px solid ${s.accent}` : '1px solid var(--slate-100)',
            }}>
              <Icon size={14} color={s.accent} style={{ marginBottom: 4 }} />
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--slate-950)' }}>{loading && stats.total === 0 ? '—' : s.value}</div>
              <div style={{ fontSize: 9, color: 'var(--slate-500)', fontWeight: 600, textTransform: 'uppercase', marginTop: 1 }}>{s.label}</div>
            </button>
          )
        })}
      </div>

      {/* Report list */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card card-padded">
              <div className="skeleton" style={{ height: 13, width: '55%', marginBottom: 8 }} />
              <div className="skeleton" style={{ height: 11, width: '35%' }} />
            </div>
          ))}
        </div>
      ) : violations.length === 0 ? (
        <div className="card">
          <EmptyState icon={Inbox} title="No reports found" message="Try adjusting your filters or submit a new report." />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {violations.map((v) => (
            <ReportCard key={v.id} v={v} onView={setSelected} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
          <span className="text-caption">Page {page} of {totalPages}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={page === 1}>Previous</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next</button>
          </div>
        </div>
      )}

      <FilterSheet
        open={showFilters} onClose={() => setShowFilters(false)}
        search={search} setSearch={v => { setSearch(v); setCurrentPage(1) }}
        statusFilter={statusFilter} setStatus={v => { setStatus(v); setCurrentPage(1) }}
        dateFrom={dateFrom} setDateFrom={v => { setDateFrom(v); setCurrentPage(1) }}
        dateTo={dateTo} setDateTo={v => { setDateTo(v); setCurrentPage(1) }}
      />

      {selected && <ReportDetailModal report={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}