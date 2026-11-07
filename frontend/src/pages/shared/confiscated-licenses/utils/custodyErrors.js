// Normalises every error the Confiscated Licenses API can return.
//
// Real shapes (Stage B backend):
//   * custody business errors  -> 409/404/403  { code, detail, ...extra }
//       e.g. payment_required, version_conflict {current_version}, no_change,
//            invalid_transition, already_released, not_ready, record_excluded,
//            document_type_unverified, verification_not_pending,
//            archived_locked, idempotency_conflict, admin_required (403), not_found (404)
//   * DRF serializer validation -> 400 { field: ["message", ...], ... }
//   * DRF permission denial     -> 403 { detail }            (no `code`)
//   * throttling                -> 429 { detail }
//   * no response at all        -> network / timeout
// A 401 is handled by the shared axios interceptor (token refresh / logout).

export const CODE_MESSAGES = {
  payment_required: 'The violation must be paid before the license can be marked ready for release.',
  invalid_transition: 'This license can no longer be marked ready for release.',
  already_released: 'This license was already released.',
  not_ready: 'Mark the license ready for release before releasing it.',
  document_type_unverified: 'The document type of this legacy record has not been verified yet.',
  record_excluded: "This record was excluded as not a driver's license.",
  verification_not_pending: 'This record does not need (or has already had) document-type verification.',
  admin_required: 'Only an Administrator may perform this action.',
  no_change: 'The license number is already recorded as entered.',
  archived_locked: 'The license number of an archived record cannot be corrected.',
  version_conflict: 'This record was changed by someone else. The latest version has been loaded.',
  idempotency_conflict: 'This request could not be processed. Please try again.',
  not_found: 'This confiscated license record no longer exists.',
}

// The record the user was looking at is out of date (or gone): the action
// cannot succeed as shown, so the caller closes the dialog and reloads.
export const STALE_CODES = [
  'version_conflict', 'invalid_transition', 'already_released', 'not_ready',
  'document_type_unverified', 'record_excluded', 'verification_not_pending',
  'archived_locked', 'not_found',
]

const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.'
const NETWORK_WRITE_MESSAGE = 'Could not reach the server, so the action may not have been saved. It is safe to try again — a repeated request is never applied twice.'
const GENERIC_MESSAGE = 'Something went wrong. Please try again.'
const FORBIDDEN_MESSAGE = 'You do not have permission to perform this action.'
const NOT_FOUND_MESSAGE = CODE_MESSAGES.not_found
const THROTTLE_MESSAGE = 'Too many requests. Please wait a moment and try again.'
const SESSION_MESSAGE = 'Your session has expired. Please sign in again.'
const VALIDATION_MESSAGE = 'Please correct the highlighted fields.'

const asText = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(' ') : typeof v === 'string' ? v : '')

/**
 * @param err      axios error
 * @param opts.fields  form field names that have an input in the UI; validation
 *                     errors for any other field are folded into `message`
 * @param opts.write   true for POST actions (network failures mean "outcome unknown")
 * @returns {{
 *   status:number|null, code:string, message:string,
 *   fieldErrors:Record<string,string>, currentVersion:number|null,
 *   stale:boolean, network:boolean, unknownOutcome:boolean
 * }}
 */
export function parseCustodyError(err, { fields = [], write = false } = {}) {
  const res = err?.response
  const base = { status: null, code: 'unknown', message: GENERIC_MESSAGE, fieldErrors: {}, currentVersion: null, stale: false, network: false, unknownOutcome: false }

  if (!res) {
    return { ...base, code: 'network', network: true, unknownOutcome: write, message: write ? NETWORK_WRITE_MESSAGE : NETWORK_MESSAGE }
  }

  const status = res.status
  const data = res.data && typeof res.data === 'object' ? res.data : {}
  const out = { ...base, status }

  if (status >= 500) {
    // A 5xx on a write may or may not have committed: never leak internals, advise retry.
    return { ...out, code: 'server_error', unknownOutcome: write, message: write ? NETWORK_WRITE_MESSAGE : GENERIC_MESSAGE }
  }

  const code = typeof data.code === 'string' ? data.code : ''
  if (code) {
    const fromServer = asText(data.detail).trim()
    return {
      ...out,
      code,
      // Known codes use our own copy (the server text for version_conflict says
      // "reload", but the UI reloads automatically); unknown codes fall back to the server's text.
      message: Object.hasOwn(CODE_MESSAGES, code) ? CODE_MESSAGES[code] : (fromServer || GENERIC_MESSAGE),
      currentVersion: Number.isInteger(data.current_version) ? data.current_version : null,
      stale: STALE_CODES.includes(code),
    }
  }

  if (status === 400) {
    const fieldErrors = {}
    const extra = []
    for (const [k, v] of Object.entries(data)) {
      const text = asText(v).trim()
      if (!text) continue
      if (fields.includes(k)) fieldErrors[k] = text
      else extra.push(text)
    }
    return { ...out, code: 'validation_error', fieldErrors, message: extra.length ? extra.join(' ') : VALIDATION_MESSAGE }
  }
  if (status === 401) return { ...out, code: 'unauthenticated', message: SESSION_MESSAGE }
  if (status === 403) return { ...out, code: 'permission_denied', message: FORBIDDEN_MESSAGE }
  if (status === 404) return { ...out, code: 'not_found', stale: true, message: NOT_FOUND_MESSAGE }
  if (status === 429) return { ...out, code: 'throttled', message: THROTTLE_MESSAGE }
  return out
}

/** True for a request cancelled via AbortController (not a real failure). */
export const isCancelled = (err) => err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError'