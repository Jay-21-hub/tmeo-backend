import { useState } from 'react'
import { getInitials } from '../../utils/helpers'

const ROLE_COLOR = { admin: 'var(--blue-600)', staff: 'var(--success-600)', enforcer: 'var(--warning-600)' }

/**
 * Avatar — renders the user's profile photo when available, falling back
 * to a role-tinted initials circle. Single source of truth so photo/initials
 * display stays consistent across Topbar, EnforcerShell, ProfileModal, admin
 * tables, and the UserViewModal.
 *
 * size     - diameter in px (default 32)
 * user     - object with full_name, role, profile_photo_url
 * fallback - optional node shown instead of initials when the user has no
 *            usable photo AND no name (e.g. a generic user icon). Default: '?'
 *
 * If the photo URL fails to load, the avatar drops to the initials/fallback
 * instead of showing a broken-image icon. The failure is remembered per URL,
 * so uploading a new photo (new URL) tries the image again automatically.
 */
export default function Avatar({ user, size = 32, style, className = '', fallback }) {
  const [failedUrl, setFailedUrl] = useState(null)
  const color = ROLE_COLOR[user?.role] || ROLE_COLOR.admin
  const photoUrl = user?.profile_photo_url
  const showPhoto = !!photoUrl && failedUrl !== photoUrl

  const base = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    ...style,
  }

  if (showPhoto) {
    return (
      <div className={className} style={{ ...base, background: 'var(--slate-100)' }}>
        <img
          src={photoUrl}
          alt={user?.full_name || 'Profile photo'}
          onError={() => setFailedUrl(photoUrl)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
    )
  }

  const initials = getInitials(user?.full_name)

  if (!initials && fallback) {
    return (
      <div className={className} style={{ ...base, background: 'var(--slate-100)', color: 'var(--navy-700)' }}>
        {fallback}
      </div>
    )
  }

  return (
    <div
      className={className}
      style={{
        ...base,
        background: color,
        color: 'var(--white)',
        fontWeight: 700,
        fontSize: Math.max(10, Math.round(size * 0.38)),
      }}
    >
      {initials || '?'}
    </div>
  )
}