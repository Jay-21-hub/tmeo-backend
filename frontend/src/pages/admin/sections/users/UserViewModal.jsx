import { User, Mail, Phone, Hash, Calendar, MapPin, Cake, Heart } from 'lucide-react'
import Modal from '../../../../components/ui/Modal'
import { StatusBadge } from '../../../../components/ui/Badge'
import AvatarUploader from '../../../../components/common/AvatarUploader'
import { API } from '../../../../constants'
import { getRoleStyle } from './userManagementConfig'
import { displayUserName } from './userDisplayName'

export default function UserViewModal({ user, onClose, onUpdated }) {
  if (!user) return null
  const roleStyle = getRoleStyle(user.role)
  const isEnforcer = user.role === 'enforcer'
  const displayName = displayUserName(user)
  const fields = [
    { icon: Hash, label: 'Employee ID (Login ID)', value: user.id_number || '—' },
    { icon: User, label: 'Full Name', value: displayName },
    { icon: User, label: 'First Name', value: user.first_name || '—' },
    { icon: User, label: 'Middle Name', value: user.middle_name || '—' },
    { icon: User, label: 'Last Name', value: user.last_name || '—' },
    { icon: Mail, label: 'Email', value: user.email || '—' },
    { icon: Phone, label: 'Phone', value: user.phone_number || '—' },
    { icon: MapPin, label: 'Address', value: user.address || '—' },
    { icon: Cake, label: 'Date of Birth', value: user.date_of_birth || '—' },
    { icon: Heart, label: 'Civil Status', value: user.civil_status_display || user.civil_status || '—' },
    ...(isEnforcer ? [
      { icon: Hash, label: 'Badge Number', value: user.badge_number || '—' },
      { icon: MapPin, label: 'Assigned Area', value: user.assigned_area || '—' },
    ] : []),
    { icon: Calendar, label: 'Hired Year', value: user.hired_year || '—' },
  ]

  return (
    <Modal open onClose={onClose} width={440} title="User Details">
      <p className="text-caption" style={{ marginTop: -12, marginBottom: 16 }}>View account information</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <AvatarUploader
          user={user}
          endpoint={`${API.USERS}${user.id}/`}
          onUpdated={onUpdated}
          size={56}
          onDark={false}
        />
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--slate-950)' }}>{displayName}</h3>
          <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
            <span className="badge" style={{ background: roleStyle.bg, color: roleStyle.text, border: `1px solid ${roleStyle.border}` }} dot={false}>{user.role}</span>
            <StatusBadge status={user.is_active ? 'active' : 'inactive'} label={user.is_active ? 'Active' : 'Inactive'} />
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        {fields.map(({ icon, label, value }) => {
          const Icon = icon
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <Icon size={15} color="var(--slate-400)" />
              <div>
                <p className="text-label" style={{ margin: 0 }}>{label}</p>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--slate-950)', fontWeight: 500 }}>{value}</p>
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}