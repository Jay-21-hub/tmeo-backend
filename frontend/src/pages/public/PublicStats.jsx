import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { fetchPublicStats } from '../../services/publicApi'
import { ErrorState, LoadingRows } from '../../components/ui'
import useCountUp from './useCountUp'
import { prefersReducedMotion, useInViewOnce } from './useReveal'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const TIP = { background: '#08152b', border: '1px solid rgba(255,255,255,.2)', borderRadius: 2, color: '#fff', fontSize: 13 }
const AXIS = { fill: '#aab6c8', fontSize: 12 }
const fine = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 })}`
const shortN = (n) => (s) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Presentation-only: true on phones, so the by-type axis gives its bars more room. */
const NARROW_MQ = '(max-width: 639px)'
const subscribeNarrow = (cb) => { const m = window.matchMedia(NARROW_MQ); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) }
const useNarrow = () => useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW_MQ).matches, () => false)

/** Presentation-only: animates 0 -> the already-fetched number once in view; always ends on the exact value. */
function CountUp({ value }) {
  const [ref, shown] = useCountUp(Number(value) || 0)
  return <span ref={ref}>{shown.toLocaleString()}</span>
}

/** Reserves the chart's height until the figure is first in view, so the bar entrance plays on screen (no layout shift). */
function ChartSlot({ height, children }) {
  const [ref, inView] = useInViewOnce({ threshold: 0.2 })
  return <div ref={ref} style={{ minHeight: height }}>{inView ? children : null}</div>
}

/**
 * Public-safe aggregates only (see PublicViolationStatsView). The year switch filters
 * the monthly chart from real by_month rows. Violation-type data is all-time only —
 * the API has no per-year type breakdown, so it is labelled as such rather than faked.
 */
export default function PublicStats() {
  const [state, setState] = useState({ loading: true, error: false, data: null })
  const [year, setYear] = useState(null)
  const [selMonth, setSelMonth] = useState(null)
  const [selType, setSelType] = useState(null)
  const narrow = useNarrow()

  const load = () => {
    setState({ loading: true, error: false, data: null })
    fetchPublicStats()
      .then((data) => setState({ loading: false, error: false, data }))
      .catch(() => setState({ loading: false, error: true, data: null }))
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount pattern used across the codebase
    load()
  }, [])

  const data = state.data
  const years = useMemo(() => {
    if (!data) return []
    const ys = new Set((data.by_month || []).map((m) => Number(m.month.slice(0, 4))))
    ys.add(data.current_year)
    return [...ys].sort((a, b) => b - a)
  }, [data])
  const activeYear = year ?? data?.current_year

  const monthData = useMemo(() => {
    if (!data) return []
    return MONTHS.map((label, i) => {
      const row = data.by_month.find((m) => m.month === `${activeYear}-${String(i + 1).padStart(2, '0')}`)
      return { label, count: row ? row.count : 0 }
    })
  }, [data, activeYear])

  if (state.loading) return <div className="pub-state"><LoadingRows rows={4} /></div>
  if (state.error || !data) {
    return <div className="pub-state"><ErrorState title="Unable to load violation statistics" message="Please try again later." onRetry={load} /></div>
  }

  const { total_all_time, total_this_year, total_last_year, total_this_month, most_common_violation, most_common_share, by_type } = data
  const typeData = by_type.slice(0, 8).map((t) => ({ label: t.violation_type, count: t.count, fines: t.total_fines }))
  const chartH = Math.max(280, typeData.length * 38) // both charts share one height so the two panels end flush
  const yoy = total_last_year > 0 ? Math.round(((total_this_year - total_last_year) / total_last_year) * 100) : null
  const yearTotal = monthData.reduce((s, m) => s + m.count, 0)
  const reduceMotion = prefersReducedMotion()
  const sel = selMonth != null ? monthData[selMonth] : null
  const selT = selType != null ? typeData[selType] : null

  return (
    <div>
      <div className="pub-year" role="group" aria-label="Select year for the monthly chart" style={{ marginBottom: 24 }}>
        {years.map((y) => (
          <button key={y} type="button" aria-pressed={y === activeYear} onClick={() => { setYear(y); setSelMonth(null) }}>{y}</button>
        ))}
      </div>

      <div className="pub-kpis">
        <div className="pub-kpi rv"><div className="pub-kpi-l">Total Historical Violations</div><div className="pub-kpi-v"><CountUp value={total_all_time} /></div></div>
        <div className="pub-kpi rv" style={{ '--d': '90ms' }}><div className="pub-kpi-l">This Year</div><div className="pub-kpi-v"><CountUp value={total_this_year} /></div>
          {yoy !== null && <div className="pub-kpi-n">{yoy >= 0 ? '+' : ''}{yoy}% vs. same period last year</div>}</div>
        <div className="pub-kpi rv" style={{ '--d': '180ms' }}><div className="pub-kpi-l">This Month</div><div className="pub-kpi-v"><CountUp value={total_this_month} /></div></div>
        <div className="pub-kpi rv" style={{ '--d': '270ms' }}><div className="pub-kpi-l">Most Common Violation</div><div className="pub-kpi-v pub-kpi-v--t">{most_common_violation || '—'}</div>
          {most_common_violation && most_common_share > 0 && <div className="pub-kpi-n">{most_common_share}% of recorded violations</div>}</div>
      </div>

      <div className="pub-charts">
        <figure className="pub-chart rv" style={{ margin: 0 }}>
          <h3>Violations by Month</h3>
          <p>{activeYear} · {yearTotal.toLocaleString()} finalized records. Select a bar for its count.</p>
          {yearTotal === 0 ? <p>No finalized records for {activeYear}.</p> : (
            <ChartSlot height={chartH}><div role="img" aria-label={`Bar chart of violations per month in ${activeYear}`}>
              <ResponsiveContainer width="100%" height={chartH}>
                <BarChart data={monthData} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,.1)" vertical={false} />
                  <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={TIP} cursor={{ fill: 'rgba(226,169,59,.12)' }} formatter={(v) => [v, 'Violations']} />
                  <Bar dataKey="count" radius={[2, 2, 0, 0]} isAnimationActive={!reduceMotion} animationDuration={700} animationEasing="ease-out" onClick={(_, i) => setSelMonth((p) => (p === i ? null : i))} cursor="pointer">
                    {monthData.map((_, i) => <Cell key={i} fill={selMonth == null || selMonth === i ? '#e2a93b' : 'rgba(226,169,59,.35)'} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div></ChartSlot>
          )}
          <div className="pub-chart-sel" aria-live="polite">{sel ? `${sel.label} ${activeYear}: ${sel.count} violation${sel.count === 1 ? '' : 's'}` : ''}</div>
          <table className="pub-sr"><caption>Violations by month, {activeYear}</caption><tbody>
            {monthData.map((m) => <tr key={m.label}><th scope="row">{m.label}</th><td>{m.count}</td></tr>)}</tbody></table>
        </figure>

        <figure className="pub-chart rv" style={{ margin: 0, '--d': '120ms' }}>
          <h3>Violations by Type</h3>
          <p>All time · most frequently recorded types.</p>
          {typeData.length === 0 ? <p>No historical data available yet.</p> : (
            <ChartSlot height={chartH}><div role="img" aria-label="Bar chart of violation counts by type">
              <ResponsiveContainer width="100%" height={chartH}>
                <BarChart data={typeData} layout="vertical" margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,.1)" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="label" width={narrow ? 112 : 152} tick={AXIS} tickFormatter={shortN(narrow ? 16 : 20)} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={TIP} cursor={{ fill: 'rgba(226,169,59,.12)' }} formatter={(v) => [v, 'Violations']}
                    labelFormatter={(l, p) => (p?.[0]?.payload?.fines ? `${l} — total fines ${fine(p[0].payload.fines)}` : l)} />
                  <Bar dataKey="count" radius={[0, 2, 2, 0]} isAnimationActive={!reduceMotion} animationDuration={700} animationEasing="ease-out" onClick={(_, i) => setSelType((p) => (p === i ? null : i))} cursor="pointer">
                    {typeData.map((_, i) => <Cell key={i} fill={selType == null || selType === i ? '#e2a93b' : 'rgba(226,169,59,.35)'} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div></ChartSlot>
          )}
          <div className="pub-chart-sel" aria-live="polite">{selT ? `${selT.label}: ${selT.count} · ${fine(selT.fines)} in fines` : ''}</div>
          <table className="pub-sr"><caption>Violations by type, all time</caption><tbody>
            {typeData.map((t) => <tr key={t.label}><th scope="row">{t.label}</th><td>{t.count}</td></tr>)}</tbody></table>
        </figure>
      </div>
    </div>
  )
}