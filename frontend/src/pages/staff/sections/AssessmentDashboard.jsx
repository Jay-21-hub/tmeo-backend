import { useState, useEffect, useCallback } from 'react'
import {
  Clock, Loader, CheckCircle, ClipboardList, Lock,
} from 'lucide-react'
import api from '../../../services/api'
import useAuth from '../../../hooks/useAuth'
import useViolationPolling from '../../../hooks/useViolationPolling'
import { ErrorState } from '../../../components/ui/States'
import {
  Dash, GreetingBar, KpiCard, Panel, PanelLink, RowSkeleton,
} from '../../../components/dashboard/Dashboard'
import { formatDateParts, violationLabel } from '../../../components/dashboard/dashboardUtils'

/**
 * Assessment Staff dashboard. Data: GET /api/violations/staff-dashboard/.
 *
 * The queue is the main surface. `recent_actions` is still returned by the
 * endpoint (it is the same payload) but is no longer shown here.
 *
 * Only the statuses Staff act on are shown: Pending Assessment, In
 * Processing and Paid. There is no separate "Assessed"/"Approved"
 * workload — "Mark as Paid" does the assessment, ticket generation and
 * payment in a single step straight from Processing.
 */

function Empty({ icon, text }) {
  const Icon = icon
  return <div className="dash-empty"><Icon size={22} aria-hidden="true" style={{ display: 'block', margin: '0 auto 8px' }} />{text}</div>
}

function QueueAction({ item, currentUserId, onProcess }) {
  const lockedByOther = item.status === 'processing' && item.locked_by_id && item.locked_by_id !== currentUserId
  const lockedByMe = item.status === 'processing' && item.locked_by_id === currentUserId
  if (lockedByOther) {
    return (
      <span className="badge badge-neutral" title={`${item.locked_by_name || 'Another staff member'} is assessing this`} style={{ cursor: 'not-allowed' }}>
        <Lock size={11} aria-hidden="true" /> Locked
      </span>
    )
  }
  return (
    <button type="button" className="btn btn-primary btn-sm" onClick={() => onProcess(item)}>
      {lockedByMe ? 'Resume' : 'Assess'}
    </button>
  )
}

export default function AssessmentDashboard({ user, onProcess, onNavigate }) {
  const { user: authUser } = useAuth()
  const currentUser = authUser || user
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchDashboard = useCallback(() => (
    api.get('/api/violations/staff-dashboard/')
      .then(res => { setData(res.data); setError('') })
      .catch(() => setError('Could not load the dashboard. Check your connection and try again.'))
      .finally(() => setLoading(false))
  ), [])

  useEffect(() => { fetchDashboard() }, [fetchDashboard])

  // Near-real-time: any lock/status change anywhere refreshes the numbers quietly.
  // Returns the request's promise so the poller never overlaps itself.
  const silentRefresh = useCallback(() => (
    api.get('/api/violations/staff-dashboard/').then(res => setData(res.data)).catch(() => {})
  ), [])
  useViolationPolling(silentRefresh)

  const retry = () => { setLoading(true); setError(''); fetchDashboard() }
  const n = (v) => (loading ? '—' : Number(v ?? 0).toLocaleString('en-PH'))
  const go = (page) => onNavigate?.(page)

  const queue = data?.pending_queue || []

  return (
    <Dash>
      <GreetingBar user={currentUser} fallbackName="Staff" subtitle="Here’s your assessment overview for today." />

      {error && <div className="card"><ErrorState message={error} onRetry={retry} /></div>}

      <div className="dash-kpis dash-kpis--3">
        <KpiCard loading={loading} icon={Clock} tone="orange" label="Pending Assessment" value={n(data?.pending_count)} sub="Waiting to be assessed" />
        <KpiCard loading={loading} icon={Loader} tone="blue" label="In Processing" value={n(data?.processing_count)} sub="Being assessed right now" />
        <KpiCard loading={loading} icon={CheckCircle} tone="green" label="Paid" value={n(data?.paid_count)} sub="Payment recorded" />
      </div>

      <Panel icon={ClipboardList} title="Assessment Queue" subtitle="OVRs waiting for assessment" flush
        action={<PanelLink onClick={() => go('pending')}>View all</PanelLink>}>
        {loading ? <RowSkeleton rows={5} /> : queue.length === 0 ? <Empty icon={CheckCircle} text="All clear. Nothing is waiting for assessment." /> : (
          <>
            <div className="dash-table-wrap">
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>Date &amp; Time</th>
                    <th className="dash-hide-sm">Enforcer</th>
                    <th className="dash-hide-md">Location</th>
                    <th>Violation Type</th>
                    <th className="dash-hide-lg">Plate Number</th>
                    <th className="dash-act"><span className="dash-sr">Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map(item => {
                    const when = formatDateParts(item.date_issued)
                    return (
                      <tr key={item.id}>
                        <td><div className="dash-when"><span>{when.date}</span><span>{when.time}</span></div></td>
                        <td className="dash-hide-sm"><div className="dash-clip">{item.enforcer_name || '—'}</div></td>
                        <td className="dash-hide-md"><div className="dash-clip" title={item.location}>{item.location || '—'}</div></td>
                        <td><div className="dash-clip">{violationLabel(item.items)}</div></td>
                        <td className="dash-hide-lg mono">{item.plate_number || '—'}</td>
                        <td className="dash-act"><QueueAction item={item} currentUserId={currentUser?.id} onProcess={onProcess || (() => {})} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {/* Narrow-width form of the same rows — same data, same QueueAction. */}
            <ul className="dash-cards">
              {queue.map(item => {
                const when = formatDateParts(item.date_issued)
                return (
                  <li key={item.id} className="dash-card-row">
                    <div className="dash-card-main">
                      <span className="dash-card-title">{violationLabel(item.items)}</span>
                      <span className="dash-card-meta">
                        <span>{when.date} {when.time}</span>
                        {item.plate_number && <span className="mono">{item.plate_number}</span>}
                        {item.location && <span>{item.location}</span>}
                        {item.enforcer_name && <span>{item.enforcer_name}</span>}
                      </span>
                    </div>
                    <div className="dash-card-side">
                      <QueueAction item={item} currentUserId={currentUser?.id} onProcess={onProcess || (() => {})} />
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </Panel>
    </Dash>
  )
}