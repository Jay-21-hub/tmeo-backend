import { useState } from 'react'
import useAuth from '../../hooks/useAuth'
import useEnforcerTracker, { haltTrackerForLogout } from '../../hooks/useEnforcerTracker'
import { useBreakpoint } from '../../hooks/useBreakpoint'
import AppShell, { AppShellLoading } from '../../components/layout/AppShell'
import EnforcerShell, { EnforcerShellLoading } from '../../components/layout/EnforcerShell'
import EnforcerHome from './sections/EnforcerHome'
import EnforcerHomeDesktop from './sections/EnforcerHomeDesktop'
import IssueOVR from './sections/IssueOVR'
import GPSTracking from './sections/GPSTracking'
import MyReports from './sections/MyReports'
import SyncData from './sections/SyncData'
import EvidenceGallery from './sections/EvidenceGallery'
import { EmptyState } from '../../components/ui/States'
import { Construction } from 'lucide-react'

const PAGE_TITLES = {
  dashboard: 'Dashboard', 'issue-ovr': 'Issue OVR', gps: 'GPS Tracking',
  reports: 'My Reports', sync: 'Sync Data', evidence: 'Camera Evidence',
}

export default function EnforcerDashboard() {
  const { user, logout, loading, updateUser } = useAuth('enforcer')
  const { isMobile } = useBreakpoint()
  const [page, setPage] = useState('dashboard')

  // The ONE owner of foreground GPS tracking for the authenticated Enforcer
  // session. It lives here (above both EnforcerShell and AppShell) so it keeps
  // running while the Enforcer moves between Home / GPS / Issue OVR / Evidence /
  // Reports; GPSTracking only displays its state. Duty decides whether it runs.
  useEnforcerTracker(user?.id)

  // Stop local tracking (and let any in-flight sync finish) before the logout
  // flow sends its own backend sign-off, so a late fix can't revive the row.
  const handleLogout = async () => {
    await haltTrackerForLogout()
    return logout()
  }

  if (!user || loading) return isMobile ? <EnforcerShellLoading /> : <AppShellLoading role="enforcer" />

  const renderPage = () => {
    switch (page) {
      // Phones keep the field-first app screen; tablets and desktops get the
      // overview dashboard.
      case 'dashboard': return isMobile
        ? <EnforcerHome user={user} setPage={setPage} />
        : <EnforcerHomeDesktop user={user} setPage={setPage} />
      // Camera/OCR license scan and OVR data entry used to be two separate
      // nav destinations ("Camera Capture" + "Submit Report"). Per the
      // corrected workflow, OCR is now Step 1 of a single "Issue OVR"
      // wizard — see IssueOVR.jsx — so both old entries collapse into one.
      case 'issue-ovr':
        return (
          <IssueOVR
            currentUser={user}
            setPage={setPage}
            onSuccess={() => { /* stay on the wizard's own success screen; MyReports will show it once synced */ }}
          />
        )
      case 'gps':      return <GPSTracking user={user} />
      case 'reports':  return <MyReports setPage={setPage} />
      case 'sync':     return <SyncData />
      case 'evidence': return <EvidenceGallery />
      default:
        return <EmptyState icon={Construction} title={PAGE_TITLES[page] || page} message="This section is under development." />
    }
  }

  // Phones get the dedicated app-style shell (bottom nav + FAB). Tablets and
  // desktops get the same Sidebar+Topbar shell admin/staff use — same nav,
  // same always-visible Logout item, same profile popover. One codebase,
  // device-appropriate chrome either way.
  if (isMobile) {
    return (
      <EnforcerShell user={user} onLogout={handleLogout} page={page} onPageChange={setPage} pageTitle={PAGE_TITLES[page]} onUserUpdate={updateUser}>
        {renderPage()}
      </EnforcerShell>
    )
  }

  return (
    <AppShell role="enforcer" user={user} onLogout={handleLogout} page={page} onPageChange={setPage} pageTitle={PAGE_TITLES[page]} onUserUpdate={updateUser}>
      {renderPage()}
    </AppShell>
  )
}