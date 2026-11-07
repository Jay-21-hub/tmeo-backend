import { useEffect, useState } from 'react'
import { WifiOff, RefreshCw, CheckCircle2, Package } from 'lucide-react'
import useOfflineQueue from '../../hooks/useOfflineQueue'
import './OfflineStatusBar.css'

/**
 * Compact offline/sync status banner (Requirement #10 — Offline Mode,
 * Session Persistence & Sync Lifecycle). Both EnforcerShell (mobile) and
 * AppShell (desktop/tablet, enforcer role only) just render
 * `<OfflineStatusBar onOpenSync={...} />` — it shares the same
 * useOfflineQueue() engine SyncData.jsx uses, so what this banner shows is
 * always exactly the real queue state, never a separate guess at it.
 *
 * Visual states, in priority order:
 *   1. offline right now                   -> red bar
 *   2. online + a sync pass is running     -> blue bar
 *   3. online + a pass just finished clean -> green bar (auto-dismisses)
 *   4. online + idle, queue not empty      -> amber "Pending Sync" chip,
 *      tappable to jump to the Sync Data page
 *   5. online + idle + empty queue         -> renders nothing
 */
export default function OfflineStatusBar({ onOpenSync }) {
  const { isOnline, syncing, pendingCount, lastSyncResult } = useOfflineQueue()
  const [showJustSynced, setShowJustSynced] = useState(false)

  useEffect(() => {
    if (!lastSyncResult) return
    if (lastSyncResult.succeeded > 0 && lastSyncResult.failed === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to an external event (a sync pass finishing), same convention used elsewhere in this codebase
      setShowJustSynced(true)
      const t = setTimeout(() => setShowJustSynced(false), 4000)
      return () => clearTimeout(t)
    }
  }, [lastSyncResult])

  if (!isOnline) {
    // Sync Data → Save Offline Report is the one dedicated offline-entry
    // point (Issue OVR is online-only), so the offline banner points
    // there directly rather than implying Issue OVR can save locally.
    return (
      <button type="button" className="osb osb--offline" onClick={onOpenSync} aria-label="You're offline — use Sync Data to save violation reports">
        <WifiOff size={14} strokeWidth={2.2} aria-hidden="true" />
        <span>You're offline — use Sync Data to save violation reports</span>
        {pendingCount > 0 && <span className="osb-count">{pendingCount}</span>}
      </button>
    )
  }

  if (syncing) {
    return (
      <div className="osb osb--syncing" role="status">
        <RefreshCw size={14} strokeWidth={2.2} className="osb-spin" aria-hidden="true" />
        <span>Syncing{pendingCount > 0 ? ` ${pendingCount}` : ''} report{pendingCount !== 1 ? 's' : ''}…</span>
      </div>
    )
  }

  if (showJustSynced) {
    return (
      <div className="osb osb--synced" role="status">
        <CheckCircle2 size={14} strokeWidth={2.2} aria-hidden="true" />
        <span>All reports synced</span>
      </div>
    )
  }

  if (pendingCount > 0) {
    return (
      <button type="button" className="osb osb--pending" onClick={onOpenSync}>
        <Package size={14} strokeWidth={2.2} aria-hidden="true" />
        <span>{pendingCount} Pending Sync</span>
      </button>
    )
  }

  return null
}