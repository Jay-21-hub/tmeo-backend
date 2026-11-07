/**
 * Offline queue ownership rules (Batch 0 / D7).
 *
 * The queue in localStorage and the evidence photos in IndexedDB belong to
 * the device, not to the session. Without an owner on each item, whoever
 * logs in next would sync the previous user's reports under THEIR token,
 * and the server would attribute them to the wrong enforcer. These pure
 * helpers decide, for the user who is logged in right now, which items are
 * theirs to sync and which must be quarantined (kept, never posted, never
 * deleted).
 *
 * Pure on purpose: no React, no localStorage access except the optional
 * default argument of getCurrentUser, so they can be unit-tested with
 * `node --test`.
 */

export function getCurrentUser(storage = globalThis.localStorage) {
  try {
    const u = JSON.parse(storage?.getItem('user') || '{}')
    return u && typeof u === 'object' ? u : {}
  } catch {
    return {}
  }
}

const sameId = (a, b) => a != null && b != null && String(a) === String(b)

/** Only a logged-in Enforcer may sync offline reports. */
export function canSyncAs(user) {
  return !!user && user.id != null && user.role === 'enforcer'
}

/**
 * Owner of a queued OVR = its owner_user_id, and NOTHING else.
 *
 * Legacy items (queued before owner stamping) have no owner_user_id. They
 * stay LEGACY OWNER UNKNOWN: quarantined for every user, never auto-claimed.
 * The old `enforcer` / `enforcer_name` fields may still exist on them for
 * display/debug, but they are client-written data and must never authorize
 * a sync, so they are deliberately ignored here.
 */
export function ownerIdOf(item) {
  if (!item || item.owner_user_id == null) return null
  return item.owner_user_id
}

export function isOwnedBy(item, userId) {
  return sameId(ownerIdOf(item), userId)
}

/** Split the raw queue into the current user's items and quarantined ones. */
export function partitionQueue(queue, userId) {
  const own = []
  const quarantined = []
  for (const item of Array.isArray(queue) ? queue : []) {
    if (isOwnedBy(item, userId)) own.push(item)
    else quarantined.push(item)
  }
  return { own, quarantined }
}

/**
 * May this IndexedDB evidence record be uploaded by `userId`?
 *  - linked to an OVR: only if that OVR is one of the user's own queue items
 *    (and, when the record carries its own owner stamp, the stamp matches);
 *  - standalone: only if it carries an owner stamp equal to the user.
 *    Standalone photos saved before owner stamping have no owner and are
 *    quarantined (never uploaded under someone else's token).
 */
export function evidenceBelongsTo(ev, userId, ownLocalIds) {
  if (!ev) return false
  if (ev.owner_user_id != null && !sameId(ev.owner_user_id, userId)) return false
  if (ev.local_ovr_id) return ownLocalIds instanceof Set && ownLocalIds.has(ev.local_ovr_id)
  return sameId(ev.owner_user_id, userId)
}