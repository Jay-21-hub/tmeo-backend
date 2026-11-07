import { useState, useEffect, useCallback } from 'react'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { FileText, Clock, BarChart3, ClipboardList, Inbox, Send } from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { colors } from '../../../styles/theme'
import { StatusBadge } from '../../../components/ui/Badge'
import { ErrorState } from '../../../components/ui/States'
import {
  Dash, GreetingBar, KpiCard, Panel, PanelLink, RowSkeleton, ChartTooltip,
} from '../../../components/dashboard/Dashboard'
import { formatDateParts, violationLabel } from '../../../components/dashboard/dashboardUtils'

/**
 * Enforcer dashboard for tablets and desktops (phones get EnforcerHome, the
 * field-first app screen). Same data rules as EnforcerHome: counts come from
 * GET /api/violations/stats/ (scoped by the backend to THIS enforcer), the
 * list from GET /api/violations/ (also scoped) — never from one paginated
 * page, never sample data.
 *
 * Deliberately not here: fines collected and approved counts (those are
 * Staff/Admin concerns), other enforcers' locations, and the Settings/Help
 * links — the system has no such pages.
 */
export default function EnforcerHomeDesktop({ user, setPage }) {
  const [stats, setStats] = useState(null)
  const [recent, setRecent] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => (
    Promise.all([
      api.get(API.VIOLATION_STATS),
      api.get(API.VIOLATIONS, { params: { page_size: 8 } }),
    ])
      .then(([s, r]) => {
        setStats(s.data)
        setRecent(Array.isArray(r.data) ? r.data : (r.data.results || []))
        setError('')
      })
      .catch(() => setError('Could not load your reports. Check your connection and try again.'))
      .finally(() => setLoading(false))
  ), [])

  useEffect(() => {
    load()
    window.addEventListener('violation-submitted', load)
    return () => window.removeEventListener('violation-submitted', load)
  }, [load])

  const retry = () => { setLoading(true); setError(''); load() }
  const n = (v) => (loading ? '—' : Number(v ?? 0).toLocaleString('en-PH'))

  const weekly = stats?.weekly_data || []
  const hasTrend = weekly.some(d => d.count > 0)

  return (
    <Dash>
      <GreetingBar user={user} fallbackName="Enforcer" subtitle="Here’s your enforcement overview for today."
        action={(
          <button type="button" className="btn btn-primary" onClick={() => setPage('issue-ovr')}>
            <Send size={16} aria-hidden="true" /> Issue OVR
          </button>
        )} />

      {error && <div className="card"><ErrorState message={error} onRetry={retry} /></div>}

      <div className="dash-kpis dash-kpis--2">
        <KpiCard loading={loading} icon={FileText} tone="blue" label="Total Reports" value={n(stats?.total)}
          sub={`${n(stats?.today)} filed today`} />
        <KpiCard loading={loading} icon={Clock} tone="orange" label="Pending Assessment" value={n(stats?.pending)}
          sub="Waiting for Staff to assess" />
      </div>

      <Panel icon={BarChart3} title="Reports Overview" subtitle="Your OVRs issued per day, last 7 days"
        action={<div className="dash-legend-inline" aria-hidden="true"><span><i style={{ background: colors.blue[600] }} />Total reports</span></div>}>
        {loading ? <RowSkeleton rows={5} /> : !hasTrend ? (
          <div className="dash-empty"><Inbox size={22} aria-hidden="true" style={{ display: 'block', margin: '0 auto 8px' }} />You haven’t issued any OVRs in the last 7 days.</div>
        ) : (
          <ResponsiveContainer width="100%" height={230}>
            <AreaChart data={weekly} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="enfTotal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={colors.blue[600]} stopOpacity={0.16} />
                  <stop offset="95%" stopColor={colors.blue[600]} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={colors.slate[100]} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: colors.slate[500] }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: colors.slate[500] }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="count" name="Total reports" stroke={colors.blue[600]} strokeWidth={2} fill="url(#enfTotal)"
                dot={{ r: 3, fill: colors.blue[600], strokeWidth: 0 }} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Panel>

      <Panel icon={ClipboardList} title="Recent Reports" subtitle="Your latest OVRs" flush
        action={<PanelLink onClick={() => setPage('reports')}>View all</PanelLink>}>
        {loading ? <RowSkeleton rows={5} /> : recent.length === 0 ? (
          <div className="dash-empty"><Inbox size={22} aria-hidden="true" style={{ display: 'block', margin: '0 auto 8px' }} />No OVRs yet. Use Issue OVR to record your first one.</div>
        ) : (
          <>
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Date &amp; Time</th>
                  <th className="dash-hide-md">Location</th>
                  <th>Violation Type</th>
                  <th className="dash-hide-lg">Plate Number</th>
                  <th>Status</th>
                  <th className="dash-act"><span className="dash-sr">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {recent.map(v => {
                  const when = formatDateParts(v.date_issued)
                  return (
                    <tr key={v.id}>
                      <td><div className="dash-when"><span>{when.date}</span><span>{when.time}</span></div></td>
                      <td className="dash-hide-md"><div className="dash-clip" title={v.location}>{v.location || '—'}</div></td>
                      <td><div className="dash-clip">{violationLabel(v.violation_types)}</div></td>
                      <td className="dash-hide-lg mono">{v.plate_number || '—'}</td>
                      <td><StatusBadge status={v.status} /></td>
                      <td className="dash-act"><button type="button" className="btn btn-primary btn-sm" onClick={() => setPage('reports')}>View</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {/* Narrow-width form of the same rows (tablet rail / small windows). */}
          <ul className="dash-cards">
            {recent.map(v => {
              const when = formatDateParts(v.date_issued)
              return (
                <li key={v.id} className="dash-card-row">
                  <div className="dash-card-main">
                    <span className="dash-card-title">{violationLabel(v.violation_types)}</span>
                    <span className="dash-card-meta">
                      <span>{when.date} {when.time}</span>
                      {v.plate_number && <span className="mono">{v.plate_number}</span>}
                      {v.location && <span>{v.location}</span>}
                    </span>
                  </div>
                  <div className="dash-card-side">
                    <StatusBadge status={v.status} />
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => setPage('reports')}>View</button>
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