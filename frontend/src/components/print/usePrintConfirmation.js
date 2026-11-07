import { useState, useRef, useCallback, useEffect } from 'react'
import api from '../../services/api'
import { API } from '../../constants'
import { useToast } from '../../context/useToast'

/**
 * Shared "Staff confirms the print" lifecycle for every official Assessment
 * Form entry point.
 *
 *   template calls onPrinted()  ->  arm(id)        (BEFORE window.print())
 *   browser print dialog closes ->  `afterprint`   -> confirmation opens
 *   Yes  -> PATCH mark-printed (the ONLY place a print is recorded)
 *   No / X / Escape -> nothing is recorded
 *
 * `afterprint` is purely a UI trigger: it means the dialog closed, NOT that
 * paper came out, so it never calls mark-printed by itself.
 *
 * If the PATCH fails the confirmation stays open and only the RECORDING is
 * retried — window.print() is never called from here.
 *
 * Usage:
 *   const confirm = usePrintConfirmation({ onRecorded, onDeclined })
 *   <Template onPrinted={() => confirm.arm(id)} />
 *   <PrintConfirmModal {...confirm.modalProps} />
 */
export default function usePrintConfirmation({ onRecorded, onDeclined } = {}) {
  const toast = useToast()
  const [pendingId, setPendingId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const savingRef = useRef(false)
  const listenerRef = useRef(null)
  const cbRef = useRef({ onRecorded, onDeclined })
  useEffect(() => { cbRef.current = { onRecorded, onDeclined } })

  const disarm = useCallback(() => {
    if (listenerRef.current) {
      window.removeEventListener('afterprint', listenerRef.current)
      listenerRef.current = null
    }
  }, [])

  const arm = useCallback((id) => {
    disarm()
    if (id == null) return
    const handler = () => { listenerRef.current = null; setSaveError(false); setPendingId(id) }
    listenerRef.current = handler
    window.addEventListener('afterprint', handler, { once: true })
  }, [disarm])

  useEffect(() => disarm, [disarm])

  const confirm = useCallback(async () => {
    if (savingRef.current || pendingId == null) return
    const id = pendingId
    savingRef.current = true
    setSaving(true)
    setSaveError(false)
    try {
      await api.patch(API.MARK_TICKET_PRINTED(id))
    } catch {
      savingRef.current = false
      setSaving(false)
      setSaveError(true)
      return
    }
    savingRef.current = false
    setSaving(false)
    setPendingId(null)
    toast.success?.('Assessment Form marked as printed successfully.')
    try { await cbRef.current.onRecorded?.(id) } catch { /* refresh failure must not undo a saved record */ }
  }, [pendingId, toast])

  const decline = useCallback(() => {
    if (savingRef.current) return
    const id = pendingId
    setPendingId(null)
    setSaveError(false)
    cbRef.current.onDeclined?.(id)
  }, [pendingId])

  return {
    arm,
    pending: pendingId != null,
    modalProps: { open: pendingId != null, saving, error: saveError, onConfirm: confirm, onDecline: decline },
  }
}