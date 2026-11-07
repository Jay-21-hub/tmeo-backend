import { useState, useRef, useEffect } from 'react'
import { Bell, CheckCheck, Info, MapPin, AlertTriangle, FileText, CreditCard, ArrowRight } from 'lucide-react'
import useNotifications from '../hooks/useNotifications'
import './NotificationBell.css'

/* Kept bespoke rather than folded into the shared Popover/FloatingPanel
 * primitive (components/ui/Popover.jsx), for two concrete reasons rather
 * than filename-based guessing:
 *  1. Popover's collision-flip logic (useFloatingPosition) exists for
 *     triggers that can sit anywhere on a scrollable page (a form field,
 *     a gallery thumbnail). The bell's trigger is pinned to the topbar,
 *     always near the top of the viewport, so "flip upward when there's
 *     no room below" never applies here — there's nothing for that logic
 *     to do.
 *  2. The panel's own max-width:639px media query (pinned with 12px side
 *     margins, width:auto) already keeps it inside the viewport on any
 *     phone width without relying on a fixed pixel width — at least as
 *     robust as the shared hook's width-clamping for this one, fixed-
 *     position case.
 * Dimensions (360px wide, up to 480px tall, content-hugging via
 * max-height not height) already match the "compact, anchored, content-
 * sized" panel this app's shared overlays are meant to feel like — no
 * width/height calls to adjust here.
 */

const NOTIF_ICON = {
  new_violation:        { icon: FileText,       color: 'var(--blue-600)',    bg: 'var(--blue-100)' },
  violation_paid:       { icon: CreditCard,      color: 'var(--success-600)', bg: 'var(--success-100)' },
  pending_too_long:     { icon: AlertTriangle,   color: 'var(--warning-600)', bg: 'var(--warning-100)' },
  enforcer_on_duty:     { icon: CheckCheck,      color: 'var(--success-600)', bg: 'var(--success-100)' },
  enforcer_out_of_zone: { icon: AlertTriangle,   color: 'var(--danger-600)',  bg: 'var(--danger-100)' },
  enforcer_in_zone:     { icon: MapPin,          color: 'var(--success-600)', bg: 'var(--success-100)' },
  duty_assigned:        { icon: MapPin,          color: 'var(--success-600)', bg: 'var(--success-100)' },
  duty_updated:         { icon: Info,            color: 'var(--blue-600)',    bg: 'var(--blue-100)' },
  duty_removed:         { icon: AlertTriangle,   color: 'var(--warning-600)', bg: 'var(--warning-100)' },
  default:              { icon: Info,            color: 'var(--slate-600)',  bg: 'var(--slate-100)' },
}

// Map notif type → admin page key
const NOTIF_PAGE_MAP = {
  new_violation:        'violations',
  violation_paid:       'violations',
  pending_too_long:     'violations',
  enforcer_on_duty:     'gps',
  enforcer_out_of_zone: 'gps',
  enforcer_in_zone:     'gps',
}

export default function NotificationBell({ onNavigate }) {
  const { notifications, unreadCount, markRead } = useNotifications()
  const [open, setOpen] = useState(false)
  const ref             = useRef(null)

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Close on Escape — matches shared Modal.jsx behavior
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  const handleOpen = () => {
    setOpen(o => !o)
  }

  const handleMarkAll = (e) => {
    e.stopPropagation()
    markRead()
  }

  const handleNotifClick = (notif) => {
    // Mark as read
    if (!notif.is_read) markRead(notif.id)
    // Navigate if we have a handler and a known page
    const targetPage = NOTIF_PAGE_MAP[notif.notif_type]
    if (onNavigate && targetPage) {
      setOpen(false)
      onNavigate(targetPage)
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>

      {/* Bell Button */}
      <button
        className={`notif-bell-btn ${open ? 'is-open' : ''}`}
        onClick={handleOpen}
        aria-label="Notifications"
        aria-expanded={open}
      >
        <Bell size={20} color="var(--blue-600)" strokeWidth={2} />
        {unreadCount > 0 && (
          <div className="notif-bell-badge">
            {unreadCount > 99 ? '99+' : unreadCount}
          </div>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications" aria-modal="false">

          {/* Header */}
          <div className="notif-panel-header">
            <div>
              <div className="notif-panel-title">Notifications</div>
              {unreadCount > 0 && (
                <div className="notif-panel-subtitle">{unreadCount} unread</div>
              )}
            </div>
            {unreadCount > 0 && (
              <button className="notif-mark-all" onClick={handleMarkAll}>
                <CheckCheck size={12} />
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="notif-list">
            {notifications.length === 0 ? (
              <div className="notif-empty">
                <Bell size={32} color="var(--slate-300)" />
                <div className="notif-empty-title">No notifications yet</div>
                <div className="notif-empty-sub">You're all caught up!</div>
              </div>
            ) : (
              notifications.map((notif) => {
                const meta       = NOTIF_ICON[notif.notif_type] || NOTIF_ICON.default
                const Icon       = meta.icon
                const unread     = !notif.is_read
                const targetPage = NOTIF_PAGE_MAP[notif.notif_type]
                const navigable  = !!onNavigate && !!targetPage

                return (
                  <div
                    key={notif.id}
                    className={`notif-row ${navigable ? 'is-navigable' : ''} ${unread ? 'is-unread' : ''}`}
                    onClick={() => handleNotifClick(notif)}
                  >
                    {/* Icon */}
                    <div className="notif-row-icon" style={{ background: meta.bg }}>
                      <Icon size={16} color={meta.color} strokeWidth={2} />
                    </div>

                    {/* Content */}
                    <div className="notif-row-body">
                      <div className="notif-row-top">
                        <span className={`notif-row-title ${unread ? 'is-unread' : ''}`}>{notif.title}</span>
                        <div className="notif-row-meta">
                          {unread && <span className="notif-dot" />}
                          {navigable && <ArrowRight size={13} color="var(--slate-500)" style={{ marginTop: 2 }} />}
                        </div>
                      </div>
                      <div className="notif-row-message">{notif.message}</div>
                      <div className="notif-row-bottom">
                        <span className="notif-row-time">{notif.time_ago}</span>
                        {navigable && (
                          <span className="notif-row-cta">
                            View {targetPage === 'gps' ? 'GPS Tracking' : 'Violations'} →
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}