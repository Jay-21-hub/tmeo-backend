import { useState } from 'react'
import {
  LayoutDashboard, MapPin, FileText, RefreshCw, LogOut,
  Camera, MoreHorizontal, X,
} from 'lucide-react'
import tmeoLogo from '../../assets/TMEO_ICON.jpg'
import NotificationBell from '../NotificationBell'
import ProfileModal from '../common/ProfileModal'
import ProfileTrigger from '../common/ProfileTrigger'
import OfflineStatusBar from './OfflineStatusBar'
import useTodayDuty from '../../hooks/useTodayDuty'
import './EnforcerShell.css'

// Left-side tabs, center FAB (primary field action), right-side tabs —
// mirrors the flex layout .ef-bottom-nav already defines (space-around,
// each slot flex:1). Only routes that actually exist in EnforcerDashboard's
// renderPage() switch are used here — no invented pages.
//
// "Sync Data" is deliberately NOT a bottom-nav tab: with 2 left tabs + the
// center FAB + Camera Evidence needing a slot, there wasn't room for a
// direct Sync tab too, and sync already runs automatically on reconnect
// (see SyncData.jsx's auto-sync effect) — so it's demoted to the "More"
// overflow reachable from the topbar instead of taking a 5th nav slot.
const LEFT_TABS  = [{ key: 'dashboard', icon: LayoutDashboard, label: 'Home' }, { key: 'reports', icon: FileText, label: 'Reports' }]
const RIGHT_TABS = [{ key: 'gps', icon: MapPin, label: 'GPS' }, { key: 'evidence', icon: Camera, label: 'Evidence' }]
const MORE_ITEMS = [{ key: 'sync', icon: RefreshCw, label: 'Sync Data' }]

export function EnforcerShellLoading() {
  return (
    <div className="ef-shell-loading">
      <span className="spinner" style={{ width: 40, height: 40, borderTopColor: 'var(--warning-600)' }} role="status" aria-label="Loading" />
    </div>
  )
}

/**
 * ENFORCER MOBILE APP SHELL
 * Dedicated, app-first chrome for the field/enforcer role on phones.
 * Pairs with EnforcerShell.css (.ef-* classes).
 *
 * Props:
 *   user, onLogout          — from useAuth()
 *   page, onPageChange(key) — current section key + setter (from EnforcerDashboard)
 *   pageTitle               — label shown in the topbar
 *   children                — rendered section content
 */
export default function EnforcerShell({ user, onLogout, page, onPageChange, pageTitle, children, onUserUpdate }) {
  const [profileOpen, setProfileOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)

  // Duty status AND today's area both come from the shared useTodayDuty()
  // read of /api/enforcers/today-status/ (server-computed from today's
  // EnforcerSchedule + local time) -- the same source GPSTracking uses.
  // Being logged in is not duty: user.duty_status / user.assigned_area are
  // deliberately NOT consulted. While loading or after a failed read the strip
  // says so ("Checking…" / "Status unavailable"); it never guesses Off/On Duty.
  const { display: duty, stripText, profileStatus } = useTodayDuty(user?.id)


  return (
    <div className="ef-shell">
      <header className="ef-topbar">
        <div className="ef-topbar-main">
          <img src={tmeoLogo} alt="" className="ef-topbar-logo" />

          <div className="ef-topbar-titles">
            <div className="ef-topbar-title">{pageTitle || 'TMEO'}</div>
          </div>

          <div className="ef-topbar-actions">
            <button
              className={`ef-account-btn ${page === 'sync' ? 'is-active' : ''}`}
              onClick={() => setMoreOpen(true)}
              aria-label="More options"
            >
              <MoreHorizontal size={20} aria-hidden="true" />
            </button>
            <NotificationBell onNavigate={onPageChange} />
            {/* Circular profile photo — same Avatar/user data as ProfileModal;
                opens the existing ProfileModal (photo, name, role, logout). */}
            <ProfileTrigger user={user} onClick={() => setProfileOpen(true)} />
          </div>
        </div>

        <button className="ef-duty-strip" onClick={() => onPageChange('gps')}>
          <span className="ef-duty-dot" style={{ background: duty.color }} aria-hidden="true" />
          <span className="ef-duty-label" style={{ color: duty.color }}>{duty.label}</span>
          <span className="ef-duty-sep" aria-hidden="true">&middot;</span>
          <span className="ef-duty-area u-truncate" title={stripText}>{stripText}</span>
        </button>
      </header>

      <OfflineStatusBar onOpenSync={() => onPageChange('sync')} />

      <main className="ef-content">
        <div key={page} className="ef-page-fade">
          {children}
        </div>
      </main>

      <nav className="ef-bottom-nav" aria-label="Quick navigation">
        {/* eslint-disable-next-line no-unused-vars -- Icon is used as the JSX tag below; core no-unused-vars doesn't see JSX usage without eslint-plugin-react */}
        {LEFT_TABS.map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            className={`ef-tab ${page === key ? 'is-active' : ''}`}
            onClick={() => onPageChange(key)}
            aria-current={page === key ? 'page' : undefined}
          >
            <span className="ef-tab-icon">
              <Icon size={20} strokeWidth={page === key ? 2.4 : 1.8} aria-hidden="true" />
            </span>
            <span>{label}</span>
          </button>
        ))}

        <div className="ef-fab-slot">
          <button
            className={`ef-fab ${page === 'issue-ovr' ? 'is-active' : ''}`}
            onClick={() => onPageChange('issue-ovr')}
            aria-label="Issue OVR"
          >
            <FileText size={22} aria-hidden="true" />
          </button>
          <span className="ef-fab-label">Issue OVR</span>
        </div>

        {/* eslint-disable-next-line no-unused-vars -- Icon is used as the JSX tag below; core no-unused-vars doesn't see JSX usage without eslint-plugin-react */}
        {RIGHT_TABS.map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            className={`ef-tab ${page === key ? 'is-active' : ''}`}
            onClick={() => onPageChange(key)}
            aria-current={page === key ? 'page' : undefined}
          >
            <span className="ef-tab-icon">
              <Icon size={20} strokeWidth={page === key ? 2.4 : 1.8} aria-hidden="true" />
            </span>
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {moreOpen && (
        <div
          className="ef-sheet-overlay"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setMoreOpen(false) }}
        >
          <div className="ef-sheet" role="dialog" aria-modal="true" aria-label="More options">
            <div className="ef-sheet-handle" />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 4px 8px' }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>More</div>
              <button onClick={() => setMoreOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--slate-500)' }} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            {/* eslint-disable-next-line no-unused-vars -- Icon is used as the JSX tag below; core no-unused-vars doesn't see JSX usage without eslint-plugin-react */}
            {MORE_ITEMS.map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                onClick={() => { onPageChange(key); setMoreOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  padding: '12px 8px', background: 'none', border: 'none',
                  borderTop: '1px solid var(--color-border)', cursor: 'pointer', minHeight: 48,
                  fontSize: 14, fontWeight: 600, color: page === key ? 'var(--auth-gold-ink)' : 'var(--slate-700)',
                  textAlign: 'left',
                }}
              >
                <Icon size={18} aria-hidden="true" /> {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <ProfileModal
        user={user}
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        onUserUpdate={onUserUpdate}
        onLogout={onLogout}
        dutyStatus={profileStatus}
      />
    </div>
  )
}