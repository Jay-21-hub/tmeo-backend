import { createPortal } from 'react-dom'

/**
 * Renders a floating dropdown/listbox panel into document.body via a
 * portal, positioned with `position: fixed` from the coordinates
 * useFloatingPosition computed. Portalling (rather than `position:
 * absolute` inside the trigger's own stacking context) is what lets the
 * panel escape overflow-hidden ancestors, scroll containers, modals, and
 * drawers instead of being clipped by them.
 *
 * `position` is whatever useFloatingPosition returned — pass it straight
 * through. Renders nothing while closed (position is null).
 */
export default function FloatingPanel({ position, className = '', style, children }) {
  if (!position) return null

  const placementStyle = position.placement === 'bottom'
    ? { top: position.top }
    : { bottom: position.bottom }

  return createPortal(
    <div
      className={`floating-panel floating-panel--${position.placement} ${className}`}
      style={{
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        ...placementStyle,
        ...style,
      }}
    >
      {children}
    </div>,
    document.body
  )
}