import { useEffect, useRef, useState } from 'react'
import { Camera, Trash2 } from 'lucide-react'
import api from '../../services/api'
import Avatar from './Avatar'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_SIZE_BYTES = 5 * 1024 * 1024

/**
 * AvatarUploader — Avatar plus a camera-badge control for changing or
 * removing the photo. Works for both self-service (endpoint = /api/auth/me/)
 * and admin-managed (endpoint = /api/auth/users/{id}/) contexts — the caller
 * just supplies the right endpoint and receives the updated user back.
 *
 * user       - the user whose photo is being edited (for display + role tint)
 * endpoint   - PATCH url to send the multipart update to
 * onUpdated  - called with the fresh user object after a successful change
 * size       - avatar diameter in px
 * onDark     - true when placed on a colored/dark background (default),
 *              false for light/white surfaces (e.g. admin's UserViewModal)
 * compact    - opt-in (Profile modal): the whole avatar is one button; with a
 *              photo it opens a small Change / Remove menu, without a photo it
 *              opens the file picker directly. No permanent "Remove photo"
 *              link. Same upload/remove API calls as the default mode.
 */
export default function AvatarUploader({ user, endpoint, onUpdated, size = 72, onDark = true, compact = false }) {
  const inputRef = useRef(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const hasPhoto = !!user?.profile_photo_url

  const send = async (fd) => {
    setBusy(true)
    setError('')
    try {
      const res = await api.patch(endpoint, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      const updatedUser = res.data?.user || res.data
      onUpdated?.(updatedUser)
    } catch (err) {
      setError(
        err.response?.data?.profile_photo?.[0]
        || err.response?.data?.detail
        || 'Could not update photo. Please try again.'
      )
    } finally {
      setBusy(false)
    }
  }

  const handleFileChange = (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return

    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Only JPEG, PNG, or WEBP images are allowed.')
      return
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError('Image must be smaller than 5MB.')
      return
    }

    const fd = new FormData()
    fd.append('profile_photo', file)
    send(fd)
  }

  const handleRemove = () => {
    const fd = new FormData()
    fd.append('profile_photo', '')
    send(fd)
  }

  // Menu behaviour (compact mode only): Escape closes just the menu (captured
  // on window so the surrounding Modal does not also close), an outside click
  // closes it, and focus moves to the first item when it opens.
  useEffect(() => {
    if (!menuOpen) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setMenuOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target) && !triggerRef.current?.contains(e.target)) setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    menuRef.current?.querySelector('button')?.focus()
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [menuOpen])

  if (compact) {
    const onTriggerClick = () => (hasPhoto ? setMenuOpen(o => !o) : inputRef.current?.click())
    const onMenuKeyDown = (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const items = [...menuRef.current.querySelectorAll('button')]
      const i = items.indexOf(document.activeElement)
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }
    return (
      <div className="pf-photo">
        <button
          ref={triggerRef}
          type="button"
          className="pf-photo-btn"
          onClick={onTriggerClick}
          disabled={busy}
          aria-label="Change profile photo"
          aria-haspopup={hasPhoto ? 'menu' : undefined}
          aria-expanded={hasPhoto ? menuOpen : undefined}
        >
          <Avatar user={user} size={size} style={{ border: '2px solid var(--slate-200)' }} />
          <span className="pf-photo-badge" aria-hidden="true"><Camera size={13} /></span>
          {busy && (
            <span className="pf-photo-busy" aria-hidden="true">
              <span className="spinner" style={{ width: 18, height: 18, borderTopColor: 'var(--white)' }} />
            </span>
          )}
        </button>
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleFileChange} style={{ display: 'none' }} />
        {menuOpen && (
          <div
            ref={menuRef}
            className="pf-photo-menu"
            role="menu"
            aria-label="Profile photo"
            onKeyDown={onMenuKeyDown}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget) && e.relatedTarget !== triggerRef.current) setMenuOpen(false) }}
          >
            <button type="button" role="menuitem" className="pf-photo-item" onClick={() => { setMenuOpen(false); inputRef.current?.click() }}>
              <Camera size={14} aria-hidden="true" /> Change photo
            </button>
            <button type="button" role="menuitem" className="pf-photo-item pf-photo-item--danger" onClick={() => { setMenuOpen(false); handleRemove() }}>
              <Trash2 size={14} aria-hidden="true" /> Remove photo
            </button>
          </div>
        )}
        {error && <span className="pf-photo-error" role="alert">{error}</span>}
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{ position: 'relative' }}>
        <Avatar user={user} size={size} style={{ border: onDark ? '2.5px solid rgba(255,255,255,0.4)' : '2.5px solid var(--slate-200)' }} />
        {busy && (
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            background: 'rgba(15,23,42,0.45)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <span className="spinner" style={{ width: 18, height: 18, borderTopColor: 'var(--white)' }} aria-hidden="true" />
          </div>
        )}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          aria-label="Change profile photo"
          style={{
            position: 'absolute', bottom: -2, right: -2, width: 26, height: 26,
            borderRadius: '50%', background: 'var(--white)', border: '2px solid var(--slate-100)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: busy ? 'default' : 'pointer',
          }}
        >
          <Camera size={13} color="var(--slate-700)" aria-hidden="true" />
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />
      </div>

      {hasPhoto && !busy && (
        <button
          type="button"
          onClick={handleRemove}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
            cursor: 'pointer', fontSize: 11, fontWeight: 600,
            color: onDark ? 'rgba(255,255,255,0.75)' : 'var(--slate-500)', padding: 0,
          }}
        >
          <Trash2 size={11} aria-hidden="true" /> Remove photo
        </button>
      )}

      {error && (
        <span style={{ fontSize: 11, color: onDark ? '#fecaca' : 'var(--danger-600)', textAlign: 'center', maxWidth: 180 }}>
          {error}
        </span>
      )}
    </div>
  )
}