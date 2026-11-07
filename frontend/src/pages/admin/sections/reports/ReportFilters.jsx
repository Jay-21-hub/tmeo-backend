import { useRef, useState } from 'react'
import { Calendar } from 'lucide-react'
import Popover from '../../../../components/ui/Popover'
import Button from '../../../../components/ui/Button'
import { CATEGORY_OPTIONS, STATUS_OPTIONS, fmtDate } from './reportsConfig'

const PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This Week (Mon–Sun)' },
  { id: 'month', label: 'This Month' },
  { id: 'custom', label: 'Custom' },
]

/**
 * Custom Date Range popover. Owns the DRAFT dates in local state — it is mounted only
 * while open, so every open starts from the applied range and anything unapplied is
 * discarded on unmount. Nothing here touches the committed filters or the report:
 * only Apply calls onApply. Cancel, the X, click-outside and Escape all call onCancel.
 */
function CustomRangePopover({ initial, triggerRef, onApply, onCancel }) {
  const [from, setFrom] = useState(initial.dateFrom || '')
  const [to, setTo] = useState(initial.dateTo || '')
  const order = !!(from && to && from > to)
  const canApply = !!from && !!to && !order

  return (
    <Popover
      open onClose={onCancel} triggerRef={triggerRef} width={300} align="left"
      title="Custom Date Range" closeLabel="Close custom date range"
      footer={(
        <>
          <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!canApply} onClick={() => onApply(from, to)}>Apply</Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="text-caption">From
          <input type="date" autoFocus className="filter-select" style={{ width: '100%', marginTop: 4 }} value={from}
            max={to || undefined} onChange={e => setFrom(e.target.value)} aria-invalid={order || undefined} />
        </label>
        <label className="text-caption">To
          <input type="date" className="filter-select" style={{ width: '100%', marginTop: 4 }} value={to}
            min={from || undefined} onChange={e => setTo(e.target.value)} aria-invalid={order || undefined} />
        </label>
        {order && (
          <p role="alert" className="text-caption" style={{ color: 'var(--danger-600)', margin: 0 }}>
            Start date cannot be after end date.
          </p>
        )}
      </div>
    </Popover>
  )
}

/**
 * Shows ONLY the filters the selected report supports (`supported` comes from
 * reportsConfig and mirrors the backend) — a control that the server would
 * silently ignore is never rendered.
 */
export default function ReportFilters({ filters, supported, onPreset, onChange, customRange, onApplyCustom, dateInvalid, vehicleOptions }) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const triggerRef = useRef(null)
  const customBtnRef = useRef(null)
  const active = filters.preset              // the COMMITTED date mode
  // While the popover is open Custom reads as the active mode, but nothing is committed until Apply.
  const shown = pickerOpen ? 'custom' : active
  const rangeText = `${fmtDate(filters.dateFrom)} – ${fmtDate(filters.dateTo)}`

  const closePicker = () => { setPickerOpen(false); customBtnRef.current?.focus() }
  const applyCustom = (from, to) => { onApplyCustom(from, to); closePicker() }

  return (
    <div className="card card-padded" style={{ marginBottom: 20 }}>
      <div role="group" aria-label="Date range" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {PRESETS.map(p => p.id !== 'custom' ? (
          <button key={p.id} type="button" aria-pressed={shown === p.id}
            className={`btn btn-sm ${shown === p.id ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => { setPickerOpen(false); onPreset(p.id) }}>{p.label}</button>
        ) : (
          <span key={p.id} ref={triggerRef} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <button ref={customBtnRef} type="button" aria-pressed={shown === 'custom'} aria-haspopup="dialog" aria-expanded={pickerOpen}
              className={`btn btn-sm ${shown === 'custom' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setPickerOpen(o => !o)}>{p.label}</button>
            {active === 'custom' && (
              <button type="button" className="btn btn-sm btn-secondary" aria-label={`Custom date range ${rangeText}. Edit`}
                aria-expanded={pickerOpen} onClick={() => setPickerOpen(o => !o)} aria-live="polite">
                <Calendar size={14} aria-hidden="true" /> {rangeText}
              </button>
            )}
          </span>
        ))}
        {active !== 'custom' && (
          <span className="text-caption" style={{ marginLeft: 4 }} aria-live="polite">{rangeText}</span>
        )}
      </div>

      {pickerOpen && (
        <CustomRangePopover
          initial={customRange ?? { dateFrom: filters.dateFrom, dateTo: filters.dateTo }}
          triggerRef={triggerRef} onApply={applyCustom} onCancel={closePicker}
        />
      )}

      {dateInvalid && (
        <p role="alert" className="text-caption" style={{ color: 'var(--danger-600)', marginTop: 8 }}>
          “From” must not be later than “To”.
        </p>
      )}

      {supported.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 14 }}>
          {supported.includes('status') && (
            <label className="text-caption" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>Status
              <select className="filter-select" value={filters.status} onChange={e => onChange({ status: e.target.value })}>
                <option value="">All statuses</option>
                {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}
          {supported.includes('category') && (
            <label className="text-caption" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>Category
              <select className="filter-select" value={filters.category} onChange={e => onChange({ category: e.target.value })}>
                <option value="">All categories</option>
                {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}
          {supported.includes('vehicle_type') && (
            <label className="text-caption" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>Vehicle type
              <select className="filter-select" value={filters.vehicleType} onChange={e => onChange({ vehicleType: e.target.value })}>
                <option value="">All vehicle types</option>
                {vehicleOptions.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  )
}