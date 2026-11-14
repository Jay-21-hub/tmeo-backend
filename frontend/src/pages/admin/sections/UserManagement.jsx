import { useState, useEffect, useCallback } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import {
  Users, Shield, UserCheck, UserCog, Search, Plus, Eye, Pencil,
  ChevronLeft, ChevronRight,
} from 'lucide-react'
import api from '../../../services/api'
import { useToast } from '../../../context/useToast'
import StatCard from '../../../components/ui/StatCard'
import Button from '../../../components/ui/Button'
import { StatusBadge } from '../../../components/ui/Badge'
import { EmptyState } from '../../../components/ui/States'
import Avatar from '../../../components/common/Avatar'

import { getRoleStyle, canChangeRole } from './users/userManagementConfig'
import { displayUserName } from './users/userDisplayName'
import UserViewModal from './users/UserViewModal'
import AddUserModal from './users/AddUserModal'
import { UserConfirmDialog, UserDeleteAccountModal } from './users/UserConfirmModals'
import UserActionsMenu from './users/UserActionsMenu'
import ChangeRoleModal from './users/ChangeRoleModal'
import TreasuryPersonnelModal from './users/TreasuryPersonnelModal'
import './UserManagement.css'

const PAGE_SIZE = 10

// The signed-in admin's own id, so their own row never offers "Change Role"
// (the backend refuses it too). Same localStorage 'user' record useAuth reads.
const getStoredUserId = () => {
  try { return JSON.parse(localStorage.getItem('user') || 'null')?.id ?? null } catch { return null }
}

const STAT_CARDS = [
  { key: 'total_users', label: 'Total Users', icon: Users, accent: '#6366f1' },
  { key: 'total_enforcers', label: 'Total Enforcers', icon: Shield, accent: 'var(--success-600)' },
  { key: 'assessment_staff', label: 'Assessment Staff', icon: UserCheck, accent: '#7c3aed' },
  { key: 'administrators', label: 'Administrators', icon: UserCog, accent: 'var(--danger-600)' },
]

export default function UserManagement() {
  const toast = useToast()
  const [users, setUsers] = useState([])
  const [stats, setStats] = useState({ total_users: 0, total_enforcers: 0, assessment_staff: 0, administrators: 0 })
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [showAdd, setShowAdd] = useState(false)
  const [showTreasury, setShowTreasury] = useState(false)
  const [viewUser, setViewUser] = useState(null)
  const [editUser, setEditUser] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [changeRoleUser, setChangeRoleUser] = useState(null)
  const currentUserId = getStoredUserId()
  const [actionLoading, setActionLoading] = useState(null)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const params = { page, page_size: PAGE_SIZE }
      if (search) params.search = search
      if (roleFilter !== 'all') params.role = roleFilter
      const res = await api.get('/api/auth/users/', { params })
      const list = res.data.results || res.data.users || []
      setUsers(list)
      setTotalCount(res.data.count ?? list.length)
      setTotalPages(Math.ceil((res.data.count || 0) / PAGE_SIZE))
      if (res.data.stats) setStats(res.data.stats)
    } catch {
      toast.danger('Failed to load users.')
    } finally {
      setLoading(false)
    }
  }, [page, search, roleFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-filter-change pattern, matches existing codebase convention
    fetchUsers()
  }, [fetchUsers])

  const handleDeactivate = async (user) => {
    setActionLoading(user.id)
    try {
      await api.patch(`/api/auth/users/${user.id}/`, { employment_status: 'terminated' })
      toast.success(`${displayUserName(user)} has been deactivated.`)
      fetchUsers()
    } catch {
      toast.danger('Failed to deactivate user.')
    } finally {
      setActionLoading(null)
      setConfirm(null)
    }
  }

  const handleResetPW = async (user) => {
    setActionLoading(user.id)
    try {
      await api.post(`/api/auth/users/${user.id}/reset-password/`)
      toast.success(`Password reset for ${displayUserName(user)}.`)
    } catch {
      toast.danger('Failed to reset password.')
    } finally {
      setActionLoading(null)
      setConfirm(null)
    }
  }

  const handlePermanentDelete = async () => {
    const user = deleteConfirm
    setActionLoading(user.id)
    try {
      await api.delete(`/api/auth/users/${user.id}/permanent/`)
      toast.success(`${displayUserName(user)} has been permanently deleted.`)
      setDeleteConfirm(null)
      fetchUsers()
    } catch (err) {
      // 409 = account has historical records (HD-B): show the backend's safe reason.
      toast.danger(err.response?.data?.error || 'Failed to delete account.')
      setDeleteConfirm(null)
    } finally {
      setActionLoading(null)
    }
  }

  const closeChangeRole = useCallback(() => setChangeRoleUser(null), [])

  // The modal stays open in its success state (it shows the NEW ID from the server);
  // the admin closes it with Done. Only the list is refreshed here, with the current
  // search / role filter / page left as they are.
  const handleRoleChanged = (data) => {
    toast.success(data?.message || 'Role changed.')
    fetchUsers()
  }

  return (
    <div className="um">
      {confirm && (
        <UserConfirmDialog
          message={confirm.type === 'deactivate'
            ? `Deactivate ${displayUserName(confirm.user)}? They will lose access immediately.`
            : `Reset password for ${displayUserName(confirm.user)}? A new temporary password will be assigned.`}
          danger={confirm.type === 'deactivate'}
          onConfirm={() => confirm.type === 'deactivate' ? handleDeactivate(confirm.user) : handleResetPW(confirm.user)}
          onCancel={() => setConfirm(null)}
        />
      )}

      {showTreasury && <TreasuryPersonnelModal onClose={() => setShowTreasury(false)} />}
      {showAdd && <AddUserModal onClose={() => setShowAdd(false)} onSuccess={(msg) => { toast.success(msg); fetchUsers() }} />}
      {editUser && (
        <AddUserModal
          mode="edit"
          user={editUser}
          onClose={() => setEditUser(null)}
          onSuccess={(msg) => { toast.success(msg); fetchUsers() }}
        />
      )}
      {viewUser && (
        <UserViewModal
          user={viewUser}
          onClose={() => setViewUser(null)}
          onUpdated={(freshUser) => { setViewUser(freshUser); fetchUsers() }}
        />
      )}
      {changeRoleUser && (
        <ChangeRoleModal
          user={changeRoleUser}
          onClose={closeChangeRole}
          onChanged={handleRoleChanged}
          onStale={fetchUsers}
        />
      )}
      {deleteConfirm && (
        <UserDeleteAccountModal
          user={deleteConfirm} onConfirm={handlePermanentDelete} onCancel={() => setDeleteConfirm(null)}
          loading={actionLoading === deleteConfirm?.id}
        />
      )}

      <PageHeader title="User Management" />

      <div className="kpi-grid">
        {STAT_CARDS.map(c => <StatCard key={c.key} label={c.label} icon={c.icon} accent={c.accent} value={loading ? '—' : (stats[c.key] ?? 0)} />)}
      </div>

      <div className="filter-bar">
        <div className="search-input-wrap">
          <Search size={14} className="search-input-icon" />
          <input className="input" value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder="Search users by name, email, or phone..." />
        </div>
        <select className="filter-select" value={roleFilter} onChange={e => { setRoleFilter(e.target.value); setPage(1) }}>
          <option value="all">All Roles</option>
          <option value="admin">Administrator</option>
          <option value="staff">Assessment Staff</option>
          <option value="enforcer">Traffic Enforcer</option>
        </select>
        <Button variant="secondary" onClick={() => setShowTreasury(true)} style={{ marginLeft: 'auto' }}>Treasury Personnel</Button>
        <Button variant="primary" icon={Plus} onClick={() => setShowAdd(true)}>Add User</Button>
      </div>

      <div className="card">
        <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
          <table className="table um-table">
            <colgroup>
              <col style={{ width: 220 }} />
              <col />
              <col style={{ width: 130 }} />
              <col style={{ width: 108 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 104 }} />
              <col style={{ width: 200 }} />
            </colgroup>
            <thead>
              <tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Badge Number</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>{Array.from({ length: 7 }).map((_, j) => (
                    <td key={j}><div className="skeleton" style={{ height: 12, width: '70%' }} /></td>
                  ))}</tr>
                ))
              ) : users.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 0 }}><EmptyState icon={Users} title="No users found." /></td></tr>
              ) : users.map((user, idx) => {
                const roleStyle = getRoleStyle(user.role)
                const isActive = user.is_active !== false
                const isLoading = actionLoading === user.id
                const displayName = displayUserName(user)
                return (
                  <tr key={user.id || idx}>
                    <td>
                      <div className="um-user">
                        <Avatar user={user} size={30} style={{ border: `1px solid ${roleStyle.border}` }} />
                        <span className="um-name um-cell-text" title={displayName}>{displayName}</span>
                      </div>
                    </td>
                    <td><span className="um-cell-text" title={user.email || undefined}>{user.email || '—'}</span></td>
                    <td>{user.phone_number || '—'}</td>
                    <td><span className="badge" style={{ background: roleStyle.bg, color: roleStyle.text, border: `1px solid ${roleStyle.border}` }}>{user.role || '—'}</span></td>
                    <td className="um-mono">{user.badge_number || '—'}</td>
                    <td><StatusBadge status={isActive ? 'active' : 'inactive'} label={isActive ? 'Active' : 'Inactive'} /></td>
                    <td>
                      <div className="um-actions">
                        <button className="btn btn-secondary um-btn" aria-label={`View ${displayName}`} onClick={() => setViewUser(user)}><Eye size={13} aria-hidden="true" /> View</button>
                        <button className="btn btn-secondary um-btn" aria-label={`Edit ${displayName}`} onClick={() => setEditUser(user)}><Pencil size={13} aria-hidden="true" /> Edit</button>
                        <UserActionsMenu
                          userName={displayName}
                          isActive={isActive}
                          disabled={isLoading}
                          canChangeRole={canChangeRole(user, currentUserId)}
                          onChangeRole={() => setChangeRoleUser(user)}
                          onDeactivate={() => setConfirm({ type: 'deactivate', user })}
                          onResetPassword={() => setConfirm({ type: 'reset', user })}
                          onDelete={() => setDeleteConfirm(user)}
                        />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {!loading && users.length > 0 && (
          <div className="um-foot">
            <p className="text-caption">
              {(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + users.length} of {totalCount} users
              {totalPages > 1 && <> · Page {page} of {totalPages}</>}
            </p>
            {totalPages > 1 && (
              <div className="pagination">
                <button className="page-btn" aria-label="Previous page" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}><ChevronLeft size={14} aria-hidden="true" /></button>
                <span className="page-btn is-active" aria-current="page">{page}</span>
                <button className="page-btn" aria-label="Next page" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}><ChevronRight size={14} aria-hidden="true" /></button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}