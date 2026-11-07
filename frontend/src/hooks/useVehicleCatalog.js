import { useState, useEffect, useCallback } from 'react'
import api from '../services/api'
import { API } from '../constants'

const CACHE_KEY = 'tmeo_cached_vehicle_catalog'

function getCached() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]') } catch { return [] }
}

/**
 * Vehicle Catalog — one flat array of selectable brand/model rows, each
 * already carrying its own `category` (Motorcycle/Car/PUV/Truck/Special).
 * There used to be a separate VehicleType table joined in client-side
 * here; that intermediate "Type" layer was removed per product decision,
 * so this hook now just fetches the brand/model list as-is:
 *
 *   { id, brand, model, category, categoryLabel }
 *
 * Cached to localStorage under one key so the enforcer's vehicle picker
 * still works offline in the field.
 */
export default function useVehicleCatalog() {
  const [vehicles, setVehicles] = useState(getCached)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    if (!navigator.onLine) { setLoading(false); return }
    setLoading(true)
    api.get(API.VEHICLE_BRANDS)
      .then((res) => {
        const brandsData = Array.isArray(res.data) ? res.data : res.data.results || []
        const mapped = brandsData.map(bm => ({
          id: bm.id,
          brand: bm.brand,
          model: bm.model,
          is_active: bm.is_active,
          category: bm.category ?? null,
          categoryLabel: bm.category_label ?? null,
        }))

        setVehicles(mapped)
        localStorage.setItem(CACHE_KEY, JSON.stringify(mapped))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Fetch on mount, and again the moment connectivity returns — mirrors
  // the `[isOnline]`-keyed re-fetch SyncData already uses for violation
  // types. Without this, a component that happens to mount while offline
  // (the enforcer's normal path into Sync Data in the field) would fetch
  // exactly once, fail the online check, and then never retry even after
  // the device reconnects, since `load` itself never changes identity.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern, matches existing codebase convention
    load()
    window.addEventListener('online', load)
    return () => window.removeEventListener('online', load)
  }, [load])

  return {
    vehicles: vehicles.filter(v => v.is_active !== false),
    loading,
    refresh: load,
  }
}