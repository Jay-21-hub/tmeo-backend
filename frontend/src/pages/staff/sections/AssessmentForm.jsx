import { useState, useEffect, useRef } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import api from '../../../services/api'
import { API } from '../../../constants'
import { useToast } from '../../../context/useToast'
import { formatDate, formatTime, getUser, formatCurrency } from './assessment/assessmentFormConfig'
import { StepIndicator, AssessmentStep1, AssessmentStep2, AssessmentStep3, AssessmentStep4 } from './assessment/AssessmentFormSteps'
import AssessmentConfirmModal from './assessment/AssessmentConfirmModal'
import AssessmentTicketModal from './assessment/AssessmentTicketModal'
import PaymentSuccessModal from './assessment/PaymentSuccessModal'
import AssessmentDirectPrint from './assessment/AssessmentDirectPrint'
import PrintConfirmModal from '../../../components/print/PrintConfirmModal'
import usePrintConfirmation from '../../../components/print/usePrintConfirmation'
import './assessment/assessmentFlow.css'
import { buildReceiptTicket } from './assessment/receiptTicket'
import { hasVehicleDetails } from '../../../utils/savedViolator'
import { filterTypesByVehicle, pruneSelectedIds } from '../../../utils/violationTypeFilter'

export default function AssessmentForm({ violationData = null, onSuccess }) {
  const toast = useToast()
  // Shared post-print confirmation for both print paths below (direct print and
  // the existing-ticket reprint). A print is recorded only after the print dialog
  // closes and Staff answers "Yes, Mark as Printed"; No / X / Escape record
  // nothing and leave the Print buttons available.
  const printConfirm = usePrintConfirmation()
  const currentUser = getUser()
  const [step, setStep] = useState(1)
  // Excel-imported historical record (Admin -> Reports -> Import). It has no
  // Enforcer and no OVR slip. Its data is locked like an Enforcer OVR, except
  // that Staff may complete the vehicle Brand / Model and the Remarks.
  const isImported = violationData?.source === 'imported'

  const [form, setForm] = useState({
    full_name: '', address: '', license_number: '', plate_number: '',
    registration_number: '', vehicle_use: '', remarks: '', vehicle_type: '', vehicle_brand: '', vehicle_model: '',
    license_status: 'not_confiscated',
    confiscated_document_type: '', confiscated_document_name: '', confiscated_document_number: '',
    ovr_number: '',
    date: formatDate(), time: formatTime(),
    // or_number is OPTIONAL. Date Paid is not a form field (the server stamps
    // it). Received By is chosen from the Treasury Personnel list in Step 4,
    // or left blank for Treasury to sign by hand.
    // assessed_by is display-only (the server records the real user).
    place_of_violation: '', or_number: '',
    assessed_by: currentUser, violation_id: '',
  })

  const [violationTypes, setViolationTypes] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [vtSearch, setVtSearch] = useState('')
  const [loadingTypes, setLoadingTypes] = useState(true)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [repeatInfo, setRepeatInfo] = useState(null)
  const [vehicleSaved, setVehicleSaved] = useState(null)
  const [nameSuggestions, setNameSuggestions] = useState([])
  const lookupTimerRef = useRef(null)
  const nameTimerRef = useRef(null)
  const [errors, setErrors] = useState({})
  const [loading, setLoading] = useState(false)
  const [_submittedId, setSubmittedId] = useState(null)
  const [ticketModal, setTicketModal] = useState(null)
  const [confirmModal, setConfirmModal] = useState(null)
  const [viewingTicketId, setViewingTicketId] = useState(null)
  // Server response of a successful Confirm Payment — drives the Paid state.
  const [paidRecord, setPaidRecord] = useState(null)
  // Direct native print job (replaces the custom print-preview modal).
  const [printJob, setPrintJob] = useState(null)
  // "Received by": optional pick from the Admin-managed Treasury Personnel list
  // (active only for Staff). Never free text, never the logged-in user.
  const [treasuryList, setTreasuryList] = useState([])
  const [receivedById, setReceivedById] = useState('')

  useEffect(() => {
    api.get(API.TREASURY_PERSONNEL)
      .then(r => setTreasuryList(Array.isArray(r.data) ? r.data : r.data.results || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    api.get('/api/violations/types/')
      .then(r => setViolationTypes(Array.isArray(r.data) ? r.data : r.data.results || []))
      .catch(() => {})
      .finally(() => setLoadingTypes(false))
  }, [])

  useEffect(() => {
    if (violationData) {
      let parsedDate = formatDate()
      if (violationData.date_issued) {
        try { parsedDate = violationData.date_issued.slice(0, 10) } catch { /* ignore */ }
      }
      // Confiscation choices: 'confiscated' now means the driver's license is
      // held in custody, so its document type is always the driver's license
      // (an Enforcer OVR arrives with it blank until Staff completes it).
      // A legacy record stored as 'confiscated' with another document type
      // (UMID, etc.) is shown as 'Other Documents' so it is never silently
      // turned into a driver's license; it is only re-saved if Staff saves.
      const loadedStatus = violationData.license_status || 'not_confiscated'
      const loadedType = violationData.confiscated_document_type || ''
      const legacyOtherDoc = loadedStatus === 'confiscated' && loadedType !== '' && loadedType !== 'drivers_license'
      const formStatus = legacyOtherDoc ? 'other_documents' : loadedStatus
      const formType = formStatus === 'confiscated' ? 'drivers_license' : loadedType
      // eslint-disable-next-line react-hooks/set-state-in-effect -- prop-driven form population when navigating in with an existing violation, matches existing codebase convention
      setForm(prev => ({
        ...prev,
        full_name: violationData.violator_name || violationData.full_name || '',
        address: violationData.address || '',
        license_number: violationData.license_number || '',
        license_status: formStatus,
        confiscated_document_type: formType,
        confiscated_document_name: violationData.confiscated_document_name || '',
        confiscated_document_number: violationData.confiscated_document_number || '',
        plate_number: violationData.plate_number || '',
        registration_number: violationData.registration_number || '',
        vehicle_use: violationData.vehicle_use || '',
        remarks: violationData.remarks || '',
        vehicle_type: violationData.vehicle_type || '',
        vehicle_brand: violationData.vehicle_brand || '',
        vehicle_model: violationData.vehicle_model || '',
        place_of_violation: violationData.location || violationData.place_of_violation || '',
        ovr_number: violationData.ovr_number || '',
        date: parsedDate,
        violation_id: violationData.id || violationData.violation_id || '',
      }))
      if (violationData.items?.length) {
        const ids = violationData.items.map(i => i.violation_type?.id).filter(Boolean)
        setSelectedIds(ids)
        setViolationTypes(prev => {
          const existingIds = new Set(prev.map(vt => vt.id))
          const fromItems = violationData.items
            .map(i => i.violation_type)
            .filter(vt => vt && vt.id && !existingIds.has(vt.id))
            .map(vt => ({ ...vt, penalty_amount: vt.penalty_amount || 0 }))
          return fromItems.length ? [...prev, ...fromItems] : prev
        })
      }
    }
  }, [violationData])

  // Walk-in complaints only: the vehicle type decides which violations apply,
  // so when it changes any ticked violation that no longer applies is dropped.
  // An existing Enforcer OVR (violationData) is never touched — its violations
  // are the Enforcer's original, locked field record, even if one of them no
  // longer matches the vehicle type. Skipped until the list is loaded.
  useEffect(() => {
    if (violationData || violationTypes.length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- keeps the ticked violations in step with the chosen vehicle type
    setSelectedIds(prev => {
      const next = pruneSelectedIds(prev, violationTypes, form.vehicle_type)
      return next.length === prev.length ? prev : next
    })
  }, [violationData, violationTypes, form.vehicle_type])

  // For an existing Enforcer OVR the violations are locked, so the stored
  // (snapshotted) penalty is the amount — never re-priced from today's
  // ViolationType list. Walk-ins are priced live until the server stores
  // the snapshot; the server remains the authority either way.
  const liveTotal = violationTypes.filter(vt => selectedIds.includes(vt.id)).reduce((sum, vt) => sum + Number(vt.penalty_amount), 0)
  const totalPenalty = (violationData && violationData.penalty_amount != null)
    ? Number(violationData.penalty_amount)
    : liveTotal

  // Existing Enforcer OVR: each row shows the fine STORED on that violation
  // item (penalty_amount_snapshot), not today's ViolationType fine, so the
  // rows always add up to the stored total even after an admin edits a fine.
  // Falls back to the live fine when the server sends no snapshot.
  const snapshotByTypeId = new Map(
    (violationData?.items || [])
      .filter(i => i.violation_type?.id != null && i.penalty_amount_snapshot != null
        // Imported items hold a 0 placeholder, not a real fine: skip it so the
        // violation falls back to its fine in the Violation Types list.
        && !(isImported && Number(i.penalty_amount_snapshot) <= 0))
      .map(i => [i.violation_type.id, i.penalty_amount_snapshot])
  )
  const displayTypes = snapshotByTypeId.size
    ? violationTypes.map(vt => (snapshotByTypeId.has(vt.id) ? { ...vt, penalty_amount: snapshotByTypeId.get(vt.id) } : vt))
    : violationTypes

  // Walk-in: offer only the violations that apply to the chosen vehicle type
  // (unassigned types and unresolvable vehicle types show all). Existing
  // Enforcer OVR: the full list is kept so its locked violations always show.
  const offeredTypes = violationData ? violationTypes : filterTypesByVehicle(violationTypes, form.vehicle_type)
  const filtered = offeredTypes.filter(vt =>
    !vtSearch || vt.name.toLowerCase().includes(vtSearch.toLowerCase()) || vt.code.toLowerCase().includes(vtSearch.toLowerCase())
  )
  const grouped = filtered.reduce((acc, vt) => {
    if (!acc[vt.category]) acc[vt.category] = []
    acc[vt.category].push(vt)
    return acc
  }, {})

  const toggleId = (id) => setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  const plateReady = (value) => (value || '').replace(/\s+/g, '').length >= 3

  const runPlateLookup = async (value) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    setLookupLoading(true)
    try {
      const res = await api.get(`/api/violations/violator-lookup/?plate_number=${encodeURIComponent(value)}`)
      const data = res.data
      setVehicleSaved(hasVehicleDetails(data?.vehicle) || data?.vehicle?.violator_name ? data.vehicle : null)
      setRepeatInfo(data?.violation_count > 0 ? data : null)
    } catch { /* offline or unavailable — leave the form as typed */ }
    finally { setLookupLoading(false) }
  }

  const handlePlateLookup = (value) => {
    clearTimeout(lookupTimerRef.current)
    const trimmed = (value || '').trim()
    if (!plateReady(trimmed)) { setVehicleSaved(null); return }
    lookupTimerRef.current = setTimeout(() => runPlateLookup(trimmed), 400)
  }

  const runNameLookup = async (last, first) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    try {
      const params = new URLSearchParams({ last_name: last.trim() })
      if ((first || '').trim()) params.set('first_name', first.trim())
      const res = await api.get(`/api/violations/violator-lookup/?${params}`)
      setNameSuggestions(Array.isArray(res.data?.suggestions) ? res.data.suggestions.slice(0, 5) : [])
    } catch { setNameSuggestions([]) }
  }

  const handleNameLookup = (last, first) => {
    clearTimeout(nameTimerRef.current)
    if ((last || '').trim().length < 3) { setNameSuggestions([]); return }
    nameTimerRef.current = setTimeout(() => runNameLookup(last, first), 400)
  }

  const applyName = (person) => {
    if (!person) return
    setForm(prev => ({
      ...prev,
      ...(person.violator_name ? { full_name: person.violator_name } : {}),
      ...(person.address ? { address: person.address } : {}),
    }))
    setNameSuggestions([])
  }

  const applyVehicle = () => {
    if (!vehicleSaved) return
    const saved = vehicleSaved
    setForm(prev => ({
      ...prev,
      ...(saved.plate_number ? { plate_number: saved.plate_number } : {}),
      ...(saved.registration_number ? { registration_number: saved.registration_number } : {}),
      ...(saved.vehicle_type ? { vehicle_type: saved.vehicle_type } : {}),
      ...(saved.vehicle_brand ? { vehicle_brand: saved.vehicle_brand } : {}),
      ...(saved.vehicle_model ? { vehicle_model: saved.vehicle_model } : {}),
      ...(saved.vehicle_use ? { vehicle_use: saved.vehicle_use } : {}),
      ...(saved.violator_name ? { full_name: saved.violator_name } : {}),
      ...(saved.address ? { address: saved.address } : {}),
    }))
    setVehicleSaved(null)
  }

  // View/reprint an EXISTING prior ticket surfaced by the repeat-violator
  // notice (MASTER PROMPT Part 10/11: reprint must reproduce the existing
  // ticket, never create a new violation/ticket/payment). Reuses the same
  // non-destructive GenerateTicketView endpoint the "Approve & Generate"
  // action already calls — it only re-renders the printable payload for the
  // record that's passed in, it never creates a row either way.
  const handleViewExistingTicket = async (historyItem) => {
    setViewingTicketId(historyItem.id)
    try {
      const res = await api.post(`/api/violations/${historyItem.id}/generate-ticket/`)
      const t = res.data || {}
      // Persisted values only (buildReceiptTicket has no paid -> penalty
      // fallback). Viewing is read-only; printing is audited separately.
      setTicketModal({
        ...buildReceiptTicket(t),
        ticket_number: t.ticket_number || `TKT-${String(historyItem.id).padStart(6, '0')}`,
        generated_at: t.generated_at || new Date().toISOString(),
        violations: (t.items || []).map(i => i.violation_type?.name).filter(Boolean).join(', '),
        date: t.date_issued ? t.date_issued.slice(0, 10) : '',
        time: t.date_issued ? t.date_issued.slice(11, 16) : '',
        place_of_violation: t.location,
        _existingId: historyItem.id,
      })
    } catch {
      toast.danger('Hindi ma-load ang ticket na ito. Subukan ulit.')
    } finally {
      setViewingTicketId(null)
    }
  }

  const handleChange = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }))
    setErrors(prev => ({ ...prev, [field]: undefined }))
  }

  const validateStep1 = (f) => {
    const e = {}
    if (!f.full_name.trim()) e.full_name = 'Required'
    if (!f.address.trim()) e.address = 'Required'
    // License Number is no longer globally required. Confiscation rules
    // (mirrored by the backend, which is the real enforcement):
    //   Confiscated     -> the driver's license is in custody, so its number is required.
    //   Other Documents -> a valid ID type and its number are required
    //                      ('Others' also needs a name); nothing enters custody.
    if (f.license_status === 'confiscated') {
      if (!f.license_number.trim()) e.license_number = "Enter the Driver's License number"
    } else if (f.license_status === 'other_documents') {
      const type = f.confiscated_document_type
      if (!type) e.confiscated_document_type = 'Select the document type'
      else if (type === 'others' && !f.confiscated_document_name.trim()) e.confiscated_document_name = 'Required for Others'
      if (type && !f.confiscated_document_number.trim()) e.confiscated_document_number = 'Required'
    }
    if (!f.plate_number.trim()) e.plate_number = 'Required'
    if (!f.vehicle_type) e.vehicle_type = 'Required'
    // OVR Number only exists (and is only required) when this record came
    // from the Enforcer's Pending Queue — a walk-in complaint has no
    // physical OVR slip, so there's no OVR Number field to validate here
    // (business rules #6/#19: OVR # is manual, City-Hall-issued, and only
    // ever set by the Enforcer who issued it).
    if (violationData && !f.ovr_number.trim()) e.ovr_number = 'Required'
    return e
  }

  const validateStep2 = (f) => {
    const e = {}
    // Imported: date, time and location are locked as imported (the logbook may
    // have no time/location), so only the violations are checked.
    if (isImported) {
      if (selectedIds.length === 0) e.violations = 'Select at least one violation'
      return e
    }
    if (!f.date) e.date = 'Required'
    if (!f.time) e.time = 'Required'
    else if (to24Hour(f.time) === null) e.time = 'Use a valid time, e.g. 02:30 pm'
    if (f.date && Number.isNaN(Date.parse(f.date))) e.date = 'Invalid date'
    if (!f.place_of_violation.trim()) e.place_of_violation = 'Required'
    if (selectedIds.length === 0) e.violations = 'Select at least one violation'
    return e
  }

  const handleNextStep = () => {
    // Imported: every Step 1 field is locked except optional Brand/Model, so
    // there is nothing for Staff to fix here — never block them on locked data.
    if (step === 1 && !isImported) {
      const e = validateStep1(form)
      if (Object.keys(e).length) { setErrors(e); return }
    }
    if (step === 2) {
      const e = validateStep2(form)
      if (Object.keys(e).length) { setErrors(e); return }
    }
    setErrors({})
    setStep(s => s + 1)
  }

  const violationId = form.violation_id || violationData?.id || null

  // An existing Enforcer OVR (opened via Pending Violations → Process) means
  // violator/vehicle/violation-type data is the Enforcer's original field
  // record — Staff reviews it but never overwrites it (business rule).
  // A walk-in/no-OVR record was entered by Staff themselves, so it stays
  // fully editable even after being saved once (violationId becomes set,
  // but violationData — the prop for an EXISTING Enforcer OVR — never does).
  // An imported record is the exception: Brand / Model / Remarks are saved.
  const isEnforcerOVR = !!violationData && !isImported

  // Time is a free-text "HH:MM am/pm" field (see AssessmentFormSteps), not
  // a native <input type="time">, so it is parsed defensively. An invalid
  // time returns null and is REJECTED by validateStep2 — it is never
  // silently turned into midnight.
  const to24Hour = (timeStr) => {
    const match = (timeStr || '').trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i)
    if (!match) return null
    let [, hh, mm, ampm] = match
    hh = parseInt(hh, 10)
    if (parseInt(mm, 10) > 59 || hh > 23 || (ampm && (hh < 1 || hh > 12))) return null
    if (ampm) {
      const isPM = ampm.toLowerCase() === 'pm'
      if (isPM && hh !== 12) hh += 12
      if (!isPM && hh === 12) hh = 0
    }
    return `${String(hh).padStart(2, '0')}:${mm}`
  }

  // Existing app convention (already used before this fix) is a hardcoded
  // +08:00 (Philippine time) offset rather than a timezone library —
  // kept as-is, only the time-of-day part was wrong before.
  const buildDateIssued = () => `${form.date}T${to24Hour(form.time)}:00+08:00`

  // Fields Staff can actually edit on Step 1/2, common to both the
  // "persist edits to an existing violation" PATCH and the "create a new
  // walk-in violation" POST — kept as one source of truth so nothing typed
  // into the form silently fails to reach the database.
  //   Confiscated     -> the driver's license (type fixed; number is license_number).
  //   Other Documents -> the chosen ID type, its name (Others only) and number.
  //   Not Confiscated -> everything cleared.
  const buildConfiscationFields = () => {
    if (form.license_status === 'confiscated') {
      return {
        confiscated_document_type: 'drivers_license',
        confiscated_document_name: '',
        confiscated_document_number: '',
      }
    }
    if (form.license_status === 'other_documents') {
      return {
        confiscated_document_type: form.confiscated_document_type,
        confiscated_document_name: form.confiscated_document_type === 'others' ? form.confiscated_document_name.trim() : '',
        confiscated_document_number: form.confiscated_document_number.trim(),
      }
    }
    return { confiscated_document_type: '', confiscated_document_name: '', confiscated_document_number: '' }
  }

  const buildEditableFields = () => ({
    violator_name: form.full_name,
    license_number: form.license_number,
    license_status: form.license_status,
    // Confiscation details — the backend validates and clears them when the
    // record is Not Confiscated.
    ...buildConfiscationFields(),
    plate_number: form.plate_number,
    registration_number: form.registration_number,
    vehicle_use: form.vehicle_use,
    remarks: form.remarks.trim(),
    vehicle_type: form.vehicle_type,
    vehicle_brand: form.vehicle_brand,
    vehicle_model: form.vehicle_model,
    address: form.address,
    location: form.place_of_violation,
    date_issued: buildDateIssued(),
    violation_type_ids: selectedIds,
  })

  // /assess/ (AssessmentView → AssessmentSerializer) only accepts status
  // (pending/processing — never paid) and assessment_notes. Actual violator/vehicle/incident edits are
  // persisted separately via persistEditableFields() below.
  const buildAssessPayload = (status) => ({
    status,
    assessment_notes: form.ovr_number ? `OVR: ${form.ovr_number}` : '',
    // No penalty_amount: the server derives it from the stored violations.
  })

  // For an EXISTING violation (opened via Pending Violations → Process),
  // persist whatever Staff corrected/completed to the actual Violation
  // record — via the general detail endpoint, which is a partial (PATCH)
  // update and accepts the full editable field set (unlike /assess/).
  // OVR Number is intentionally never included here: it's read-only in the
  // UI for this case (physical, Enforcer-written OVR — business rule) and
  // must never be silently overwritten.
  // Imported: ONLY Brand, Model and Remarks are sent, so nothing else on the
  // record (date, violations, fine, violator, plate...) can be overwritten.
  const buildImportedFields = () => ({
    vehicle_brand: form.vehicle_brand,
    vehicle_model: form.vehicle_model,
    remarks: form.remarks.trim(),
  })
  const persistEditableFields = (id) =>
    api.patch(`/api/violations/${id}/`, isImported ? buildImportedFields() : buildEditableFields())

  // Enforcer OVRs keep their original field record locked, but the internal
  // confiscated-document details are Staff's to complete. Only those fields
  // (plus the License Number when the OVR had none) are sent. The
  // confiscation choice is sent too, so a legacy record shown as
  // 'Other Documents' is saved consistently with its document details.
  const persistConfiscationDetails = (id) => {
    if (form.license_status === 'not_confiscated') return Promise.resolve()
    const body = { license_status: form.license_status, ...buildConfiscationFields() }
    if (form.license_status === 'confiscated' && !violationData?.license_number) {
      body.license_number = form.license_number
    }
    return api.patch(`/api/violations/${id}/`, body)
  }

  const buildCreatePayload = (status) => ({
    // Reaching buildCreatePayload means there was no existing violationId —
    // i.e. this is a Staff-encoded walk-in complaint, not an Enforcer's
    // OVR (those already exist as a Violation row from Pending Queue, so
    // they go through persistEditableFields + buildAssessPayload instead).
    // No physical OVR was ever issued for a walk-in, so ovr_number stays
    // blank and source marks it accordingly (business rules #6/#19/#21).
    source: 'staff_walk_in',
    ovr_number: '',
    status,
    ...buildEditableFields(),
  })

  const resetForm = () => {
    setForm({ full_name: '', address: '', license_number: '', plate_number: '', registration_number: '', vehicle_use: '', remarks: '', vehicle_type: '', vehicle_brand: '', vehicle_model: '', license_status: 'not_confiscated', confiscated_document_type: '', confiscated_document_name: '', confiscated_document_number: '', ovr_number: '', date: formatDate(), time: formatTime(), place_of_violation: '', or_number: '', assessed_by: currentUser, violation_id: '' })
    setSelectedIds([]); setVtSearch(''); setErrors({}); setSubmittedId(null); setRepeatInfo(null); setVehicleSaved(null); setNameSuggestions([]); setPaidRecord(null); setTicketModal(null); setPrintJob(null); setStep(1)
  }

  const doSave = async () => {
    setLoading('save')
    try {
      let res
      if (violationId) {
        // Persist Staff's corrections FIRST, then transition status — so a
        // failed/edited save never gets recorded as if it went through
        // with stale (pre-edit) data. Skipped for an existing Enforcer OVR:
        // those violator/vehicle/violation-type fields are locked in the UI
        // and must never be overwritten (business rule) — only the status/
        // assessment_notes/penalty transition below applies to that case.
        if (!isEnforcerOVR) await persistEditableFields(violationId)
        else await persistConfiscationDetails(violationId)
        res = await api.patch(`/api/violations/${violationId}/assess/`, buildAssessPayload('pending'))
      } else {
        res = await api.post('/api/violations/create/', buildCreatePayload('pending'))
      }
      setSubmittedId(res.data.id || violationId)
      setConfirmModal(null)
      toast.success('Assessment saved as draft.')
      resetForm()
    } catch (err) {
      const msg = err?.response?.data ? JSON.stringify(err.response.data) : 'Failed to save.'
      setConfirmModal(null)
      toast.danger(msg)
    } finally { setLoading(false) }
  }

  // Step 3 action: no O.R./date validation — O.R. No. is optional and the
  // payment date is stamped by the server.
  const handleConfirmPayment = () => {
    setErrors({})
    setConfirmModal('paid')
  }

  // CONFIRM PAYMENT — separate from printing. The server derives the
  // amount, the payment date (today, server time) and the assessor, and
  // does the whole payment in one transaction.
  const doConfirmPayment = async () => {
    setLoading('paid')
    try {
      let targetId = violationId
      if (!targetId) {
        const res = await api.post('/api/violations/create/', buildCreatePayload('processing'))
        targetId = res.data.id
        setForm(prev => ({ ...prev, violation_id: targetId }))
      } else {
        // Edits land in the record before the status transition; an
        // existing Enforcer OVR only gets its confiscation details completed.
        if (!isEnforcerOVR) await persistEditableFields(targetId)
        else await persistConfiscationDetails(targetId)
        await api.patch(`/api/violations/${targetId}/assess/`, buildAssessPayload('processing'))
      }
      const paidRes = await api.post(API.CONFIRM_PAYMENT(targetId), {
        or_number: form.or_number.trim(),
        ...(receivedById ? { received_by_personnel: Number(receivedById) } : {}),
      })
      setPaidRecord(paidRes.data || {})
      setConfirmModal(null)
      toast.success('Payment confirmed. The violation is now Paid.')
    } catch (err) {
      const d = err?.response?.data
      const msg = d?.error || (d ? JSON.stringify(d) : 'Failed to confirm payment.')
      setConfirmModal(null)
      toast.danger(msg)
    } finally { setLoading(false) }
  }

  // Print Assessment Form (paid state only): builds the same ticket as before
  // and opens the native browser print preview directly via the isolated
  // Assessment wrapper. A new key per click lets Staff print again.
  const handlePrintAssessmentForm = () => {
    if (!paidRecord) return
    setPrintJob({
      key: Date.now(),
      ticket: {
        ...buildReceiptTicket(paidRecord),
        ticket_number: paidRecord.ticket_number,
        generated_at: paidRecord.generated_at,
        _violationId: paidRecord.id,
      },
    })
  }

  const selectedViolationsForModal = displayTypes.filter(vt => selectedIds.includes(vt.id))

  const goToStep = (n) => { setErrors({}); setStep(n) }
  const selectedViolationsText = selectedViolationsForModal.map(v => v.name).join(', ')

  return (
    <div className="af-root">
      {confirmModal && (
        <AssessmentConfirmModal
          type={confirmModal}
          form={form}
          selectedViolations={selectedViolationsForModal}
          totalPenalty={totalPenalty}
          formatCurrency={formatCurrency}
          onConfirm={confirmModal === 'draft' ? doSave : doConfirmPayment}
          onCancel={() => setConfirmModal(null)}
          loading={loading}
        />
      )}

      <PageHeader title="Assessment Form" />

      <StepIndicator current={step} />

      {step === 1 && (
        <AssessmentStep1
          form={form} errors={errors} lookupLoading={lookupLoading} repeatInfo={repeatInfo} violationData={violationData}
          vehicleSaved={!!vehicleSaved}
          nameSuggestions={nameSuggestions}
          onUseVehicle={applyVehicle}
          onNameLookup={handleNameLookup}
          onSelectName={applyName}
          onChange={handleChange} onPlateLookup={handlePlateLookup} onNext={handleNextStep}
          onViewTicket={handleViewExistingTicket} viewingTicketId={viewingTicketId}
        />
      )}
      {step === 2 && (
        <AssessmentStep2
          form={form} errors={errors} violationTypes={displayTypes} grouped={grouped} selectedIds={selectedIds}
          vtSearch={vtSearch} loadingTypes={loadingTypes} totalPenalty={totalPenalty} formatCurrency={formatCurrency}
          violationData={violationData}
          onChange={handleChange}
          onVtSearch={setVtSearch} onToggleId={toggleId}
          onBack={() => goToStep(1)} onNext={handleNextStep}
        />
      )}
      {step === 3 && (
        <AssessmentStep3
          form={form} errors={errors} violationData={violationData} totalPenalty={totalPenalty} formatCurrency={formatCurrency}
          onChange={handleChange} onBack={() => goToStep(2)} onNext={handleNextStep}
        />
      )}
      {step === 4 && (
        <AssessmentStep4
          form={form} violationData={violationData} selectedTypes={selectedViolationsForModal}
          totalPenalty={totalPenalty} formatCurrency={formatCurrency}
          onBack={() => goToStep(3)} onEditStep={goToStep}
          onConfirmPayment={handleConfirmPayment} loading={loading} paid={!!paidRecord}
          treasuryList={treasuryList} receivedById={receivedById} onReceivedByChange={setReceivedById}
          receivedByRecorded={paidRecord?.assessment?.received_by || ''}
        />
      )}

      {/* Payment Successful — shown after the existing Confirm Payment succeeds.
          New Assessment reuses the previous reset/navigation (resetForm + onSuccess). */}
      {paidRecord && (
        <PaymentSuccessModal
          form={form} violationsText={selectedViolationsText} paidRecord={paidRecord} formatCurrency={formatCurrency}
          onNewAssessment={() => { resetForm(); onSuccess?.() }}
          onPrint={handlePrintAssessmentForm}
        />
      )}

      {printJob && (
        <AssessmentDirectPrint
          key={printJob.key} ticket={printJob.ticket} formatCurrency={formatCurrency}
          onPrinted={() => printConfirm.arm(printJob.ticket._violationId)}
          onDone={() => setPrintJob(null)}
        />
      )}

      {/* View/reprint of an EXISTING prior ticket from the repeat-violator
          notice — unchanged. */}
      {ticketModal && ticketModal._existingId && (
        <AssessmentTicketModal
          ticket={ticketModal} formatCurrency={formatCurrency}
          onPrinted={() => printConfirm.arm(ticketModal._existingId)}
          onClose={() => setTicketModal(null)}
        />
      )}

      <PrintConfirmModal {...printConfirm.modalProps} />
    </div>
  )
}