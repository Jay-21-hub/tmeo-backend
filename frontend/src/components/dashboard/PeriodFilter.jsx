import { useState } from 'react'
import {
  DEFAULT_PRESET, PERIOD_PRESETS, customRangeIssue, periodParams,
} from './periodRange'
import './PeriodFilter.css'

/**
 * Preset bar for the admin dashboard. Calls `onChange(params)` only when a
 * preset is chosen, or when Custom is Applied — not while the dates are typed.
 * `now` is an instant; omitted, it is the current instant. Manila day math
 * lives in periodRange.js.
 */
export default function PeriodFilter({
  value, initialPreset = DEFAULT_PRESET, onChange, now, presets = PERIOD_PRESETS,
}) {
  const selected = value ?? initialPreset
  const [preset, setPreset] = useState(selected)
  const [seen, setSeen] = useState(selected)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  if (selected !== seen) {
    setSeen(selected)
    setPreset(selected)
  }
  const issue = customRangeIssue(dateFrom, dateTo)
  const instant = now ?? new Date()

  const pick = (id) => {
    setPreset(id)
    if (id === 'custom') return
    onChange?.(periodParams(id, instant), id)
  }

  const applyCustom = () => {
    if (issue) return
    onChange?.(periodParams('custom', instant, { date_from: dateFrom, date_to: dateTo }), 'custom')
  }

  return (
    <div className="period-filter">
      <div className="period-filter-presets" role="group" aria-label="Period">
        {presets.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={`btn btn-sm ${preset === opt.id ? 'btn-primary' : 'btn-secondary'}`}
            aria-pressed={preset === opt.id}
            onClick={() => pick(opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {preset === 'custom' && (
        <div className="period-filter-custom">
          <label className="period-filter-field">
            <span className="field-label">From</span>
            <input
              className={`input ${issue === 'order' ? 'input-error' : ''}`}
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>
          <label className="period-filter-field">
            <span className="field-label">To</span>
            <input
              className={`input ${issue === 'order' ? 'input-error' : ''}`}
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary btn-sm period-filter-apply"
            disabled={issue !== null}
            onClick={applyCustom}
          >
            Apply
          </button>
          {issue === 'order' && (
            <p className="period-filter-error" role="alert">From must be on or before To.</p>
          )}
        </div>
      )}
    </div>
  )
}
