import { useState, useEffect, useCallback } from 'react'
import {
  Clock, AlertTriangle, Timer, Search, ClipboardList, ClipboardCheck,
  ChevronRight, RefreshCw, Lock, X,
  ChevronLeft, ChevronsLeft, ChevronsRight,
} from 'lucide-react'
import api from '../../../services/api'
import useAuth from '../../../hooks/useAuth'
import useViolationPolling from '../../../hooks/useViolationPolling'
import { EmptyState, ErrorState } from '../../../components/ui/States'
import './PendingViolation.css'

/* ── Pagination (windowed, matches ViolationRecords/ManageViolationTypes pattern) ── */
function Pagination({ currentPage, totalPages, totalItems, pageSize, onPageChange }) {
  const start = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const end = Math.min(currentPage * pageSize, totalItems)

  const pageButtons = Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
    let p = i + 1
    if (totalPages > 5) {
      if (currentPage <= 3) p = i + 1
      else if (currentPage >= totalPages - 2) p = totalPages - 4 + i
      else p = currentPage - 2 + i
    }
    return p
  })

  return (
    <div className="pv-pager">
      <span>Showing <strong>{start}–{end}</strong> of <strong>{totalItems}</strong> violations</span>

      <div className="pagination">
        <button className="page-btn" onClick={() => onPageChange(1)} disabled={currentPage === 1} title="First page" aria-label="First page"><ChevronsLeft size={14} /></button>
        <button className="page-btn" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1} title="Previous page" aria-label="Previous page"><ChevronLeft size={14} /></button>
        {pageButtons.map(p => (
          <button key={p} className={`page-btn ${p === currentPage ? 'is-active' : ''}`} onClick={() => onPageChange(p)} aria-label={`Page ${p}`} aria-current={p === currentPage ? 'page' : undefined}>{p}</button>
        ))}
        <button className="page-btn" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === totalPages || totalPages === 0} title="Next page" aria-label="Next page"><ChevronRight size={14} /></button>
        <button className="page-btn" onClick={() => onPageChange(totalPages)} disabled={currentPage === totalPages || totalPages === 0} title="Last page" aria-label="Last page"><ChevronsRight size={14} /></button>
      </div>
    </div>
  )
}

/* ── KPI card (compact, page-scoped). Same four metrics + same values as before;
      the root element is stable across loading/loaded so the entrance animation
      runs once and the card never changes size when data arrives. ── */
function KpiCard({ label, value, sublabel, accent, icon, loading, index }) {
  const Icon = icon
  return (
    <div className="pv-kpi" style={{ '--pv-accent': accent, '--pv-i': index }}>
      <span className="pv-kpi-icon" aria-hidden="true"><Icon size={18} strokeWidth={2.2} /></span>
      <div className="pv-kpi-body">
        <p className="pv-kpi-label">{label}</p>
        {loading
          ? <div className="skeleton pv-kpi-skel" role="status" aria-label="Loading" />
          : <p className="pv-kpi-value">{value ?? 0}</p>}
        <p className="pv-kpi-sub">{sublabel}</p>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════════════════ */
export default function PendingViolation({ onNavigate }) {
  const { user: currentUser } = useAuth()
  const [violations, setViolations] = useState([])
  const [stats, setStats] = useState({ total_pending: 0, processing_count: 0, oldest_pending_days: 0, today_count: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const [currentPage, setCurrentPage] = useState(1)
  const [total, setTotal] = useState(0)
  const pageSize = 10

  const deriveStats = (data, results) => ({
    total_pending: data.total_pending ?? results.filter(v => v.status === 'pending').length,
    processing_count: data.processing_count ?? results.filter(v => v.status === 'processing').length,
    oldest_pending_days: data.oldest_days ?? 0,
    today_count: data.violations_today ?? results.filter(v => {
      const d = new Date(v.created_at || v.date_issued)
      return d.toDateString() === new Date().toDateString()
    }).length,
  })

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const params = { page: currentPage, page_size: pageSize }
      if (search.trim()) params.search = search.trim()
      const res = await api.get('/api/violations/pending/', { params })
      const results = res.data.results || []
      setViolations(results)
      setTotal(res.data.count ?? results.length)
      setStats(deriveStats(res.data, results))
    } catch {
      setError('Failed to load pending violations.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [currentPage, search])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount / on-filter-change pattern, matches existing codebase convention
    fetchData()
  }, [fetchData])

  const silentFetch = useCallback(async () => {
    try {
      const params = { page: currentPage, page_size: pageSize }
      if (search.trim()) params.search = search.trim()
      const res = await api.get('/api/violations/pending/', { params })
      const results = res.data.results || []
      setViolations(results)
      setTotal(res.data.count ?? results.length)
      setStats(deriveStats(res.data, results))
    } catch { /* silent */ }
  }, [currentPage, search])

  // Quiet refresh on a timer (lock/status changes by other staff). Returns the request's
  // promise so the poller never overlaps itself.
  const handlePoll = useCallback(() => silentFetch(), [silentFetch])
  useViolationPolling(handlePoll)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset pagination on filter change, matches existing codebase convention
    setCurrentPage(1)
  }, [search])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const paginated = violations

  const handleProcess = async (v) => {
    if (v.status === 'processing' && v.locked_by_id && v.locked_by_id !== currentUser?.id) return
    if (v.status === 'processing' && v.locked_by_id === currentUser?.id) {
      onNavigate && onNavigate('assessment', v)
      return
    }
    try {
      const res = await api.patch(`/api/violations/${v.id}/`, { status: 'processing' })
      const updated = res.data
      setViolations(prev => prev.map(x =>
        x.id === v.id
          ? { ...x, status: 'processing', locked_by_id: updated.locked_by_id ?? currentUser?.id, locked_by_name: updated.locked_by_name ?? currentUser?.full_name }
          : x
      ))
      const merged = { ...v, ...updated, items: (updated.items && updated.items.length) ? updated.items : (v.items || []) }
      onNavigate && onNavigate('assessment', merged)
    } catch {
      onNavigate && onNavigate('assessment', v)
    }
  }

  const fmt = (val) => val || '—'
  const fmtDate = (d) => {
    if (!d) return '—'
    return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: '2-digit', year: 'numeric' })
  }
  // The pending endpoint returns the violation types in `items` (no flat
  // `violation_type` field), so list their names; falls back to the old fields.
  const getViolationTypes = (v) => {
    const names = (v.items || []).map(i => i.violation_type?.name).filter(Boolean)
    if (names.length) return names.join(', ')
    return v.violation_type ?? v.violations ?? '—'
  }

  const COLS = ['Violation ID', 'Violator Name', 'License No.', 'Plate Number', 'Vehicle Type', 'Violation Type', 'Location', 'Date Issued', 'Enforcer', 'Status', 'Action']

  // State order: loading → error → (empty | rows). An API failure never renders
  // as an empty list, and a search with no matches never says "all processed".
  const isSearching = search.trim().length > 0
  const showError = !!error && !loading
  const isEmpty = !loading && !error && paginated.length === 0

  return (
    <div className="pv">
      <header className="pv-header">
        <h1 className="pv-title">Pending Violations</h1>
        <button className="btn btn-secondary btn-sm pv-refresh" onClick={() => fetchData(true)} disabled={refreshing} aria-busy={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> Refresh
        </button>
      </header>

      <div className="pv-kpis">
        <KpiCard index={0} label="Total Pending" value={stats.total_pending} sublabel="Requires immediate attention" accent="var(--blue-600)" icon={ClipboardList} loading={loading} />
        <KpiCard index={1} label="In Processing" value={stats.processing_count} sublabel="Currently being assessed" accent="var(--warning-600)" icon={Timer} loading={loading} />
        <KpiCard index={2} label="Oldest Pending" value={`${stats.oldest_pending_days} day`} sublabel="Requires priority processing" accent="#f59e0b" icon={AlertTriangle} loading={loading} />
        <KpiCard index={3} label="Violations Today" value={stats.today_count} sublabel="Filed today" accent="#7c3aed" icon={Clock} loading={loading} />
      </div>

      <section className="pv-search" aria-labelledby="pv-search-title">
        <div className="pv-search-text">
          <h2 id="pv-search-title" className="pv-h2">Search Pending Violations</h2>
          <p className="pv-caption">Filter by violator name, plate number, license number, or violation ID</p>
        </div>
        <div className="pv-searchbox">
          <Search size={15} className="pv-searchbox-icon" aria-hidden="true" />
          <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name, plate, license, or violation ID..." aria-label="Search pending violations" />
          {search && (
            <button type="button" className="pv-searchbox-clear" onClick={() => setSearch('')} aria-label="Clear search"><X size={14} /></button>
          )}
        </div>
      </section>

      <section className="pv-records" aria-labelledby="pv-records-title">
        <div className="pv-records-head">
          <h2 id="pv-records-title" className="pv-h2">
            Pending Violations{!loading && !error && <span className="pv-count"> ({total})</span>}
          </h2>
          <div className="pv-records-meta">
            <p className="pv-summary" role="status">
              Showing <strong>{loading || error ? '—' : paginated.length}</strong> of <strong>{loading || error ? '—' : total}</strong> violation{total !== 1 ? 's' : ''}
              {isSearching && !loading && !error && <span className="pv-muted"> for "{search}"</span>}
            </p>
            {!loading && !error && violations.length > 0 && (
              <div className="pv-badges">
                {stats.total_pending > 0 && <span className="badge badge-info">{stats.total_pending} pending</span>}
                {stats.processing_count > 0 && <span className="badge badge-warning">{stats.processing_count} in progress</span>}
              </div>
            )}
          </div>
        </div>

        {showError ? (
          <div className="pv-state">
            <ErrorState title="Unable to load pending violations" message={error} onRetry={() => fetchData()} />
          </div>
        ) : (
          <>
            <div className="table-wrap pv-tablewrap">
              <table className="table pv-table">
                <thead><tr>{COLS.map(c => <th key={c} scope="col">{c}</th>)}</tr></thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i}>{Array.from({ length: 11 }).map((_, j) => (
                        <td key={j}><div className="skeleton" style={{ height: 13, width: j === 1 ? 90 : 60 }} /></td>
                      ))}</tr>
                    ))
                  ) : paginated.map((v, idx) => {
                    const isLockedByMe = v.status === 'processing' && v.locked_by_id === currentUser?.id
                    const isLockedByOther = v.status === 'processing' && v.locked_by_id && v.locked_by_id !== currentUser?.id
                    const types = getViolationTypes(v)
                    const locationText = fmt(v.location)
                    const nameText = fmt(v.violator_name || v.name)
                    return (
                      <tr key={v.id || idx}>
                        <td><span className="mono pv-id">#{v.id ?? idx + 1}</span></td>
                        <td><span className="pv-clamp pv-name" title={nameText}>{nameText}</span></td>
                        <td className="mono pv-muted">{fmt(v.license_no || v.license_number)}</td>
                        <td className="mono pv-plate">{fmt(v.plate_number || v.plate)}</td>
                        <td className="pv-cap">{fmt(v.vehicle_type)}</td>
                        <td><span className="pv-clamp pv-clamp--type" title={String(types)}>{types}</span></td>
                        <td><span className="pv-clamp pv-clamp--loc" title={locationText}>{locationText}</span></td>
                        <td className="pv-nowrap">{fmtDate(v.date_issued || v.created_at)}</td>
                        <td><span className="pv-clamp pv-clamp--sm" title={fmt(v.enforcer_name || v.enforcer)}>{fmt(v.enforcer_name || v.enforcer)}</span></td>
                        <td>
                          {v.status === 'processing'
                            ? <span className="badge badge-warning pv-status">Processing</span>
                            : <span className="badge badge-info pv-status">Pending</span>}
                        </td>
                        <td>
                          {isLockedByOther ? (
                            <div className="pv-locked">
                              <div className="pv-locked-pill"><Lock size={11} /> Locked</div>
                              <span className="pv-locked-note">Being assessed by {v.locked_by_name || 'another staff'}</span>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleProcess(v)}
                              className={`btn btn-sm pv-act${isLockedByMe ? ' pv-act--resume' : ''}`}
                            >
                              {isLockedByMe ? <>Resume <ChevronRight size={13} /></> : <>Process <ChevronRight size={13} /></>}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {isEmpty && (
              <div className="pv-state">
                {isSearching ? (
                  <EmptyState
                    icon={Search} title="No matching violations found"
                    message={`No results for "${search.trim()}". Try adjusting your search.`}
                    action={<button className="btn btn-secondary btn-sm" onClick={() => setSearch('')}>Clear search</button>}
                  />
                ) : (
                  <EmptyState
                    icon={ClipboardCheck} title="No pending violations found"
                    message="All violations have been processed. Newly filed violations will appear here for assessment."
                  />
                )}
              </div>
            )}
          </>
        )}

        {!loading && !error && total > 0 && (
          <Pagination currentPage={currentPage} totalPages={totalPages} totalItems={total} pageSize={pageSize} onPageChange={setCurrentPage} />
        )}
      </section>
    </div>
  )
}