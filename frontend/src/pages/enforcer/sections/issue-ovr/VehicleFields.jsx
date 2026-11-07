import { useMemo, useState } from 'react'
import { Field, Select, TextInput } from '../../../../components/ui'
import useVehicleCatalog from '../../../../hooks/useVehicleCatalog'

const unique = (list) => Array.from(new Set(list))

// Same order as VehicleBrandModel.Category on the backend, most common first.
const CATEGORY_ORDER = ['motorcycle', 'car', 'puv', 'truck', 'special']
const OTHER = '__other__'

/**
 * Vehicle Type → Brand → Model, three linked dropdowns built from the same
 * catalog (GET /api/violations/vehicle-brands/, cached for offline use) the
 * old combined search field used. It still writes the same three plain-text
 * fields — vehicle_type / vehicle_brand / vehicle_model — so the API payload
 * is unchanged. "Type" is the catalog's category label (Motorcycle, Car, …).
 *
 * If the catalog is empty (first launch with no connection), the dropdowns
 * fall back to plain text inputs so the enforcer is never blocked.
 */
export default function VehicleFields({ form, setForm, errors = {} }) {
  const { vehicles, loading } = useVehicleCatalog()
  const hasCatalog = vehicles.length > 0

  // Type = the catalog's category. Listed in a fixed, sensible order rather
  // than whichever row the API happened to return first.
  const types = useMemo(() => {
    const byLabel = new Map()
    vehicles.forEach(v => { if (v.categoryLabel && !byLabel.has(v.categoryLabel)) byLabel.set(v.categoryLabel, v.category) })
    const rank = (cat) => { const i = CATEGORY_ORDER.indexOf(cat); return i === -1 ? CATEGORY_ORDER.length : i }
    return Array.from(byLabel.entries()).sort((a, b) => rank(a[1]) - rank(b[1])).map(([label]) => label)
  }, [vehicles])
  const brands = useMemo(
    () => unique(vehicles.filter(v => v.categoryLabel === form.vehicle_type).map(v => v.brand)).sort(),
    [vehicles, form.vehicle_type],
  )
  const models = useMemo(
    () => unique(
      vehicles
        .filter(v => v.categoryLabel === form.vehicle_type && v.brand === form.vehicle_brand)
        .map(v => v.model),
    ).sort(),
    [vehicles, form.vehicle_type, form.vehicle_brand],
  )

  const set = (patch) => setForm(f => ({ ...f, ...patch }))

  // "Other" lets the enforcer type a brand/model that isn't in the catalog
  // yet. It's also inferred from the value, so it survives leaving and
  // re-entering this step.
  const [otherBrand, setOtherBrand] = useState(false)
  const [otherModel, setOtherModel] = useState(false)
  const brandIsOther = !!form.vehicle_type && (otherBrand || (form.vehicle_brand !== '' && !brands.includes(form.vehicle_brand)))
  const modelIsOther = brandIsOther || otherModel || (form.vehicle_model !== '' && !models.includes(form.vehicle_model))

  if (!hasCatalog && !loading) {
    return (
      <>
        <p className="ovr-inline-note">
          The vehicle list isn&apos;t saved on this device yet. Type the details instead — connect once to load it.
        </p>
        <div className="ovr-grid ovr-grid--3">
          <Field label="Vehicle type" required error={errors.vehicle_type}>
            {id => <TextInput id={id} value={form.vehicle_type} error={!!errors.vehicle_type}
              onChange={e => set({ vehicle_type: e.target.value })} placeholder="Motorcycle" />}
          </Field>
          <Field label="Brand">
            {id => <TextInput id={id} value={form.vehicle_brand} onChange={e => set({ vehicle_brand: e.target.value })} placeholder="Honda" />}
          </Field>
          <Field label="Model">
            {id => <TextInput id={id} value={form.vehicle_model} onChange={e => set({ vehicle_model: e.target.value })} placeholder="Click 125" />}
          </Field>
        </div>
      </>
    )
  }

  const busy = loading && !hasCatalog

  return (
    <div className="ovr-grid ovr-grid--3">
      <Field label="Vehicle type" required error={errors.vehicle_type}>
        {id => (
          <Select id={id} value={form.vehicle_type} error={!!errors.vehicle_type} disabled={busy}
            onChange={e => {
              setOtherBrand(false); setOtherModel(false)
              set({ vehicle_type: e.target.value, vehicle_brand: '', vehicle_model: '' })
            }}>
            <option value="">{busy ? 'Loading…' : 'Select type'}</option>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </Select>
        )}
      </Field>

      <Field label="Brand">
        {id => (
          <div className="ovr-stack" style={{ gap: 'var(--space-2)' }}>
            <Select id={id} value={brandIsOther ? OTHER : form.vehicle_brand} disabled={!form.vehicle_type}
              onChange={e => {
                setOtherModel(false)
                if (e.target.value === OTHER) { setOtherBrand(true); set({ vehicle_brand: '', vehicle_model: '' }) }
                else { setOtherBrand(false); set({ vehicle_brand: e.target.value, vehicle_model: '' }) }
              }}>
              <option value="">{form.vehicle_type ? 'Select brand' : 'Select type first'}</option>
              {brands.map(b => <option key={b} value={b}>{b}</option>)}
              {form.vehicle_type && <option value={OTHER}>Other (type it)</option>}
            </Select>
            {brandIsOther && (
              <TextInput aria-label="Brand" value={form.vehicle_brand} placeholder="Type the brand" autoComplete="off"
                onChange={e => set({ vehicle_brand: e.target.value })} />
            )}
          </div>
        )}
      </Field>

      <Field label="Model">
        {id => (
          <div className="ovr-stack" style={{ gap: 'var(--space-2)' }}>
            {!brandIsOther && (
              <Select id={id} value={modelIsOther ? OTHER : form.vehicle_model} disabled={!form.vehicle_brand}
                onChange={e => {
                  if (e.target.value === OTHER) { setOtherModel(true); set({ vehicle_model: '' }) }
                  else { setOtherModel(false); set({ vehicle_model: e.target.value }) }
                }}>
                <option value="">{form.vehicle_brand ? 'Select model' : 'Select brand first'}</option>
                {models.map(m => <option key={m} value={m}>{m}</option>)}
                {form.vehicle_brand && <option value={OTHER}>Other (type it)</option>}
              </Select>
            )}
            {modelIsOther && (
              <TextInput id={brandIsOther ? id : undefined} aria-label="Model" value={form.vehicle_model}
                placeholder="Type the model" autoComplete="off"
                onChange={e => set({ vehicle_model: e.target.value })} />
            )}
          </div>
        )}
      </Field>
    </div>
  )
}