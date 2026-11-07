import { useState, useEffect, useRef, useCallback } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import {
  Search,
  Eye, Trash2, X, ChevronLeft, ChevronRight,
  FileText, CheckCircle, Clock, ShieldAlert,
  AlertCircle, History, Users,
} from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { useToast } from '../../../context/useToast'
import Modal from '../../../components/ui/Modal'
import Button from '../../../components/ui/Button'
import StatCard from '../../../components/ui/StatCard'
import Badge, { StatusBadge } from '../../../components/ui/Badge'
import { EmptyState } from '../../../components/ui/States'
import ViolatorHistoryPanel from '../../../components/common/ViolatorHistoryPanel'
import './ViolationRecords.css'

/* ─── helpers ───────────────────────────────────────────────── */
const fmt     = (v, f = '—') => (v != null && v !== '' ? v : f)
const fmtDate = d => {
  if (!d) return '—'
  const dt = new Date(d)
  return isNaN(dt) ? d : dt.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}
const fmtTime = d => {
  if (!d) return '—'
  const dt = new Date(d)
  return isNaN(dt) ? '—' : dt.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: true }).replace(/\s?([ap])\.?m\.?/i, (_, c) => ` ${c.toUpperCase()}M`)
}
const fmtPeso = n => n != null ? `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 })}` : '—'
const initials = name => name ? name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase() : '?'
const AVATAR_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899']
const avatarColor = name => {
  let h = 0; for (const c of (name || '')) h = c.charCodeAt(0) + ((h << 5) - h)
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

const violationText = r => (r.violation_types?.length ? r.violation_types.map(i => i.name || '').filter(Boolean).join(', ') : '')

const STATUS_LABELS = { pending: 'Pending', processing: 'Processing', paid: 'Paid' }

/* Server-computed, active-database-only status (never counts archived years) —
   see ViolationListSerializer.get_repeat_status on the backend. */
const RepeatStatusBadge = ({ status }) => {
  if (!status) return null
  return (
    <Badge tone={status === 'REPEAT VIOLATOR' ? 'warning' : 'neutral'} dot={false}>
      {status}
    </Badge>
  )
}

/* ─── sortable table header cell (module-level: must not be redefined per render) ──
   Sorting still works exactly as before; the visible arrows are intentionally gone on this page.
   Sortable headers are real <button>s (keyboard accessible) and expose aria-sort only while active. */
const TH = ({ label, field, w, sortField, sortDir, onSort, right = false }) => {
  const active = field && sortField === field
  const ariaSort = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined
  return (
    <th scope="col" aria-sort={ariaSort} className={right ? 'vr-th-right' : undefined} style={{ width: w }}>
      {field
        ? <button type="button" className="vr-th vr-th--sort" onClick={() => onSort(field)}>{label}</button>
        : <span className="vr-th">{label}</span>}
    </th>
  )
}

/* One "Other Violations" entry — its own standalone card (never merged into
   a shared box/table, per MASTER PROMPT Part 23), view-only (no Print — that
   stays a Staff-only action). Clicking it switches the panel to that record;
   the backend's /related/ endpoint already excludes whichever record is
   currently selected, so it can never show up in its own "other" list. */
const RelatedViolationCard = ({ rec, onView }) => {
  const types = rec.violation_types?.length ? rec.violation_types.map(i => i.name).filter(Boolean).join(', ') : '—'
  return (
    <div className="card card-padded" style={{ marginBottom: 10, cursor: 'pointer' }} onClick={() => onView(rec)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--blue-600)' }}>#{rec.id}</span>
        <StatusBadge status={rec.status} label={STATUS_LABELS[rec.status]} />
      </div>
      <p style={{ margin: '0 0 2px', fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{types}</p>
      <p className="text-caption" style={{ margin: 0 }}>{fmtDate(rec.date_issued)} · {fmt(rec.location)}</p>
    </div>
  )
}

/* ─── detail panel ──────────────────────────────────────────── */
const DetailPanel = ({ record, onClose, onSelect }) => {
  const [related, setRelated] = useState([])
  const [relatedLoading, setRelatedLoading] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset/fetch related records whenever the selected record changes, same convention used elsewhere in this codebase
    if (!record) { setRelated([]); return }
    let cancelled = false
    setRelatedLoading(true)
    api.get(API.VIOLATION_RELATED_ACTIVE(record.id))
      .then(res => { if (!cancelled) setRelated(res.data?.related || []) })
      .catch(() => { if (!cancelled) setRelated([]) })
      .finally(() => { if (!cancelled) setRelatedLoading(false) })
    return () => { cancelled = true }
  }, [record])

  if (!record) return null

  const enforcerName = record.enforcer
    ? (typeof record.enforcer === 'object'
        ? (record.enforcer.full_name || `${record.enforcer.last_name || ''}, ${record.enforcer.first_name || ''}`.trim())
        : record.enforcer)
    : '—'

  const violationTypes = record.items?.length
    ? record.items.map(i => i.violation_type?.name || i.name || '').filter(Boolean).join(', ')
    : (record.violation_type || '—')

  const rows = [
    ['Violation ID', record.id],
    ['Violator Name', record.violator_name],
    ['License No.', record.license_number],
    ['Plate Number', record.plate_number],
    ['Vehicle Type', record.vehicle_type],
    ['Violation Type', violationTypes],
    ['Date Issued', record.date_issued ? fmtDate(record.date_issued) : fmtDate(record.date)],
    // Date Paid lives on the separate Assessment record (Assessment.date_paid,
    // surfaced via ViolationListSerializer.date_paid) — distinct from Date
    // Issued, which is when the Enforcer originally wrote the OVR. Only
    // shown once a payment has actually been recorded.
    ...(record.status === 'paid' ? [['Date Paid', fmtDate(record.date_paid)]] : []),
    ['Location', record.location],
    ['Enforcer', enforcerName],
    ['Penalty Amount', fmtPeso(record.penalty_amount ?? record.fine_amount)],
    ['OVR Number', record.ovr_number],
    ['Status', <StatusBadge key="s" status={record.status} label={STATUS_LABELS[record.status]} />],
    ['Offender Status', <RepeatStatusBadge key="r" status={record.repeat_status} />],
    ['Remarks', record.remarks],
  ]

  return (
    <Modal open={!!record} onClose={onClose} width={480} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div style={{ margin: '-24px -24px 18px', padding: '20px 24px 16px', borderBottom: '1px solid var(--slate-100)' }}>
        <p className="text-label" style={{ margin: 0 }}>Violation Detail</p>
        <h3 className="text-h2" style={{ margin: '2px 0 0' }}>{record.id}</h3>
      </div>

      <div style={{ background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 18, border: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--blue-100)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, color: 'var(--blue-700)', flexShrink: 0 }}>
          {initials(record.violator_name)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="u-truncate" style={{ margin: 0, fontWeight: 700, color: 'var(--slate-950)', fontSize: 15 }}>{fmt(record.violator_name)}</p>
          <p className="mono" style={{ margin: 0, fontSize: 12, color: 'var(--slate-600)' }}>{fmt(record.license_number)}</p>
        </div>
        <StatusBadge status={record.status} label={STATUS_LABELS[record.status]} />
      </div>

      {rows.map(([label, val]) => val != null && val !== '' && val !== '—' ? (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '9px 0', borderBottom: '1px solid var(--slate-100)', gap: 12 }}>
          <span className="text-caption" style={{ fontWeight: 500, flexShrink: 0 }}>{label}</span>
          <span style={{ fontSize: 13, color: 'var(--slate-950)', fontWeight: 600, textAlign: 'right', wordBreak: 'break-word' }}>{val}</span>
        </div>
      ) : null)}

      {record.repeat_status === 'REPEAT VIOLATOR' && (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <Users size={14} color="var(--slate-500)" aria-hidden="true" />
            <p className="text-label" style={{ margin: 0 }}>Other Violations of This Violator — Active Year</p>
          </div>
          {relatedLoading ? (
            <div className="skeleton" style={{ height: 70, borderRadius: 'var(--radius-md)' }} />
          ) : related.length === 0 ? (
            <p className="text-caption">No other active-year records found.</p>
          ) : (
            related.map(rec => <RelatedViolationCard key={rec.id} rec={rec} onView={onSelect} />)
          )}
        </div>
      )}
    </Modal>
  )
}

/* ═══════════════════════════════════════════════════════════════
   MAIN
═══════════════════════════════════════════════════════════════ */
export default function ViolationRecords() {
  const toast = useToast()
  const [records, setRecords]           = useState([])
  const [loading, setLoading]           = useState(true)
  const [search, setSearch]             = useState('')
  const [filterType, setFilterType]     = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterDate, setFilterDate]     = useState('')
  const [sortField, setSortField]       = useState('created_at')
  const [sortDir, setSortDir]           = useState('desc')
  const [page, setPage]                 = useState(1)
  const pageSize = 10
  const [total, setTotal]               = useState(0)
  const [counts, setCounts]             = useState({ pending: 0, processing: 0, paid: 0 })
  const [selected, setSelected]         = useState(null)
  const [historyTarget, setHistoryTarget] = useState(null)
  const [violationTypes, setViolationTypes] = useState([])
  const tableRef = useRef(null)

  const hasFilters = search || filterType || filterStatus || filterDate

  const fetchRecords = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (search)       params.append('search', search)
      if (filterType)   params.append('violation_type', filterType)
      // Default scope for this page is pending+processing+paid — sent
      // explicitly so the server's pagination count matches exactly what's
      // displayed. A specific status filter overrides it with one value.
      params.append('status', filterStatus || 'pending,processing,paid')
      if (filterDate)   params.append('date', filterDate)
      params.append('ordering', sortDir === 'desc' ? `-${sortField}` : sortField)
      params.append('page', page)
      params.append('page_size', pageSize)
      // One row per violator — their latest/current violation only (see
      // ViolationListView.group_by_violator on the backend). Previous
      // violations for the same violator remain in the database and are
      // reachable through this row's View Details panel.
      params.append('group_by_violator', '1')

      const res  = await api.get(`${API.VIOLATIONS}?${params}`)
      const data = res.data
      const all  = Array.isArray(data) ? data : data.results ?? []
      setRecords(all)
      setTotal(data.count ?? all.length)

      // StatCards show totals across the whole dataset, not just this page,
      // so fetch each status's count independently (page_size=1 keeps the
      // payload tiny — only the `count` field is read from each response).
      // Same grouping flag, so these counts match what the table would show
      // if that status were selected (one per violator, not per ticket).
      const searchParams = search ? `&search=${encodeURIComponent(search)}` : ''
      const [pendingRes, processingRes, paidRes] = await Promise.all([
        api.get(`${API.VIOLATIONS}?status=pending&page_size=1&group_by_violator=1${searchParams}`),
        api.get(`${API.VIOLATIONS}?status=processing&page_size=1&group_by_violator=1${searchParams}`),
        api.get(`${API.VIOLATIONS}?status=paid&page_size=1&group_by_violator=1${searchParams}`),
      ])
      setCounts({
        pending:    pendingRes.data.count ?? 0,
        processing: processingRes.data.count ?? 0,
        paid:       paidRes.data.count ?? 0,
      })
    } catch {
      setRecords([]); setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [search, filterType, filterStatus, filterDate, sortField, sortDir, page, pageSize])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-filter-change pattern, matches existing codebase convention
    fetchRecords()
  }, [fetchRecords])

  const handleDelete = async (record, e) => {
    e.stopPropagation()
    if (!window.confirm(`Delete violation #${record.id} for ${record.violator_name}? This cannot be undone.`)) return
    try {
      setSelected(null)
      await api.delete(`/api/violations/${record.id}/`)
      toast.success('Violation record deleted.')
      records.length === 1 && page > 1 ? setPage(p => p - 1) : fetchRecords()
    } catch { toast.danger('Failed to delete record.') }
  }

  useEffect(() => {
    api.get(API.VIOLATION_TYPES).then(r => {
      const d = r.data; setViolationTypes(Array.isArray(d) ? d : d.results ?? [])
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (window.XLSX) return
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
    s.async = true
    document.head.appendChild(s)
  }, [])

  const handleSort = f => {
    if (sortField === f) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(f); setSortDir('asc') }
    setPage(1)
  }

  const clearFilters = () => { setSearch(''); setFilterType(''); setFilterStatus(''); setFilterDate(''); setPage(1) }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to   = Math.min(page * pageSize, total)

  const pageButtons = Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
    let p = i + 1
    if (totalPages > 5) {
      if (page <= 3) p = i + 1
      else if (page >= totalPages - 2) p = totalPages - 4 + i
      else p = page - 2 + i
    }
    return p
  })

  return (
    <div className="vr">
      <PageHeader title="Violation Records" />

      {/* ── STAT CARDS ── */}
      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        <StatCard label="Total Records" value={total.toLocaleString()} accent="var(--blue-600)" icon={ShieldAlert} />
        <StatCard label="Pending" value={counts.pending.toLocaleString()} accent="var(--warning-600)" icon={Clock} />
        <StatCard label="Processing" value={counts.processing.toLocaleString()} accent="var(--info-600)" icon={AlertCircle} />
        <StatCard label="Paid" value={counts.paid.toLocaleString()} accent="var(--success-600)" icon={CheckCircle} />
      </div>

      {/* ── FILTER BAR ── */}
      <div className="filter-bar" style={{ marginBottom: 16 }}>
        <div className="search-input-wrap">
          <Search size={14} className="search-input-icon" aria-hidden="true" />
          <input
            className="input" value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search name, plate, violation ID…" aria-label="Search violation records"
          />
          {search && (
            <button className="search-input-clear" onClick={() => { setSearch(''); setPage(1) }} aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </div>

        <div className="filter-divider" />

        <select className="filter-select" value={filterType} onChange={e => { setFilterType(e.target.value); setPage(1) }} aria-label="Filter by violation type">
          <option value="">All Types</option>
          {violationTypes.map(vt => <option key={vt.id} value={vt.name || vt.id}>{vt.name}</option>)}
        </select>

        <select className="filter-select" value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(1) }} aria-label="Filter by status">
          <option value="">All Status</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="paid">Paid</option>
        </select>

        <input type="date" className="filter-select" value={filterDate} onChange={e => { setFilterDate(e.target.value); setPage(1) }} aria-label="Filter by date" />

        {hasFilters && (
          <Button variant="danger-ghost" size="sm" icon={X} onClick={clearFilters}>Clear</Button>
        )}

        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {filterType   && <Badge tone="info" dot={false}>{filterType}</Badge>}
          {filterStatus && <StatusBadge status={filterStatus} label={STATUS_LABELS[filterStatus]} />}
          {filterDate   && <Badge tone="success" dot={false}>{fmtDate(filterDate)}</Badge>}
        </div>
      </div>

      {/* ── TABLE ── */}
      <div className="table-wrap">
        <div ref={tableRef} style={{ overflowX: 'auto' }}>
          <table className="table vr-table">
            <thead>
              <tr>
                <TH label="Violation ID" field="violation_id" w={88} sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <TH label="Violator Name" field="violator_name" w={128} sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <TH label="License No." field="license_number" w={100} sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <TH label="Plate No." field="plate_number" w={86} sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <TH label="Violation Type" field="violation_type" w={140} sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <TH label="Date & Time" field="date" w={96} sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <TH label="Location" field="location" w={110} sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <TH label="Enforcer" field="enforcer" w={112} sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <TH label="Fine" field="fine_amount" w={84} right sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <TH label="Status" field="status" w={92} sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <TH label="Actions" field={null} w={104} sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array(Math.min(pageSize, 5)).fill(0).map((_, i) => (
                  <tr key={i}>
                    {Array(11).fill(0).map((__, j) => (
                      <td key={j}><div className="skeleton" style={{ height: 12, width: j === 0 ? 64 : j === 1 ? '70%' : '60%' }} /></td>
                    ))}
                  </tr>
                ))
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={11} style={{ padding: 0 }}>
                    <EmptyState
                      icon={FileText} title="No violation records found"
                      message={hasFilters ? 'Try adjusting your filters.' : 'Records will appear here once violations are encoded.'}
                      action={hasFilters && <Button variant="secondary" size="sm" onClick={clearFilters}>Clear Filters</Button>}
                    />
                  </td>
                </tr>
              ) : records.map((r, idx) => {
                // enforcer_name is the event-time name (snapshot-first, see enforcer_historical)
                const enforcer = r.enforcer_historical !== undefined
                  ? (r.enforcer_name || '')
                  : (r.enforcer_name || (typeof r.enforcer === 'string' ? r.enforcer : '') || '')
                return (
                  <tr key={r.id ?? idx} onClick={() => setSelected(r)} style={{ cursor: 'pointer' }}>
                    <td><span className="vr-id">{fmt(r.violation_id || `VL-${String(r.id).padStart(6, '0')}`)}</span></td>
                    <td>
                      <span className="vr-name" title={r.violator_name || undefined}>{fmt(r.violator_name)}</span>
                      {r.repeat_status === 'REPEAT VIOLATOR' && (
                        <span className="vr-repeat" onClick={e => { e.stopPropagation(); setSelected(r) }}>
                          <RepeatStatusBadge status={r.repeat_status} />
                        </span>
                      )}
                    </td>
                    <td><span className="vr-lic">{r.license_number ? r.license_number : <span className="vr-dash">—</span>}</span></td>
                    <td>
                      {r.plate_number
                        ? <span className="mono vr-plate" title={r.plate_number}>{r.plate_number}</span>
                        : <span className="vr-dash">—</span>}
                    </td>
                    <td>
                      <span className="vr-clamp" title={violationText(r) || undefined}>{violationText(r) || fmt(r.violation_type)}</span>
                    </td>
                    <td>
                      <div className="vr-date">{fmtDate(r.date_issued || r.date)}</div>
                      <div className="vr-time">{fmtTime(r.date_issued || r.date)}</div>
                    </td>
                    <td><span className="vr-clamp" title={r.location || undefined}>{r.location ? r.location : <span className="vr-dash">—</span>}</span></td>
                    <td>
                      {enforcer ? (
                        <div className="vr-enf">
                          <span className="vr-avatar" style={{ background: avatarColor(enforcer) }} aria-hidden="true">{initials(enforcer)}</span>
                          <span className="vr-enf-name">{enforcer}</span>
                        </div>
                      ) : <span className="vr-dash">—</span>}
                    </td>
                    <td className="vr-fine">{fmtPeso(r.fine_amount)}</td>
                    <td><StatusBadge status={r.status} label={STATUS_LABELS[r.status]} /></td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="row-action-btn" style={{ background: 'var(--blue-50)' }} title="View" aria-label={`View violation ${r.id}`} onClick={e => { e.stopPropagation(); setSelected(r) }}>
                          <Eye size={14} color="var(--blue-600)" aria-hidden="true" />
                        </button>
                        {r.violator_name && r.license_number && (
                          <button type="button" className="row-action-btn" style={{ background: 'var(--slate-100)' }} title="Violation History" aria-label={`View history for ${r.violator_name}`} onClick={e => { e.stopPropagation(); setHistoryTarget({ name: r.violator_name, license: r.license_number }) }}>
                            <History size={14} color="var(--slate-600)" aria-hidden="true" />
                          </button>
                        )}
                        <button type="button" className="row-action-btn" style={{ background: 'var(--danger-50)' }} title="Delete" aria-label={`Delete violation ${r.id}`} onClick={e => handleDelete(r, e)}>
                          <Trash2 size={14} color="var(--danger-600)" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* ── PAGINATION ── */}
        <div className="vr-foot">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="text-caption">{total === 0 ? 'No records' : `${from}–${to} of ${total.toLocaleString()} records`}</span>
          </div>
          <div className="pagination">
            <button className="page-btn" disabled={page === 1} onClick={() => setPage(p => p - 1)} aria-label="Previous page">
              <ChevronLeft size={14} />
            </button>
            {pageButtons.map(p => (
              <button key={p} className={`page-btn ${page === p ? 'is-active' : ''}`} onClick={() => setPage(p)} aria-current={page === p ? 'page' : undefined}>
                {p}
              </button>
            ))}
            <button className="page-btn" disabled={page === totalPages} onClick={() => setPage(p => p + 1)} aria-label="Next page">
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      <DetailPanel record={selected} onClose={() => setSelected(null)} onSelect={setSelected} />
      <ViolatorHistoryPanel
        open={!!historyTarget}
        onClose={() => setHistoryTarget(null)}
        violatorName={historyTarget?.name}
        licenseNumber={historyTarget?.license}
        allowPrint={false}
      />
    </div>
  )
}