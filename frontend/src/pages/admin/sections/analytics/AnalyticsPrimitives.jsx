import { useState, useEffect, useRef } from 'react'
import { ChevronRight, X, Info } from 'lucide-react'
import { FILTER_LABELS } from './analyticsConfig'

/* ─── Animated counter ─── */
export function AnimatedNumber({ value, prefix = '', suffix = '', decimals = 0, duration = 800 }) {
  const [display, setDisplay] = useState(0)
  const start = useRef(null)
  const raf = useRef(null)
  useEffect(() => {
    const target = parseFloat(value) || 0
    start.current = null
    const animate = (ts) => {
      if (!start.current) start.current = ts
      const prog = Math.min((ts - start.current) / duration, 1)
      const ease = 1 - Math.pow(1 - prog, 3)
      setDisplay(target * ease)
      if (prog < 1) raf.current = requestAnimationFrame(animate)
    }
    raf.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(raf.current)
  }, [value, duration])
  return <>{prefix}{display.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}{suffix}</>
}

/* ─── Recharts tooltip ─── */
export function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--navy-900)', borderRadius: 'var(--radius-md)', padding: '10px 14px', boxShadow: 'var(--shadow-lg)' }}>
      <div style={{ fontSize: 11, color: 'var(--slate-400)', marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ fontSize: 13, fontWeight: 700, color: p.color || '#fff' }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toLocaleString() : p.value}
        </div>
      ))}
    </div>
  )
}

/* ─── Empty chart state ─── */
export function EmptyChart({ icon, message }) {
  const Icon = icon
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 180, gap: 10 }}>
      <Icon size={36} strokeWidth={1.2} color="var(--slate-300)" />
      <span className="text-caption" style={{ textAlign: 'center' }}>{message}</span>
    </div>
  )
}

/* ─── "View all N" link ─── */
export function ViewAllButton({ total, visible, onClick }) {
  if (total <= visible) return null
  return (
    <button onClick={onClick} className="link-chip" style={{ width: '100%', justifyContent: 'center', marginTop: 10, padding: '9px 0', border: '1px dashed var(--blue-100)' }}>
      <ChevronRight size={14} /> View All ({total})
    </button>
  )
}

/* ─── Clickable hover wrapper ─── */
export function Clickable({ onClick, children, style = {} }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ cursor: 'pointer', borderRadius: 'var(--radius-md)', outline: hovered ? '2px solid var(--blue-100)' : '2px solid transparent', transition: 'outline var(--transition-fast)', ...style }}
    >
      {children}
    </div>
  )
}

/* ─── Tooltip with optional extra lines per row ─── */
export function RichTooltip({ active, payload, label, extra, title }) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  const lines = extra && row ? extra(row) : null
  return (
    <div style={{ background: 'var(--navy-900)', borderRadius: 'var(--radius-md)', padding: '10px 14px', boxShadow: 'var(--shadow-lg)', maxWidth: 260 }}>
      <div style={{ fontSize: 11, color: 'var(--slate-400)', marginBottom: 4 }}>{title ? title(row) : label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toLocaleString() : p.value}
        </div>
      ))}
      {lines && lines.map((l, i) => <div key={i} style={{ fontSize: 11, color: 'var(--slate-300)', marginTop: 2 }}>{l}</div>)}
    </div>
  )
}

/* ─── Active cross-filter chips ─── */
export function FilterChips({ chips, onRemove, onClearAll }) {
  if (!chips.length) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }} aria-label="Active filters">
      <span className="text-caption" style={{ fontWeight: 600 }}>Filtered by:</span>
      {chips.map(c => (
        <button
          key={c.key} type="button" onClick={() => onRemove(c.key)}
          className="badge badge-info" style={{ cursor: 'pointer', gap: 6 }}
          aria-label={`Remove ${FILTER_LABELS[c.key] || c.key} filter`}
        >
          <span><strong>{FILTER_LABELS[c.key] || c.key}:</strong> {c.label}</span>
          <X size={12} aria-hidden="true" />
        </button>
      ))}
      <button type="button" className="link-chip" onClick={onClearAll}>Clear all</button>
    </div>
  )
}

/* ─── Small explanatory note (scope, exclusions, basis) ─── */
export function ChartNote({ children, style }) {
  if (!children) return null
  return (
    <div className="text-caption" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 10, lineHeight: 1.45, ...style }}>
      <Info size={12} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
      <span>{children}</span>
    </div>
  )
}