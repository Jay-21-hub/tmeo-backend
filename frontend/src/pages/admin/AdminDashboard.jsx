import { useState } from 'react'
import AppShell, { AppShellLoading } from '../../components/layout/AppShell'
import DashboardHome from './sections/DashboardHome'
import ViolationRecords from './sections/ViolationRecords'
import GISViolationMap from './sections/GISViolationMap'
import GPSEnforcerTracking from './sections/GPSEnforcerTracking'
import ManageEnforcers from './sections/ManageEnforcers'
import ManageViolationTypes from './sections/ManageViolationTypes'
import ManageVehicleCatalog from './sections/ManageVehicleCatalog'
import useAuth from '../../hooks/useAuth'
import Reports from './sections/Reports'
import UserManagement from './sections/UserManagement'
import Analytics from './sections/Analytics'
import AuditTrail from './sections/AuditTrail'
import ArchiveManagement from './sections/ArchiveManagement'
import ConfiscatedLicenses from '../shared/confiscated-licenses/ConfiscatedLicenses'
import { EmptyState } from '../../components/ui/States'
import { Construction } from 'lucide-react'

const PAGE_TITLES = {
  dashboard: 'Dashboard', violations: 'Violation Records', gis: 'GIS Violation Map',
  gps: 'GPS Enforcer Tracking', enforcers: 'Manage Enforcers', vtypes: 'Violation Types',
  vehiclecatalog: 'Vehicle Catalog',
  reports: 'Reports', analytics: 'Analytics', audit: 'Audit Trail', users: 'User Management',
  archive: 'Archive Management', custody: 'Confiscated Licenses',
}

export default function AdminDashboard() {
  const { user, logout, loading, updateUser } = useAuth('admin')
  const [page, setPage] = useState('dashboard')
  const [pageParam, setPageParam] = useState(null)

  if (!user || loading) return <AppShellLoading role="admin" />

  const renderPage = () => {
    switch (page) {
      case 'dashboard':  return <DashboardHome user={user} setPage={setPage} />
      case 'violations': return <ViolationRecords />
      case 'gis':        return <GISViolationMap />
      case 'gps':        return <GPSEnforcerTracking />
      case 'enforcers':  return <ManageEnforcers />
      case 'vtypes':     return <ManageViolationTypes />
      case 'vehiclecatalog': return <ManageVehicleCatalog />
      case 'reports':    return <Reports />
      case 'users':      return <UserManagement />
      case 'analytics':  return <Analytics scrollTo={pageParam} />
      case 'audit':      return <AuditTrail />
      case 'archive':    return <ArchiveManagement />
      case 'custody':    return <ConfiscatedLicenses role="admin" />
      default:
        return <EmptyState icon={Construction} title={PAGE_TITLES[page] || page} message="This section is under development." />
    }
  }

  return (
    <AppShell
      role="admin" user={user} onLogout={logout}
      page={page} onPageChange={(p) => { setPage(p); setPageParam(null) }}
      pageTitle={PAGE_TITLES[page]}
      onNavigate={setPage}
      onUserUpdate={updateUser}
    >
      {renderPage()}
    </AppShell>
  )
}