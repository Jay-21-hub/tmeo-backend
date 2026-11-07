/**
 * offlineEvidenceDB — IndexedDB wrapper for evidence photo Blobs captured
 * while offline.
 *
 * Why not localStorage: the existing offline queue (`tmeo_offline_reports`
 * in localStorage) already handles the OVR's JSON fields fine, but
 * localStorage can only store strings — a captured photo's File/Blob has
 * to be base64-encoded first, which bloats it ~33% and risks blowing the
 * ~5-10MB localStorage quota with just a couple of photos. IndexedDB
 * stores Blobs natively with a much larger quota, so this module is
 * purely an extension for evidence photos — it does NOT replace or
 * touch the existing localStorage OVR queue.
 *
 * Each evidence record is OPTIONALLY keyed by the OVR's local offline id
 * (e.g. `offline_1735689600000`, the same id SyncData/IssueOVR assigns the
 * queued Violation) so evidence stays linked to its OVR until the OVR
 * itself has synced and received a real server id — see SyncData.jsx's
 * flush step, which re-keys and uploads evidence AFTER the OVR sync
 * succeeds and a real violation id exists.
 *
 * `local_ovr_id` may also be null/omitted — Camera Evidence can be
 * captured completely standalone (no OVR context at all, e.g. from the
 * dashboard's own "Camera Evidence" entry point) and associated with an
 * OVR later, from the Evidence Gallery, once it has synced.
 */

import { getCurrentUser } from '../utils/offlineOwnership'

const DB_NAME = 'tmeo_offline_evidence'
const DB_VERSION = 1
const STORE = 'evidence'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
        store.createIndex('local_ovr_id', 'local_ovr_id', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * Save a captured evidence Blob while offline.
 * @param {string|null} localOvrId - the offline queue id of the parent OVR,
 *   or null/undefined for a fully standalone capture (no OVR context yet).
 * @param {Blob} blob - the photo
 * @param {{capturedAt: string, latitude: number|null, longitude: number|null, gpsAccuracy?: number|null}} meta
 * @returns {Promise<number>} the IndexedDB record id
 */
export async function saveOfflineEvidence(localOvrId, blob, meta) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const record = {
      local_ovr_id: localOvrId || null,
      // Batch 0 (D7): who captured it on this device. Stamped here from the
      // live session so a different user logging in later cannot upload it
      // under their own token.
      owner_user_id: getCurrentUser().id ?? null,
      blob,
      captured_at: meta.capturedAt,
      latitude: meta.latitude ?? null,
      longitude: meta.longitude ?? null,
      gps_accuracy: meta.gpsAccuracy ?? null,
      saved_at: new Date().toISOString(),
    }
    const req = store.add(record)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Get all evidence records queued for a given local OVR id. */
export async function getOfflineEvidenceForOvr(localOvrId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const idx = tx.objectStore(STORE).index('local_ovr_id')
    const req = idx.getAll(localOvrId)
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

/** Get every offline evidence record with no OVR context at all (standalone captures). */
export async function getOfflineEvidenceUnassociated() {
  const all = await getAllOfflineEvidence()
  return all.filter(r => !r.local_ovr_id)
}

/** Get every evidence record currently queued offline (for SyncData's badge/count). */
export async function getAllOfflineEvidence() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

/** Delete one evidence record by its IndexedDB id (after successful upload). */
export async function deleteOfflineEvidence(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Delete every evidence record queued for a given local OVR id (after that OVR fully syncs). */
export async function deleteOfflineEvidenceForOvr(localOvrId) {
  const records = await getOfflineEvidenceForOvr(localOvrId)
  await Promise.all(records.map(r => deleteOfflineEvidence(r.id)))
}