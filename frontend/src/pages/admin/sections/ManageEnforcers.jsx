import { useState, useEffect } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import { Search, X, Users, ShieldCheck, Clock3, UserMinus, CalendarRange, UsersRound } from 'lucide-react'
import api from '../../../services/api'
import { useBreakpoint } from '../../../hooks/useBreakpoint'
import { useToast } from '../../../context/useToast'
import StatCard from '../../../components/ui/StatCard'
import Alert from '../../../components/ui/Alert'

import { DUTY_STATUS_OPTIONS, dutyStatusLabel } from './enforcers/enforcerStatus'
import EnforcersTable from './enforcers/EnforcersTable'
import EnforcerMobileList from './enforcers/EnforcerMobileCard'
import EnforcerViewModal from './enforcers/EnforcerViewModal'
import EnforcerDeactivateModal from './enforcers/EnforcerDeactivateModal'
import TeamScheduling from './enforcers/TeamScheduling'
import './enforcers/TeamScheduling.css'

const PER_PAGE = 10

export default function ManageEnforcers() {
  const toast = useToast()
  const { isMobile } = useBreakpoint()

  const [view, setView] = useState('roster') // 'roster' | 'scheduling'

  const [enforcers, setEnforcers] = useState([])
  const [stats, setStats] = useState({ total: 0, active_on_duty: 0, on_leave_suspended: 0, resigned_retired: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)

  const [viewData, setViewData] = useState(null)
  const [deactConfirm, setDeactConfirm] = useState(null)

  /* ── Fetch enforcers ── */
  const fetchData = async () => {
    setLoading(true); setError(null)
    try {
      const res = await api.get('/api/enforcers/')
      setEnforcers(res.data.results || [])
      setStats(res.data.stats || { total: 0, active_on_duty: 0, on_leave_suspended: 0, resigned_retired: 0 })
    } catch { setError('Failed to load enforcers.') }
    finally { setLoading(false) }
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern, matches existing codebase convention
    fetchData()
  }, [])

  const showToast = (msg, type = 'success') => type === 'success' ? toast.success(msg) : toast.danger(msg)

  /* ── Filter + Paginate ── */
  const filtered = enforcers.filter(e => {
    const q = search.toLowerCase()
    const matchSearch = !q ||
      (e.full_name || '').toLowerCase().includes(q) ||
      (e.enforcer_id || '').toLowerCase().includes(q) ||
      (e.badge_number || '').toLowerCase().includes(q)
    const matchStatus = !statusFilter || dutyStatusLabel(e) === statusFilter
    return matchSearch && matchStatus
  })
  const totalPages = Math.ceil(filtered.length / PER_PAGE)
  const paginated = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  const openView = (enforcer) => setViewData(enforcer)

  /* ── Deactivate ── */
  const confirmDeactivate = async () => {
    const enforcer = deactConfirm
    setDeactConfirm(null)
    try {
      await api.patch(`/api/auth/users/${enforcer.id}/`, { employment_status: 'suspended' })
      showToast('Enforcer deactivated.')
      fetchData()
    } catch { showToast('Failed to deactivate.', 'error') }
  }

  const STAT_CARDS = [
    { label: 'Total Enforcers', value: stats.total, sublabel: 'All records', icon: Users, accent: 'var(--blue-600)' },
    { label: 'Active / On Duty', value: stats.active_on_duty, sublabel: 'Currently working', icon: ShieldCheck, accent: 'var(--success-600)' },
    { label: 'On Leave / Suspended', value: stats.on_leave_suspended, sublabel: 'Temporarily away', icon: Clock3, accent: 'var(--warning-600)' },
    { label: 'Resigned / Retired', value: stats.resigned_retired, sublabel: 'No longer active', icon: UserMinus, accent: 'var(--slate-500)' },
  ]

  const activeEnforcers = enforcers.filter(e => e.is_active !== false)

  return (
    <div>
      {/* Header */}
      <PageHeader
        title="Manage Enforcers"
        action={(
          <>
          <div className="seg-toggle">
            <button className={`seg-toggle-btn ${view === 'roster' ? 'is-active' : ''}`} onClick={() => setView('roster')}>
              <UsersRound size={14} /> Enforcers
            </button>
            <button className={`seg-toggle-btn ${view === 'scheduling' ? 'is-active' : ''}`} onClick={() => setView('scheduling')}>
              <CalendarRange size={14} /> Team Scheduling
            </button>
          </div>
      
          </>
        )}
      />

      {error && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="danger">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <span>{error}</span>
              <button onClick={fetchData} style={{ fontSize: 13, color: 'var(--blue-600)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Retry</button>
            </div>
          </Alert>
        </div>
      )}

      {view === 'roster' ? (
        <>
          {/* Stat Cards */}
          <div className="kpi-grid" style={{ marginBottom: 20 }}>
            {STAT_CARDS.map(c => <StatCard key={c.label} {...c} loading={loading} />)}
          </div>

          {/* Search + Filter */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="filter-bar" style={{ border: 'none' }}>
              <div className="search-input-wrap">
                <Search size={14} className="search-input-icon" />
                <input className="input" placeholder="Search by name, ID, or badge number..." value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} />
                {search && (
                  <button className="search-input-clear" onClick={() => setSearch('')} aria-label="Clear search"><X size={12} /></button>
                )}
              </div>
              <select className="filter-select" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1) }}>
                <option value="">All Statuses</option>
                {DUTY_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          {/* Table / Mobile list */}
          {!isMobile ? (
            <EnforcersTable
              loading={loading} filtered={filtered} paginated={paginated} page={page} totalPages={totalPages}
              search={search} onClearSearch={() => setSearch('')} onPageChange={setPage}
              onView={openView} onDeact={setDeactConfirm}
            />
          ) : (
            <EnforcerMobileList
              loading={loading} filtered={filtered} paginated={paginated} page={page} totalPages={totalPages}
              onPageChange={setPage} onView={openView} onDeact={setDeactConfirm}
            />
          )}
        </>
      ) : (
        <TeamScheduling
          enforcers={activeEnforcers} loading={loading}
        />
      )}

      {/* Modals */}
      {viewData && (
        <EnforcerViewModal enforcer={viewData} onClose={() => setViewData(null)} />
      )}

      <EnforcerDeactivateModal enforcer={deactConfirm} onConfirm={confirmDeactivate} onCancel={() => setDeactConfirm(null)} />
    </div>
  )
}