import { useId, useState } from 'react'
import { Calendar, Clock, ImagePlus, Pencil, ScanLine, Search } from 'lucide-react'
import { Alert, Button, Field, ReviewRow, ReviewSection, TextInput, Textarea } from '../../../../components/ui'
import { ErrorState } from '../../../../components/ui/States'
import { toTitleCase } from '../../../../utils/helpers'
import { formatScanFailure, hasReadableLicense } from '../../../../utils/licenseScan'
import LicenseScanner from './LicenseScanner'
import LicensePhotoUpload from './LicensePhotoUpload'
import VehicleFields from './VehicleFields'
import {
  buildViolatorName, formatIssuedDate, formatIssuedTime, formatIssuedDateTime, prettyCategory,
} from './helpers'

const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH')}`

function CardHead({ title, sub, action }) {
  return (
    <div className="ovr-card-head">
      <div>
        <h2 className="ovr-card-title">{title}</h2>
        {sub && <p className="ovr-card-sub">{sub}</p>}
      </div>
      {action}
    </div>
  )
}

/** Labelled radio group (a plain <label htmlFor> can't point at a group). */
function SegmentedField({ name, label, value, options, onChange }) {
  const labelId = useId()
  return (
    <div className="field">
      <span id={labelId} className="field-label">{label}</span>
      <div className="ovr-seg" role="radiogroup" aria-labelledby={labelId}>
        {options.map(([val, text]) => (
          <label key={val} className={`ovr-seg-item ${value === val ? 'is-selected' : ''}`}>
            <input type="radio" name={name} value={val} checked={value === val} onChange={() => onChange(val)} />
            <span>{text}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

/* ───────────────────────── Step 1 — Driver & Vehicle ─────────────────────────
 * Driver Information comes first (the enforcer identifies / scans the driver
 * before completing the vehicle), then Vehicle Information. Only the ORDER of
 * the two cards changed — every field, handler and payload key is the same.
 *
 * License status is an explicit enforcer choice. Scanning a license never
 * flips it (mergeOcrIntoForm doesn't touch license_status). Confiscated shows
 * a summary only — the existing Enforcer data model has no extra confiscation
 * inputs (Staff completes the document details during assessment), and the
 * License no. is read live from form.license_number, so there is one source
 * of truth and nothing to type twice. */
export function StepDriverVehicle({
  form, setForm, errors, repeatInfo, lookupLoading, onLookup, onApplyOcr,
  plateLookupLoading, vehicleFound, onPlateLookup,
}) {
  const [scanOpen, setScanOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [ocrApplied, setOcrApplied] = useState(false)
  const [uploadNote, setUploadNote] = useState(null)
  const set = (patch) => setForm(f => ({ ...f, ...patch }))

  const openScan = () => { setScanOpen(o => !o); setUploadOpen(false) }
  const openUpload = () => { setUploadOpen(o => !o); setScanOpen(false) }

  const confiscated = form.license_status === 'confiscated'
  const licenseNo = (form.license_number || '').trim()

  return (
    <>
      <section className="card card-padded ovr-card">
        <CardHead
          title="Driver Information"
          sub="Scan the driver's license to fill this in, or type it manually."
          action={(
            <div className="ovr-head-actions">
              <Button variant="secondary" size="sm" icon={ScanLine} onClick={openScan}>
                {scanOpen ? 'Close scanner' : 'Scan license'}
              </Button>
              <Button variant="secondary" size="sm" icon={ImagePlus} onClick={openUpload}>
                {uploadOpen ? 'Close upload' : 'Upload Photo'}
              </Button>
            </div>
          )}
        />

        {scanOpen && (
          <LicenseScanner
            onClose={() => setScanOpen(false)}
            onApply={(parsed) => { onApplyOcr(parsed); setOcrApplied(true); setScanOpen(false) }}
          />
        )}
        {ocrApplied && !scanOpen && (
          <div style={{ marginBottom: 'var(--space-4)' }}>
            <Alert tone="info">Filled in from the scanned license. Check each field before you continue.</Alert>
          </div>
        )}

        {uploadOpen && (
          <LicensePhotoUpload
            photo={form.license_photo}
            onChange={(file) => {
              set({ license_photo: file })
              setUploadNote(null)
            }}
            onClose={() => setUploadOpen(false)}
            onScan={(outcome) => {
              if (outcome?.ok && hasReadableLicense(outcome.parsed)) {
                onApplyOcr(outcome.parsed)
                setOcrApplied(true)
                setUploadNote(null)
                return
              }
              if (outcome?.ok) {
                setUploadNote({ text: 'Nothing readable was found in the photo. Type the details below.', alert: false })
                return
              }
              setUploadNote({ text: formatScanFailure(outcome), alert: true })
            }}
          />
        )}
        {form.license_photo && !uploadOpen && (
          <div className="ovr-scan" style={{ marginBottom: 'var(--space-4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
              <span className="ovr-scan-title"><ImagePlus size={16} aria-hidden="true" /> Photo attached</span>
              <Button variant="secondary" size="sm" onClick={openUpload}>Remove / replace</Button>
            </div>
            {uploadNote && (
              <p className={uploadNote.alert ? 'ovr-inline-error' : 'ovr-inline-note'} role={uploadNote.alert ? 'alert' : 'status'} style={{ marginBottom: 0 }}>
                {uploadNote.text}
              </p>
            )}
          </div>
        )}

        <div className="ovr-stack">
          <div className="ovr-grid ovr-grid--name">
            <Field label="Last name" required error={errors.last_name}>
              {id => <TextInput id={id} value={form.last_name} error={!!errors.last_name} placeholder="Dela Cruz" autoComplete="off"
                onChange={e => set({ last_name: e.target.value })}
                onBlur={e => set({ last_name: toTitleCase(e.target.value) })} />}
            </Field>
            <Field label="First name" required error={errors.first_name}>
              {id => <TextInput id={id} value={form.first_name} error={!!errors.first_name} placeholder="Juan" autoComplete="off"
                onChange={e => set({ first_name: e.target.value })}
                onBlur={e => set({ first_name: toTitleCase(e.target.value) })} />}
            </Field>
            <Field label="M.I.">
              {id => <TextInput id={id} value={form.middle_initial} placeholder="S" maxLength={3} autoComplete="off"
                onChange={e => set({ middle_initial: e.target.value })}
                onBlur={e => set({ middle_initial: toTitleCase(e.target.value) })} />}
            </Field>
          </div>

          <Field label="Address">
            {id => <TextInput id={id} value={form.address} placeholder="Barangay, City / Municipality" autoComplete="off"
              onChange={e => set({ address: e.target.value })}
              onBlur={e => set({ address: toTitleCase(e.target.value) })} />}
          </Field>

          <Field label="License no."
            helper={lookupLoading ? 'Checking records…' : 'Leave the field to check for earlier violations.'}>
            {id => <TextInput id={id} className="mono" value={form.license_number} placeholder="A01-23-456789" autoComplete="off"
              onChange={e => set({ license_number: e.target.value })}
              onBlur={e => onLookup(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onLookup(form.license_number) } }} />}
          </Field>

          {repeatInfo?.violation_count > 0 && (
            <Alert tone="warning" title="Repeat violator">
              {repeatInfo.violation_count} earlier violation{repeatInfo.violation_count !== 1 ? 's' : ''} on record for this license.
            </Alert>
          )}

          <SegmentedField name="license_status" label="License status" value={form.license_status}
            options={[['not_confiscated', 'Not confiscated'], ['confiscated', 'Confiscated']]}
            onChange={v => set({ license_status: v })} />

          {confiscated && (
            <div className="ovr-confiscated ovr-reveal" role="group" aria-label="Confiscated driver's license">
              <span className="ovr-confiscated-title">Driver&apos;s license confiscated</span>
              <div className="ovr-confiscated-row">
                <span className="ovr-confiscated-label">License no.</span>
                {licenseNo
                  ? <span className="ovr-confiscated-value mono">{licenseNo}</span>
                  : <span className="ovr-confiscated-missing">Not entered yet. Fill in License no. above.</span>}
              </div>
              <p className="ovr-confiscated-note">Staff completes the remaining confiscation details during assessment.</p>
            </div>
          )}
        </div>
      </section>

      <section className="card card-padded ovr-card">
        <CardHead title="Vehicle Information" sub="Enter the plate number, then choose the vehicle from the list." />
        <div className="ovr-stack">
          <div className="ovr-grid ovr-grid--2">
            <Field label="Plate / body no."
              helper={plateLookupLoading ? 'Checking records…' : vehicleFound ? 'Vehicle information found — check Brand/Model below.' : 'Leave the field to check for a matching vehicle on record.'}>
              {id => <TextInput id={id} className="mono ovr-plate" value={form.plate_number} placeholder="ABC 1234"
                autoCapitalize="characters" autoComplete="off"
                onChange={e => set({ plate_number: e.target.value.toUpperCase() })}
                onBlur={e => onPlateLookup?.(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onPlateLookup?.(form.plate_number) } }} />}
            </Field>
            <Field label="Registration no.">
              {id => <TextInput id={id} className="mono" value={form.registration_number} placeholder="Optional"
                autoComplete="off" onChange={e => set({ registration_number: e.target.value.toUpperCase() })} />}
            </Field>
          </div>

          <VehicleFields form={form} setForm={setForm} errors={errors} />

          <SegmentedField name="vehicle_use" label="Vehicle use" value={form.vehicle_use}
            options={[['private', 'Private'], ['public', 'Public']]} onChange={v => set({ vehicle_use: v })} />
        </div>
      </section>
    </>
  )
}

/* ───────────────────────── Step 2 — Violation ───────────────────────── */
function ViolationRow({ vtype, checked, onToggle }) {
  return (
    <label className={`ovr-vrow ${checked ? 'is-checked' : ''}`}>
      <input type="checkbox" checked={checked} onChange={() => onToggle(vtype.id)} />
      <span className="ovr-vrow-box" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2l2.4 2.4 4.6-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <span className="ovr-vrow-text">
        <span className="ovr-vrow-name">{vtype.name}</span>
        <span className="ovr-vrow-code">{vtype.code}</span>
      </span>
      <span className="ovr-vrow-fine">{peso(vtype.penalty_amount)}</span>
    </label>
  )
}

export function StepViolation({
  violationTypes, loadingTypes, typesError, onRetryTypes,
  selectedIds, toggleId, search, setSearch, totalPenalty,
  form, setForm, errors, gps,
}) {
  const q = search.trim().toLowerCase()
  const filtered = violationTypes.filter(vt => !q || vt.name.toLowerCase().includes(q) || vt.code.toLowerCase().includes(q))
  const grouped = filtered.reduce((acc, vt) => { (acc[vt.category] ||= []).push(vt); return acc }, {})

  return (
    <>
      <section className="card card-padded ovr-card">
        <CardHead title="Violation Information" sub="Tick every violation that applies." />

        <div className="ovr-search">
          <Search size={15} aria-hidden="true" />
          <input className="input" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or code" aria-label="Search violations" />
        </div>

        {typesError ? (
          <ErrorState message={typesError} onRetry={onRetryTypes} />
        ) : loadingTypes && violationTypes.length === 0 ? (
          <div className="ovr-vlist-empty"><span className="spinner" style={{ width: 20, height: 20 }} aria-hidden="true" /> Loading violations…</div>
        ) : (
          <div className="ovr-vlist" role="group" aria-label="Violations">
            {Object.entries(grouped).map(([cat, types]) => (
              <div key={cat}>
                <div className="ovr-vlist-group">{prettyCategory(cat)} <span>{types.length}</span></div>
                {types.map(vt => (
                  <ViolationRow key={vt.id} vtype={vt} checked={selectedIds.includes(vt.id)} onToggle={toggleId} />
                ))}
              </div>
            ))}
            {Object.keys(grouped).length === 0 && (
              <div className="ovr-vlist-empty">
                {violationTypes.length !== 0
                  ? 'No violation matches your search.'
                  : (typeof navigator !== 'undefined' && !navigator.onLine)
                    ? 'These options have not been cached on this device yet. Connect to the internet once to load the latest options.'
                    : 'No violations are available yet.'}
              </div>
            )}
          </div>
        )}
        {errors.violations && <span className="field-error-text" role="alert" style={{ display: 'block', marginTop: 8 }}>{errors.violations}</span>}

        {selectedIds.length > 0 && (
          <div className="ovr-total" aria-live="polite">
            <span>{selectedIds.length} violation{selectedIds.length !== 1 ? 's' : ''} selected</span>
            <strong>{peso(totalPenalty)}</strong>
          </div>
        )}
      </section>

      <section className="card card-padded ovr-card">
        <CardHead title="Location and Time" sub="Where and when the violation happened." />
        <div className="ovr-stack">
          <Field label="Location" required error={errors.location}
            helper={form.location ? 'Filled in from GPS. Edit it if it isn’t right.' : gps === 'locating' ? 'Getting your location…' : gps === 'unavailable' ? 'GPS is unavailable. Type the location.' : 'Couldn’t look up the address. Type the location.'}>
            {id => <TextInput id={id} value={form.location} error={!!errors.location} placeholder="Street, Barangay, Lucena City" autoComplete="off"
              onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />}
          </Field>

          <div className="ovr-grid ovr-grid--2">
            <Field label="Date">
              {id => (
                <div className="ovr-affix">
                  <Calendar size={15} aria-hidden="true" />
                  <input id={id} className="input" readOnly value={formatIssuedDate(form.date_issued)} />
                </div>
              )}
            </Field>
            <Field label="Time" helper="Fixed automatically when you submit.">
              {id => (
                <div className="ovr-affix">
                  <Clock size={15} aria-hidden="true" />
                  <input id={id} className="input" readOnly value={formatIssuedTime(form.date_issued)} />
                </div>
              )}
            </Field>
          </div>

          <Field label="Additional notes" helper="Optional">
            {id => <Textarea id={id} rows={3} value={form.remarks} placeholder="Anything else worth recording…"
              onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} />}
          </Field>
        </div>
      </section>
    </>
  )
}

/* ───────────────────────── Step 3 — Review & Submit ───────────────────────── */
export function StepReview({ form, setForm, errors, selectedViolations, totalPenalty, onEdit }) {
  const edit = (step) => (
    <button type="button" className="ovr-edit" onClick={() => onEdit(step)}>
      <Pencil size={12} aria-hidden="true" /> Edit
    </button>
  )

  return (
    <>
      <section className="card card-padded ovr-card">
        <CardHead title="Review and Submit" sub="Check everything before you submit. It goes to Staff for assessment." />

        <ReviewSection title="Driver" action={edit(1)}>
          <ReviewRow label="Name" value={buildViolatorName(form)} />
          <ReviewRow label="Address" value={form.address} />
          <ReviewRow label="License no." value={form.license_number} />
          <ReviewRow label="License status" value={form.license_status === 'confiscated' ? 'Confiscated' : 'Not confiscated'} />
        </ReviewSection>

        <ReviewSection title="Vehicle" action={edit(1)}>
          <ReviewRow label="Plate / body no." value={form.plate_number} />
          <ReviewRow label="Type" value={form.vehicle_type} />
          <ReviewRow label="Brand / model" value={[form.vehicle_brand, form.vehicle_model].filter(Boolean).join(' ')} />
          <ReviewRow label="Registration no." value={form.registration_number} />
          <ReviewRow label="Use" value={form.vehicle_use === 'public' ? 'Public' : 'Private'} />
        </ReviewSection>

        <ReviewSection title="Violation" action={edit(2)}>
          {selectedViolations.map(vt => <ReviewRow key={vt.id} label={vt.name} value={peso(vt.penalty_amount)} />)}
          <ReviewRow label="Total fine" value={peso(totalPenalty)} emphasis />
          <ReviewRow label="Location" value={form.location} />
          <ReviewRow label="Date and time" value={`${formatIssuedDateTime(form.date_issued)} (set on submit)`} />
          <ReviewRow label="Notes" value={form.remarks} />
        </ReviewSection>
      </section>

      <section className="card card-padded ovr-card">
        <CardHead title="Manual Inputs" sub="Copy this from the printed OVR booklet from City Hall." />
        <div className="ovr-stack">
          <Field label="OVR number" required error={errors.ovr_number}>
            {id => <TextInput id={id} className="mono ovr-ovrno" value={form.ovr_number} error={!!errors.ovr_number}
              placeholder="A 00070851" autoComplete="off" autoCapitalize="characters"
              onChange={e => setForm(f => ({ ...f, ovr_number: e.target.value.toUpperCase() }))} />}
          </Field>
          <Alert tone="info">The O.R. number is recorded by Staff when the fine is paid. You don&apos;t enter it here.</Alert>
        </div>
      </section>
    </>
  )
}