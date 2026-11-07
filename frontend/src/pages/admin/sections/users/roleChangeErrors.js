// Maps the backend's change-role error responses ({ error, code }) to a safe
// message for the Change Role modal. Codes mirror accounts.services.RoleChangeError.

export const ROLE_CHANGE_ERROR_MESSAGES = {
  permission_denied: 'Only an active administrator can change roles.',
  self_change: 'You cannot change your own role.',
  invalid_role: 'Invalid role.',
  reason_required: 'A reason for the role change is required.',
  reason_too_long: 'The reason is too long.',
  not_found: 'This user no longer exists.',
  admin_transition_not_supported: 'Role changes to or from Administrator are not supported.',
  unsupported_transition: 'This role change is not supported.',
  stale_request: "This account's role has changed since you loaded it. The list has been refreshed.",
  role_unchanged: 'This account already has that role. The list has been refreshed.',
  account_inactive: 'Only an active account can change role. Reactivate the account first.',
  schedules_exist: 'This enforcer still has schedules dated today or later. Remove them before changing the role.',
  id_conflict: 'Could not allocate a new ID number. Please try again.',
  id_not_accepted: 'The ID number is assigned by the system and cannot be supplied.',
}

// After these, what the admin is looking at is out of date: reload the list.
export const REFRESH_ERROR_CODES = ['stale_request', 'role_unchanged', 'not_found', 'account_inactive']

const GENERIC = 'Failed to change role. Please try again.'
const NETWORK = 'Could not reach the server. Check your connection and try again.'

/**
 * Normalise an axios error into { code, message, refresh }.
 * Known codes use the backend's own safe message when it sent one; anything
 * unrecognised (or a 5xx) gets a generic message and never leaks internals.
 */
export function getRoleChangeError(err) {
  const res = err?.response
  if (!res) return { code: 'network', message: NETWORK, refresh: false }

  const code = res.data?.code
  if (code && Object.hasOwn(ROLE_CHANGE_ERROR_MESSAGES, code)) {
    const fromServer = typeof res.data?.error === 'string' && res.data.error.trim()
    return {
      code,
      message: res.status < 500 && fromServer ? fromServer : ROLE_CHANGE_ERROR_MESSAGES[code],
      refresh: REFRESH_ERROR_CODES.includes(code),
    }
  }
  if (res.status === 403) return { code: 'permission_denied', message: ROLE_CHANGE_ERROR_MESSAGES.permission_denied, refresh: false }
  if (res.status === 404) return { code: 'not_found', message: ROLE_CHANGE_ERROR_MESSAGES.not_found, refresh: true }
  return { code: code || 'unknown', message: GENERIC, refresh: false }
}