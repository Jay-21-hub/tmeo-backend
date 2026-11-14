import { toTitleCase, APP_TIMEZONE } from '../../../../utils/helpers'

/** "Dela Cruz, Juan S." — the same shape the backend already stores in
 *  Violation.violator_name (Last, First M.). */
export function buildViolatorName(form) {
  const ln = (form.last_name || '').trim()
  const fn = (form.first_name || '').trim()
  const mi = (form.middle_initial || '').trim()
  if (!ln && !fn) return ''
  let name = `${ln}, ${fn}`
  if (mi) name += ` ${mi.replace(/\.+$/, '')}.`
  return name
}

/**
 * Current moment as an unambiguous ISO string in Manila time,
 * e.g. "2026-09-21T14:30:05+08:00".
 *
 * The old form used `new Date().toISOString().slice(0, 16)`, which is UTC.
 * The backend runs with TIME_ZONE='Asia/Manila' + USE_TZ=True and reads a
 * timezone-less value as Manila time — so every OVR was saved 8 hours
 * early. The Philippines has no DST, so a fixed +08:00 offset is exact.
 */
export function manilaNowIso() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map(p => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`
}

const fmt = (iso, opts) => (iso
  ? new Date(iso).toLocaleString('en-PH', { timeZone: APP_TIMEZONE, ...opts })
  : '—')

export const formatIssuedDate = iso => fmt(iso, { year: 'numeric', month: 'short', day: 'numeric' })
export const formatIssuedTime = iso => fmt(iso, { hour: '2-digit', minute: '2-digit' })
export const formatIssuedDateTime = iso => fmt(iso, { dateStyle: 'medium', timeStyle: 'short' })

export function emptyForm() {
  return {
    ovr_number: '',
    last_name: '', first_name: '', middle_initial: '',
    license_number: '', scanned_license: '', confiscated_license_draft: '',
    license_status: 'not_confiscated', address: '',
    plate_number: '', registration_number: '',
    vehicle_type: '', vehicle_brand: '', vehicle_model: '', vehicle_use: 'private',
    location: '', latitude: '', longitude: '',
    date_issued: manilaNowIso(),
    remarks: '',
    // File selected via Scan License → Upload Photo. It is only read for OCR
    // (to fill in the driver details). It is never submitted with the OVR and
    // never saved as evidence; evidence photos have their own capture flow.
    license_photo: null,
  }
}

const TYPED_FIELDS = [
  'ovr_number', 'last_name', 'first_name', 'middle_initial', 'license_number',
  'scanned_license', 'confiscated_license_draft', 'address',
  'plate_number', 'registration_number', 'vehicle_type', 'vehicle_brand', 'vehicle_model', 'remarks',
]

/** True once the enforcer has typed/picked anything worth protecting.
 *  GPS-filled location and the auto timestamp don't count. */
export function isFormDirty(form, selectedIds) {
  return selectedIds.length > 0 || !!form.license_photo
    || TYPED_FIELDS.some(k => String(form[k] || '').trim() !== '')
}

/**
 * Fold a driver's-license OCR result into the form. OCR never overwrites a
 * value the enforcer already typed (business rule: OCR pre-fills, the
 * enforcer confirms) — it only fills blanks.
 */
export function mergeOcrIntoForm(form, parsed) {
  if (!parsed) return form
  const raw = (parsed.full_name || parsed.violator_name || '').trim()
  let last_name = form.last_name, first_name = form.first_name, middle_initial = form.middle_initial

  if (raw) {
    if (raw.includes(',')) {
      const [lastPart, restPart = ''] = raw.split(',').map(s => s.trim())
      const rest = restPart.split(/\s+/).filter(Boolean)
      let mi = ''
      if (rest.length > 1 && rest[rest.length - 1].replace('.', '').length <= 2) {
        mi = rest.pop().replace('.', '')
      }
      last_name = form.last_name || lastPart
      first_name = form.first_name || rest.join(' ')
      middle_initial = form.middle_initial || mi
    } else {
      const words = raw.split(/\s+/)
      last_name = form.last_name || words[0] || ''
      first_name = form.first_name || words.slice(1).join(' ')
    }
  }

  const scanned = String(parsed.license_number || '').trim()
  const status = form.license_status || 'not_confiscated'
  const next = {
    ...form,
    last_name: toTitleCase(last_name || ''),
    first_name: toTitleCase(first_name || ''),
    middle_initial: toTitleCase(middle_initial || ''),
    address: form.address || parsed.address || '',
    // A scan never chooses Confiscated. The enforcer's current choice stays.
    license_status: status,
  }
  if (scanned) {
    next.scanned_license = form.scanned_license || scanned
    if (status === 'confiscated') {
      if (!String(form.confiscated_license_draft || '').trim()) {
        next.confiscated_license_draft = next.scanned_license
      }
    } else {
      next.license_number = next.scanned_license
    }
  }
  return next
}

/** License number that is actually saved on the violation.
 *  Not confiscated: only a scanned number. A number typed inside Confiscated
 *  is submitted only while that choice is still selected. */
export function driverLicenseForSubmit(form) {
  if (!form) return ''
  if (form.license_status === 'confiscated') return String(form.confiscated_license_draft || '').trim()
  return String(form.scanned_license || '').trim()
}

/** multipart body for POST /api/violations/create/ (ViolationDetailSerializer). */
export function buildOvrFormData(form, selectedIds) {
  const fd = new FormData()
  const put = (key, value) => fd.append(key, value ?? '')

  put('source', 'enforcer_ovr')            // backend forces this for enforcers anyway
  put('ovr_number', form.ovr_number.trim())
  put('violator_name', buildViolatorName(form))
  put('license_number', driverLicenseForSubmit(form))
  put('license_status', form.license_status === 'confiscated' ? 'confiscated' : 'not_confiscated')
  put('plate_number', form.plate_number)
  put('registration_number', form.registration_number)
  put('vehicle_type', form.vehicle_type)
  put('vehicle_brand', form.vehicle_brand)
  put('vehicle_model', form.vehicle_model)
  put('vehicle_use', form.vehicle_use)
  put('address', form.address)
  put('location', form.location)
  if (form.latitude !== '' && form.longitude !== '') {
    put('latitude', form.latitude)
    put('longitude', form.longitude)
  }
  put('date_issued', form.date_issued)
  put('remarks', form.remarks)
  put('violation_type_ids', JSON.stringify(selectedIds))
  // The Upload Photo license photo (form.license_photo) is only read for OCR.
  // It is deliberately NOT appended here: it must never become the violation's
  // image / Photo Evidence. Evidence photos use the separate Evidence capture.
  return fd
}

/** Row shape for localStorage 'tmeo_offline_reports'. NOT currently called
 *  from IssueOVR.jsx — Issue OVR is online-only; SyncData.jsx's own
 *  "Save Violation Report Offline" form (the dedicated offline-entry
 *  point) builds its own equivalent record and is what actually writes
 *  to this queue. Kept here for the field list / shape reference. */
export function buildOfflineRecord(form, selectedIds, localId) {
  return {
    id: localId,
    // Idempotency key sent on every sync attempt for this record (see
    // useOfflineQueue.js / backend ViolationCreateView) — same value as
    // the local queue id, so a resend after a dropped response replays
    // instead of creating a duplicate Violation.
    client_offline_id: localId,
    source: 'enforcer_ovr',
    ovr_number: form.ovr_number.trim(),
    violator_name: buildViolatorName(form),
    last_name: form.last_name, first_name: form.first_name, middle_initial: form.middle_initial,
    address: form.address,
    license_number: driverLicenseForSubmit(form),
    license_status: form.license_status === 'confiscated' ? 'confiscated' : 'not_confiscated',
    plate_number: form.plate_number, registration_number: form.registration_number,
    vehicle_type: form.vehicle_type, vehicle_brand: form.vehicle_brand, vehicle_model: form.vehicle_model,
    vehicle_use: form.vehicle_use,
    violation_type_ids: selectedIds,
    location: form.location, latitude: form.latitude, longitude: form.longitude,
    date_issued: form.date_issued, remarks: form.remarks,
    savedAt: new Date().toISOString(), syncStatus: 'queued', status: 'pending',
  }
}

/** Names of the violations on a create-response. The API nests each item
 *  as { violation_type: { id, code, name, ... } }. */
export function violationNamesFromResponse(items) {
  return (items || []).map(i => i?.violation_type?.name || i?.name).filter(Boolean)
}

export function prettyCategory(value) {
  return String(value || 'other').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}