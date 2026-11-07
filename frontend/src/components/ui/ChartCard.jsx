import { BarChart3 } from 'lucide-react'

/**
 * ChartCard — the container every Analytics chart (line/bar/donut) sits
 * in: title, optional subtitle, an action slot (e.g. a period filter),
 * and an honest empty state.
 *
 * Per the MASTER PROMPT (Part 15 / Part 25 Phase 8), a chart must never
 * imply data exists when it doesn't — pass `isEmpty` and an
 * `emptyMessage` (e.g. "Insufficient historical data for forecasting.")
 * rather than rendering a chart against zeros.
 *
 * props:
 *  title, subtitle, action
 *  height       - chart area height in px (default 280)
 *  loading      - shows a skeleton block instead of children
 *  isEmpty      - shows emptyMessage instead of children
 *  emptyMessage - defaults to a generic "not enough data" line
 */
export default function ChartCard({
  title, subtitle, action, height = 280, loading = false, isEmpty = false,
  emptyMessage = 'Not enough data to show this yet.', children,
}) {
  return (
    <div className="card card-padded chart-card">
      <div className="chart-card-header">
        <div>
          {title && <div className="text-h3">{title}</div>}
          {subtitle && <div className="text-caption" style={{ marginTop: 2 }}>{subtitle}</div>}
        </div>
        {action}
      </div>

      <div style={{ height }}>
        {loading ? (
          <div className="skeleton" style={{ width: '100%', height: '100%' }} />
        ) : isEmpty ? (
          <div className="empty-state" style={{ height: '100%', padding: 'var(--space-6)' }}>
            <span className="empty-state-icon"><BarChart3 size={22} aria-hidden="true" /></span>
            <p className="text-caption">{emptyMessage}</p>
          </div>
        ) : children}
      </div>
    </div>
  )
}