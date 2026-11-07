import { useState, useRef, useEffect, useCallback } from 'react'
import { MoreHorizontal, UserX, KeyRound, Trash2, ArrowLeftRight } from 'lucide-react'
import useFloatingPosition from '../../../../hooks/useFloatingPosition'
import FloatingPanel from '../../../../components/ui/FloatingPanel'

/**
 * UserActionsMenu — the compact "⋯" menu in User Management's Actions column.
 *
 * It holds ONLY the secondary / account-sensitive actions that used to be
 * stacked in the row: Deactivate, Reset Password, Change Role, Delete. It does not own any
 * business logic — every item just calls the callback the page passes in, and
 * those callbacks open the SAME confirm dialogs / handlers the page already had.
 *
 * The panel is portalled to document.body (FloatingPanel) and positioned with
 * useFloatingPosition, so it is never clipped by the table's overflow, never
 * sits behind rows, and flips upward near the bottom of the viewport.
 *
 * Keyboard: Enter/Space/ArrowDown on the trigger opens it (native button +
 * focus moves to first item), Arrow keys / Home / End move between items,
 * Escape closes and returns focus to the trigger, Tab closes.
 *
 * Props:
 *  - userName      - used for the accessible label ("More actions for …")
 *  - isActive      - Deactivate is only offered for an active account
 *                    (same condition the old inline button used)
 *  - disabled      - mirrors the old per-row `actionLoading === user.id` lock
 *  - canChangeRole - "Change Role" is only offered when true (the page decides:
 *                    supported Staff <-> Enforcer, active, not the admin's own row)
 *  - onDeactivate / onResetPassword / onChangeRole / onDelete
 */
const MENU_WIDTH = 184

export default function UserActionsMenu({ userName, isActive, disabled = false, canChangeRole = false, onDeactivate, onResetPassword, onChangeRole, onDelete }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const position = useFloatingPosition(triggerRef, open, { width: MENU_WIDTH, align: 'right' })
  const ready = !!position

  const close = useCallback((returnFocus = false) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  // Move focus into the menu once it has been positioned and rendered.
  useEffect(() => {
    if (!ready) return
    panelRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus()
  }, [ready])

  // Click/tap outside closes (capture so clicks inside modals still count).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e) => {
      if (panelRef.current?.contains(e.target)) return
      if (triggerRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown, true)
    return () => document.removeEventListener('mousedown', onPointerDown, true)
  }, [open])

  const onMenuKeyDown = (e) => {
    const items = Array.from(panelRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])
    const idx = items.indexOf(document.activeElement)
    if (e.key === 'Escape') { e.preventDefault(); close(true) }
    else if (e.key === 'Tab') { close(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus() }
  }

  const choose = (handler) => () => { setOpen(false); handler?.() }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-secondary um-btn um-more"
        aria-label={`More actions for ${userName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={() => setOpen(o => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true) } }}
      >
        <MoreHorizontal size={16} strokeWidth={2.2} aria-hidden="true" />
      </button>

      {open && position && (
        <FloatingPanel position={position} className="um-menu-panel">
          <div ref={panelRef} role="menu" aria-label={`Actions for ${userName}`} className="um-menu" onKeyDown={onMenuKeyDown}>
            {isActive && (
              <button type="button" role="menuitem" className="um-menu-item" disabled={disabled} onClick={choose(onDeactivate)}>
                <UserX size={14} aria-hidden="true" /> Deactivate
              </button>
            )}
            <button type="button" role="menuitem" className="um-menu-item" disabled={disabled} onClick={choose(onResetPassword)}>
              <KeyRound size={14} aria-hidden="true" /> Reset Password
            </button>
            {canChangeRole && (
              <button type="button" role="menuitem" className="um-menu-item" disabled={disabled} onClick={choose(onChangeRole)}>
                <ArrowLeftRight size={14} aria-hidden="true" /> Change Role
              </button>
            )}
            <div className="um-menu-sep" role="separator" />
            <button type="button" role="menuitem" className="um-menu-item um-menu-item--danger" disabled={disabled} onClick={choose(onDelete)}>
              <Trash2 size={14} aria-hidden="true" /> Delete
            </button>
          </div>
        </FloatingPanel>
      )}
    </>
  )
}