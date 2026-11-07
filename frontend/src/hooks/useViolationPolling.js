import usePolling from './usePolling'

// How often Staff/Admin screens that show OVR lock/status refresh themselves.
// Replaces the old persistent /api/violations/sse/ stream (it pinned one server
// thread per open tab). Short on purpose: the "locked by <staff>" badge is what
// stops two staff members from assessing the same OVR, and the lock is only
// advisory on the server (last PATCH wins), so the badge must not go stale.
export const STAFF_POLL_MS = 5000

/**
 * useViolationPolling(refresh)
 * `refresh` must return the promise of the request it makes, so polls never overlap.
 */
export default function useViolationPolling(refresh) {
  usePolling(refresh, { intervalMs: STAFF_POLL_MS })
}