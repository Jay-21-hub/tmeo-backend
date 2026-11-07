import { useState, useEffect, useCallback } from 'react'
import {
  FileText, Clock, Loader, Camera, Send, CalendarCheck, ClipboardList,
  ChevronRight, MapPin, RefreshCw,
} from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { StatusBadge } from '../../../components/ui/Badge'
import { EmptyState, ErrorState } from '../../../components/ui/States'
import { manilaHour } from '../../../utils/helpers'

/**
 * EnforcerHome — the field-first landing screen for a Traffic Enforcer
 * (phones only; tablets/desktops use EnforcerHomeDesktop).
 *
 * Order is the order of use in the field: the one primary action (Issue OVR),
 * quick access to My Reports / Camera Evidence / GPS, a compact overview,
 * then the latest reports.
 *
 * Data rules (unchanged):
 *  - Counts come from GET /api/violations/stats/, which the backend scopes
 *    to THIS enforcer's own records. They must never be derived from a
 *    paginated list: /api/violations/ returns 10 rows per page, so a
 *    list-derived "Total" silently caps at 10.
 *  - "Issued today" is stats.today — a real backend count (Manila date).
 *    It is a single KPI, not an activity feed.
 *  - Row fields follow ViolationListSerializer: `violation_types` (an
 *    array of {id, name, code}) and `date_issued`.
 *  - The assigned area and duty status are shown by the shell's duty strip
 *    (EnforcerShell), so they are not repeated here.
 */

/* ── Greeting ── */
function Greeting({ user }) {
  const hour = manilaHour()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const firstName = user?.full_name?.split(' ')[0] || 'Enforcer'
  const today = new Date().toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila', weekday: 'long', month: 'long', day: 'numeric',
  })
  return (
    <div className="eh-greet">
      <h1>{greeting}, {firstName}</h1>
      <p>{today}</p>
    </div>
  )
}

/* ── Primary + quick field actions ── */
function QuickActions({ setPage }) {
  return (
    <div className="eh-actions">
      <button type="button" className="eh-action eh-action--primary" onClick={() => setPage('issue-ovr')}>
        <span className="eh-action-icon"><Send size={22} strokeWidth={2.2} aria-hidden="true" /></span>
        <span className="eh-action-text">
          <span className="eh-action-title">Issue OVR</span>
          <span className="eh-action-sub">Record a violation in the field</span>
        </span>
        <ChevronRight size={20} aria-hidden="true" />
      </button>

      <div className="eh-quick">
        <button type="button" className="eh-action eh-action--secondary" onClick={() => setPage('reports')}>
          <span className="eh-action-icon"><FileText size={19} strokeWidth={2.1} aria-hidden="true" /></span>
          <span className="eh-action-title">My Reports</span>
        </button>
        <button type="button" className="eh-action eh-action--secondary" onClick={() => setPage('evidence')}>
          <span className="eh-action-icon"><Camera size={19} strokeWidth={2.1} aria-hidden="true" /></span>
          <span className="eh-action-title">Evidence</span>
        </button>
        <button type="button" className="eh-action eh-action--secondary" onClick={() => setPage('gps')}>
          <span className="eh-action-icon"><MapPin size={19} strokeWidth={2.1} aria-hidden="true" /></span>
          <span className="eh-action-title">GPS</span>
        </button>
      </div>
    </div>
  )
}

/* ── Overview — backend counts, never page-derived ── */
function Overview({ stats, loading }) {
  const cards = [
    { label: 'Issued today', value: stats?.today, icon: CalendarCheck, tone: 'gold' },
    { label: 'Total reports', value: stats?.total, icon: FileText, tone: 'navy' },
    { label: 'Pending', value: stats?.pending, icon: Clock, tone: 'amber' },
    { label: 'Processing', value: stats?.processing, icon: Loader, tone: 'green' },
  ]
  return (
    <section className="eh-section" aria-label="Overview">
      <p className="eh-section-title">Overview</p>
      <div className="eh-kpis">
        {cards.map(({ label, value, icon, tone }) => {
          // `const Icon = icon` — the ESLint config has no jsx-uses-vars rule.
          const Icon = icon
          return (
            <div key={label} className="eh-kpi">
              <span className={`eh-kpi-icon eh-kpi-icon--${tone}`} aria-hidden="true"><Icon size={17} strokeWidth={2.2} /></span>
              <div>
                <div className="eh-kpi-value">{loading ? '—' : (value ?? 0)}</div>
                <div className="eh-kpi-label">{label}</div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/* ── Latest reports by this enforcer ── */
function RecentReports({ items, loading, setPage }) {
  return (
    <section className="eh-section" aria-label="Recent reports">
      <div className="eh-section-head">
        <p className="eh-section-title">Recent reports</p>
        <button type="button" className="eh-link-btn" onClick={() => setPage('reports')}>
          View all <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card card-padded" style={{ padding: 12 }}>
              <div className="skeleton" style={{ height: 13, width: '60%', marginBottom: 8 }} />
              <div className="skeleton" style={{ height: 11, width: '40%' }} />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={ClipboardList}
            title="No OVRs yet."
            message="Tap Issue OVR to record a violation."
          />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((v) => {
            const types = (v.violation_types || []).map(t => t.name).filter(Boolean)
            const typeLabel = types.length === 0 ? '—'
              : types.length === 1 ? types[0]
              : `${types[0]} +${types.length - 1}`
            const when = v.date_issued
              ? new Date(v.date_issued).toLocaleString('en-PH', {
                  timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })
              : '—'
            return (
              <button key={v.id} type="button" className="eh-row" onClick={() => setPage('reports')}>
                <span className="eh-row-main">
                  <span className="eh-row-title">{v.violator_name || '—'}</span>
                  <span className="eh-row-meta">
                    <span className="mono">{v.plate_number || '—'}</span>
                    <span aria-hidden="true">·</span>
                    <span className="eh-row-type">{typeLabel}</span>
                    <span aria-hidden="true">·</span>
                    <span>{when}</span>
                  </span>
                </span>
                <StatusBadge status={v.status} />
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

export default function EnforcerHome({ user, setPage }) {
  const [stats, setStats] = useState(null)
  const [recent, setRecent] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // fetch() never calls setState synchronously — only inside promise
  // callbacks — so it is safe both on mount and from the Retry/Refresh
  // buttons without triggering cascading renders.
  const load = useCallback(() => (
    Promise.all([
      api.get(API.VIOLATION_STATS),
      api.get(API.VIOLATIONS, { params: { page_size: 5 } }),
    ])
      .then(([statsRes, listRes]) => {
        setStats(statsRes.data)
        setRecent(Array.isArray(listRes.data) ? listRes.data : (listRes.data.results || []))
        setError('')
      })
      .catch(() => setError('Could not load your reports. Check your connection and try again.'))
      .finally(() => setLoading(false))
  ), [])

  useEffect(() => {
    load()
    // Same refresh trigger the desktop dashboard uses after an OVR is filed.
    window.addEventListener('violation-submitted', load)
    return () => window.removeEventListener('violation-submitted', load)
  }, [load])

  const reload = () => { setLoading(true); load() }

  return (
    <div className="eh-home">
      <Greeting user={user} />
      <QuickActions setPage={setPage} />

      {error ? (
        <div className="card" style={{ marginBottom: 20 }}>
          <ErrorState message={error} onRetry={reload} />
        </div>
      ) : (
        <Overview stats={stats} loading={loading} />
      )}

      <RecentReports items={recent} loading={loading} setPage={setPage} />

      {!loading && !error && (
        <button type="button" className="eh-link-btn" style={{ marginTop: 10 }} onClick={reload}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
      )}
    </div>
  )
}