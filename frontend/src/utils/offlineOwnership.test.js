import { describe, it, expect } from 'vitest'
import {
  getCurrentUser, canSyncAs, ownerIdOf, isOwnedBy, partitionQueue, evidenceBelongsTo,
} from './offlineOwnership'

// Pure-helper tests for the offline ownership rules (Batch 0 / D7).
// The hook-level behaviour (sync / quarantine / retry) is covered separately in
// src/hooks/__tests__/useOfflineQueue.test.jsx.

const store = (value) => ({ getItem: (k) => (k === 'user' ? value : null) })

// A = 7 (number), B = 8; items as the app writes them today.
const A = 7
const B = 8
const aItem = { local_id: 'a1', owner_user_id: A }
const bItem = { local_id: 'b1', owner_user_id: B }
// Queued before owner stamping: no owner_user_id. enforcer / enforcer_name are
// client-written leftovers and must never authorise anything.
const legacyForA = { local_id: 'l1', enforcer: A, enforcer_name: 'Enforcer A' }

describe('ownerIdOf / isOwnedBy', () => {
  it('a new item belongs to its explicit owner_user_id', () => {
    expect(ownerIdOf(aItem)).toBe(A)
    expect(isOwnedBy(aItem, A)).toBe(true)
  })

  it("User B cannot treat A's item as their own", () => {
    expect(isOwnedBy(aItem, B)).toBe(false)
    expect(isOwnedBy(bItem, A)).toBe(false)
  })

  it('a legacy item with no owner_user_id has no owner', () => {
    expect(ownerIdOf(legacyForA)).toBeNull()
    expect(ownerIdOf({ owner_user_id: null })).toBeNull()
    expect(ownerIdOf({ owner_user_id: undefined })).toBeNull()
  })

  it('a legacy item is NOT inferred from the old `enforcer` field', () => {
    expect(isOwnedBy(legacyForA, A)).toBe(false)
    expect(isOwnedBy({ enforcer: A }, A)).toBe(false)
  })

  it('a legacy item is NOT inferred from `enforcer_name`', () => {
    expect(isOwnedBy({ enforcer_name: 'Enforcer A' }, A)).toBe(false)
    expect(isOwnedBy({ enforcer_name: 'Enforcer A' }, 'Enforcer A')).toBe(false)
  })

  it('the logged-in user does not implicitly claim an ownerless item', () => {
    for (const me of [A, B, '7', null, undefined]) {
      expect(isOwnedBy(legacyForA, me)).toBe(false)
      expect(isOwnedBy({}, me)).toBe(false)
    }
  })

  it('compares ids across number / string (JSON storage vs session user)', () => {
    expect(isOwnedBy({ owner_user_id: 7 }, '7')).toBe(true)
    expect(isOwnedBy({ owner_user_id: '7' }, 7)).toBe(true)
    expect(isOwnedBy({ owner_user_id: 7 }, '70')).toBe(false)
    expect(isOwnedBy({ owner_user_id: 7 }, '8')).toBe(false)
  })

  it('never matches when the current user id is missing', () => {
    expect(isOwnedBy(aItem, null)).toBe(false)
    expect(isOwnedBy(aItem, undefined)).toBe(false)
  })

  it('tolerates a missing item', () => {
    expect(ownerIdOf(null)).toBeNull()
    expect(ownerIdOf(undefined)).toBeNull()
    expect(isOwnedBy(null, A)).toBe(false)
  })
})

describe('partitionQueue', () => {
  const queue = [aItem, bItem, legacyForA]

  it("keeps the current user's items apart from quarantined ones", () => {
    const { own, quarantined } = partitionQueue(queue, A)
    expect(own).toEqual([aItem])
    expect(quarantined).toEqual([bItem, legacyForA])
  })

  it("B sees only B's item; A's and the legacy item stay quarantined", () => {
    const { own, quarantined } = partitionQueue(queue, B)
    expect(own).toEqual([bItem])
    expect(quarantined).toEqual([aItem, legacyForA])
  })

  it('the ownerless legacy item is quarantined for every user, never claimed', () => {
    for (const me of [A, B, '7', null]) {
      const { own, quarantined } = partitionQueue(queue, me)
      expect(own).not.toContain(legacyForA)
      expect(quarantined).toContain(legacyForA)
    }
  })

  it('quarantines everything when nobody is identified', () => {
    const { own, quarantined } = partitionQueue(queue, null)
    expect(own).toEqual([])
    expect(quarantined).toEqual(queue)
  })

  it('never drops or duplicates an item, and keeps the original objects', () => {
    const { own, quarantined } = partitionQueue(queue, A)
    expect(own.length + quarantined.length).toBe(queue.length)
    expect(own[0]).toBe(aItem)
    expect(quarantined[0]).toBe(bItem)
  })

  it('does not mutate the input queue', () => {
    const copy = [...queue]
    partitionQueue(queue, A)
    expect(queue).toEqual(copy)
  })

  it('treats a non-array queue as empty', () => {
    for (const bad of [null, undefined, {}, 'x', 5]) {
      expect(partitionQueue(bad, A)).toEqual({ own: [], quarantined: [] })
    }
  })
})

describe('canSyncAs', () => {
  it('only a logged-in enforcer with an id may sync', () => {
    expect(canSyncAs({ id: A, role: 'enforcer' })).toBe(true)
  })

  it('staff and admin may not sync, even with the same id', () => {
    expect(canSyncAs({ id: A, role: 'staff' })).toBe(false)
    expect(canSyncAs({ id: A, role: 'admin' })).toBe(false)
  })

  it('no user, no id, or no role may not sync', () => {
    expect(canSyncAs(null)).toBe(false)
    expect(canSyncAs(undefined)).toBe(false)
    expect(canSyncAs({})).toBe(false)
    expect(canSyncAs({ role: 'enforcer' })).toBe(false)
    expect(canSyncAs({ id: null, role: 'enforcer' })).toBe(false)
    expect(canSyncAs({ id: A })).toBe(false)
  })
})

describe('getCurrentUser', () => {
  it('reads the logged-in user from storage', () => {
    expect(getCurrentUser(store(JSON.stringify({ id: A, role: 'enforcer' })))).toEqual({ id: A, role: 'enforcer' })
  })

  it('returns {} when nothing is stored', () => {
    expect(getCurrentUser(store(null))).toEqual({})
  })

  it('returns {} for malformed JSON instead of throwing', () => {
    expect(getCurrentUser(store('{not json'))).toEqual({})
  })

  it('returns {} when the stored value is not an object', () => {
    expect(getCurrentUser(store('null'))).toEqual({})
    expect(getCurrentUser(store('7'))).toEqual({})
    expect(getCurrentUser(store('"x"'))).toEqual({})
  })

  it('returns {} when storage itself is unavailable or throws', () => {
    expect(getCurrentUser(null)).toEqual({})
    expect(getCurrentUser({ getItem: () => { throw new Error('denied') } })).toEqual({})
  })
})

describe('evidenceBelongsTo (IndexedDB photos)', () => {
  const own = new Set(['ovr-a'])

  it("a photo linked to the user's own queued OVR is theirs", () => {
    expect(evidenceBelongsTo({ local_ovr_id: 'ovr-a' }, A, own)).toBe(true)
    expect(evidenceBelongsTo({ local_ovr_id: 'ovr-a', owner_user_id: A }, A, own)).toBe(true)
  })

  it("a photo linked to someone else's OVR is quarantined", () => {
    expect(evidenceBelongsTo({ local_ovr_id: 'ovr-b' }, A, own)).toBe(false)
  })

  it('a conflicting owner stamp wins over a matching OVR link', () => {
    expect(evidenceBelongsTo({ local_ovr_id: 'ovr-a', owner_user_id: B }, A, own)).toBe(false)
  })

  it('a linked photo is quarantined when the own-OVR set is missing or not a Set', () => {
    expect(evidenceBelongsTo({ local_ovr_id: 'ovr-a' }, A, undefined)).toBe(false)
    expect(evidenceBelongsTo({ local_ovr_id: 'ovr-a' }, A, ['ovr-a'])).toBe(false)
  })

  it('a standalone photo needs an owner stamp equal to the user', () => {
    expect(evidenceBelongsTo({ owner_user_id: A }, A, own)).toBe(true)
    expect(evidenceBelongsTo({ owner_user_id: '7' }, A, own)).toBe(true)
    expect(evidenceBelongsTo({ owner_user_id: B }, A, own)).toBe(false)
  })

  it('an unstamped legacy standalone photo is never uploaded by anyone', () => {
    for (const me of [A, B, null]) {
      expect(evidenceBelongsTo({}, me, own)).toBe(false)
      expect(evidenceBelongsTo({ owner_user_id: null }, me, own)).toBe(false)
    }
  })

  it('a missing record is not owned', () => {
    expect(evidenceBelongsTo(null, A, own)).toBe(false)
    expect(evidenceBelongsTo(undefined, A, own)).toBe(false)
  })
})