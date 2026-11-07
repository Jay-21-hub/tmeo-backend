import { useCallback, useState } from 'react'
import { IdCard, ShieldOff } from 'lucide-react'
import PageHeader from '../../../components/ui/PageHeader'
import { EmptyState } from '../../../components/ui/States'
import CustodyList from './components/CustodyList'
import CustodyDetail from './components/CustodyDetail'
import { DEFAULT_FILTERS, canAccessCustody } from './utils/custodyConfig'
import './ConfiscatedLicenses.css'

function CustodyModule({ role }) {
  // The dashboards switch sections with state (no per-section URL), so the
  // module keeps its own list <-> detail view. Filters live here so they
  // survive opening a record and coming back.
  const [recordKey, setRecordKey] = useState(null)
  const [filters, setFilters] = useState(DEFAULT_FILTERS)

  const patchFilters = useCallback((patch) => setFilters((f) => ({ ...f, ...patch })), [])
  const openRecord = useCallback((key) => setRecordKey(key), [])
  const closeRecord = useCallback(() => setRecordKey(null), [])

  return (
    <div className="cl-module">
      <PageHeader icon={IdCard} title="Confiscated Licenses" />
      {recordKey === null ? (
        <>
          <p className="cl-subtitle">
            {role === 'admin'
              ? "Manage confiscated driver's licenses for release and oversight."
              : "Manage confiscated driver's licenses for release."}
          </p>
          <CustodyList role={role} filters={filters} onFiltersChange={patchFilters} onOpen={openRecord} />
        </>
      ) : (
        <CustodyDetail key={recordKey} role={role} recordKey={recordKey} onBack={closeRecord} />
      )}
    </div>
  )
}

/**
 * Confiscated Licenses — one module shared by Staff and Admin.
 * `role` only shapes what is shown; every action is re-checked by the backend
 * (Staff/Admin endpoints are IsAdminOrStaff, correction is IsAdmin). Enforcers
 * have no navigation entry and the backend answers them with 403; this guard
 * is a second, defensive layer so the module never renders for another role.
 */
export default function ConfiscatedLicenses({ role }) {
  if (!canAccessCustody(role)) {
    return (
      <EmptyState
        icon={ShieldOff} title="Access restricted"
        message="Confiscated license records are available to Administrators and Assessment Staff only."
      />
    )
  }
  return <CustodyModule role={role} />
}