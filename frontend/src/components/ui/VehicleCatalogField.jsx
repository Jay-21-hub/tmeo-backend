import { useState, useMemo, useRef, useId, useEffect } from 'react'
import { Search, Car } from 'lucide-react'
import useVehicleCatalog from '../../hooks/useVehicleCatalog'
import useFloatingPosition from '../../hooks/useFloatingPosition'
import useListboxNav from '../../hooks/useListboxNav'
import FloatingPanel from './FloatingPanel'

/**
 * Unified Vehicle Catalog field — search-first combobox over the flat
 * Category → Brand → Model catalog (see useVehicleCatalog); one
 * selection sets all three plain-text fields at once. There is no
 * separate "Type" layer anymore — Category (Motorcycle/Car/PUV/Truck/
 * Special) is the only classification, so `vehicle_type` below is
 * filled with the vehicle's category label.
 *
 * `value` / `onSelect` work on the same three free-text fields the
 * backend has always expected — Violation.vehicle_type/vehicle_brand/
 * vehicle_model stay CharFields for backward compatibility, so nothing
 * about the create/update payload shape changes here. Only the picking
 * UI is unified; matching is done by name since that's still the only
 * thing saved on the violation record.
 *
 * The result list is a collision-aware FloatingPanel (see
 * useFloatingPosition) so it flips above the field instead of getting
 * clipped near the bottom of the viewport, inside a modal, or inside a
 * drawer.
 */
export default function VehicleCatalogField({
  value, onSelect, onClear, label = 'Vehicle', required = false, error,
  accent = '#0f766e', accentLight = '#f0fdfa', placeholder = 'Search vehicle, brand or model…',
}) {
  const { vehicles, loading } = useVehicleCatalog()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  const listRef = useRef(null)
  const baseId = useId()

  const { vehicle_type = '', vehicle_brand = '', vehicle_model = '' } = value || {}
  const hasSelection = !!(vehicle_brand || vehicle_model || vehicle_type)

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? vehicles.filter(v =>
          v.brand.toLowerCase().includes(q) ||
          v.model.toLowerCase().includes(q) ||
          (v.categoryLabel || '').toLowerCase().includes(q))
      : vehicles
    const byBrand = new Map()
    filtered.forEach(v => {
      if (!byBrand.has(v.brand)) byBrand.set(v.brand, [])
      byBrand.get(v.brand).push(v)
    })
    return Array.from(byBrand.entries())
  }, [vehicles, query])

  const flatIds = useMemo(() => groups.flatMap(([, items]) => items.map(v => v.id)), [groups])
  const optionId = (id) => `${baseId}-opt-${id}`

  const select = (v) => {
    onSelect({
      vehicle_brand: v.brand,
      vehicle_model: v.model,
      vehicle_type: v.categoryLabel || '',
    })
    setQuery(''); setOpen(false)
  }
  const clear = () => { onClear(); setQuery(''); setOpen(false) }
  const selectById = (id) => {
    const v = vehicles.find(v => v.id === id)
    if (v) select(v)
  }
  const close = () => setOpen(false)

  const position = useFloatingPosition(triggerRef, open)
  const { activeId, setActiveId, handleKeyDown } = useListboxNav({ flatIds, open, onSelect: selectById, onClose: close })

  useEffect(() => {
    if (activeId == null || !listRef.current) return
    listRef.current.querySelector(`[data-option-id="${activeId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const selectedTitle = vehicle_brand ? `${vehicle_brand} ${vehicle_model}`.trim() : (vehicle_type || '')

  return (
    <div>
      <label htmlFor={`${baseId}-input`} className="field-label" style={{ marginBottom: 6, display: 'block' }}>
        {label} {required && <span className="field-required" aria-hidden="true">*</span>}
      </label>
      <div ref={triggerRef} style={{ position: 'relative' }}>
        {hasSelection && !open ? (
          <div onClick={() => setOpen(true)} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
            border: `1.5px solid ${accent}`, borderRadius: 10, padding: '10px 14px',
            background: accentLight, cursor: 'pointer',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: accent, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Car size={14} /> {selectedTitle || '—'}
              </div>
              {(vehicle_type || vehicle_brand) && (
                <div style={{ fontSize: 11.5, color: 'var(--slate-500)', fontWeight: 500, marginTop: 1 }}>
                  {[vehicle_brand ? vehicle_type : null].filter(Boolean).join(' · ') || vehicle_type}
                </div>
              )}
            </div>
            <button onClick={e => { e.stopPropagation(); clear() }} aria-label="Change vehicle"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: accent, opacity: 0.7, fontSize: 12, fontWeight: 700, padding: 0, flexShrink: 0 }}>
              Change
            </button>
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--slate-400)', pointerEvents: 'none' }} />
            <input
              id={`${baseId}-input`}
              autoFocus={open}
              role="combobox"
              aria-expanded={open}
              aria-controls={`${baseId}-listbox`}
              aria-autocomplete="list"
              aria-activedescendant={activeId != null ? optionId(activeId) : undefined}
              value={query}
              onChange={e => { setQuery(e.target.value); setOpen(true) }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className={`input ${error ? 'input-error' : ''}`}
              style={{ paddingLeft: 36 }}
            />
          </div>
        )}

        <FloatingPanel position={position}>
          <div ref={listRef} role="listbox" id={`${baseId}-listbox`} aria-label={label} style={{ maxHeight: '100%', overflowY: 'auto' }}>
            {loading && vehicles.length === 0 ? (
              <div style={{ padding: 14, fontSize: 13, color: 'var(--slate-500)', textAlign: 'center' }}>Loading vehicles…</div>
            ) : groups.length === 0 ? (
              <div style={{ padding: 14, fontSize: 13, color: 'var(--slate-500)', textAlign: 'center' }}>
                {vehicles.length === 0
                  ? 'These options have not been cached on this device yet. Connect to the internet once to load the latest options.'
                  : 'No match found.'}
              </div>
            ) : groups.map(([brand, items]) => (
              <div key={brand}>
                <div className="floating-panel-group-label">{brand}</div>
                {items.map(v => {
                  const selected = vehicle_brand === v.brand && vehicle_model === v.model
                  const active = activeId === v.id
                  return (
                    <div
                      key={v.id}
                      id={optionId(v.id)}
                      data-option-id={v.id}
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActiveId(v.id)}
                      onMouseDown={() => select(v)}
                      className={`floating-panel-option ${active ? 'is-active' : ''}`}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1,
                        color: selected ? accent : 'var(--slate-900)',
                        background: selected ? accentLight : undefined,
                      }}
                    >
                      <span style={{ fontWeight: selected ? 700 : 600 }}>
                        {selected && '✓ '}{v.brand} {v.model}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--slate-400)', fontWeight: 400 }}>
                        {v.categoryLabel || '—'}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </FloatingPanel>
      </div>
      {error && <span className="field-error-text">⚠ {error}</span>}
    </div>
  )
}