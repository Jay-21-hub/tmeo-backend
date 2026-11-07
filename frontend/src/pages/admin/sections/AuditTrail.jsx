import { useState, useEffect, useCallback, useRef } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import {
  ClipboardList, ChevronLeft, ChevronRight,
  User, Calendar, XCircle, RefreshCw, Eye, Clock, Search, X,
} from 'lucide-react'
import api from '../../../services/api'
import StatCard from '../../../components/ui/StatCard'
import Button from '../../../components/ui/Button'
import { EmptyState } from '../../../components/ui/States'
import { ACTION_COLORS, MODULE_ICONS, ACTION_FILTER_OPTIONS, STATUS_FILTER_OPTIONS } from './auditConfig'
import AuditDetailModal from './AuditDetailModal'

const STATUS_TONE = { SUCCESS: 'success', FAILED: 'danger', WARNING: 'warning', INFO: 'info' }
const PAGE_SIZE = 15
const SEARCH_DEBOUNCE_MS = 350

export default function AuditTrail() {
  const [logs, setLogs] = useState([])
  const [stats, setStats] = useState({ total_logs: 0, today_events: 0, failed_count: 0, active_users: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedLog, setSelectedLog] = useState(null)

  // ── filters ──────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [filterAction, setFilterAction] = useState('')
  const [filterModule, setFilterModule] = useState('')
  const [filterUser, setFilterUser] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterDate, setFilterDate] = useState('')

  const [filterOptions, setFilterOptions] = useState({ modules: [], users: [] })
  const debounceRef = useRef(null)

  const hasFilters = search || filterAction || filterModule || filterUser || filterStatus || filterDate

  const clearFilters = () => {
    setSearchInput(''); setSearch('')
    setFilterAction(''); setFilterModule(''); setFilterUser(''); setFilterStatus(''); setFilterDate('')
    setPage(1)
  }

  // Debounced search — mirrors ViolationRecords' live-search feel without
  // firing a request on every keystroke.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(debounceRef.current)
  }, [searchInput])

  const fetchFilterOptions = useCallback(async () => {
    try {
      const res = await api.get('/api/audit/filter-options/')
      setFilterOptions({
        modules: res.data.modules || [],
        users: res.data.users || [],
      })
    } catch {
      // Non-fatal — dropdowns just stay populated from the static fallback lists.
    }
  }, [])

  const fetchLogs = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const params = { page, page_size: PAGE_SIZE }
      if (search) params.search = search
      if (filterAction) params.action = filterAction
      if (filterModule) params.module = filterModule
      if (filterUser) params.user_id = filterUser
      if (filterStatus) params.status = filterStatus
      if (filterDate) { params.date_from = filterDate; params.date_to = filterDate }

      const res = await api.get('/api/audit/logs/', { params })
      setLogs(res.data.results || [])
      const count = res.data.count || 0
      setTotalCount(count)
      setTotalPages(Math.max(1, Math.ceil(count / PAGE_SIZE)))
      if (res.data.stats) setStats(res.data.stats)
    } catch {
      setError('Hindi ma-load ang audit logs.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [page, search, filterAction, filterModule, filterUser, filterStatus, filterDate])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern, matches existing codebase convention
    fetchFilterOptions()
  }, [fetchFilterOptions])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern, matches existing codebase convention
    fetchLogs()
  }, [fetchLogs])

  const formatDate = (str) => {
    if (!str) return '—'
    return new Date(str).toLocaleString('en-PH', { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
  }

  const getRoleLabel = (role) => role ? role.charAt(0).toUpperCase() + role.slice(1) : ''

  const STAT_CARDS = [
    { label: 'Total Logs', value: stats.total_logs, icon: ClipboardList, accent: '#6366f1' },
    { label: "Today's Logs", value: stats.today_events, icon: Calendar, accent: 'var(--success-600)' },
    { label: 'Failed Actions', value: stats.failed_count, icon: XCircle, accent: 'var(--danger-600)' },
    { label: 'Active Users', value: stats.active_users, icon: User, accent: 'var(--warning-600)' },
  ]

  return (
    <div>
      <PageHeader
        title="Audit Trail"
        action={(
          <>
          <button className="btn btn-secondary btn-sm" onClick={() => fetchLogs(true)} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> Refresh
          </button>
      
          </>
        )}
      />

      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        {STAT_CARDS.map(c => <StatCard key={c.label} {...c} value={c.value?.toLocaleString() || '0'} loading={loading} />)}
      </div>

      {/* ── FILTER BAR ── */}
      <div className="filter-bar" style={{ marginBottom: 16 }}>
        <div className="search-input-wrap">
          <Search size={14} className="search-input-icon" aria-hidden="true" />
          <input
            className="input" value={searchInput} onChange={e => setSearchInput(e.target.value)}
            placeholder="Search actor, description, module, target, IP…" aria-label="Search audit logs"
          />
          {searchInput && (
            <button className="search-input-clear" onClick={() => setSearchInput('')} aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </div>

        <div className="filter-divider" />

        <select className="filter-select" value={filterAction} onChange={e => { setFilterAction(e.target.value); setPage(1) }} aria-label="Filter by action">
          <option value="">All Actions</option>
          {ACTION_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <select className="filter-select" value={filterModule} onChange={e => { setFilterModule(e.target.value); setPage(1) }} aria-label="Filter by module">
          <option value="">All Modules</option>
          {filterOptions.modules.map(m => <option key={m} value={m}>{m}</option>)}
        </select>

        <select className="filter-select" value={filterUser} onChange={e => { setFilterUser(e.target.value); setPage(1) }} aria-label="Filter by user">
          <option value="">All Users</option>
          {filterOptions.users.map(u => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
        </select>

        <select className="filter-select" value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(1) }} aria-label="Filter by status">
          <option value="">All Status</option>
          {STATUS_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <input type="date" className="filter-select" value={filterDate} onChange={e => { setFilterDate(e.target.value); setPage(1) }} aria-label="Filter by date" />

        {hasFilters && (
          <Button variant="danger-ghost" size="sm" icon={X} onClick={clearFilters}>Clear</Button>
        )}
      </div>

      <div className="card">
        <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
          <table className="table">
            <thead>
              <tr><th>User</th><th>Action</th><th>Module</th><th>Target</th><th>Status</th><th>Client</th><th>Timestamp</th><th></th></tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>{Array.from({ length: 8 }).map((_, j) => (
                    <td key={j}><div className="skeleton" style={{ height: 13, width: '70%' }} /></td>
                  ))}</tr>
                ))
              ) : error ? (
                <tr><td colSpan={8} style={{ padding: 0 }}><EmptyState icon={XCircle} title="Failed to load" message={error} /></td></tr>
              ) : logs.length === 0 ? (
                <tr><td colSpan={8} style={{ padding: 0 }}>
                  <EmptyState
                    icon={ClipboardList} title="Walang audit logs na nahanap."
                    message={hasFilters ? 'Try adjusting your filters.' : undefined}
                    action={hasFilters && <Button variant="secondary" size="sm" onClick={clearFilters}>Clear Filters</Button>}
                  />
                </td></tr>
              ) : logs.map((log, idx) => {
                const actionStyle = ACTION_COLORS[log.action] || ACTION_COLORS.DEFAULT
                const statusTone = STATUS_TONE[log.status?.toUpperCase()] || 'info'
                const ModIcon = MODULE_ICONS[log.module] || MODULE_ICONS.DEFAULT
                return (
                  <tr key={log.id || idx} onClick={() => setSelectedLog(log)} style={{ cursor: 'pointer' }}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 30, height: 30, borderRadius: '50%', background: actionStyle.bg, border: `1px solid ${actionStyle.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <User size={13} color={actionStyle.text} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <p className="u-truncate" style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{log.user_name || '—'}</p>
                          <p className="text-caption" style={{ margin: 0 }}>{getRoleLabel(log.user_role)}</p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="badge" style={{ background: actionStyle.bg, color: actionStyle.text, border: `1px solid ${actionStyle.border}` }}>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: actionStyle.dot }} />{log.action}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <ModIcon size={13} color="var(--slate-400)" />
                        <span className="u-truncate" style={{ fontSize: 12, color: 'var(--slate-600)' }}>{log.module}</span>
                      </div>
                    </td>
                    <td>
                      <span className="text-caption u-truncate" style={{ maxWidth: 140, display: 'inline-block' }}>
                        {log.target_label || '—'}
                      </span>
                    </td>
                    <td><span className={`badge badge-${statusTone}`}>{log.status}</span></td>
                    <td>
                      <span className="text-caption u-truncate" style={{ maxWidth: 150, display: 'inline-block' }}>
                        {log.client_summary || '—'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Clock size={12} color="var(--slate-400)" />
                        <span className="text-caption">{formatDate(log.timestamp)}</span>
                      </div>
                    </td>
                    <td>
                      <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); setSelectedLog(log) }}>
                        <Eye size={13} /> View
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', borderTop: '1px solid var(--slate-100)', background: 'var(--slate-50)', flexWrap: 'wrap', gap: 10 }}>
            <p className="text-caption" style={{ margin: 0 }}>Page {page} of {totalPages} · {totalCount.toLocaleString()} total records</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                <ChevronLeft size={14} /> Prev
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                Next <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {selectedLog && <AuditDetailModal log={selectedLog} onClose={() => setSelectedLog(null)} />}
    </div>
  )
}