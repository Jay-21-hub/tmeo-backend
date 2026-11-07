import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Printer, Check, X } from 'lucide-react'

/**
 * Post-print confirmation. Shown AFTER the browser print dialog has closed.
 *
 *  - "Yes, Mark as Printed" -> onConfirm (the ONLY path that records a print)
 *  - "No, Try Again", the X, and Escape -> onDecline (never records anything)
 *
 * Backdrop clicks are ignored on purpose so a stray click can neither confirm
 * nor dismiss an official-document decision.
 *
 * Escape is handled on window in the CAPTURE phase and stopped there, so a
 * modal/preview underneath (Digital Ticket Details, History preview, ...)
 * never sees the same keypress and closes behind this dialog.
 */
export default function PrintConfirmModal({ open, saving = false, error = false, onConfirm, onDecline }) {
  const panelRef = useRef(null)
  const declineBtnRef = useRef(null)
  const declineRef = useRef(onDecline)
  const savingRef = useRef(saving)
  useEffect(() => { declineRef.current = onDecline; savingRef.current = saving })

  useEffect(() => {
    if (!open) return undefined
    const opener = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Initial focus on the safe action, so a reflexive Enter never records a print.
    declineBtnRef.current?.focus()

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (!savingRef.current) declineRef.current?.()
        return
      }
      if (e.key === 'Tab' && panelRef.current) {
        const items = Array.from(panelRef.current.querySelectorAll('button:not(:disabled)'))
        if (!items.length) return
        const first = items[0]
        const last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prevOverflow
      if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus()
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div className="pcm-overlay">
      <div
        ref={panelRef}
        className="pcm-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="pcm-title"
        aria-describedby="pcm-desc"
      >
        <button type="button" className="pcm-x" onClick={onDecline} disabled={saving} aria-label="Close without marking as printed">
          <X size={18} />
        </button>

        <span className="pcm-icon" aria-hidden="true"><Printer size={28} strokeWidth={2} /></span>
        <h2 id="pcm-title" className="pcm-title">Was the Assessment Form{' '}<br />printed successfully?</h2>
        <p id="pcm-desc" className="pcm-desc">
          Please confirm only if the Assessment Form{' '}<br />was successfully printed.
        </p>

        {error && (
          <p className="pcm-error" role="alert">
            The Assessment Form was printed, but the print record could not be saved. Please try again.
          </p>
        )}

        <div className="pcm-actions">
          <button ref={declineBtnRef} type="button" className="pcm-btn pcm-btn--secondary" onClick={onDecline} disabled={saving}>
            No, Try Again
          </button>
          <button type="button" className="pcm-btn pcm-btn--primary" onClick={onConfirm} disabled={saving} aria-busy={saving}>
            <Check size={16} strokeWidth={2.6} /> {saving ? 'Saving…' : 'Yes, Mark as Printed'}
          </button>
        </div>
      </div>

      <style>{`
        .pcm-overlay {
          position: fixed; inset: 0; z-index: 1300;
          display: flex; align-items: center; justify-content: center;
          padding: 16px; background: rgba(15, 23, 42, 0.55);
          font-family: Helvetica, Arial, sans-serif;
        }
        .pcm-panel {
          position: relative; box-sizing: border-box;
          width: 100%; max-width: 460px; max-height: calc(100% - 8px); overflow-y: auto;
          background: var(--white, #fff); border-radius: var(--radius-xl, 16px);
          box-shadow: var(--shadow-xl, 0 20px 50px rgba(15, 23, 42, 0.3));
          padding: 28px 28px 24px; text-align: center;
        }
        .pcm-x {
          position: absolute; top: 12px; right: 12px; width: 32px; height: 32px;
          display: inline-flex; align-items: center; justify-content: center;
          background: none; border: none; border-radius: 8px; cursor: pointer;
          color: var(--slate-700, #334155);
        }
        .pcm-x:hover:not(:disabled) { background: var(--slate-100, #f1f5f9); }
        .pcm-x:disabled { opacity: 0.4; cursor: not-allowed; }
        .pcm-icon {
          width: 64px; height: 64px; margin: 0 auto 14px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          background: var(--blue-50, #eff6ff); color: var(--blue-600, #2563eb);
        }
        .pcm-title { margin: 0 0 8px; font-size: 21px; line-height: 1.3; font-weight: 700; color: var(--slate-950, #0f172a); }
        .pcm-desc { margin: 0 0 20px; font-size: 14px; line-height: 1.5; color: var(--slate-600, #475569); }
        .pcm-error {
          margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; text-align: left;
          font-size: 13px; line-height: 1.45;
          background: var(--danger-50, #fef2f2); color: var(--danger-600, #dc2626);
          border: 1px solid var(--danger-100, #fee2e2);
        }
        .pcm-actions { display: flex; gap: 12px; }
        .pcm-btn {
          flex: 1 1 0; min-width: 0; min-height: 44px; padding: 10px 14px;
          display: inline-flex; align-items: center; justify-content: center; gap: 8px;
          font: inherit; font-size: 14px; font-weight: 700; border-radius: 8px; cursor: pointer;
        }
        .pcm-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .pcm-btn--secondary { background: var(--white, #fff); color: var(--slate-800, #1e293b); border: 1px solid var(--slate-300, #cbd5e1); }
        .pcm-btn--secondary:hover:not(:disabled) { background: var(--slate-50, #f8fafc); }
        .pcm-btn--primary { background: var(--navy-900, #0b1830); color: #fff; border: 1px solid var(--navy-900, #0b1830); }
        .pcm-btn--primary:hover:not(:disabled) { background: var(--navy-800, #12254a); }
        .pcm-btn:focus-visible, .pcm-x:focus-visible { outline: 2px solid var(--blue-600, #2563eb); outline-offset: 2px; }
        @media (max-width: 480px) {
          .pcm-panel { padding: 24px 18px 18px; }
          .pcm-title { font-size: 19px; }
          .pcm-title br, .pcm-desc br { display: none; }
          .pcm-actions { flex-direction: column-reverse; }
        }
        @media print { .pcm-overlay { display: none !important; } }
      `}</style>
    </div>,
    document.body
  )
}