import { useState } from 'react'
import Modal from '../../../../components/ui/Modal'
import { YEAR_COLORS, THIS_YEAR, YEAR_BREAKDOWN_OPTIONS } from './analyticsConfig'

/* ─── Detail modal (single-item breakdown) ─── */
export function DetailModal({ data, onClose }) {
  if (!data) return null
  const { title, subtitle, color, icon: Icon, rows, badge } = data
  return (
    <Modal open onClose={onClose} width={440}>
      <div style={{ margin: '-24px -24px 0', padding: '18px 24px', background: `${color || 'var(--blue-600)'}10`, borderBottom: '1px solid var(--slate-100)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ background: `${color || 'var(--blue-600)'}20`, border: `1px solid ${color || 'var(--blue-600)'}40`, borderRadius: 'var(--radius-md)', padding: 7, flexShrink: 0 }}>
          {Icon && <Icon size={16} color={color || 'var(--blue-600)'} />}
        </div>
        <div>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--slate-950)' }}>{title}</p>
          {subtitle && <p className="text-caption" style={{ margin: 0 }}>{subtitle}</p>}
        </div>
      </div>

      {badge && (
        <div style={{ margin: '14px 0 0' }}>
          <span className="badge" style={{ background: `${color || 'var(--blue-600)'}15`, color: color || 'var(--blue-600)', border: `1px solid ${color || 'var(--blue-600)'}30` }}>{badge}</span>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        {rows.map((row, i) => (
          row.divider
            ? <div key={i} style={{ height: 1, background: 'var(--slate-100)', margin: '8px 0' }} />
            : (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: i < rows.length - 1 ? '1px solid var(--slate-50)' : 'none' }}>
                <span className="text-caption" style={{ fontWeight: 500 }}>{row.label}</span>
                <span style={{ fontSize: 13, fontWeight: row.highlight ? 700 : 500, color: row.color || (row.highlight ? 'var(--slate-950)' : 'var(--slate-600)') }}>{row.value}</span>
              </div>
            )
        ))}
      </div>
    </Modal>
  )
}

/* ─── List modal (ranked list, drill into DetailModal) ─── */
export function ListModal({ config, onClose, onItemClick }) {
  if (!config) return null
  const { title, subtitle, icon: Icon, color, items, renderItem } = config
  return (
    <Modal
      open onClose={onClose} width={520}
      title={title}
      footer={null}
    >
      <div style={{ margin: '-24px -24px 0', padding: '18px 24px', background: `${color || 'var(--blue-600)'}10`, borderBottom: '1px solid var(--slate-100)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ background: `${color || 'var(--blue-600)'}20`, border: `1px solid ${color || 'var(--blue-600)'}40`, borderRadius: 'var(--radius-md)', padding: 7 }}>
            {Icon && <Icon size={16} color={color || 'var(--blue-600)'} />}
          </div>
          <div>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--slate-950)' }}>{title}</p>
            {subtitle && <p className="text-caption" style={{ margin: 0 }}>{subtitle}</p>}
          </div>
        </div>
        <span className="badge" style={{ background: `${color || 'var(--blue-600)'}15`, color: color || 'var(--blue-600)', border: `1px solid ${color || 'var(--blue-600)'}30` }}>{items.length} total</span>
      </div>
      <div style={{ margin: '14px -8px -8px', maxHeight: '60vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}>
        {items.map((item, i) => renderItem(item, i, onItemClick))}
      </div>
    </Modal>
  )
}

/* ─── Year comparison filter modal ─── */
export function YearFilterModal({ onClose, selectedYears, onApply, availableYears, selectedBreakdowns = [] }) {
  const [localSelected, setLocalSelected] = useState(selectedYears)
  const [localBreakdowns, setLocalBreakdowns] = useState(selectedBreakdowns)

  const toggleBreakdown = (key) => {
    setLocalBreakdowns(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    )
  }

  const FIXED_START = 2020
  const allYears = Array.from({ length: THIS_YEAR - FIXED_START + 1 }, (_, i) => FIXED_START + i)
  const yearOptions = [...new Set([...allYears, ...availableYears])].sort((a, b) => b - a)

  const toggle = (yr) => {
    setLocalSelected(prev => {
      if (prev.includes(yr)) {
        if (prev.length === 1) return prev
        return prev.filter(y => y !== yr)
      }
      return [...prev, yr].sort((a, b) => a - b)
    })
  }

  const cols = yearOptions.length > 4 ? 3 : 2

  return (
    <Modal
      open onClose={onClose} width={400}
      title="Year Comparison Filter"
    >
      <p className="text-caption" style={{ marginTop: -10, marginBottom: 16 }}>Select one or more years to compare</p>

      {yearOptions.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--slate-400)', fontSize: 13, padding: '24px 0' }}>No years with data available.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 10, marginBottom: 20 }}>
          {yearOptions.map(yr => {
            const isSelected = localSelected.includes(yr)
            const swatch = YEAR_COLORS[localSelected.indexOf(yr)] || 'var(--slate-500)'
            return (
              <button
                key={yr} onClick={() => toggle(yr)}
                style={{
                  padding: '14px 8px', borderRadius: 'var(--radius-md)', border: 'none', cursor: 'pointer',
                  fontWeight: 700, fontSize: 15, transition: 'all var(--transition-fast)', position: 'relative',
                  background: isSelected ? swatch : 'var(--slate-100)',
                  color: isSelected ? '#fff' : 'var(--slate-700)',
                  boxShadow: isSelected ? `0 2px 10px ${swatch}44` : 'none',
                }}
              >
                {yr}
                {isSelected && (
                  <span style={{ position: 'absolute', top: 4, right: 5, fontSize: 9, fontWeight: 800, background: 'rgba(255,255,255,0.3)', borderRadius: 4, padding: '1px 4px', lineHeight: 1.4 }}>
                    {localSelected.indexOf(yr) + 1}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {localSelected.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          {localSelected.map((yr, i) => (
            <div key={yr} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--slate-700)' }}>
              <div style={{ width: 10, height: 10, borderRadius: 3, background: YEAR_COLORS[i] || 'var(--slate-500)' }} />
              <span style={{ fontWeight: 600 }}>{yr}</span>
              <span style={{ color: 'var(--slate-400)' }}>{i === 0 ? '(base)' : ''}</span>
            </div>
          ))}
        </div>
      )}

      <p className="text-caption" style={{ marginBottom: 16 }}>
        {localSelected.length === 0 ? 'Select at least one year.'
          : localSelected.length === 1 ? '1 year selected. Add more to compare side by side.'
          : `${localSelected.length} years selected: ${localSelected.join(', ')}.`}
      </p>

      <div style={{ height: 1, background: 'var(--slate-100)', margin: '4px 0 16px' }} />

      <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, color: 'var(--slate-800)' }}>Break down by (optional)</p>
      <p className="text-caption" style={{ marginBottom: 12 }}>Check any categories to add a comparison chart per category, alongside the monthly trend.</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 20 }}>
        {YEAR_BREAKDOWN_OPTIONS.map(opt => {
          const checked = localBreakdowns.includes(opt.key)
          return (
            <label
              key={opt.key}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                borderRadius: 'var(--radius-md)', cursor: 'pointer',
                background: checked ? 'var(--blue-50)' : 'transparent',
                border: `1px solid ${checked ? 'var(--blue-100)' : 'transparent'}`,
              }}
            >
              <input
                type="checkbox" checked={checked} onChange={() => toggleBreakdown(opt.key)}
                style={{ width: 16, height: 16, accentColor: 'var(--blue-600)', cursor: 'pointer', flexShrink: 0 }}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-800)' }}>{opt.label}</div>
                <div style={{ fontSize: 11, color: 'var(--slate-400)' }}>{opt.subtitle}</div>
              </div>
            </label>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={onClose} className="btn btn-secondary" style={{ flex: 1 }}>Cancel</button>
        <button
          onClick={() => { onApply(localSelected, localBreakdowns); onClose() }}
          disabled={localSelected.length === 0}
          className="btn btn-primary" style={{ flex: 2 }}
        >
          {localSelected.length >= 2 ? `Compare ${localSelected.join(' vs ')}` : 'Apply Filter'}
        </button>
      </div>
    </Modal>
  )
}