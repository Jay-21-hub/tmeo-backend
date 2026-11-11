import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Send } from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { Alert, Button, ConfirmDialog } from '../../../components/ui'
import { StepDriverVehicle, StepViolation, StepReview } from './issue-ovr/Steps'
import SuccessScreen from './issue-ovr/SuccessScreen'
import {
  buildOvrFormData, emptyForm, isFormDirty, manilaNowIso, mergeOcrIntoForm,
} from './issue-ovr/helpers'
import { filterTypesByVehicle, pruneSelectedIds } from '../../../utils/violationTypeFilter'
import './IssueOVR.css'

/**
 * Issue OVR — three steps, one screen per step:
 *   1 Driver & Vehicle · driver details first (license scan lives here), then vehicle details
 *   2 Violation · what happened, where, when
 *   3 Review    · read-only summary + the manually typed OVR number → Submit
 *
 * Talks to (unchanged) backend endpoints only:
 *   GET  /api/violations/types/            violation catalog
 *   GET  /api/violations/vehicle-brands/   vehicle catalog (via useVehicleCatalog)
 *   POST /api/violations/scan-license/     driver's-license OCR
 *   GET  /api/violations/violator-lookup/  repeat-violator check (by license_number)
 *                                          + vehicle-info lookup (by plate_number)
 *   POST /api/violations/create/           multipart, see buildOvrFormData()
 *
 * Violation list per vehicle type: every violation type is assigned to one
 * vehicle type (ViolationType.vehicle_category). Step 2 only offers the
 * violations that apply to the vehicle type chosen in Step 1 (types that are
 * not assigned yet are offered for every vehicle type). When the vehicle type
 * changes, any ticked violation that no longer applies is dropped. The
 * backend enforces the same rule on create, so this is a convenience filter,
 * not the only check.
 *
 * Online Plate Number lookup (added alongside the existing License Number
 * lookup): on blur, the same violator-lookup endpoint is queried by
 * plate_number. If a matching historical vehicle record is found, Vehicle
 * Brand/Model/Type are suggested — but ONLY into fields that are still
 * empty. A value the enforcer already picked/typed is never overwritten
 * (same "fill blanks only" rule the License Number → Address autofill and
 * the OCR merge already follow). This is online-only, courtesy-only: a
 * failed or no-match lookup never blocks the form or destroys anything
 * typed.
 *
 * Date and time are read-only. The value on screen is a live clock; the
 * time that is actually recorded is stamped at the moment Submit is
 * pressed (see handleSubmit).
 *
 * The OVR number is entered by hand from the City Hall booklet. The O.R.
 * number is NOT collected here — it belongs to the Staff-side Assessment
 * record and is entered when the fine is paid.
 *
 * Issue OVR is the ONLINE OVR workflow only. If Submit is pressed while
 * there's no connection, nothing is queued here — the enforcer is pointed
 * to Sync Data → Save Offline Report, which is the single dedicated
 * offline-entry point (shares the same `tmeo_offline_reports` queue /
 * sync engine, see useOfflineQueue.js). This keeps there from being two
 * different places an offline OVR could come from.
 */

const STEPS = [
  { id: 1, label: 'Driver & Vehicle' },
  { id: 2, label: 'Violation' },
  { id: 3, label: 'Review' },
]

const TYPES_CACHE_KEY = 'tmeo_cached_violation_types'
const readCachedTypes = () => {
  try { return JSON.parse(localStorage.getItem(TYPES_CACHE_KEY) || '[]') } catch { return [] }
}

// Which fields each step is responsible for.
const STEP_FIELDS = {
  1: ['last_name', 'first_name', 'vehicle_type'],
  2: ['violations', 'location'],
  3: ['ovr_number'],
}

function collectIssues(form, selectedIds) {
  const issues = {}
  if (!form.last_name.trim()) issues.last_name = 'Last name is required.'
  if (!form.first_name.trim()) issues.first_name = 'First name is required.'
  if (!form.vehicle_type.trim()) issues.vehicle_type = 'Choose the vehicle type.'
  if (selectedIds.length === 0) issues.violations = 'Select at least one violation.'
  if (!form.location.trim()) issues.location = 'Location is required.'
  if (!form.ovr_number.trim()) issues.ovr_number = 'Enter the OVR number from the City Hall booklet.'
  return issues
}

function describeApiError(data) {
  if (!data) return 'Couldn’t submit the OVR. Check your connection and try again.'
  if (typeof data === 'string') return data.length < 200 ? data : 'Couldn’t submit the OVR. Please try again.'
  if (data.detail) return String(data.detail)
  const [key, val] = Object.entries(data)[0] || []
  const msg = Array.isArray(val) ? val[0] : val
  if (!key || !msg) return 'Couldn’t submit the OVR. Please try again.'
  const label = key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
  return `${label}: ${msg}`
}

function Stepper({ current, onJump }) {
  return (
    <ol className="ovr-stepper" aria-label="Progress">
      {STEPS.map(({ id, label }) => {
        const state = id < current ? 'done' : id === current ? 'active' : 'todo'
        return (
          <li key={id} className={`ovr-step ovr-step--${state}`} aria-current={state === 'active' ? 'step' : undefined}>
            <button type="button" className="ovr-step-btn" disabled={state !== 'done'} onClick={() => onJump(id)}>
              <span className="ovr-step-dot" aria-hidden="true">{state === 'done' ? <Check size={14} strokeWidth={3} /> : id}</span>
              <span className="ovr-step-label">{label}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

export default function IssueOVR({ onSuccess, setPage }) {
  const pageRef = useRef(null)
  const submittingRef = useRef(false)

  const [step, setStep] = useState(1)
  const [form, setForm] = useState(emptyForm)
  const [selectedIds, setSelectedIds] = useState([])
  const [flagged, setFlagged] = useState({})
  const [error, setError] = useState('')
  // Set instead of `error` when Submit is pressed with no connection.
  // Issue OVR never queues an offline record itself (Sync Data does) —
  // this just tells the enforcer where to go, without touching what
  // they've typed.
  const [offlineNotice, setOfflineNotice] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(null)   // { data, snapshot } — online success only
  const [leaveOpen, setLeaveOpen] = useState(false)

  const [violationTypes, setViolationTypes] = useState(readCachedTypes)
  const [loadingTypes, setLoadingTypes] = useState(true)
  const [typesError, setTypesError] = useState('')
  const [search, setSearch] = useState('')

  const [repeatInfo, setRepeatInfo] = useState(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  // License lookup bookkeeping: lookupKeyRef = the value last looked up (an
  // identical repeat — Enter followed by blur, or OCR Apply followed by blur —
  // is skipped); lookupSeqRef = newest request wins.
  const lookupKeyRef = useRef('')
  const lookupSeqRef = useRef(0)
  // Plate Number lookup is a separate, independent request from the License
  // Number one above — its own loading flag and its own "found" indicator
  // (not the repeat-violator badge, which stays tied to License Number).
  const [plateLookupLoading, setPlateLookupLoading] = useState(false)
  const [vehicleFound, setVehicleFound] = useState(false)
  const [gps, setGps] = useState(() => (typeof navigator !== 'undefined' && navigator.geolocation ? 'locating' : 'unavailable'))

  /* ── data loading ── */
  const loadTypes = useCallback(() => {
    if (!navigator.onLine) {
      // No point attempting a request we already know will fail. Whatever
      // was cached (readCachedTypes, above) is already the initial state;
      // an empty cache here is a real "not cached yet" state, not an error.
      setLoadingTypes(false)
      return
    }
    api.get(API.VIOLATION_TYPES)
      .then(res => {
        const list = (Array.isArray(res.data) ? res.data : res.data.results || []).filter(vt => vt.is_active)
        setViolationTypes(list)
        setTypesError('')
        try { localStorage.setItem(TYPES_CACHE_KEY, JSON.stringify(list)) } catch { /* storage full — the cache is optional */ }
      })
      .catch(() => setTypesError('Couldn’t load the violation list. Check your connection and try again.'))
      .finally(() => setLoadingTypes(false))
  }, [])

  useEffect(() => { loadTypes() }, [loadTypes])

  const retryTypes = () => { setTypesError(''); setLoadingTypes(true); loadTypes() }

  // The vehicle type decides which violations apply. When it changes (picked
  // in Step 1, or suggested by the plate lookup), drop any ticked violation
  // that no longer applies. Skipped until the violation list is loaded so a
  // slow/empty list never clears a valid selection. Returning `prev` when
  // nothing is dropped avoids a pointless re-render.
  useEffect(() => {
    if (violationTypes.length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- keeps the ticked violations in step with the chosen vehicle type
    setSelectedIds(prev => {
      const next = pruneSelectedIds(prev, violationTypes, form.vehicle_type)
      return next.length === prev.length ? prev : next
    })
  }, [form.vehicle_type, violationTypes])

  // GPS + reverse geocoding (Nominatim — same pattern as SubmitReport / GPSTracking).
  // Never overwrites a location the enforcer already typed.
  const requestPosition = useCallback(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = pos.coords.latitude.toFixed(6)
      const lng = pos.coords.longitude.toFixed(6)
      setForm(f => ({ ...f, latitude: lat, longitude: lng }))
      setGps('ready')
      fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`)
        .then(r => r.json())
        .then(data => {
          const a = data?.address
          if (!a) return
          const parts = [a.road, a.suburb || a.village || a.neighbourhood, a.city || a.town].filter(Boolean)
          const auto = parts.length ? parts.join(', ') : data.display_name
          if (auto) setForm(f => (f.location.trim() ? f : { ...f, location: auto }))
        })
        .catch(() => {})
    }, () => setGps('unavailable'), { enableHighAccuracy: true, timeout: 8000 })
  }, [])

  useEffect(() => { requestPosition() }, [requestPosition])

  // Keep the on-screen date/time current. Display only — Submit re-stamps it.
  useEffect(() => {
    const timer = setInterval(() => setForm(f => ({ ...f, date_issued: manilaNowIso() })), 15000)
    return () => clearInterval(timer)
  }, [])

  const handleLicenseLookup = async (licenseNumber) => {
    const value = (licenseNumber || '').trim()
    const key = value.toLowerCase()
    if (!key) {
      lookupSeqRef.current += 1; lookupKeyRef.current = ''
      setLookupLoading(false); setRepeatInfo(null)
      return
    }
    if (key === lookupKeyRef.current) return   // same value already checked
    lookupKeyRef.current = key
    const seq = ++lookupSeqRef.current
    setLookupLoading(true)
    try {
      const res = await api.get(`/api/violations/violator-lookup/?license_number=${encodeURIComponent(value)}`)
      if (seq !== lookupSeqRef.current) return  // a newer lookup superseded this one
      const data = res.data
      if (data?.found && data.match) {
        setForm(f => ({ ...f, address: f.address || data.match.address || '' }))
      }
      setRepeatInfo(data?.violation_count > 0 ? data : null)
    } catch {
      // lookup is a courtesy — never block the form on it. Allow a retry.
      if (seq === lookupSeqRef.current) lookupKeyRef.current = ''
    } finally {
      if (seq === lookupSeqRef.current) setLookupLoading(false)
    }
  }

  // Apply a scanned license: same fill-blanks-only merge as before, and then
  // the SAME earlier-violation lookup the License no. field uses on blur —
  // previously an OCR-filled License no. was only checked if the enforcer
  // happened to focus and leave the field. License status is never touched.
  const handleApplyOcr = (parsed) => {
    setForm(f => mergeOcrIntoForm(f, parsed))
    const lic = (form.license_number || parsed?.license_number || '').trim()
    if (lic) handleLicenseLookup(lic)
  }

  // Online Plate Number lookup (NEW). Reuses the same violator-lookup
  // endpoint as License Number, queried by plate_number instead. Only
  // suggests Vehicle Type/Brand/Model into fields that are currently
  // empty — a value the enforcer already selected/typed is left alone.
  const handlePlateLookup = async (plateNumber) => {
    if (!plateNumber?.trim()) { setVehicleFound(false); return }
    if (!navigator.onLine) { setVehicleFound(false); return }
    setPlateLookupLoading(true)
    try {
      const res = await api.get(`/api/violations/violator-lookup/?plate_number=${encodeURIComponent(plateNumber.trim())}`)
      const data = res.data
      if (data?.found && data.match) {
        const m = data.match
        setForm(f => ({
          ...f,
          vehicle_type: f.vehicle_type || m.vehicle_type || '',
          vehicle_brand: f.vehicle_brand || m.vehicle_brand || '',
          vehicle_model: f.vehicle_model || m.vehicle_model || '',
        }))
        setVehicleFound(!!(m.vehicle_brand || m.vehicle_model || m.vehicle_type))
      } else {
        setVehicleFound(false)
      }
    } catch { /* lookup is a courtesy — never block the form on it */ }
    finally { setPlateLookupLoading(false) }
  }

  /* ── derived ── */
  const toggleId = id => setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  const selectedViolations = violationTypes.filter(vt => selectedIds.includes(vt.id))
  const totalPenalty = selectedViolations.reduce((sum, vt) => sum + Number(vt.penalty_amount), 0)
  // Only the violations that apply to the vehicle type chosen in Step 1 are
  // offered in Step 2 (unassigned types and unresolvable vehicle types show all).
  const availableTypes = filterTypesByVehicle(violationTypes, form.vehicle_type)

  // An error shows only while its field is still wrong, so it clears the
  // moment the enforcer fixes it.
  const issues = collectIssues(form, selectedIds)
  const errors = Object.fromEntries(Object.keys(flagged).filter(k => issues[k]).map(k => [k, issues[k]]))

  useEffect(() => { pageRef.current?.scrollIntoView({ block: 'start' }) }, [step, submitted])

  /* ── navigation ── */
  const flagAndScroll = (keys) => {
    setFlagged(f => ({ ...f, ...Object.fromEntries(keys.map(k => [k, true])) }))
    setTimeout(() => {
      const target = pageRef.current?.querySelector('.input-error, .field-error-text')
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      if (target?.focus) target.focus({ preventScroll: true })
    }, 0)
  }

  const goNext = () => {
    setError(''); setOfflineNotice(false)
    const bad = STEP_FIELDS[step].filter(k => issues[k])
    if (bad.length) { flagAndScroll(bad); return }
    setStep(s => Math.min(s + 1, STEPS.length))
  }
  const goBack = () => { setError(''); setOfflineNotice(false); setStep(s => Math.max(s - 1, 1)) }
  const jumpTo = (n) => { if (n < step) { setError(''); setOfflineNotice(false); setStep(n) } }

  const leave = () => {
    if (isFormDirty(form, selectedIds)) setLeaveOpen(true)
    else setPage?.('dashboard')
  }

  const resetForm = () => {
    setStep(1); setSelectedIds([]); setFlagged({}); setError(''); setOfflineNotice(false); setSearch('')
    setRepeatInfo(null); setVehicleFound(false); setSubmitted(null)
    lookupSeqRef.current += 1; lookupKeyRef.current = ''; setLookupLoading(false)
    setForm(emptyForm())
    if (navigator.geolocation) setGps('locating')
    requestPosition()
  }

  /* ── submit ── */
  const handleSubmit = async () => {
    if (submittingRef.current) return
    setError(''); setOfflineNotice(false)

    const bad = Object.keys(issues)
    if (bad.length) {
      // Something earlier was changed after the fact — send them to it.
      const firstStep = [1, 2, 3].find(n => STEP_FIELDS[n].some(k => issues[k]))
      if (firstStep !== step) setStep(firstStep)
      flagAndScroll(bad)
      return
    }

    // Issue OVR is the online workflow only — if there's plainly no
    // connection, don't even attempt the request (and don't touch
    // anything the enforcer has typed). Send them to Sync Data instead.
    if (!navigator.onLine) {
      setOfflineNotice(true)
      return
    }

    submittingRef.current = true
    setSubmitting(true)
    // The recorded date/time is the moment of submission, in Manila time.
    const stamped = { ...form, date_issued: manilaNowIso() }
    const snapshot = {
      ovr_number: stamped.ovr_number.trim(), plate_number: stamped.plate_number, location: stamped.location,
      date_issued: stamped.date_issued, violationNames: selectedViolations.map(v => v.name),
    }

    try {
      const res = await api.post('/api/violations/create/', buildOvrFormData(stamped, selectedIds), {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setSubmitted({ data: res.data, snapshot })
      window.dispatchEvent(new Event('violation-submitted'))
      onSuccess?.(res.data)
    } catch (err) {
      // A network-style failure with no server response at all (flaky
      // connection, DNS blip, request timeout, navigator.onLine flipping
      // mid-request) means the OVR never reached TMEO. Issue OVR does NOT
      // queue it locally — Sync Data → Save Offline Report is the one
      // dedicated offline-entry point (see file header). Nothing typed
      // here is discarded: the form and its data stay exactly as they
      // were, so the enforcer can either retry once back online or
      // re-enter the same details in Sync Data right now.
      //
      // A real server-returned error (err.response present, e.g. 400
      // validation, 401, 500) reached TMEO and is a genuine failure, not
      // a connectivity issue — that still shows as a normal error.
      const isNetworkFailure = !err?.response
      if (isNetworkFailure) {
        setOfflineNotice(true)
      } else {
        setError(describeApiError(err?.response?.data))
      }
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  /* ── render ── */
  if (submitted) {
    return (
      <div className="ovr-page" ref={pageRef}>
        <SuccessScreen
          data={submitted.data}
          fallback={submitted.snapshot}
          onIssueAnother={resetForm}
          onViewDetails={setPage ? () => setPage('reports') : undefined}
        />
      </div>
    )
  }

  return (
    <div className="ovr-page" ref={pageRef}>
      <header className="ovr-header">
        <button type="button" className="ovr-back" onClick={step === 1 ? leave : goBack}
          aria-label={step === 1 ? 'Back to dashboard' : 'Previous step'}>
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <div>
          <h1 className="ovr-title">Issue OVR</h1>
          <p className="ovr-subtitle">Create a new violation ticket. Follow the steps to complete the form.</p>
        </div>
      </header>

      <Stepper current={step} onJump={jumpTo} />

      {error && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Alert tone="danger" title="OVR not submitted">{error}</Alert>
        </div>
      )}

      {offlineNotice && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Alert tone="warning" title="You're offline">
            <p style={{ margin: 0 }}>
              Issue OVR needs a connection to submit. To create a violation while offline, use Sync Data — what
              you've entered here is still on screen if you'd like to re-enter it there.
            </p>
            {setPage && (
              <div style={{ marginTop: 'var(--space-2)' }}>
                <Button variant="secondary" size="sm" onClick={() => setPage('sync')}>Go to Sync Data</Button>
              </div>
            )}
          </Alert>
        </div>
      )}

      <div className="ovr-layout">
        <div className="ovr-main">
          {step === 1 && (
            <StepDriverVehicle form={form} setForm={setForm} errors={errors}
              repeatInfo={repeatInfo} lookupLoading={lookupLoading} onLookup={handleLicenseLookup}
              plateLookupLoading={plateLookupLoading} vehicleFound={vehicleFound} onPlateLookup={handlePlateLookup}
              onApplyOcr={handleApplyOcr} />
          )}
          {step === 2 && (
            <StepViolation
              violationTypes={availableTypes} loadingTypes={loadingTypes}
              typesError={violationTypes.length === 0 ? typesError : ''} onRetryTypes={retryTypes}
              selectedIds={selectedIds} toggleId={toggleId} search={search} setSearch={setSearch}
              totalPenalty={totalPenalty} form={form} setForm={setForm} errors={errors} gps={gps} />
          )}
          {step === 3 && (
            <StepReview form={form} setForm={setForm} errors={errors}
              selectedViolations={selectedViolations} totalPenalty={totalPenalty} onEdit={jumpTo} />
          )}

          <div className="ovr-actions">
            {step === 1
              ? <Button variant="secondary" onClick={leave}>Cancel</Button>
              : <Button variant="secondary" onClick={goBack} disabled={submitting}>Back</Button>}
            {step < STEPS.length
              ? <Button variant="primary" iconRight={ArrowRight} onClick={goNext}>Next</Button>
              : <Button variant="primary" icon={Send} onClick={handleSubmit} loading={submitting}>
                  {submitting ? 'Submitting…' : 'Submit OVR'}
                </Button>}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={leaveOpen} onClose={() => setLeaveOpen(false)} tone="danger"
        title="Discard this OVR?" message="The details you entered will be lost."
        confirmLabel="Discard" cancelLabel="Keep editing"
        onConfirm={() => { setLeaveOpen(false); setPage?.('dashboard') }}
      />
    </div>
  )
}