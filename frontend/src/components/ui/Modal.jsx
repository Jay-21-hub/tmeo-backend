import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/**
 * Accessible modal: traps focus, closes on Escape, restores focus to the
 * trigger on close, and locks background scroll.
 *
 * `dismissible` (default true): when false, Escape, an overlay click and the
 * header X do NOT call onClose (e.g. while a request is in flight). It is read
 * through a ref so toggling it never re-runs the focus/scroll-lock effect.
 *
 * Optional, additive (existing callers unaffected):
 *  - `initialFocus`: CSS selector inside the panel to focus on open instead of
 *    the first control (e.g. Cancel on a destructive confirmation).
 *  - `titleId`: id for the title element (default 'modal-title'); pass a unique
 *    one when you need stable aria-labelledby wiring.
 *  - `describedBy`: id of the element that describes the dialog (aria-describedby).
 */
export default function Modal({ open, onClose, title, children, footer, width = 520, mobileFullScreen = true, className = '', dismissible = true, initialFocus, titleId = 'modal-title', describedBy }) {
  const panelRef = useRef(null)
  const lastFocused = useRef(null)
  const dismissibleRef = useRef(dismissible)
  useEffect(() => { dismissibleRef.current = dismissible })
  const initialFocusRef = useRef(initialFocus)
  useEffect(() => { initialFocusRef.current = initialFocus })

  useEffect(() => {
    if (!open) return
    lastFocused.current = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKeyDown = (e) => {
      if (e.key === 'Escape' && dismissibleRef.current) onClose?.()
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        if (!focusables.length) return
        const first = focusables[0], last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const preferred = initialFocusRef.current ? panelRef.current?.querySelector(initialFocusRef.current) : null
    ;(preferred || panelRef.current?.querySelector('button, input, select, textarea'))?.focus()

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
      lastFocused.current?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  // Rendered via portal straight to document.body: any ancestor page wrapper
  // that animates `transform` (e.g. .page-shell-inner, .ef-page-fade) would
  // otherwise become a new containing block for this `position: fixed`
  // overlay, confining it to the content area instead of the full viewport.
  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && dismissibleRef.current) onClose?.() }}>
      <div
        className={`modal-panel ${mobileFullScreen ? 'modal-panel--mobile-full' : ''} ${className}`.trim()}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={describedBy}
        style={{ maxWidth: width }}
      >
        {title && (
          <div className="modal-header">
            <span id={titleId} className="text-h3">{title}</span>
            <button className="btn btn-ghost btn-icon" onClick={() => { if (dismissibleRef.current) onClose?.() }} aria-label="Close dialog" aria-disabled={!dismissible || undefined}>
              <X size={18} strokeWidth={2} />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}