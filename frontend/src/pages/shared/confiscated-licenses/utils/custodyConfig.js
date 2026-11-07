// Confiscated Licenses — shared constants and pure helpers (Staff + Admin).
// Every value here mirrors the Stage B backend contract
// (violations/custody_models.py, custody.py, custody_views.py,
// custody_serializers.py). Nothing here invents a status, field or permission.

export const CUSTODY_ROLES = ['admin', 'staff']

/** Only Admin and Staff may use this module (backend: IsAdminOrStaff). */
export const canAccessCustody = (role) => CUSTODY_ROLES.includes(role)

// LicenseCustody.Status values, forward-only: confiscated -> ready_for_release -> released
export const STATUS = {
  IN_CUSTODY: 'confiscated',
  READY: 'ready_for_release',
  RELEASED: 'released',
}

// UI wording follows the approved design ("In Custody / Ready for Release / Released").
export const STATUS_META = {
  [STATUS.IN_CUSTODY]: { label: 'In Custody', tone: 'danger' },
  [STATUS.READY]: { label: 'Ready for Release', tone: 'success' },
  [STATUS.RELEASED]: { label: 'Released', tone: 'neutral' },
}

// LicenseCustody.DocTypeStatus values ("legacy" document-type verification)
export const DOC = {
  NOT_REQUIRED: 'not_required',
  PENDING: 'pending',
  CONFIRMED: 'confirmed_drivers_license',
  EXCLUDED: 'excluded',
}

// `not_required` is a normal (non-legacy) record: no badge at all.
export const DOC_META = {
  [DOC.PENDING]: { label: 'Verification needed', tone: 'warning' },
  [DOC.CONFIRMED]: { label: "Confirmed driver's license", tone: 'info' },
  [DOC.EXCLUDED]: { label: 'Excluded', tone: 'neutral' },
}

// Tabs map to the backend `status` filter. `all` sends no status filter and is
// only offered to Admin (oversight), matching the approved Admin design.
export const TABS = [
  { key: STATUS.IN_CUSTODY, label: 'In Custody', countKey: 'confiscated', adminOnly: false },
  { key: STATUS.READY, label: 'Ready for Release', countKey: 'pending_release', adminOnly: false },
  { key: STATUS.RELEASED, label: 'Released', countKey: 'released', adminOnly: false },
  { key: 'all', label: 'All Records', countKey: 'total', adminOnly: true },
]

export const tabsForRole = (role) => TABS.filter((t) => !t.adminOnly || role === 'admin')

// Backend `legacy` filter values: 'only' | 'exclude'
export const LEGACY_FILTER_OPTIONS = [
  { value: '', label: 'All records' },
  { value: 'only', label: 'Legacy records only' },
  { value: 'exclude', label: 'Exclude legacy records' },
]

// ReleaseSerializer.claimant_id_type choices (LicenseCustody.ClaimantIdType)
export const CLAIMANT_ID_TYPES = [
  { value: 'drivers_license', label: "Driver's License" },
  { value: 'passport', label: 'Passport' },
  { value: 'umid', label: 'UMID' },
  { value: 'philsys', label: 'PhilSys National ID' },
  { value: 'postal', label: 'Postal ID' },
  { value: 'voters', label: "Voter's ID" },
  { value: 'other', label: 'Other' },
]

export const claimantIdTypeLabel = (value) =>
  CLAIMANT_ID_TYPES.find((o) => o.value === value)?.label || value || '—'

// Max lengths come straight from the backend serializers.
export const LIMITS = {
  releasedToName: 150,
  claimantIdLast4: 4,
  authorizationReference: 100,
  releaseRemarks: 1000,
  reason: 500,
  licenseNumber: 50,
}

export const PAGE_SIZE = 10

export const DEFAULT_FILTERS = {
  tab: STATUS.IN_CUSTODY,
  search: '',
  dateFrom: '',
  dateTo: '',
  legacy: '',
  includeExcluded: false,
  page: 1,
}

const EVENT_LABELS = {
  marked_ready: 'Marked ready for release',
  released: 'Released',
  document_type_confirmed: "Confirmed as driver's license",
  document_type_excluded: "Excluded (not a driver's license)",
  license_number_corrected: 'License number corrected',
}

export const eventLabel = (type) =>
  EVENT_LABELS[type] || (type ? type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'Event')

export const statusLabel = (status) => STATUS_META[status]?.label || status || '—'

/**
 * Query params for the list endpoint. Only supported params are ever sent:
 * search, status, date_from, date_to, legacy, include_excluded (admin only),
 * page, page_size. `includeStatus:false` builds the params for the summary
 * call, which feeds the tab counts and must not be narrowed by the active tab.
 */
export function buildListParams(filters, role, { includeStatus = true, paged = true } = {}) {
  const p = {}
  const search = (filters.search || '').trim()
  if (search) p.search = search
  if (includeStatus && filters.tab && filters.tab !== 'all') p.status = filters.tab
  if (filters.dateFrom) p.date_from = filters.dateFrom
  if (filters.dateTo) p.date_to = filters.dateTo
  if (filters.legacy === 'only' || filters.legacy === 'exclude') p.legacy = filters.legacy
  if (role === 'admin' && filters.includeExcluded) p.include_excluded = '1'
  if (paged) {
    p.page = Math.max(1, Number(filters.page) || 1)
    p.page_size = PAGE_SIZE
  }
  return p
}

export const hasActiveFilters = (f) =>
  !!((f.search || '').trim() || f.dateFrom || f.dateTo || f.legacy || f.includeExcluded)

const docOk = (doc) => doc === DOC.NOT_REQUIRED || doc === DOC.CONFIRMED

/**
 * Which actions a record offers to a role, derived ONLY from fields the API
 * returned (status, doc_type_status, can_correct). The server stays the
 * authority: every action is re-validated there, including payment.
 *
 * Payment cannot be pre-checked: the Stage B list/detail payload carries no
 * payment field, so "Mark Ready" is offered whenever the custody state allows
 * it and a `payment_required` response is handled in the modal.
 */
export function getActionAvailability(record, role) {
  const none = { visible: false, enabled: false, reason: '' }
  if (!record || !canAccessCustody(role)) {
    return { markReady: none, release: none, verify: none, correct: none, canExclude: false }
  }
  const { status, doc_type_status: doc } = record
  const isAdmin = role === 'admin'

  const gateReason = doc === DOC.PENDING
    ? 'Verify the legacy document first.'
    : doc === DOC.EXCLUDED ? 'This record was excluded from custody.' : ''

  let markReady
  if (status === STATUS.IN_CUSTODY) {
    markReady = gateReason
      ? { visible: true, enabled: false, reason: gateReason }
      : { visible: true, enabled: true, reason: 'Payment must already be confirmed for the violation.' }
  } else {
    markReady = {
      visible: true, enabled: false,
      reason: status === STATUS.RELEASED ? 'Already released.' : 'Already marked ready.',
    }
  }

  let release
  if (status === STATUS.READY) {
    release = docOk(doc)
      ? { visible: true, enabled: true, reason: 'Records the actual release of the license.' }
      : { visible: true, enabled: false, reason: gateReason }
  } else if (status === STATUS.RELEASED) {
    release = { visible: true, enabled: false, reason: 'Already released.' }
  } else {
    release = { visible: true, enabled: false, reason: 'License must be marked ready first.' }
  }

  const verify = doc === DOC.PENDING
    ? { visible: true, enabled: true, reason: 'For legacy records only.' }
    : {
      visible: true, enabled: false,
      reason: doc === DOC.NOT_REQUIRED ? 'Only for legacy records that need verification.' : 'Already verified.',
    }

  const correct = !isAdmin
    ? none
    : record.can_correct === true
      ? { visible: true, enabled: true, reason: 'Corrects the license number used for custody.' }
      : { visible: true, enabled: false, reason: 'Archived records cannot be corrected.' }

  // Only an Administrator may exclude a record as "not a driver's license".
  return { markReady, release, verify, correct, canExclude: isAdmin }
}

/**
 * Human-readable rows for an event's Admin-only `details` payload.
 * Staff events carry no `details`, so this returns [] for them.
 */
export function describeEventDetails(event) {
  const d = event?.details
  if (!d || typeof d !== 'object') return []
  const rows = []
  if (d.reason) rows.push(['Reason', d.reason])
  if (d.before?.license_number !== undefined || d.after?.license_number !== undefined) {
    rows.push(['License number', `${d.before?.license_number || '—'} → ${d.after?.license_number || '—'}`])
  }
  if (d.before?.doc_type_status !== undefined || d.after?.doc_type_status !== undefined) {
    const lab = (v) => DOC_META[v]?.label || v || '—'
    rows.push(['Document verification', `${lab(d.before?.doc_type_status)} → ${lab(d.after?.doc_type_status)}`])
  }
  if (d.released_to_name) rows.push(['Released to', d.released_to_name])
  if (d.claimant_id_type) {
    const last4 = d.claimant_id_last4 ? ` ••••${d.claimant_id_last4}` : ''
    rows.push(['Claimant ID', `${claimantIdTypeLabel(d.claimant_id_type)}${last4}`])
  }
  if (d.authorization_reference) rows.push(['Authorization ref.', d.authorization_reference])
  return rows
}