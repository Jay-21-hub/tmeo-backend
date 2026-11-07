import { useState, useEffect } from 'react'
import Sidebar from './Sidebar'
import Topbar from './Topbar'
import OfflineStatusBar from './OfflineStatusBar'
import { useBreakpoint } from '../../hooks/useBreakpoint'
import './AppShell.css'

const ROLE_ACCENT = { admin: 'var(--blue-500)', staff: 'var(--success-500)', enforcer: 'var(--warning-500)' }

export function AppShellLoading({ role = 'admin' }) {
  return (
    <div className="app-shell-loading">
      <span className="spinner" style={{ width: 40, height: 40, borderTopColor: ROLE_ACCENT[role] }} role="status" aria-label="Loading" />
      <span className="text-caption" style={{ color: 'rgba(255,255,255,0.6)', marginTop: 16 }}>Loading...</span>
    </div>
  )
}

/**
 * role         - 'admin' | 'staff' | 'enforcer'
 * user, onLogout
 * page, onPageChange(key) - current section key + setter
 * pageTitle    - label shown in the topbar breadcrumb
 * onNavigate   - optional, forwarded to Topbar (notification deep-links)
 * children     - the rendered section content
 */
export default function AppShell({ role, user, onLogout, page, onPageChange, pageTitle, onNavigate, onUserUpdate, children }) {
  const { isMobile, isTablet } = useBreakpoint()
  // On phones the sidebar is an off-canvas drawer, so it starts CLOSED there
  // (it used to start open and cover the dashboard on first load). Desktop and
  // tablet keep the docked sidebar.
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile)
  // null = no manual choice yet, so the rail auto-collapses on tablet and
  // opens full-width on desktop. Once the user toggles it, their choice
  // wins on any breakpoint until they toggle again.
  const [manualCollapsed, setManualCollapsed] = useState(null)
  const collapsed = manualCollapsed !== null ? manualCollapsed : isTablet

  // sidebarOpen only means something for the mobile drawer. If the page was
  // loaded (or the window was resized) at phone width, it stayed `false` after
  // growing back to desktop, so the sidebar was drawn but the content got
  // marginLeft 0 and slid underneath it. Re-sync whenever the breakpoint flips.
  useEffect(() => { setSidebarOpen(!isMobile) }, [isMobile])

  // Desktop/tablet: the sidebar is always docked, so the offset never depends
  // on sidebarOpen. Only mobile (drawer + bottom nav) uses 0.
  const marginLeft = isMobile ? 0 : (collapsed ? 76 : 248)

  return (
    <div className="app-shell">
      <Sidebar
        page={page}
        setPage={(p) => { onPageChange(p); if (isMobile) setSidebarOpen(false) }}
        role={role}
        onLogout={onLogout}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onOpenMenu={() => setSidebarOpen(true)}
        collapsed={collapsed}
        onToggleCollapse={() => setManualCollapsed(c => !(c !== null ? c : isTablet))}
      />

      <div className="app-shell-main" style={{ marginLeft }}>
        <Topbar
          user={user}
          onMenuClick={() => setSidebarOpen(o => !o)}
          isOpen={isMobile ? sidebarOpen : true}
          onNavigate={onNavigate}
          pageTitle={pageTitle}
          onUserUpdate={onUserUpdate}
        />
        {/* Desktop/tablet enforcers can also work the field from a tablet,
            not just the EnforcerShell phone view — same offline queue,
            same banner, just mounted here instead. Admin/Staff never queue
            offline OVRs, so the banner would always be empty noise for
            them; it's skipped entirely rather than rendering nothing. */}
        {role === 'enforcer' && (
          <OfflineStatusBar onOpenSync={() => onPageChange('sync')} />
        )}
        <main className="app-shell-content page-shell" style={{ paddingBottom: isMobile ? 84 : undefined }}>
          <div key={page} className="page-shell-inner" style={{ animation: 'shell-fade-in 0.22s var(--ease) both' }}>
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}