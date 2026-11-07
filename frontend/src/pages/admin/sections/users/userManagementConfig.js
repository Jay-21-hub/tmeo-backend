export const ROLE_STYLES = {
  Administrator: { bg: '#eff6ff', text: '#2563eb', border: '#bfdbfe' },
  'Assessment Staff': { bg: '#f5f3ff', text: '#7c3aed', border: '#ddd6fe' },
  'Traffic Enforcer': { bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0' },
}

export const getRoleStyle = (role) => ROLE_STYLES[role] || ROLE_STYLES['Traffic Enforcer']

export const EMPTY_FORM = {
  last_name: '', first_name: '', middle_name: '',
  email: '', phone_number: '',
  address: '', date_of_birth: '', civil_status: '',
  role: 'enforcer', badge_number: '', assigned_area: '', password: '',
  hired_year: new Date().getFullYear(),
  employment_status: 'active',
}

export const ROLE_LABELS = { enforcer: 'Traffic Enforcer', staff: 'Assessment Staff', admin: 'Administrator' }

// ── Change Role (Phase 6) ─────────────────────────────────────────────────
// Mirrors accounts.services.SUPPORTED_TRANSITIONS: only Staff <-> Enforcer.
// Admin accounts are never changed here and nobody is promoted to Admin.
// The backend is the authority; this only decides whether to OFFER the action.
export const ROLE_CHANGE_TRANSITIONS = { staff: 'enforcer', enforcer: 'staff' }
export const ROLE_CHANGE_REASON_MAX = 500

// Mirrors CustomUser.is_separated on the backend.
export const SEPARATED_EMPLOYMENT_STATUSES = [
  'resigned', 'retired', 'terminated', 'dropped', 'deceased', 'coterminous',
]

/** The role this account would change TO, or null when no change is supported. */
export const getRoleChangeTarget = (role) => ROLE_CHANGE_TRANSITIONS[role] || null

/**
 * Whether "Change Role" is offered for a row: a supported transition, an
 * active non-separated account, and not the signed-in admin's own account.
 */
export const canChangeRole = (user, currentUserId = null) => {
  if (!user || !getRoleChangeTarget(user.role)) return false
  if (user.is_active === false) return false
  if (SEPARATED_EMPLOYMENT_STATUSES.includes(user.employment_status)) return false
  if (currentUserId !== null && currentUserId !== undefined && String(user.id) === String(currentUserId)) return false
  return true
}

export const CIVIL_STATUS_OPTIONS = [
  { value: 'single', label: 'Single' },
  { value: 'married', label: 'Married' },
  { value: 'widowed', label: 'Widowed' },
  { value: 'separated', label: 'Separated' },
  { value: 'divorced', label: 'Divorced' },
]

// Mirrors CustomUser.EmploymentStatus on the backend (accounts/models.py).
export const EMPLOYMENT_STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'on_leave', label: 'On Leave' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'resigned', label: 'Resigned' },
  { value: 'retired', label: 'Retired' },
  { value: 'terminated', label: 'Terminated' },
  { value: 'dropped', label: 'Dropped from Rolls' },
  { value: 'deceased', label: 'Deceased' },
  { value: 'coterminous', label: 'Coterminous' },
]

/**
 * Mirrors the backend's build_full_name() (accounts/models.py) so the
 * "Review" step can preview the composed full_name before saving, without
 * waiting on a round trip. Format: "Last, First Middle".
 */
export const buildFullNameDisplay = (lastName, firstName, middleName) => {
  const last = (lastName || '').trim()
  const first = (firstName || '').trim()
  const middle = (middleName || '').trim()
  const given = middle ? `${first} ${middle}`.trim() : first
  if (last && given) return `${last}, ${given}`
  return last || given || '—'
}