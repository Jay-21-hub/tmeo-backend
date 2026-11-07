import { useState } from 'react'
import { Pencil, KeyRound, LogOut } from 'lucide-react'
import Modal from '../ui/Modal'
import Badge from '../ui/Badge'
import Button from '../ui/Button'
import AvatarUploader from './AvatarUploader'
import ProfileEditForm from './ProfileEditForm'
import ChangePasswordModal from './ChangePasswordModal'
import { API } from '../../constants'
import {
  ROLE_LABEL, EMPLOYMENT_TONE, formatLabel,
  formatProfileDate, formatLastLogin, formatYearHired,
} from './profileFormat'
import './ProfileModal.css'

/**
 * ProfileModal — the ONE profile experience for Admin, Staff and Enforcer.
 * Role differences come only from real data (user.role, badge_number,
 * assigned_area, duty_status), never from separate per-role components.
 *
 * Props
 *   user         authenticated user object (from useAuth; refreshed from /api/auth/me/)
 *   open/onClose standard modal control
 *   onUserUpdate called with the fresh user after a photo or profile change
 *   onLogout     optional — shows a Log out action (used by the mobile Enforcer shell)
 *   dutyStatus   optional live duty status override (Enforcer shell tracks it separately)
 */
function DetailRow({ label, value, emptyText }) {
  return (
    <div className="pf-row">
      <dt className="pf-label">{label}</dt>
      <dd className={`pf-value ${value ? '' : 'is-empty'}`}>{value || emptyText}</dd>
    </div>
  )
}

export default function ProfileModal({ user, open, onClose, onUserUpdate, onLogout, dutyStatus }) {
  const [editOpen, setEditOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)

  const role = user?.role
  const roleLabel = ROLE_LABEL[role] || user?.role_display || role || 'User'
  const employment = user?.employment_status
  const statusText = user?.employment_status_display
    || formatLabel(employment)
    || (user?.is_active === false ? 'Inactive' : user?.is_active ? 'Active' : '')
  const statusTone = employment ? (EMPLOYMENT_TONE[employment] || 'neutral') : (user?.is_active === false ? 'neutral' : 'success')

  const duty = dutyStatus || user?.duty_status
  const dutyText = role === 'enforcer' && duty ? (user?.duty_status_display && !dutyStatus ? user.duty_status_display : formatLabel(duty)) : ''

  // While Edit Profile / Change Password sit on top, Escape and backdrop
  // belong to THEM — never close the profile underneath at the same time.
  const handleClose = () => { if (!editOpen && !passwordOpen) onClose?.() }

  return (
    <>
      <Modal open={open} onClose={handleClose} title="Profile" width={460} className="pf-modal">
        <div className="pf">
          <div className="pf-identity">
            <AvatarUploader user={user} endpoint={API.ME} onUpdated={onUserUpdate} size={64} onDark={false} compact />
            <div className="pf-identity-text">
              <div className="pf-name">{user?.full_name || 'User'}</div>
              <div className="pf-idnum">{user?.id_number || 'No ID number'}</div>
              <div className="pf-chips">
                <span className="pf-role">{roleLabel}</span>
                {statusText && <Badge tone={statusTone}>{statusText}</Badge>}
              </div>
            </div>
          </div>

          <dl className="pf-details">
            <DetailRow label="Email" value={user?.email} emptyText="Not provided" />
            <DetailRow label="Phone" value={user?.phone_number || user?.phone} emptyText="Not provided" />
            {role === 'enforcer' && <DetailRow label="Badge No." value={user?.badge_number} emptyText="Not assigned" />}
            {role === 'enforcer' && <DetailRow label="Assigned Area" value={user?.assigned_area} emptyText="Not assigned" />}
            {role === 'enforcer' && dutyText && <DetailRow label="Duty Status" value={dutyText} emptyText="" />}
            <DetailRow label="Year Hired" value={formatYearHired(user?.hired_year)} emptyText="Not provided" />
            <DetailRow label="Date Joined" value={formatProfileDate(user?.date_joined)} emptyText="Not provided" />
            <DetailRow label="Last Login" value={formatLastLogin(user?.last_login)} emptyText="No login recorded" />
          </dl>

          <div className="pf-actions">
            <Button variant="primary" icon={Pencil} onClick={() => setEditOpen(true)}>Edit Profile</Button>
            <Button variant="secondary" icon={KeyRound} onClick={() => setPasswordOpen(true)}>Change Password</Button>
          </div>

          {onLogout && (
            <button type="button" className="pf-logout" onClick={onLogout}>
              <LogOut size={15} aria-hidden="true" /> Log out
            </button>
          )}
        </div>
      </Modal>

      {/* Mounted only while open so the form always starts from the CURRENT
          user values (a saved edit is reflected the next time it opens). */}
      {editOpen && (
        <ProfileEditForm
          user={user}
          open
          onClose={() => setEditOpen(false)}
          onUpdated={(freshUser) => { onUserUpdate?.(freshUser); setEditOpen(false) }}
        />
      )}
      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </>
  )
}