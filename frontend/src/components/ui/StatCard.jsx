import { TrendingUp, TrendingDown } from 'lucide-react'

/**
 * Canonical KPI stat card. This is the ONLY StatCard in the app —
 * every dashboard/section imports this instead of redefining its own.
 *
 * props:
 *  label     - eyebrow text
 *  value     - main number/string
 *  icon      - lucide icon component
 *  accent    - token color string, e.g. 'var(--blue-600)'
 *  sublabel  - small caption under the value
 *  trend     - optional number (e.g. 4.2 or -2.1) rendered with an arrow
 *  loading   - shows skeleton state
 */
export default function StatCard({ label, value, icon: Icon, accent = 'var(--blue-600)', sublabel, trend, loading = false }) {
  if (loading) {
    return (
      <div className="card card-padded">
        <div className="skeleton" style={{ height: 11, width: '55%', marginBottom: 14 }} />
        <div className="skeleton" style={{ height: 30, width: '40%' }} />
      </div>
    )
  }

  const trendUp = typeof trend === 'number' && trend >= 0
  const TrendIcon = trendUp ? TrendingUp : TrendingDown

  return (
    <div className="card card-padded card-interactive">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <span className="text-label">{label}</span>
        {Icon && (
          <span
            style={{
              width: 32, height: 32, borderRadius: 'var(--radius-md)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: `color-mix(in srgb, ${accent} 12%, white)`, color: accent, flexShrink: 0,
            }}
            aria-hidden="true"
          >
            <Icon size={16} strokeWidth={2.2} />
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span className="text-display" style={{ fontSize: 28 }}>{value ?? 0}</span>
        {typeof trend === 'number' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 12, fontWeight: 700, color: trendUp ? 'var(--success-600)' : 'var(--danger-600)' }}>
            <TrendIcon size={12} strokeWidth={2.5} />
            {Math.abs(trend)}%
          </span>
        )}
      </div>
      {sublabel && <div className="text-caption" style={{ marginTop: 4 }}>{sublabel}</div>}
    </div>
  )
}