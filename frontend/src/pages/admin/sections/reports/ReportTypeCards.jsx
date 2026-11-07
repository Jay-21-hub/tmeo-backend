import { REPORT_TYPES } from './reportsConfig'

/** Selecting a card only SELECTS the report. Generating is an explicit action. */
export default function ReportTypeCards({ selectedId, onSelect }) {
  return (
    <div role="radiogroup" aria-label="Report type" className="kpi-grid" style={{ marginBottom: 20 }}>
      {REPORT_TYPES.map((r) => {
        const Icon = r.icon
        const selected = selectedId === r.id
        return (
          <button
            key={r.id} type="button" role="radio" aria-checked={selected}
            onClick={() => onSelect(r.id)}
            className="card card-padded card-interactive"
            style={{
              textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit',
              borderLeft: `4px solid ${r.accent}`,
              outline: selected ? '2px solid var(--blue-600)' : undefined, outlineOffset: -2,
              boxShadow: selected ? 'var(--shadow-md)' : undefined,
            }}
          >
            <span style={{ display: 'inline-flex', padding: 10, borderRadius: 'var(--radius-md)', background: r.iconBg, marginBottom: 10 }}>
              <Icon size={20} color={r.accent} aria-hidden="true" />
            </span>
            <span className="text-title" style={{ display: 'block', lineHeight: 1.35 }}>{r.title}</span>
            <span className="text-caption" style={{ display: 'block', marginTop: 4, lineHeight: 1.5 }}>{r.desc}</span>
          </button>
        )
      })}
    </div>
  )
}