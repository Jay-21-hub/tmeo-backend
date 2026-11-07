import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import { clearAuthSession } from '../utils/session'

export default function useAuth(requiredRole = null) {
  const [user, setUser]       = useState(null)
  const [loading, setLoading] = useState(true)
  const navigate              = useNavigate()

  useEffect(() => {
    const token  = localStorage.getItem('access_token')
    const stored = localStorage.getItem('user')

    if (!token || !stored) {
      navigate('/login')
      return
    }

    let parsed
    try {
      parsed = JSON.parse(stored)
    } catch {
      clearAuthSession()
      navigate('/login')
      return
    }

    // Role guard — fast check before fetch
    if (requiredRole && parsed.role !== requiredRole) {
      navigate('/login')
      return
    }

    // Set stored user immediately so UI doesn't flicker
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate-from-localStorage-then-refetch pattern, same convention used elsewhere in this codebase
    setUser(parsed)

    // Fetch fresh data from backend
    api.get('/api/auth/me/')
      .then(res => {
        const freshUser = res.data

        // Role guard on fresh data
        if (requiredRole && freshUser.role !== requiredRole) {
          navigate('/login')
          return
        }

        // Update localStorage and state with latest data
        localStorage.setItem('user', JSON.stringify(freshUser))
        setUser(freshUser)
      })
      .catch((err) => {
        // Only a real server-returned auth failure (401/403 from
        // /api/auth/me/, meaning the token itself is invalid/expired)
        // should force a logout. A dropped/timed-out/offline request has
        // no err.response at all — that's a connectivity problem, not an
        // auth problem, so the already-hydrated localStorage user stays
        // logged in and the app keeps working offline (Requirement #1/#9).
        const status = err?.response?.status
        if (status === 401 || status === 403) {
          clearAuthSession()
          navigate('/login')
        }
        // else: silently keep the locally-hydrated session; nothing else
        // to do here — `user` is already set from localStorage above.
      })
      .finally(() => {
        setLoading(false)
      })
  }, [navigate, requiredRole])

  // Merges fresh fields (e.g. after a profile/photo update) into both
  // React state and localStorage, so the header/avatar update immediately
  // everywhere without a reload — no global store needed since every
  // dashboard already threads `user` down through props.
  const updateUser = (freshUser) => {
    setUser(freshUser)
    localStorage.setItem('user', JSON.stringify(freshUser))
  }

  const logout = async () => {
    // Deactivate GPS location before logout — enforcer-only, since the
    // backend (UpdateLocationView) rejects this with 403 for any other
    // role. Skipping it for Admin/Staff avoids a call that can never
    // succeed for them; behavior for Enforcer is unchanged.
    if (user?.role === 'enforcer') {
      try {
        // Explicit sign-off marker (not a real GPS fix, and not a duty claim):
        // the server marks the enforcer's location inactive without storing
        // (0, 0) or running geofence logic. Duty itself is server-computed.
        await api.post('/api/enforcers/update-location/', {
          sign_off: true,
          latitude: 0,
          longitude: 0,
        })
      } catch {
        // Silent — continue logout even if GPS update fails
      }
    }

    try {
      const refresh = localStorage.getItem('refresh_token')
      if (refresh) {
        await api.post('/api/auth/logout/', { refresh })
      }
    } catch {
      // Logout continues even if server-side token revocation fails
    } finally {
      clearAuthSession()
      navigate('/login')
    }
  }

  return { user, loading, logout, updateUser }
}