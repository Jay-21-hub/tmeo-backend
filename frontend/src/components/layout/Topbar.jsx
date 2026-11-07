import { useState } from 'react'
import { Menu } from 'lucide-react'
import NotificationBell from '../NotificationBell'
import ProfileModal from '../common/ProfileModal'
import ProfileTrigger from '../common/ProfileTrigger'
import './Topbar.css'

export default function Topbar({ user, onMenuClick, isOpen, onNavigate, onUserUpdate }) {
  const [showProfile, setShowProfile] = useState(false)

  return (
    <>
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          {!isOpen && (
            <button className="topbar-icon-btn" onClick={onMenuClick} aria-label="Open navigation menu">
              <Menu size={17} />
            </button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <NotificationBell onNavigate={onNavigate} />
          {/* Circular photo IS the profile button (same Avatar/user data as
              ProfileModal). Name and role live inside the ProfileModal. */}
          <ProfileTrigger user={user} onClick={() => setShowProfile(true)} />
        </div>
      </header>

      <ProfileModal user={user} open={showProfile} onClose={() => setShowProfile(false)} onUserUpdate={onUserUpdate} />
    </>
  )
}