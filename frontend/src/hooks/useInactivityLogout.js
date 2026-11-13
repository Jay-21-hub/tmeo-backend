import { useEffect } from 'react'
import { clearAuthSession } from '../utils/session'
import { isInstalledPwa } from '../utils/pwaDisplay'

// Installed app only: log out when the phone was away from the app too long.
// clearAuthSession() leaves the offline queue alone, so queued reports stay on
// the device and sync when the same enforcer logs back in.
const AWAY_LIMIT_MS = 30 * 60 * 1000 // change this number to adjust
const KEY = 'last_active_at'

const isStandalone = () => isInstalledPwa()

export function useInactivityLogout() {
  useEffect(() => {
    if (!isStandalone()) return

    const stamp = () => localStorage.setItem(KEY, String(Date.now()))

    const checkAway = () => {
      if (!localStorage.getItem('access_token')) return
      if (!navigator.onLine) return // cannot log back in offline, so do not log out
      const last = Number(localStorage.getItem(KEY) || 0)
      if (last && Date.now() - last > AWAY_LIMIT_MS) {
        clearAuthSession()
        localStorage.removeItem(KEY)
        window.location.replace('/login')
      } else {
        stamp()
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stamp()
      else checkAway()
    }

    checkAway()
    document.addEventListener('visibilitychange', onVisibility)
    const events = ['pointerdown', 'keydown', 'touchstart']
    events.forEach((e) => window.addEventListener(e, stamp, { passive: true }))
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && localStorage.getItem('access_token')) stamp()
    }, 60000)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      events.forEach((e) => window.removeEventListener(e, stamp))
      clearInterval(timer)
    }
  }, [])
}