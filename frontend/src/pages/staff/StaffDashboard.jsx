import { useState } from 'react'
import useAuth from '../../hooks/useAuth'
import AppShell, { AppShellLoading } from '../../components/layout/AppShell'
import AssessmentDashboard from './sections/AssessmentDashboard'
import PendingViolation from './sections/PendingViolation'
import AssessmentForm from './sections/AssessmentForm'
import DigitalTickets from './sections/DigitalTickets'
import ConfiscatedLicenses from '../shared/confiscated-licenses/ConfiscatedLicenses'
import api from '../../services/api'
import { EmptyState } from '../../components/ui/States'
import { Construction } from 'lucide-react'

const PAGE_TITLES = {
  dashboard: 'Dashboard', pending: 'Pending Violations', assessment: 'Assessment Form',
  tickets: 'Digital Tickets', custody: 'Confiscated Licenses',
}

export default function StaffDashboard() {
  const { user, logout, loading, updateUser } = useAuth('staff')
  const currentUser = user
  const [page, setPage] = useState('dashboard')
  const [selectedViolation, setSelectedViolation] = useState(null)

  if (!user || loading) return <AppShellLoading role="staff" />

  const handleProcess = async (v) => {
    // Already locked by someone else — don't navigate
    if (v.status === 'processing' && v.locked_by_id && v.locked_by_id !== currentUser?.id) {
      return
    }
    // Already locked by me — just navigate
    if (v.status === 'processing' && v.locked_by_id === currentUser?.id) {
      setSelectedViolation(v)
      setPage('assessment')
      return
    }
    try {
      const res = await api.patch(`/api/violations/${v.id}/`, { status: 'processing' })
      setSelectedViolation({
        ...v,
        ...res.data,
        items: (res.data.items && res.data.items.length) ? res.data.items : (v.items || []),
      })
    } catch {
      setSelectedViolation(v)
    }
    setPage('assessment')
  }

  // Sidebar navigation (as opposed to Pending Violations → Process) always
  // opens a clean Assessment Form — this is what lets the SAME form serve
  // as the manual/no-OVR entry point (source: 'staff_walk_in' on submit)
  // without a separate "Walk-in Complaint" page. handleProcess above sets
  // selectedViolation itself and navigates directly via setPage, so it is
  // NOT affected by this reset.
  const handleSidebarNav = (p) => {
    if (p === 'assessment') setSelectedViolation(null)
    setPage(p)
  }

  const renderPage = () => {
    switch (page) {
      case 'dashboard':
        return <AssessmentDashboard user={user} onProcess={handleProcess} onNavigate={handleSidebarNav} />
      case 'pending':
        return <PendingViolation onNavigate={(section, v) => { setSelectedViolation(v); setPage(section) }} />
      case 'assessment':
        // ONE Assessment Form for both cases:
        //  - selectedViolation set (via Pending Violations → Process) → pre-filled from the Enforcer's OVR
        //  - selectedViolation null (direct sidebar nav) → blank, Staff enters everything manually
        // AssessmentForm/AssessmentFormSteps key off violationData being
        // present or null to decide what's read-only (OVR Number) vs shown.
        return (
          <AssessmentForm
            violationData={selectedViolation}
            onSuccess={() => { setSelectedViolation(null); setPage('dashboard') }}
          />
        )
      case 'tickets': return <DigitalTickets />
      case 'custody': return <ConfiscatedLicenses role="staff" />
      default:
        return <EmptyState icon={Construction} title={PAGE_TITLES[page] || page} message="This section is under development." />
    }
  }

  return (
    <AppShell role="staff" user={user} onLogout={logout} page={page} onPageChange={handleSidebarNav} pageTitle={PAGE_TITLES[page]} onUserUpdate={updateUser}>
      {renderPage()}
    </AppShell>
  )
}