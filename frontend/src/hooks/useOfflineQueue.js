import { useState, useEffect, useCallback, useMemo } from 'react'
import api from '../services/api'
import { API } from '../constants'
import {
  getOfflineEvidenceForOvr, getOfflineEvidenceUnassociated, deleteOfflineEvidence,
} from '../services/offlineEvidenceDB'
import {
  getCurrentUser, canSyncAs, isOwnedBy, partitionQueue, evidenceBelongsTo,
} from '../utils/offlineOwnership'

const STORAGE_KEY = 'tmeo_offline_reports'
// Broadcast whenever the queue changes, so every mounted useOfflineQueue()
// instance (SyncData page, OfflineStatusBar, anything else) re-reads
// localStorage and stays in sync with each other — no prop drilling, no
// separate store needed.
const SYNC_EVENT = 'tmeo-offline-queue-changed'

// Module-level (not per-hook-instance) in-flight guard. Requirement #10
// explicitly calls out that overlapping sync passes must not be able to
// POST the same queued report twice. Without this, the OfflineStatusBar's
// auto-sync-on-reconnect and SyncData's own auto-sync effect could both
// fire at once from two different mounted components.
let inFlight = false
// A sync requested while a pass is already running (e.g. Save Offline right
// after a background evidence pass started) is not dropped: it is re-run once
// the current pass finishes, so a freshly queued report is never left waiting.
let rerunRequested = false
let latestSync = null

function readQueue() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}
function writeQueue(next) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent(SYNC_EVENT))
}

const isPending = (r) => r.syncStatus === 'queued' || r.syncStatus === 'failed'

/**
 * Upload one offline evidence photo. Resolves only when the server accepted
 * it; throws otherwise. The caller deletes the IndexedDB record ONLY after
 * this resolves — a failed upload (403/500/network) must leave the photo
 * where it is so it can be retried (Batch 0: evidence reliability).
 */
async function uploadEvidence(ev, violationId) {
  const fd = new FormData()
  fd.append('image', new File([ev.blob], `evidence_${ev.id}.jpg`, { type: 'image/jpeg' }))
  fd.append('captured_at', ev.captured_at)
  if (violationId != null)     fd.append('violation', violationId)
  if (ev.latitude != null)     fd.append('latitude', ev.latitude)
  if (ev.longitude != null)    fd.append('longitude', ev.longitude)
  if (ev.gps_accuracy != null) fd.append('gps_accuracy', ev.gps_accuracy)
  await api.post(API.EVIDENCE, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}

/**
 * Single shared engine for the offline OVR queue's sync lifecycle
 * (Requirement #10). Both SyncData.jsx (full queue view) and
 * OfflineStatusBar.jsx (compact banner/chip) call this instead of each
 * keeping their own copy of the sync logic — that duplication is exactly
 * what used to make double-POSTs possible.
 *
 * Identity safety (Batch 0 / D7): every queued item is stamped with the
 * owner_user_id of whoever saved it. A sync pass only POSTs items owned by
 * the user logged in RIGHT NOW (and only if that user is an Enforcer).
 * Everything else is quarantined: still in storage, never posted, never
 * deleted, and surfaced separately as `quarantined`. The backend is still
 * the authority on who filed a record (it uses the token), so this is what
 * stops one user's report being filed under another user's token.
 */
export default function useOfflineQueue() {
  const [rawQueue, setRawQueue]         = useState(readQueue)
  const [isOnline, setIsOnline]         = useState(navigator.onLine)
  const [syncing, setSyncing]           = useState(inFlight)
  const [lastSyncResult, setLastSyncResult] = useState(null) // { at, succeeded, failed }

  // The logged-in user, re-read whenever the queue/session may have changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rawQueue change is the cue to re-read the session
  const user = useMemo(() => getCurrentUser(), [rawQueue])
  const userId = user?.id ?? null

  const { own: reports, quarantined } = useMemo(
    () => partitionQueue(rawQueue, userId),
    [rawQueue, userId],
  )

  // ── stay in sync with other mounted instances / other tabs ─────────────
  useEffect(() => {
    const refresh = () => setRawQueue(readQueue())
    window.addEventListener(SYNC_EVENT, refresh)
    window.addEventListener('storage', refresh) // cross-tab
    return () => {
      window.removeEventListener(SYNC_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  // ── online/offline ───────────────────────────────────────────────────
  useEffect(() => {
    const on  = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online',  on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  // ── the actual sync pass ────────────────────────────────────────────
  const sync = useCallback(async () => {
    if (!navigator.onLine) return
    if (inFlight) { rerunRequested = true; return }

    // Who is syncing is decided ONCE, from the live session. Non-enforcers
    // (Staff/Admin) never sync the offline queue.
    const me = getCurrentUser()
    if (!canSyncAs(me)) return
    const myId = me.id
    const stillMe = () => String(getCurrentUser().id ?? '') === String(myId)

    const current = readQueue()
    const mine    = current.filter(r => isOwnedBy(r, myId))
    const toSync  = mine.filter(isPending)

    inFlight = true
    // Only show the "Syncing…" state when there are reports to send. An
    // evidence-only retry pass runs quietly in the background.
    if (toSync.length > 0) setSyncing(true)

    let succeeded = 0
    let failed = 0

    // Write back one item's change without touching anyone else's items,
    // always against a fresh read so concurrent edits are not clobbered.
    const patchItem = (id, patch) => {
      const next = readQueue().map(r => (r.id === id ? { ...r, ...patch } : r))
      writeQueue(next); setRawQueue(next)
    }

    try {
      if (toSync.length > 0) {
        const ids = new Set(toSync.map(r => r.id))
        const marked = readQueue().map(r => (ids.has(r.id) ? { ...r, syncStatus: 'syncing' } : r))
        writeQueue(marked); setRawQueue(marked)
      }

      for (const report of toSync) {
        // Session changed mid-pass (logout / different login): stop. Remaining
        // items go back to their previous status instead of staying 'syncing'.
        if (!stillMe()) {
          const rest = new Set(toSync.slice(toSync.indexOf(report)).map(r => r.id))
          const reverted = readQueue().map(r =>
            rest.has(r.id) && r.syncStatus === 'syncing'
              ? { ...r, syncStatus: toSync.find(t => t.id === r.id).syncStatus }
              : r)
          writeQueue(reverted); setRawQueue(reverted)
          break
        }

        let newViolationId = null
        try {
          const payload = {
            violator_name:      report.violator_name,
            address:            report.address,
            license_number:     report.license_number,
            plate_number:       report.plate_number,
            vehicle_type:       report.vehicle_type,
            vehicle_brand:      report.vehicle_brand,
            vehicle_model:      report.vehicle_model,
            violation_type_ids: report.violation_type_ids,
            location:           report.location,
            date_issued:        report.date_issued,
            remarks:            report.remarks || '',
            status:             'pending',
            // Idempotency key (Requirement #6/#10) — sent on every attempt
            // for this record, including retries, so a resend after a
            // dropped response replays the original instead of creating a
            // duplicate Violation. Falls back to the local queue id for any
            // record queued before this field existed.
            client_offline_id: report.client_offline_id || report.id,
          }
          if (report.source)               payload.source               = report.source
          if (report.ovr_number)           payload.ovr_number           = report.ovr_number
          if (report.license_status)       payload.license_status       = report.license_status
          if (report.registration_number)  payload.registration_number  = report.registration_number
          if (report.vehicle_use)          payload.vehicle_use          = report.vehicle_use
          if (report.latitude)             payload.latitude             = report.latitude
          if (report.longitude)            payload.longitude            = report.longitude
          if (report.penalty_amount != null) payload.penalty_amount     = report.penalty_amount

          const res = await api.post('/api/violations/create/', payload)
          newViolationId = res.data?.id ?? null
          patchItem(report.id, {
            syncStatus: 'synced',
            syncedAt: new Date().toISOString(),
            // Remember the server id so evidence that fails to upload now
            // can still be retried on a later pass.
            serverViolationId: newViolationId,
          })
          succeeded++
        } catch {
          patchItem(report.id, { syncStatus: 'failed' })
          failed++
        }
      }

      // ── evidence photos linked to the user's OVRs ───────────────────
      // Covers this pass's fresh syncs AND earlier ones whose photos failed
      // to upload. Each photo is deleted ONLY after its own upload succeeds.
      if (stillMe()) {
        try {
          const myNow = readQueue().filter(r => isOwnedBy(r, myId))
          for (const report of myNow) {
            const serverId = report.serverViolationId
            if (report.syncStatus !== 'synced' || serverId == null) continue
            if (!stillMe()) break
            const queuedEvidence = await getOfflineEvidenceForOvr(report.id)
            const ownIds = new Set([report.id])
            for (const ev of queuedEvidence) {
              if (!evidenceBelongsTo(ev, myId, ownIds)) continue
              try {
                await uploadEvidence(ev, serverId)
                await deleteOfflineEvidence(ev.id)
              } catch { /* upload failed — photo stays in IndexedDB, retried next pass */ }
            }
          }
        } catch { /* IndexedDB unavailable — evidence stays queued, no data lost */ }
      }

      // ── fully-standalone evidence (no OVR context) ──────────────────
      // Only photos stamped with THIS user are uploaded. Unstamped legacy
      // photos have no provable owner and are left untouched.
      if (stillMe()) {
        try {
          const standalone = await getOfflineEvidenceUnassociated()
          for (const ev of standalone) {
            if (!stillMe()) break
            if (!evidenceBelongsTo(ev, myId, new Set())) continue
            try {
              await uploadEvidence(ev, null)
              await deleteOfflineEvidence(ev.id)
            } catch { /* left in IndexedDB — retried on next sync pass */ }
          }
        } catch { /* IndexedDB unavailable — evidence stays queued, no data lost */ }
      }
    } finally {
      inFlight = false
      setSyncing(false)
      if (succeeded + failed > 0) setLastSyncResult({ at: new Date(), succeeded, failed })
      if (rerunRequested) { rerunRequested = false; setTimeout(() => latestSync?.(), 0) }
    }
  }, [])

  useEffect(() => { latestSync = sync }, [sync])

  // ── auto-sync on reconnect (and on mount, if already online) ──────────
  // sync() itself no-ops for non-enforcers and when nothing belongs to the
  // current user, so this is safe to fire on every mount.
  useEffect(() => {
    if (!isOnline) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-sync on reconnect, matches existing codebase convention (see useAuth.js)
    sync()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect trigger only, sync() is stable
  }, [isOnline])

  const retry = useCallback((id) => {
    // Only the owner can retry an item.
    const me = getCurrentUser()
    const updated = readQueue().map(r =>
      r.id === id && isOwnedBy(r, me.id) ? { ...r, syncStatus: 'queued' } : r)
    writeQueue(updated); setRawQueue(updated)
    // Fire the pass on the next tick so the 'queued' state above is what
    // sync() reads back from localStorage.
    setTimeout(sync, 0)
  }, [sync])

  const remove = useCallback((id) => {
    const me = getCurrentUser()
    const updated = readQueue().filter(r => !(r.id === id && isOwnedBy(r, me.id)))
    writeQueue(updated); setRawQueue(updated)
  }, [])

  const clearSynced = useCallback(() => {
    // Never clears another user's items.
    const me = getCurrentUser()
    const updated = readQueue().filter(r => !(isOwnedBy(r, me.id) && r.syncStatus === 'synced'))
    writeQueue(updated); setRawQueue(updated)
  }, [])

  const add = useCallback((record) => {
    // The owner is stamped HERE from the live session — never taken from
    // the caller — so every new item is bound to whoever saved it.
    const me = getCurrentUser()
    const stamped = { ...record, owner_user_id: me.id ?? null }
    const updated = [stamped, ...readQueue()]
    writeQueue(updated); setRawQueue(updated)
  }, [])

  const queuedCount = reports.filter(r => r.syncStatus === 'queued').length
  const failedCount = reports.filter(r => r.syncStatus === 'failed').length
  const syncedCount = reports.filter(r => r.syncStatus === 'synced').length
  const pendingCount = queuedCount + failedCount

  return {
    reports, quarantined, quarantinedCount: quarantined.length,
    isOnline, syncing, lastSyncResult,
    sync, retry, remove, clearSynced, add,
    queuedCount, failedCount, syncedCount, pendingCount,
  }
}