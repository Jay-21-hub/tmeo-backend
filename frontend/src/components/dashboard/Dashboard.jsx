import { ArrowUp, ArrowDown } from 'lucide-react'
import { firstNameOf, greetingFor } from './dashboardUtils'
import './Dashboard.css'

/** Wrapper that turns on the container-query layout (see Dashboard.css). */
export function Dash({ children }) {
  return <div className="dash">{children}</div>
}

export function GreetingBar({ user, subtitle, fallbackName, action }) {
  return (
    <div className="dash-greet">
      <div>
        <h1>{greetingFor()}, {firstNameOf(user, fallbackName)}!</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </div>
  )
}

/**
 * KPI card: tinted icon tile, label, big value, one line of context.
 * `delta` = whole-number % (or null/undefined to show nothing) with
 * `deltaLabel` explaining what it compares.
 */
export function KpiCard({ icon, tone = 'blue', label, value, sub, delta, deltaLabel, loading }) {
  if (loading) {
    return (
      <div className="dash-kpi">
        <div className="skeleton" style={{ width: 44, height: 44, borderRadius: 12 }} />
        <div style={{ flex: 1 }}>
          <div className="skeleton" style={{ height: 11, width: '60%', marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 26, width: '45%' }} />
        </div>
      </div>
    )
  }
  const Icon = icon
  const hasDelta = typeof delta === 'number'
  const up = hasDelta && delta >= 0
  const DeltaIcon = up ? ArrowUp : ArrowDown
  return (
    <div className="dash-kpi">
      <span className={`dash-kpi-icon dash-tone-${tone}`} aria-hidden="true"><Icon size={20} strokeWidth={2.1} /></span>
      <div className="dash-kpi-body">
        <span className="dash-kpi-label">{label}</span>
        <span className="dash-kpi-value">{value}</span>
        {hasDelta ? (
          <span className={`dash-kpi-sub ${up ? 'is-up' : 'is-down'}`}>
            <DeltaIcon size={12} strokeWidth={2.6} aria-hidden="true" /> {Math.abs(delta)}%
            <span className="dash-kpi-sub-muted">{deltaLabel}</span>
          </span>
        ) : sub ? <span className="dash-kpi-sub dash-kpi-sub-muted">{sub}</span> : null}
      </div>
    </div>
  )
}

/** Card with the icon-tile title used across the redesigned dashboards. */
export function Panel({ icon, title, subtitle, action, flush = false, className = '', children }) {
  const Icon = icon
  return (
    <section className={`card dash-panel ${className}`}>
      <header className="dash-panel-head">
        <div className="dash-panel-title">
          {Icon && <span className="dash-panel-icon" aria-hidden="true"><Icon size={16} strokeWidth={2.1} /></span>}
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
        </div>
        {action}
      </header>
      <div className={flush ? 'dash-panel-body is-flush' : 'dash-panel-body'}>{children}</div>
    </section>
  )
}

export function PanelLink({ children, onClick }) {
  return <button type="button" className="dash-link" onClick={onClick}>{children}</button>
}

/** A row of skeleton lines for tables/lists while loading. */
export function RowSkeleton({ rows = 4 }) {
  return (
    <div className="dash-skel">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 14, width: `${88 - (i % 3) * 12}%` }} />
      ))}
    </div>
  )
}

/** Recharts tooltip matching the app's card style. */
export function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="card dash-tooltip">
      <div className="dash-tooltip-title">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="dash-tooltip-row">
          <span style={{ background: p.color || p.payload?.fill }} />
          {p.name}: <strong>{p.value}</strong>
        </div>
      ))}
    </div>
  )
}