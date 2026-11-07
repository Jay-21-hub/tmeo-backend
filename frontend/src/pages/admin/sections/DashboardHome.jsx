import { useState, useEffect, useCallback } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts'
import {
  FileText, Banknote, Clock, CheckCircle, Users, BarChart3, MapPin, Inbox, PieChart as PieIcon, TrafficCone,
  Trophy,
} from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { colors } from '../../../styles/theme'
import { StatusBadge } from '../../../components/ui/Badge'
import { ErrorState } from '../../../components/ui/States'
import {
  Dash, GreetingBar, KpiCard, Panel, PanelLink, RowSkeleton, ChartTooltip,
} from '../../../components/dashboard/Dashboard'
import { formatDateParts, formatPesoCompact, violationLabel } from '../../../components/dashboard/dashboardUtils'
import {
  pickPanel, LABEL_CUMULATIVE, LABEL_THIS_MONTH, LABEL_ACTIVE_ONLY, LABEL_ACTIVE_THIS_MONTH,
} from '../../../components/dashboard/historicalPanels'

/**
 * Admin dashboard. Every figure comes from GET /api/violations/stats/ and
 * GET /api/violations/ (latest 5). The three headline KPIs (Total OVR, Revenue, Paid)
 * are CUMULATIVE — active + archived, from stats.historical (Admin-only block);
 * Pending Assessment is OPERATIONAL (active cases only), because pending records
 * are never archived. If the backend does not send `historical`, the cards fall
 * back to the active-table figures and are labelled accordingly. Violations by Type, Top Locations
 * (cumulative) and Top Enforcers (this month) also read stats.historical (active + archived,
 * duplicates already removed by the backend); each panel falls back on its own to the
 * active-only top-level list, labelled "archive not included", so a label never over-claims.
 * The Audit Trail has its own page; the
 * dashboard no longer reads audit logs. Nothing is sample data: a section with no
 * data shows an empty state, and a comparison that can't be computed (no
 * previous-week figure) is left out instead of guessed.
 */

const TYPE_COLORS = [colors.blue[600], colors.warning[500], colors.success[500], colors.navy[500], colors.danger[500]]
const OTHER_COLOR = colors.slate[500]

function Empty({ text }) {
  return <div className="dash-empty"><Inbox size={22} aria-hidden="true" style={{ display: 'block', margin: '0 auto 8px' }} />{text}</div>
}

export default function DashboardHome({ user, setPage }) {
  const [stats, setStats] = useState(null)
  const [recent, setRecent] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => (
    Promise.all([
      api.get(API.VIOLATION_STATS),
      api.get(API.VIOLATIONS, { params: { page_size: 5 } }),
    ])
      .then(([s, r]) => {
        setStats(s.data)
        setRecent(Array.isArray(r.data) ? r.data : (r.data.results || []))
        setError('')
      })
      .catch(() => setError('Could not load the dashboard. Check your connection and try again.'))
      .finally(() => setLoading(false))
  ), [])

  useEffect(() => {
    load()
    window.addEventListener('violation-submitted', load)
    return () => window.removeEventListener('violation-submitted', load)
  }, [load])

  const retry = () => { setLoading(true); setError(''); load() }

  const n = (v) => (loading ? '—' : Number(v ?? 0).toLocaleString('en-PH'))

  // Cumulative (all-time, incl. archived) when the backend provides it.
  const hist = stats?.historical || null
  const allTimeSub = hist ? 'All-time, incl. archived' : 'Active records only'

  const daily = stats?.daily_data || []
  const hasTrend = daily.some(d => d.total > 0)

  const typePanel = pickPanel(hist, 'type_data', stats?.type_data, LABEL_CUMULATIVE, LABEL_ACTIVE_ONLY)
  const locPanel = pickPanel(hist, 'hotspots', stats?.hotspots, LABEL_CUMULATIVE, LABEL_ACTIVE_ONLY)
  const enfPanel = pickPanel(hist, 'top_enforcers', stats?.top_enforcers, LABEL_THIS_MONTH, LABEL_ACTIVE_THIS_MONTH)
  const types = typePanel.rows
  const typeTotal = types.reduce((sum, t) => sum + t.count, 0)
  const hotspots = locPanel.rows
  const topEnforcers = enfPanel.rows

  return (
    <Dash>
      <GreetingBar user={user} fallbackName="Admin" subtitle="Here’s an overview of the TMEO traffic management system." />

      {error && <div className="card"><ErrorState message={error} onRetry={retry} /></div>}

      <div className="dash-kpis dash-kpis--5">
        <KpiCard loading={loading} icon={FileText} tone="blue" label="Total OVR Issued"
          value={n(hist ? hist.total : stats?.total)} sub={allTimeSub} />
        <KpiCard loading={loading} icon={Banknote} tone="orange" label="Total Revenue (Fines)"
          value={loading ? '—' : formatPesoCompact(hist ? hist.total_collected : stats?.total_collected)} sub={allTimeSub} />
        <KpiCard loading={loading} icon={Clock} tone="orange" label="Pending Assessment" value={n(stats?.pending)}
          sub="Active cases only" />
        <KpiCard loading={loading} icon={CheckCircle} tone="green" label="Paid Tickets"
          value={n(hist ? hist.paid : stats?.paid)} sub={allTimeSub} />
        <KpiCard loading={loading} icon={Users} tone="purple" label="Active Enforcers" value={n(stats?.active_enforcers)}
          sub={`${n(stats?.on_duty_enforcers)} on duty now`} />
      </div>

      <div className="dash-row dash-row--trio">
        <Panel icon={BarChart3} title="Violations Trend" subtitle="OVRs issued per day"
          action={(
            <div className="dash-legend-inline" aria-hidden="true">
              <span><i style={{ background: colors.blue[600] }} />Total violations</span>
              <span><i style={{ background: colors.success[500] }} />Paid</span>
            </div>
          )}>
          {loading ? <RowSkeleton rows={5} /> : !hasTrend ? <Empty text="No violations in the last 7 days." /> : (
            <ResponsiveContainer width="100%" height={230}>
              <AreaChart data={daily} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="dashTotal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={colors.blue[600]} stopOpacity={0.16} />
                    <stop offset="95%" stopColor={colors.blue[600]} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={colors.slate[100]} vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: colors.slate[500] }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: colors.slate[500] }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="total" name="Total violations" stroke={colors.blue[600]} strokeWidth={2} fill="url(#dashTotal)"
                  dot={{ r: 3, fill: colors.blue[600], strokeWidth: 0 }} />
                <Area type="monotone" dataKey="paid" name="Paid" stroke={colors.success[500]} strokeWidth={2} fill="none"
                  dot={{ r: 3, fill: colors.success[500], strokeWidth: 0 }} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel icon={PieIcon} title="Violations by Type" subtitle={typePanel.label}>
          {loading ? <RowSkeleton rows={5} /> : types.length === 0 ? <Empty text="No violations recorded yet." /> : (
            <div className="dash-donut">
              <div className="dash-donut-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={types} dataKey="count" nameKey="name" innerRadius={48} outerRadius={70} paddingAngle={2} stroke="none">
                      {types.map((t, i) => <Cell key={t.name} fill={t.name === 'Other' ? OTHER_COLOR : TYPE_COLORS[i % TYPE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="dash-donut-center"><strong>{typeTotal.toLocaleString('en-PH')}</strong><span>Total</span></div>
              </div>
              <ul className="dash-legend">
                {types.map((t, i) => (
                  <li key={t.name}>
                    <span style={{ background: t.name === 'Other' ? OTHER_COLOR : TYPE_COLORS[i % TYPE_COLORS.length] }} />
                    <span className="dash-grow" title={t.name}>{t.name}</span>
                    <strong>{t.count}</strong>
                    <em>{typeTotal ? Math.round((t.count / typeTotal) * 100) : 0}%</em>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <Panel icon={MapPin} title="Top Locations" subtitle={locPanel.label}
          action={<PanelLink onClick={() => setPage('gis')}>View map</PanelLink>}>
          {loading ? <RowSkeleton rows={5} /> : hotspots.length === 0 ? <Empty text="No location data yet." /> : (
            <ol className="dash-list">
              {hotspots.map((h, i) => (
                <li key={h.area}>
                  <span className="dash-rank">{i + 1}</span>
                  <span className="dash-pin" aria-hidden="true"><MapPin size={13} /></span>
                  <span className="dash-grow"><span className="dash-name" style={{ display: 'block' }} title={h.area}>{h.area}</span></span>
                  <span className="dash-num">{h.count}</span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>

      <div className="dash-row dash-row--duo">
        <Panel icon={TrafficCone} title="Recent OVRs" flush action={<PanelLink onClick={() => setPage('violations')}>View all</PanelLink>}>
          {loading ? <RowSkeleton rows={5} /> : recent.length === 0 ? <Empty text="No OVRs have been issued yet." /> : (
            <>
              <div className="dash-table-wrap">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>Date &amp; Time</th>
                      <th className="dash-hide-sm">Enforcer</th>
                      <th className="dash-hide-md">Location</th>
                      <th>Violation Type</th>
                      <th className="dash-hide-xl">Plate Number</th>
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
                          <td className="dash-hide-sm"><div className="dash-clip">{v.enforcer_name || '—'}</div></td>
                          <td className="dash-hide-md"><div className="dash-clip" title={v.location}>{v.location || '—'}</div></td>
                          <td><div className="dash-clip">{violationLabel(v.violation_types)}</div></td>
                          <td className="dash-hide-xl mono">{v.plate_number || '—'}</td>
                          <td><StatusBadge status={v.status} /></td>
                          <td className="dash-act"><button type="button" className="btn btn-primary btn-sm" onClick={() => setPage('violations')}>View</button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {/* Narrow-width form of the same rows (see .dash-cards). */}
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
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => setPage('violations')}>View</button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </Panel>

        <Panel icon={Trophy} title="Top Performing Enforcers" subtitle={enfPanel.label}>
          {loading ? <RowSkeleton rows={5} /> : topEnforcers.length === 0 ? <Empty text="No OVRs issued this month yet." /> : (
            <ol className="dash-list">
              {topEnforcers.map((e, i) => (
                <li key={e.id ?? i}>
                  <span className="dash-rank">{i + 1}</span>
                  <span className="dash-pin" aria-hidden="true"><Trophy size={13} /></span>
                  <span className="dash-grow">
                    <span className="dash-name" style={{ display: 'block' }} title={e.name}>{e.name}</span>
                    <span className="dash-sub">{e.badge ? `Badge ${e.badge}` : 'No badge on file'}</span>
                  </span>
                  <span className="dash-num">{e.tickets}</span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </Dash>
  )
}