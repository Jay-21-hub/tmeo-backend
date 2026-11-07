import { CircleUser } from 'lucide-react'
import Avatar from './Avatar'
import './ProfileTrigger.css'

/**
 * ProfileTrigger — the compact top-right profile control for every role
 * (Admin / Staff via Topbar, Enforcer mobile via EnforcerShell).
 *
 * It renders the SAME <Avatar> the ProfileModal uses, fed from the same
 * `user` object (profile_photo_url), so there is no second image source.
 * When a photo is saved/removed, useAuth.updateUser replaces `user` and this
 * re-renders on its own — no extra request, no reload.
 *
 * Fallback order: profile photo -> initials circle -> generic CircleUser.
 * A photo that fails to load is handled inside Avatar (no broken-image UI).
 *
 * The button is 44x44 (hit area); the visible photo is 40x40.
 */
export default function ProfileTrigger({ user, onClick }) {
  return (
    <button type="button" className="profile-trigger" onClick={onClick} aria-label="Profile" title="Profile">
      <Avatar
        user={user}
        size={40}
        className="profile-trigger-avatar"
        fallback={<CircleUser size={26} strokeWidth={1.7} aria-hidden="true" />}
      />
    </button>
  )
}