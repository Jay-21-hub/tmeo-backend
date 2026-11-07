import { useState, useEffect, useCallback, useRef } from 'react'
import api from '../services/api'
import usePolling from './usePolling'

const API_NOTIF = '/api/notifications/'

export const NOTIF_POLL_MS = 15000

export default function useNotifications() {
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount]     = useState(0)
  // True only while a fetch is running: initial load, poll and refetch() share it,
  // so requests never overlap.
  const fetchingRef = useRef(false)
  // Bumped by every local mutation (markRead). A poll that STARTED before a mutation
  // is discarded, otherwise its stale server snapshot would briefly un-read what the
  // user just marked as read.
  const mutationRef = useRef(0)
  // Same rule as before: no token, no live updates.
  const [hasToken] = useState(() => !!localStorage.getItem('access_token'))

  const fetchNotifications = useCallback(async () => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    const startedAt = mutationRef.current
    try {
      const res = await api.get(API_NOTIF)
      if (mutationRef.current !== startedAt) return
      setNotifications(res.data.notifications || [])
      setUnreadCount(res.data.unread_count || 0)
    } catch (err) {
      console.error('[useNotifications] fetch failed:', err)
    } finally {
      fetchingRef.current = false
    }
  }, [])

  // Initial load
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount pattern, same convention used elsewhere in this codebase
    fetchNotifications()
  }, [fetchNotifications])

  // Live updates: poll every 15 s (paused while the tab is hidden, immediate refresh
  // when it is shown again). This replaces the persistent /api/notifications/sse/
  // stream, which held one server thread per open tab. The list and unread_count come
  // from the same endpoint as the initial load, so they are always authoritative.
  usePolling(fetchNotifications, { intervalMs: NOTIF_POLL_MS, enabled: hasToken })

  const markRead = async (id = null) => {
    mutationRef.current += 1
    try {
      if (id) {
        // Fabricated ids (see above) are always negative and never exist
        // server-side — skip the no-op request and just reconcile locally
        // next time a full fetch happens.
        if (typeof id === 'number' && id < 0) {
          setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n))
          setUnreadCount(prev => Math.max(0, prev - 1))
          return
        }
        await api.post(`${API_NOTIF}${id}/read/`)
        setNotifications(prev =>
          prev.map(n => n.id === id ? { ...n, is_read: true } : n)
        )
        setUnreadCount(prev => Math.max(0, prev - 1))
      } else {
        await api.post(`${API_NOTIF}read/`)
        setNotifications(prev => prev.map(n => ({ ...n, is_read: true })))
        setUnreadCount(0)
      }
    } catch {
      // Best-effort mark-as-read — a failed request here shouldn't
      // surface an error to the user; the bell will just stay unread.
    } finally {
      mutationRef.current += 1
    }
  }

  return { notifications, unreadCount, markRead, refetch: fetchNotifications }
}