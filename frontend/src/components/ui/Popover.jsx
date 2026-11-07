import { useRef, useEffect } from 'react'
import { X } from 'lucide-react'
import useFloatingPosition from '../../hooks/useFloatingPosition'
import FloatingPanel from './FloatingPanel'

/**
 * Popover — a compact, anchored card for read-only or low-stakes content
 * triggered from a specific element (a button, a gallery thumbnail, etc).
 *
 * Unlike Modal, a Popover never dims the page or blocks scroll — it's a
 * contextual flyout, not a blocking interruption. It's built on the same
 * useFloatingPosition + FloatingPanel primitives as the searchable
 * dropdowns (see VehicleCatalogField.jsx), generalized to hold richer
 * content at a caller-chosen width instead of always matching the
 * trigger's own width.
 *
 * Dismisses on: click/tap outside the panel, Escape, or the close button
 * (only shown when `title` is given — pass your own close affordance in
 * `children` otherwise, same as EvidenceCapture does).
 *
 * Props:
 *  - open, onClose: standard controlled visibility
 *  - triggerRef: ref to the element the popover anchors to. Note Button
 *    (components/ui/Button) doesn't forward refs — wrap it in a plain
 *    span/div and ref that instead (see EvidenceGallery.jsx for the
 *    pattern).
 *  - closeLabel: accessible name for the header close button (default 'Close')
 *  - title: optional header text — renders a header row with a close X.
 *    Omit it if your content supplies its own header/close affordance.
 *  - width: panel width in px (default 340)
 *  - align: 'left' | 'right' | 'center' — which edge/point of the panel
 *    lines up with the trigger (default 'left')
 *  - footer: optional footer content, right-aligned like Modal's
 */
export default function Popover({
  open, onClose, triggerRef, title, closeLabel = 'Close', width = 340, align = 'left', footer, className = '', children,
}) {
  const panelRef = useRef(null)
  const position = useFloatingPosition(triggerRef, open, { width, align })

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose?.() }
    const onPointerDown = (e) => {
      if (panelRef.current?.contains(e.target)) return
      if (triggerRef?.current?.contains(e.target)) return
      onClose?.()
    }
    document.addEventListener('keydown', onKeyDown)
    // capture:true so a click inside a nested modal/sheet (its own, higher
    // stacking context) still registers as "outside" the popover
    document.addEventListener('mousedown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown, true)
    }
  }, [open, onClose, triggerRef])

  if (!open || !position) return null

  return (
    <FloatingPanel position={position} className={`popover-panel ${className}`}>
      <div ref={panelRef} style={{ display: 'flex', flexDirection: 'column', maxHeight: position.maxHeight }}>
        {title && (
          <div className="popover-header">
            <span className="text-h3" style={{ fontSize: 14 }}>{title}</span>
            <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label={closeLabel}>
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        )}
        <div className="popover-body">{children}</div>
        {footer && <div className="popover-footer">{footer}</div>}
      </div>
    </FloatingPanel>
  )
}