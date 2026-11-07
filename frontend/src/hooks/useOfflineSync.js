import { useState, useEffect, useCallback } from 'react'
import api from '../services/api'

const STORAGE_KEY = 'tmeo_pending_violations'

export function useOfflineSync() {
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [pendingCount, setPendingCount] = useState(0)
  const [isSyncing, setIsSyncing] = useState(false)
  const [lastSyncResult, setLastSyncResult] = useState(null)

  // Declared before the effects that use them (directly or via the
  // functions below), and wrapped in useCallback so effect dependency
  // arrays can name them without retriggering on every render.
  const getPendingDrafts = useCallback(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : []
    } catch { return [] }
  }, [])

  const updatePendingCount = useCallback(() => {
    setPendingCount(getPendingDrafts().length)
  }, [getPendingDrafts])

  const saveDraft = useCallback((violationData) => {
    const drafts = getPendingDrafts()
    const draft = {
      ...violationData,
      _draft_id: `draft_${Date.now()}`,
      _saved_at: new Date().toISOString(),
    }
    drafts.push(draft)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
    updatePendingCount()
    return draft._draft_id
  }, [getPendingDrafts, updatePendingCount])

  const syncPendingViolations = useCallback(async () => {
    const drafts = getPendingDrafts()
    if (drafts.length === 0 || isSyncing) return
    setIsSyncing(true)
    let synced = 0, failed = 0
    const remaining = []
    for (const draft of drafts) {
      try {
        const formData = new FormData()
        const { _draft_id, _saved_at, ...fields } = draft
        Object.entries(fields).forEach(([k, v]) => {
          if (v !== null && v !== undefined) formData.append(k, v)
        })
        await api.post('/api/violations/create/', formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        })
        synced++
      } catch {
        remaining.push(draft)
        failed++
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(remaining))
    updatePendingCount()
    setIsSyncing(false)
    setLastSyncResult({ synced, failed })
    return { synced, failed }
  }, [isSyncing, getPendingDrafts, updatePendingCount])

  const deleteDraft = useCallback((draftId) => {
    const drafts = getPendingDrafts().filter(d => d._draft_id !== draftId)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
    updatePendingCount()
  }, [getPendingDrafts, updatePendingCount])

  const getAllDrafts = useCallback(() => getPendingDrafts(), [getPendingDrafts])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync pending-drafts count from localStorage on mount, same convention used elsewhere in this codebase
    updatePendingCount()
  }, [updatePendingCount])

  useEffect(() => {
    const handleOnline = () => { setIsOnline(true); syncPendingViolations() }
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [syncPendingViolations])

  return { isOnline, pendingCount, isSyncing, lastSyncResult, saveDraft, syncPendingViolations, deleteDraft, getAllDrafts }
}