import {
  LayoutDashboard, FileText, Map, Navigation, Users, ListChecks,
  BarChart2, UserCog, Ticket, ClipboardList, LogOut,
  TrendingUp, ShieldCheck, MapPin, Send, RefreshCw, Camera,
  ChevronsLeft, ChevronsRight, Car, Menu, Archive, IdCard,
} from 'lucide-react'
import tmeoLogo from '../../assets/TMEO_ICON.jpg'
import { useBreakpoint } from '../../hooks/useBreakpoint'
import './Sidebar.css'

// Flat list, no section headings — every item sits at the same level so the
// full menu is scannable (and fits on screen) without grouping labels
// breaking it into scroll-inducing chunks.
const navMap = {
  admin: [
    { key: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { key: 'violations', icon: FileText, label: 'Violation Records' },
    { key: 'gis', icon: Map, label: 'GIS Violation Map' },
    { key: 'gps', icon: Navigation, label: 'GPS Enforcer Tracking' },
    { key: 'custody', icon: IdCard, label: 'Confiscated Licenses' },
    { key: 'reports', icon: BarChart2, label: 'Reports' },
    { key: 'analytics', icon: TrendingUp, label: 'Analytics' },
    { key: 'enforcers', icon: Users, label: 'Manage Enforcers' },
    { key: 'users', icon: UserCog, label: 'User Management' },
    { key: 'vtypes', icon: ListChecks, label: 'Violation Types' },
    { key: 'vehiclecatalog', icon: Car, label: 'Vehicle Catalog' },
    { key: 'audit', icon: ShieldCheck, label: 'Audit Trail' },
    { key: 'archive', icon: Archive, label: 'Archive Management' },
  ],
  staff: [
    { key: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { key: 'pending', icon: ClipboardList, label: 'Pending Violations' },
    { key: 'assessment', icon: FileText, label: 'Assessment Form' },
    { key: 'tickets', icon: Ticket, label: 'Digital Tickets' },
    { key: 'custody', icon: IdCard, label: 'Confiscated Licenses' },
  ],
  enforcer: [
    { key: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { key: 'issue-ovr', icon: Send, label: 'Issue OVR' },
    { key: 'evidence', icon: Camera, label: 'Camera Evidence' },
    { key: 'gps', icon: MapPin, label: 'GPS Tracking' },
    { key: 'reports', icon: FileText, label: 'My Reports' },
    { key: 'sync', icon: RefreshCw, label: 'Sync Data' },
  ],
}

const roleLabel = { admin: 'Administrator', staff: 'Assessment Staff', enforcer: 'Traffic Enforcer' }
const roleDot = { admin: 'var(--blue-400, #60a5fa)', staff: 'var(--success-500)', enforcer: 'var(--warning-500)' }

function renderNavIcon(icon, active, size = 16) {
  const IconComponent = icon
  return <IconComponent size={size} strokeWidth={active ? 2.4 : 1.8} style={{ flexShrink: 0 }} aria-hidden="true" />
}

export default function Sidebar({ page, setPage, role, onLogout, isOpen, onClose, onOpenMenu, collapsed, onToggleCollapse }) {
  const { isMobile } = useBreakpoint()
  const navItems = navMap[role] || []
  const isCollapsed = !isMobile && collapsed

  const sidebarClass = [
    'sidebar',
    isCollapsed ? 'sidebar--collapsed' : '',
    isMobile ? 'sidebar--mobile' : '',
    isMobile && isOpen ? 'sidebar--open' : '',
    isMobile && !isOpen ? 'sidebar--hidden' : '',
  ].filter(Boolean).join(' ')

  const navItemsWithActive = navItems.map(item => ({ ...item, active: page === item.key }))

  const content = (
    <aside className={sidebarClass} aria-label="Main navigation">
      <div className="sidebar-brand">
        <div className="sidebar-brand-row">
          <div className="sidebar-logo-frame">
            <img src={tmeoLogo} alt="" style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover' }} />
          </div>
          {!isCollapsed && (
            <div>
              <div style={{ font: 'var(--text-title)', color: 'var(--white)', letterSpacing: 0.3 }}>TMEO</div>
              <div className="text-caption" style={{ color: 'rgba(255,255,255,0.55)' }}>Lucena City</div>
            </div>
          )}
        </div>

        <div className="sidebar-role-badge">
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: roleDot[role] || roleDot.admin, flexShrink: 0 }} aria-hidden="true" />
          <span className="sidebar-role-label" style={{ fontSize: 12, fontWeight: 600, color: 'var(--white)' }}>
            {roleLabel[role] || role}
          </span>
        </div>
      </div>

      <nav className="sidebar-nav">
        {navItemsWithActive.map(({ key, label, icon, active }) => (
          <button
            key={key}
            className={`sidebar-link ${active ? 'is-active' : ''}`}
            onClick={() => { setPage(key); if (isMobile) onClose?.() }}
            title={isCollapsed ? label : undefined}
            aria-label={isCollapsed ? label : undefined}
            aria-current={active ? 'page' : undefined}
          >
            {renderNavIcon(icon, active)}
            <span className="sidebar-link-label">{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        {!isMobile && (
          <button className="sidebar-collapse-btn" onClick={onToggleCollapse} aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {isCollapsed ? <ChevronsRight size={15} /> : <><ChevronsLeft size={15} /><span className="text-caption" style={{ fontWeight: 600 }}>Collapse</span></>}
          </button>
        )}
        <button className="sidebar-logout" onClick={onLogout} title={isCollapsed ? 'Logout' : undefined} aria-label={isCollapsed ? 'Logout' : undefined}>
          <LogOut size={15} strokeWidth={1.8} style={{ flexShrink: 0 }} aria-hidden="true" />
          {!isCollapsed && 'Logout'}
        </button>
      </div>
    </aside>
  )

  return (
    <>
      {isMobile && isOpen && <div className="sidebar-overlay" onClick={onClose} aria-hidden="true" />}
      {content}
      {isMobile && (
        <nav className="bottom-nav" aria-label="Quick navigation">
          {navItems.slice(0, 4).map(({ key, label, icon }) => (
            <button
              key={key}
              className={`bottom-nav-item ${page === key ? 'is-active' : ''}`}
              onClick={() => setPage(key)}
              aria-current={page === key ? 'page' : undefined}
            >
              <span className="bottom-nav-icon">{renderNavIcon(icon, page === key, 18)}</span>
              <span>{label}</span>
            </button>
          ))}
          <button
            className={`bottom-nav-item ${!navItems.slice(0, 4).some(i => i.key === page) ? 'is-active' : ''}`}
            onClick={onOpenMenu}
            aria-label="More navigation options"
          >
            <span className="bottom-nav-icon"><Menu size={18} strokeWidth={1.8} aria-hidden="true" /></span>
            <span>More</span>
          </button>
        </nav>
      )}
    </>
  )
}