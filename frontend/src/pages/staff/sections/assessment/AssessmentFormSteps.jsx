import { useState, useEffect, useRef } from 'react'
import { Search, User, Car, FileWarning, AlertTriangle, ShieldAlert, Eye, ClipboardList, CreditCard, FileText, Check } from 'lucide-react'
import { toTitleCase } from '../../../../utils/helpers'
import Button from '../../../../components/ui/Button'
import useVehicleCatalog from '../../../../hooks/useVehicleCatalog'
import EvidencePhoto from '../../../../components/ui/EvidencePhoto'
import './assessmentFlow.css'

const FIELD_LABELS = {
  full_name: 'Last Name', address: 'Address', license_number: "Driver's License Number",
  plate_number: 'Plate Number', ovr_number: 'OVR Number',
  vehicle_type: 'Vehicle', date: 'Date of Violation', time: 'Time of Violation',
  place_of_violation: 'Place of Violation', violations: 'Violation Type',
  or_number: 'O.R. Number',
  confiscated_document_type: 'Confiscated Document Type',
  confiscated_document_name: 'Document Type / Name',
  confiscated_document_number: 'Document / Reference Number',
}

// INTERNAL record options only — never printed on the Assessment Form.
// (Saved values are unchanged from the previous implementation.)
const CONFISCATED_DOCUMENT_OPTIONS = [
  { value: 'drivers_license', label: "Driver's License" },
  { value: 'bir',             label: 'BIR-related ID/document' },
  { value: 'umid',            label: 'UMID' },
  { value: 'company_id',      label: 'Company ID' },
  { value: 'philhealth',      label: 'PhilHealth ID' },
  { value: 'others',          label: 'Others' },
]

/** Titled list of current errors; each links to (and focuses) its field. */
function ErrorSummary({ errors }) {
  const keys = Object.keys(errors || {}).filter(k => errors[k])
  if (keys.length === 0) return null

  const jumpTo = (key) => (e) => {
    e.preventDefault()
    const el = document.getElementById(key)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (typeof el.focus === 'function') el.focus({ preventScroll: true })
  }

  return (
    <div className="alert alert-danger" role="alert" style={{ margin: '16px 22px 0', flexDirection: 'column', gap: 6 }}>
      <p className="alert-title" style={{ margin: 0 }}>There is a problem</p>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {keys.map(key => (
          <li key={key}>
            <a href={`#${key}`} onClick={jumpTo(key)} style={{ color: 'var(--danger-700)', textDecoration: 'underline', fontWeight: 600 }}>
              {FIELD_LABELS[key] || key} — {errors[key]}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

const STEPS = [
  { num: 1, label: 'Vehicle & Violator' },
  { num: 2, label: 'Violation & Fine' },
  { num: 3, label: 'Remarks & Payment' },
  { num: 4, label: 'Review' },
]

/* ── Full-name split/combine (UI-only; the backend stores ONE string) ──
   Unchanged from the previous implementation: typing in the 3 boxes
   composes "Last, First, M.I." exactly as before. */
const combineName = (last, first, mi) => [last, first, mi].map(s => s.trim()).filter(Boolean).join(', ')
const splitName = (fullName) => {
  const parts = (fullName || '').split(',').map(p => p.trim()).filter(Boolean)
  if (parts.length >= 3) return { last: parts[0], first: parts[1], mi: parts.slice(2).join(', ') }
  if (parts.length === 2) {
    const words = parts[1].split(/\s+/).filter(Boolean)
    const last = words[words.length - 1]
    if (words.length > 1 && /^[A-Za-z]\.?$/.test(last)) {
      return { last: parts[0], first: words.slice(0, -1).join(' '), mi: last }
    }
    return { last: parts[0], first: parts[1], mi: '' }
  }
  return { last: parts[0] || '', first: '', mi: '' }
}

/* ── Field wrapper. `htmlFor` ties the visible label to its control. ── */
export const Field = ({ label, required, optional, children, error, helper, helperGreen, htmlFor, className = '' }) => (
  <div className={`field ${className}`}>
    <label className="field-label" htmlFor={htmlFor}>
      {label}
      {required && <span className="field-required"> *<span className="sr-only"> (required)</span></span>}
      {optional && <span style={{ color: 'var(--slate-400)', fontWeight: 400 }}> (optional)</span>}
    </label>
    {children}
    {helper && !error && <span style={{ fontSize: 11, color: helperGreen ? 'var(--success-600)' : 'var(--slate-400)', marginTop: 2 }}>{helperGreen ? '✓ ' : ''}{helper}</span>}
    {error && <span className="field-error-text" role="alert">⚠ {error}</span>}
  </div>
)

/* Locked (read-only) field — Enforcer-submitted data shown to Staff. */
export const LockedField = ({ label, value, className = '', id }) => (
  <Field label={label} className={className} htmlFor={id}>
    <input
      id={id} className="input" readOnly
      style={{ background: 'var(--slate-100)', color: 'var(--slate-600)', cursor: 'not-allowed', fontWeight: 600 }}
      value={value || '—'}
    />
  </Field>
)

const readOnlyInput = { background: 'var(--slate-100)', color: 'var(--slate-600)', cursor: 'not-allowed', fontWeight: 600 }

export const StepIndicator = ({ current }) => (
  <ol className="af-steps" aria-label="Assessment progress">
    {STEPS.map(step => {
      const state = current > step.num ? 'done' : current === step.num ? 'active' : 'todo'
      return (
        <li key={step.num} className="af-step" data-state={state} aria-current={state === 'active' ? 'step' : undefined}>
          <div className="af-step-body">
            <span className="af-step-dot" aria-hidden="true">{state === 'done' ? <Check size={16} strokeWidth={3} /> : step.num}</span>
            <span className="af-step-label">{step.label}<span className="sr-only">{state === 'done' ? ' (completed)' : ''}</span></span>
          </div>
          <span className="af-step-line" aria-hidden="true" />
        </li>
      )
    })}
  </ol>
)

const SectionHead = ({ icon, title, sub }) => {
  const Icon = icon
  return (
    <div className="af-section-head">
      <span className="af-section-icon" aria-hidden="true"><Icon size={16} /></span>
      <div>
        <h2 className="af-section-title">{title}</h2>
        {sub && <p className="af-section-sub">{sub}</p>}
      </div>
    </div>
  )
}

/* ── Repeat-violator notice (behaviour unchanged) ── */
function RepeatViolatorNotice({ repeatInfo, onViewTicket, viewingId }) {
  if (!repeatInfo || !repeatInfo.violation_count) return null
  const { violation_count, history = [] } = repeatInfo
  const ordinal = violation_count + 1
  const suffix = ordinal === 2 ? 'nd' : ordinal === 3 ? 'rd' : 'th'
  const fmtShortDate = (val) => {
    if (!val) return '—'
    const d = new Date(val)
    return isNaN(d) ? val : d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  return (
    <div style={{ padding: '12px 14px', borderRadius: 8, margin: '16px 22px 0', background: 'var(--warning-50, #fffbeb)', border: '1px solid var(--warning-200, #fde68a)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
        <ShieldAlert size={18} color="var(--warning-600, #d97706)" style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ flex: 1 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--warning-700, #b45309)' }}>
            REPEAT VIOLATOR — this would be their {ordinal}{suffix} violation this active year
          </p>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--slate-500)' }}>
            {violation_count} prior violation{violation_count !== 1 ? 's' : ''} found under this license/plate for the current active database. This ticket is filed as its own independent record — it does not merge with or change the ones below.
          </p>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {history.slice(0, 5).map(h => (
          <div key={h.id} style={{ background: '#fff', border: '1px solid var(--warning-200, #fde68a)', borderRadius: 'var(--radius-md)', padding: '8px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--blue-600)' }}>TKT-{String(h.id).padStart(6, '0')}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-600)', textTransform: 'capitalize' }}>{h.status}</span>
              </div>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--slate-700)' }}>
                {fmtShortDate(h.date_issued)} — {(h.violation_types || []).join(', ') || 'N/A'}
                {h.location ? <span style={{ color: 'var(--slate-400)' }}> · {h.location}</span> : null}
              </p>
            </div>
            {onViewTicket && (
              <Button variant="secondary" size="sm" icon={Eye} loading={viewingId === h.id} onClick={() => onViewTicket(h)}>View</Button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Confiscation of Documents (Step 1) ─────────────────────────────────
   Three choices (stored in license_status):
     Not Confiscated  -> nothing else is shown.
     Confiscated      -> the driver's license is held in TMEO custody. Only
                         the License Number is asked; the saved document
                         type is always 'drivers_license'. Only these
                         records enter the Confiscated Licenses module.
     Other Documents  -> TMEO only records the violator's information from
                         a valid ID. Nothing is held in custody, so these
                         records never enter the Confiscated Licenses module.
                         Staff picks the ID from the existing list and enters
                         its number ('Others' also needs a name).
   `statusLocked` = Enforcer OVR whose decision is read-only (Staff still
   completes the document details). */
function ConfiscationSection({ form, errors, onChange, statusLocked, licenseLocked, onLookupReset, onLookup }) {
  const status = form.license_status
  const confiscated = status === 'confiscated'
  const otherDocs = status === 'other_documents'
  const type = form.confiscated_document_type
  const isOthers = type === 'others'
  const otherOptions = CONFISCATED_DOCUMENT_OPTIONS.filter(o => o.value !== 'drivers_license')
  const statusLabel = confiscated ? 'Confiscated' : otherDocs ? 'Other Documents' : 'Not Confiscated'

  // Switching the choice resets the document details so nothing stale from
  // the previous choice is ever saved.
  const handleStatus = (value) => {
    onChange('license_status', value)
    onChange('confiscated_document_name', '')
    onChange('confiscated_document_number', '')
    if (value === 'confiscated') onChange('confiscated_document_type', 'drivers_license')
    else onChange('confiscated_document_type', '')
  }

  return (
    <div className="af-section">
      <SectionHead icon={FileWarning} title="Confiscation of Documents" sub="Record whether a document was confiscated or only its information was taken." />
      <div className="af-grid">
        <div className="af-s6">
          {statusLocked ? (
            <LockedField id="license_status" label="Confiscation" value={statusLabel} />
          ) : (
            <Field label="Confiscation" htmlFor="license_status"
              helper={confiscated ? "The driver's license is held in TMEO custody." : otherDocs ? 'Only the ID information is recorded. Nothing is held in custody.' : undefined}>
              <select id="license_status" className="select" value={status} onChange={e => handleStatus(e.target.value)}>
                <option value="not_confiscated">Not Confiscated</option>
                <option value="confiscated">Confiscated</option>
                <option value="other_documents">Other Documents</option>
              </select>
            </Field>
          )}
        </div>
        {otherDocs && (
          <div className="af-s6 af-reveal">
            <Field label="Valid ID / Document" required error={errors.confiscated_document_type} htmlFor="confiscated_document_type">
              <select id="confiscated_document_type" className={`select ${errors.confiscated_document_type ? 'input-error' : ''}`}
                value={type} onChange={e => onChange('confiscated_document_type', e.target.value)}>
                <option value="">Select valid ID…</option>
                {otherOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          </div>
        )}
        {otherDocs && isOthers && (
          <div className="af-s6 af-reveal">
            <Field label="Document Type / Name" required error={errors.confiscated_document_name} htmlFor="confiscated_document_name">
              <input id="confiscated_document_name" className={`input ${errors.confiscated_document_name ? 'input-error' : ''}`}
                placeholder="e.g. Postal ID" maxLength={100} value={form.confiscated_document_name}
                onChange={e => onChange('confiscated_document_name', e.target.value)} />
            </Field>
          </div>
        )}
        {otherDocs && type && (
          <div className="af-s6 af-reveal">
            <Field label="Document Number" required error={errors.confiscated_document_number} htmlFor="confiscated_document_number">
              <input id="confiscated_document_number" className={`input ${errors.confiscated_document_number ? 'input-error' : ''}`}
                placeholder="Number printed on the document" maxLength={50} value={form.confiscated_document_number}
                onChange={e => onChange('confiscated_document_number', e.target.value)} />
            </Field>
          </div>
        )}
        {confiscated && (
          <div className="af-s6 af-reveal">
            <Field label="Driver's License Number" required error={errors.license_number} htmlFor="license_number">
              <input id="license_number" className={`input ${errors.license_number ? 'input-error' : ''}`}
                placeholder="e.g. N01-23-456789" value={form.license_number} readOnly={licenseLocked}
                style={licenseLocked ? readOnlyInput : undefined}
                onChange={e => { onChange('license_number', e.target.value); onLookupReset?.() }}
                onBlur={() => onLookup?.(form.license_number)} />
            </Field>
          </div>
        )}
      </div>
    </div>
  )
}

/* Vehicle Type → Make/Brand → Model: three linked dropdowns built from the same
   vehicle catalog (useVehicleCatalog) the Enforcer's Issue OVR form uses. Brand and
   Model only list what belongs to the selected Type / Brand. It writes the same three
   plain-text fields (vehicle_type / vehicle_brand / vehicle_model) as before, so the
   payload is unchanged. "Other" allows a brand/model that is not in the catalog yet;
   with no catalog at all the dropdowns fall back to plain text inputs. */
const VEHICLE_CATEGORY_ORDER = ['motorcycle', 'car', 'puv', 'truck', 'special']
const VEHICLE_OTHER = '__other__'
const uniqueSorted = (list) => Array.from(new Set(list)).sort()

function VehicleSelectFields({ form, errors, onChange }) {
  const { vehicles, loading } = useVehicleCatalog()
  const hasCatalog = vehicles.length > 0
  const [otherBrand, setOtherBrand] = useState(false)
  const [otherModel, setOtherModel] = useState(false)

  const types = (() => {
    const byLabel = new Map()
    vehicles.forEach(v => { if (v.categoryLabel && !byLabel.has(v.categoryLabel)) byLabel.set(v.categoryLabel, v.category) })
    const rank = (cat) => { const i = VEHICLE_CATEGORY_ORDER.indexOf(cat); return i === -1 ? VEHICLE_CATEGORY_ORDER.length : i }
    return Array.from(byLabel.entries()).sort((a, b) => rank(a[1]) - rank(b[1])).map(([label]) => label)
  })()
  // A type that is already on the form but not in the catalog (e.g. auto-filled from an older record) stays visible.
  const typeOptions = form.vehicle_type && !types.includes(form.vehicle_type) ? [...types, form.vehicle_type] : types
  const brands = uniqueSorted(vehicles.filter(v => v.categoryLabel === form.vehicle_type).map(v => v.brand))
  const models = uniqueSorted(vehicles.filter(v => v.categoryLabel === form.vehicle_type && v.brand === form.vehicle_brand).map(v => v.model))

  const brandIsOther = !!form.vehicle_type && (otherBrand || (form.vehicle_brand !== '' && !brands.includes(form.vehicle_brand)))
  const modelIsOther = brandIsOther || otherModel || (form.vehicle_model !== '' && !models.includes(form.vehicle_model))
  const busy = loading && !hasCatalog

  if (!hasCatalog && !loading) {
    return (
      <>
        <div className="af-s6">
          <Field label="Vehicle Type" required error={errors.vehicle_type} htmlFor="vehicle_type">
            <input id="vehicle_type" className={`input ${errors.vehicle_type ? 'input-error' : ''}`} placeholder="e.g. Motorcycle"
              value={form.vehicle_type} onChange={e => onChange('vehicle_type', e.target.value)} />
          </Field>
        </div>
        <div className="af-s6">
          <Field label="Make / Brand" htmlFor="vehicle_brand">
            <input id="vehicle_brand" className="input" placeholder="e.g. Honda" value={form.vehicle_brand} onChange={e => onChange('vehicle_brand', e.target.value)} />
          </Field>
        </div>
        <div className="af-s6">
          <Field label="Model" htmlFor="vehicle_model">
            <input id="vehicle_model" className="input" placeholder="e.g. Click 125" value={form.vehicle_model} onChange={e => onChange('vehicle_model', e.target.value)} />
          </Field>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="af-s6">
        <Field label="Vehicle Type" required error={errors.vehicle_type} htmlFor="vehicle_type">
          <select id="vehicle_type" className={`select ${errors.vehicle_type ? 'input-error' : ''}`} value={form.vehicle_type} disabled={busy}
            onChange={e => {
              setOtherBrand(false); setOtherModel(false)
              onChange('vehicle_type', e.target.value); onChange('vehicle_brand', ''); onChange('vehicle_model', '')
            }}>
            <option value="">{busy ? 'Loading…' : 'Select vehicle type'}</option>
            {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </div>

      <div className="af-s6">
        <Field label="Make / Brand" htmlFor="vehicle_brand">
          <select id="vehicle_brand" className="select" value={brandIsOther ? VEHICLE_OTHER : form.vehicle_brand} disabled={!form.vehicle_type}
            onChange={e => {
              setOtherModel(false)
              if (e.target.value === VEHICLE_OTHER) { setOtherBrand(true); onChange('vehicle_brand', ''); onChange('vehicle_model', '') }
              else { setOtherBrand(false); onChange('vehicle_brand', e.target.value); onChange('vehicle_model', '') }
            }}>
            <option value="">{form.vehicle_type ? 'Select make / brand' : 'Select vehicle type first'}</option>
            {brands.map(b => <option key={b} value={b}>{b}</option>)}
            {form.vehicle_type && <option value={VEHICLE_OTHER}>Other (type it)</option>}
          </select>
          {brandIsOther && (
            <input className="input" style={{ marginTop: 8 }} aria-label="Make / Brand" placeholder="Type the make / brand" autoComplete="off"
              value={form.vehicle_brand} onChange={e => onChange('vehicle_brand', e.target.value)} />
          )}
        </Field>
      </div>

      <div className="af-s6">
        <Field label="Model" htmlFor="vehicle_model">
          {!brandIsOther && (
            <select id="vehicle_model" className="select" value={modelIsOther ? VEHICLE_OTHER : form.vehicle_model} disabled={!form.vehicle_brand}
              onChange={e => {
                if (e.target.value === VEHICLE_OTHER) { setOtherModel(true); onChange('vehicle_model', '') }
                else { setOtherModel(false); onChange('vehicle_model', e.target.value) }
              }}>
              <option value="">{form.vehicle_brand ? 'Select model' : 'Select make / brand first'}</option>
              {models.map(m => <option key={m} value={m}>{m}</option>)}
              {form.vehicle_brand && <option value={VEHICLE_OTHER}>Other (type it)</option>}
            </select>
          )}
          {modelIsOther && (
            <input id={brandIsOther ? 'vehicle_model' : undefined} className="input" style={brandIsOther ? undefined : { marginTop: 8 }} aria-label="Model" placeholder="Type the model" autoComplete="off"
              value={form.vehicle_model} onChange={e => onChange('vehicle_model', e.target.value)} />
          )}
        </Field>
      </div>
    </>
  )
}

/* Type / Make-Brand / Model readout — always mirrors the selected catalog entry */
const VehicleReadout = ({ form }) => (
  <dl className="af-readout" aria-label="Selected vehicle">
    <div className="af-readout-item"><dt>Vehicle Type</dt><dd>{form.vehicle_type || '—'}</dd></div>
    <div className="af-readout-item"><dt>Make / Brand</dt><dd>{form.vehicle_brand || '—'}</dd></div>
    <div className="af-readout-item"><dt>Model</dt><dd>{form.vehicle_model || '—'}</dd></div>
  </dl>
)

const vehicleUseLabel = (v) => (v === 'private' ? 'Private' : v === 'public' ? 'Public' : '')

/* ── STEP 1: Vehicle & Violator Information ── */
export function AssessmentStep1({ form, errors, lookupLoading, lookupDone, repeatInfo, violationData, onChange, onLookup, onLookupReset, onNext, onViewTicket, viewingTicketId }) {
  // Existing Enforcer OVR → original field record, locked. Walk-in → editable.
  const locked = !!violationData
  const [nameParts, setNameParts] = useState(() => splitName(form.full_name))
  const lastPushedRef = useRef(form.full_name)

  // Re-split only when full_name changes from somewhere other than these
  // boxes (lookup autofill, initial load) so typing is never fought.
  useEffect(() => {
    if (form.full_name === lastPushedRef.current) return
    setNameParts(splitName(form.full_name))
    lastPushedRef.current = form.full_name
  }, [form.full_name])

  const updateNamePart = (key, value) => {
    const next = { ...nameParts, [key]: value }
    setNameParts(next)
    const combined = combineName(next.last, next.first, next.mi)
    lastPushedRef.current = combined
    onChange('full_name', combined)
  }

  // An Enforcer-stored name is only shown split when it follows the
  // "Last, First[, M.I.]" format; otherwise it is shown whole, untouched.
  const canSplitLocked = (form.full_name || '').includes(',')
  const lookupStyle = lookupDone ? { background: 'var(--success-50)', borderColor: 'var(--success-100)', color: 'var(--success-700)', fontWeight: 600 } : undefined

  return (
    <section className="af-panel" aria-labelledby="af-step1-title">
      <h2 id="af-step1-title" className="sr-only">Step 1: Vehicle and violator information</h2>

      {(
        <div style={{ padding: '12px 22px', borderBottom: '1px solid var(--slate-100)', background: 'var(--slate-50)', borderRadius: 'var(--radius-lg, 10px) var(--radius-lg, 10px) 0 0', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {violationData ? (
            <>
              <div className="field" style={{ minWidth: 200 }}>
                <label className="field-label" htmlFor="ovr_number">OVR Number</label>
                <input id="ovr_number" className="input" readOnly style={readOnlyInput} value={form.ovr_number} />
              </div>
              <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>From the Enforcer's submitted OVR — original field record, read-only</span>
            </>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--slate-500)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <User size={13} aria-hidden="true" /> Walk-in complaint — no OVR Number (no physical OVR was issued in the field)
            </span>
          )}
        </div>
      )}

      <ErrorSummary errors={errors} />
      <RepeatViolatorNotice repeatInfo={repeatInfo} onViewTicket={onViewTicket} viewingId={viewingTicketId} />

      {/* A. VIOLATOR INFORMATION */}
      <div className="af-section">
        <SectionHead icon={User} title="Violator Information" sub="Provide the violator's details." />
        {locked ? (
          <div className="af-grid">
            {canSplitLocked ? (() => {
              const p = splitName(form.full_name)
              return (<>
                <div className="af-s4"><LockedField id="locked_last" label="Last Name" value={p.last} /></div>
                <div className="af-s4"><LockedField id="locked_first" label="First Name" value={p.first} /></div>
                <div className="af-s4"><LockedField id="locked_mi" label="M.I." value={p.mi} /></div>
              </>)
            })() : (
              <div><LockedField id="locked_name" label="Violator Name" value={form.full_name} /></div>
            )}
            <div className="af-s6"><LockedField id="locked_address" label="Address" value={form.address} /></div>
            <div className="af-s6"><LockedField id="locked_reg" label="Registration No." value={form.registration_number} /></div>
            <div className="af-s6">
              <span className="field-label" style={{ display: 'block', marginBottom: 6 }}>Classification</span>
              <div className="af-radios" role="group" aria-label="Classification (read-only)">
                {['private', 'public'].map(v => (
                  <label key={v} className="af-radio" data-locked="true">
                    <input type="radio" disabled checked={form.vehicle_use === v} readOnly /> {vehicleUseLabel(v)}
                  </label>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="af-grid">
            <div className="af-s4">
              <Field label="Last Name" required error={errors.full_name} htmlFor="full_name">
                <input id="full_name" className={`input ${errors.full_name ? 'input-error' : ''}`} placeholder="Dela Cruz" value={nameParts.last} onChange={e => updateNamePart('last', e.target.value)} onBlur={e => updateNamePart('last', toTitleCase(e.target.value))} />
              </Field>
            </div>
            <div className="af-s4">
              <Field label="First Name" htmlFor="first_name">
                <input id="first_name" className="input" placeholder="Juan" value={nameParts.first} onChange={e => updateNamePart('first', e.target.value)} onBlur={e => updateNamePart('first', toTitleCase(e.target.value))} />
              </Field>
            </div>
            <div className="af-s4">
              <Field label="M.I." htmlFor="middle_initial">
                <input id="middle_initial" className="input" placeholder="R." value={nameParts.mi} onChange={e => updateNamePart('mi', e.target.value)} onBlur={e => updateNamePart('mi', toTitleCase(e.target.value))} />
              </Field>
            </div>
            <div className="af-s6">
              <Field label="Address" required error={errors.address} htmlFor="address">
                <input id="address" className={`input ${errors.address ? 'input-error' : ''}`} placeholder="Complete Address" value={form.address} onChange={e => onChange('address', e.target.value)} onBlur={() => onChange('address', toTitleCase(form.address))} />
              </Field>
            </div>
            <div className="af-s6">
              <Field label="Registration No." optional htmlFor="registration_number">
                <input id="registration_number" className="input" placeholder="e.g. 2026-REG-XXXXX" value={form.registration_number} onChange={e => onChange('registration_number', e.target.value)} />
              </Field>
            </div>
            <div className="af-s6">
              <span className="field-label" id="af-class-label" style={{ display: 'block', marginBottom: 6 }}>Classification <span style={{ color: 'var(--slate-400)', fontWeight: 400 }}>(optional)</span></span>
              <div className="af-radios" role="radiogroup" aria-labelledby="af-class-label">
                {['private', 'public'].map(v => (
                  <label key={v} className="af-radio">
                    <input type="radio" name="vehicle_use" value={v} checked={form.vehicle_use === v} onChange={() => onChange('vehicle_use', v)} /> {vehicleUseLabel(v)}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* B. VEHICLE INFORMATION — no general License Number here */}
      <div className="af-section">
        <SectionHead icon={Car} title="Vehicle Information" sub="Provide the vehicle details." />
        <div className="af-grid">
          <div className={locked ? 'af-s5' : 'af-s6'}>
            {locked ? (
              <LockedField id="plate_number" label="Plate Number" value={form.plate_number} />
            ) : (
              <Field label="Plate Number" required error={errors.plate_number} htmlFor="plate_number"
                helper={lookupLoading ? 'Searching...' : lookupDone ? 'Violator info auto-filled' : 'Press Enter to auto-fill from records'} helperGreen={lookupDone}>
                <div style={{ position: 'relative' }}>
                  <input id="plate_number" className={`input ${errors.plate_number ? 'input-error' : ''}`} style={lookupStyle}
                    placeholder="e.g. ABC 1234" value={form.plate_number}
                    onChange={e => { onChange('plate_number', e.target.value); onLookupReset() }}
                    onKeyDown={e => { if (e.key === 'Enter') onLookup(form.plate_number) }}
                    onBlur={() => onLookup(form.plate_number)} />
                  {lookupLoading && <span className="spinner" style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14 }} />}
                </div>
              </Field>
            )}
          </div>
          {!locked && <VehicleSelectFields form={form} errors={errors} onChange={onChange} />}
        </div>
        {locked && <VehicleReadout form={form} />}
      </div>

      {/* C. CONFISCATION OF DOCUMENTS */}
      <ConfiscationSection
        form={form} errors={errors} onChange={onChange}
        statusLocked={locked} licenseLocked={!!violationData?.license_number}
        onLookupReset={locked ? undefined : onLookupReset} onLookup={locked ? undefined : onLookup}
      />

      {violationData?.image && (
        <div className="af-section">
          <p className="text-label" style={{ marginBottom: 8 }}>Evidence Photo</p>
          <EvidencePhoto src={violationData.image} alt="Evidence photo submitted with this violation" />
        </div>
      )}

      <div className="af-actions">
        <span />
        <div className="af-actions-end"><Button onClick={onNext}>Next: Violation Details →</Button></div>
      </div>
    </section>
  )
}

/* ── STEP 2: Violation Details & Fine Computation ── */
export function AssessmentStep2({
  form, errors, violationTypes, grouped, selectedIds, vtSearch, loadingTypes, totalPenalty, formatCurrency,
  violationData, onChange, onVtSearch, onToggleId, onBack, onNext,
}) {
  const locked = !!violationData
  const selectedTypes = (violationTypes || []).filter(vt => selectedIds.includes(vt.id))
  return (
    <section className="af-panel" aria-labelledby="af-step2-title">
      <h2 id="af-step2-title" className="sr-only">Step 2: Violation details and fine computation</h2>
      <ErrorSummary errors={errors} />

      <div className="af-section">
        <SectionHead icon={AlertTriangle} title="Violation Details" sub="When and where the violation happened." />
        {locked ? (
          <div className="af-grid">
            <div className="af-s3"><LockedField id="date" label="Date" value={form.date} /></div>
            <div className="af-s3"><LockedField id="time" label="Time" value={form.time} /></div>
            <div className="af-s6"><LockedField id="place_of_violation" label="Location" value={form.place_of_violation} /></div>
          </div>
        ) : (
          <div className="af-grid">
            <div className="af-s3">
              <Field label="Date" required error={errors.date} htmlFor="date" helper="Auto-filled" helperGreen>
                <input id="date" type="date" className={`input ${errors.date ? 'input-error' : ''}`} value={form.date} onChange={e => onChange('date', e.target.value)} />
              </Field>
            </div>
            <div className="af-s3">
              <Field label="Time" required error={errors.time} htmlFor="time" helper="Auto-filled" helperGreen>
                <input id="time" className={`input ${errors.time ? 'input-error' : ''}`} placeholder="HH:MM am/pm" value={form.time} onChange={e => onChange('time', e.target.value)} />
              </Field>
            </div>
            <div className="af-s6">
              <Field label="Location" required error={errors.place_of_violation} htmlFor="place_of_violation">
                <input id="place_of_violation" className={`input ${errors.place_of_violation ? 'input-error' : ''}`} placeholder="Exact location where violation occurred" value={form.place_of_violation} onChange={e => onChange('place_of_violation', e.target.value)} />
              </Field>
            </div>
          </div>
        )}
      </div>

      <div className="af-section" id="violations" tabIndex={-1}>
        <SectionHead icon={ClipboardList} title="Violation Type" sub={locked ? "From the Enforcer's submitted OVR — read-only" : 'Select all applicable violations.'} />
        {errors.violations && <p role="alert" style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--danger-600)', fontWeight: 600 }}>⚠ {errors.violations}</p>}
        {locked ? (
          <div className="af-vt-list">
            {selectedTypes.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--slate-400)', fontSize: 13 }}>No violations on this OVR.</div>
            ) : selectedTypes.map(vt => (
              <div key={vt.id} className="af-vt-row" data-locked="true" data-checked="true">
                <div className="af-vt-name">{vt.name}<div className="af-vt-code">{vt.code}</div></div>
                <div className="af-vt-amt">₱{Number(vt.penalty_amount).toLocaleString()}</div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="search-input-wrap" style={{ marginBottom: 8 }}>
              <Search size={14} className="search-input-icon" aria-hidden="true" />
              <input aria-label="Search violations" value={vtSearch} onChange={e => onVtSearch(e.target.value)} placeholder="Search violation type..." className="input" />
            </div>
            <div className="af-vt-list" role="group" aria-label="Violation types">
              {loadingTypes ? (
                <div style={{ textAlign: 'center', padding: 24, color: 'var(--slate-400)', fontSize: 13 }}>Loading violations...</div>
              ) : Object.entries(grouped).map(([cat, types]) => (
                <div key={cat}>
                  <div className="af-vt-cat"><span>{cat.charAt(0).toUpperCase() + cat.slice(1)}</span><span>{types.length} item{types.length !== 1 ? 's' : ''}</span></div>
                  {types.map(vt => {
                    const checked = selectedIds.includes(vt.id)
                    return (
                      <label key={vt.id} className="af-vt-row" data-checked={checked}>
                        <input type="checkbox" checked={checked} onChange={() => onToggleId(vt.id)} />
                        <span className="af-vt-name">{vt.name}<span className="af-vt-code" style={{ display: 'block' }}>{vt.code}</span></span>
                        <span className="af-vt-amt">₱{Number(vt.penalty_amount).toLocaleString()}</span>
                      </label>
                    )
                  })}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="af-section">
        <div className="af-fine" role="status" aria-live="polite">
          <div>
            <div className="af-fine-label">Fine Amount</div>
            <div className="af-fine-note">{selectedIds.length} violation{selectedIds.length !== 1 ? 's' : ''} selected · set by the system, non-adjustable</div>
          </div>
          <div className="af-fine-amt">{formatCurrency(totalPenalty)}</div>
        </div>
      </div>

      <div className="af-actions">
        <Button variant="secondary" onClick={onBack}>← Back</Button>
        <div className="af-actions-end"><Button onClick={onNext}>Next: Remarks &amp; Payment →</Button></div>
      </div>
    </section>
  )
}

/* ── STEP 3: Others / Remarks + Payment Details ── */
export function AssessmentStep3({ form, errors, violationData, totalPenalty, formatCurrency, onChange, onBack, onNext }) {
  const locked = !!violationData
  return (
    <section className="af-panel" aria-labelledby="af-step3-title">
      <h2 id="af-step3-title" className="sr-only">Step 3: Others, remarks and payment details</h2>
      <ErrorSummary errors={errors} />

      <div className="af-section">
        <SectionHead icon={FileText} title="Others / Remarks" sub={locked ? "Original remarks from the Enforcer's OVR — read-only" : 'Other details about the violation.'} />
        {locked ? (
          <Field label="Remarks" htmlFor="remarks">
            <textarea id="remarks" className="input" readOnly rows={4} style={{ ...readOnlyInput, fontWeight: 500, resize: 'none' }} value={violationData?.remarks || '—'} />
          </Field>
        ) : (
          <Field label="Remarks" optional htmlFor="remarks">
            <textarea id="remarks" className="input" rows={4} style={{ resize: 'vertical' }} placeholder="Add any other notes about this violation" value={form.remarks} onChange={e => onChange('remarks', e.target.value)} />
          </Field>
        )}
      </div>

      <div className="af-section">
        <SectionHead icon={CreditCard} title="Payment Details" sub="Recorded by the system when payment is confirmed." />
        <div className="af-grid">
          <div className="af-s6">
            <Field label="Amount Paid (₱)" htmlFor="amount_paid" helper="Fixed — the assessed fine, recorded on confirmation" helperGreen>
              <input id="amount_paid" className="input" style={readOnlyInput} readOnly value={formatCurrency(totalPenalty)} />
            </Field>
          </div>
          <div className="af-s6">
            <Field label="Date Paid" htmlFor="date_paid" helper="Recorded automatically when you confirm payment">
              <input id="date_paid" className="input" style={readOnlyInput} readOnly value="Set automatically on confirmation" />
            </Field>
          </div>
          <div className="af-s6">
            <Field label="O.R. Number" optional error={errors.or_number} htmlFor="or_number" helper="Enter it if you already have it. You may leave this blank.">
              <input id="or_number" className={`input ${errors.or_number ? 'input-error' : ''}`} placeholder="OR-2026-XXXXX" maxLength={50} value={form.or_number} onChange={e => onChange('or_number', e.target.value)} />
            </Field>
          </div>
          <div className="af-s6">
            <Field label="Assessed By" htmlFor="assessed_by" helper="The signed-in Assessment Staff" helperGreen>
              <input id="assessed_by" className="input" style={readOnlyInput} readOnly value={form.assessed_by} />
            </Field>
          </div>
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--slate-500)' }}>
          “Received by” is not filled in here — Treasury completes it by hand on the printed Assessment Form.
        </p>
      </div>

      <div className="af-actions">
        <Button variant="secondary" onClick={onBack}>← Back</Button>
        <div className="af-actions-end"><Button onClick={onNext}>Next: Review →</Button></div>
      </div>
    </section>
  )
}

const ReviewBlock = ({ title, step, paid, onEditStep, children }) => (
  <div className="af-review-block">
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <h3>{title}</h3>
      {!paid && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEditStep(step)} aria-label={`Edit ${title}`}>Edit</button>}
    </div>
    <dl style={{ margin: 0 }}>{children}</dl>
  </div>
)

const Row = ({ label, children }) => (
  <div className="af-review-row"><dt>{label}</dt><dd>{children || '—'}</dd></div>
)

/* ── STEP 4: Review (read-only; reads the SAME form state that is submitted) ── */
export function AssessmentStep4({ form, violationData, selectedTypes, totalPenalty, formatCurrency, onBack, onConfirmPayment, loading, paid, onEditStep }) {
  const status = form.license_status
  const docType = CONFISCATED_DOCUMENT_OPTIONS.find(o => o.value === form.confiscated_document_type)
  return (
    <section className="af-panel" aria-labelledby="af-step4-title">
      <div className="af-section" style={{ paddingBottom: 6 }}>
        <SectionHead icon={ClipboardList} title="Review" sub="Verify all information before confirming payment." />
        <h2 id="af-step4-title" className="sr-only">Step 4: Review</h2>
        <div className="af-review-grid">
          <div>
            <ReviewBlock paid={paid} onEditStep={onEditStep} title="Violator Information" step={1}>
              <Row label="Name">{form.full_name}</Row>
              <Row label="Address">{form.address}</Row>
              {form.registration_number && <Row label="Registration No.">{form.registration_number}</Row>}
              {form.vehicle_use && <Row label="Classification">{vehicleUseLabel(form.vehicle_use)}</Row>}
              {violationData && <Row label="OVR Number">{form.ovr_number}</Row>}
            </ReviewBlock>
            <ReviewBlock paid={paid} onEditStep={onEditStep} title="Vehicle Information" step={1}>
              <Row label="Plate Number">{form.plate_number}</Row>
              <Row label="Vehicle Type">{form.vehicle_type}</Row>
              <Row label="Make / Brand">{form.vehicle_brand}</Row>
              <Row label="Model">{form.vehicle_model}</Row>
            </ReviewBlock>
            <ReviewBlock paid={paid} onEditStep={onEditStep} title="Confiscation of Documents" step={1}>
              {status === 'confiscated' ? (
                <>
                  <Row label="Confiscation">Confiscated (driver&apos;s license held in custody)</Row>
                  <Row label="Type of Document">Driver&apos;s License</Row>
                  <Row label="Document Number">{form.license_number}</Row>
                </>
              ) : status === 'other_documents' ? (
                <>
                  <Row label="Confiscation">Other Documents (information recorded only)</Row>
                  <Row label="Type of Document">{form.confiscated_document_type === 'others' ? (form.confiscated_document_name || 'Others') : docType?.label}</Row>
                  <Row label="Document Number">{form.confiscated_document_number}</Row>
                </>
              ) : <Row label="Confiscation">Not Confiscated</Row>}
            </ReviewBlock>
          </div>
          <div>
            <ReviewBlock paid={paid} onEditStep={onEditStep} title="Violation Details" step={2}>
              <Row label="Date & Time">{`${form.date || ''} ${form.time || ''}`.trim()}</Row>
              <Row label="Location">{form.place_of_violation}</Row>
              <Row label="Violation Type">{selectedTypes.map(v => v.name).join(', ')}</Row>
            </ReviewBlock>
            <ReviewBlock paid={paid} onEditStep={onEditStep} title="Fine Amount" step={2}>
              <Row label="Fine Amount">{formatCurrency(totalPenalty)}</Row>
            </ReviewBlock>
            <ReviewBlock paid={paid} onEditStep={onEditStep} title="Others / Remarks" step={3}>
              <Row label="Remarks">{violationData ? violationData.remarks : form.remarks}</Row>
            </ReviewBlock>
            <ReviewBlock paid={paid} onEditStep={onEditStep} title="Payment Details" step={3}>
              <Row label="Amount Paid">{formatCurrency(totalPenalty)}</Row>
              <Row label="Date Paid">Recorded automatically on confirmation</Row>
              <Row label="O.R. Number">{form.or_number.trim() || 'Not entered (optional)'}</Row>
              <Row label="Assessed By">{form.assessed_by}</Row>
              <Row label="Received By">Left blank — Treasury signs by hand</Row>
            </ReviewBlock>
          </div>
        </div>
      </div>
      <div className="af-actions">
        <Button variant="secondary" onClick={onBack} disabled={!!loading || paid}>← Back</Button>
        <div className="af-actions-end">
          <Button style={{ background: '#7c3aed', color: '#fff', border: 'none' }} onClick={onConfirmPayment} loading={loading === 'paid'} disabled={paid}>
            {loading === 'paid' ? 'Processing...' : '✓ Confirm Payment'}
          </Button>
        </div>
      </div>
    </section>
  )
}