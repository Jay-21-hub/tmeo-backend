// Shared reverse-geocoding helper (OpenStreetMap Nominatim, no API key).
// Used by GPS Tracking (Location History), Issue OVR, and Submit Report so
// every part of the app resolves coordinates → address the same way.

const cache = new Map() // "lat.toFixed(5),lng.toFixed(5)" -> result

// Nominatim asks that automated clients not fire more than ~1 req/sec and
// identify themselves. We also de-dupe in-flight requests for the same
// rounded coordinate so a fast-scrolling list doesn't fan out N calls.
const inFlight = new Map()

function cacheKey(lat, lng) {
  return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`
}

/**
 * Picks how much of the address to surface based on GPS accuracy, and the
 * qualifier word to prefix it with. Poor accuracy must never be presented
 * as an exact location — this is a hard product requirement, not a nicety.
 *
 *   accuracy <= 50m   -> "Detected Location"    street-level detail
 *   accuracy <= 150m  -> "Approximate Location" neighborhood/barangay level
 *   accuracy > 150m   -> "Approximate Location" city/province level only
 *   accuracy unknown  -> treated as low-confidence (city/province level)
 */
function pickLabel(address, displayName, accuracy) {
  if (!address) return { text: displayName || null, precision: 'unknown' }

  const road = address.road
  const neighborhood = address.suburb || address.village || address.neighbourhood || address.barangay
  const city = address.city || address.town || address.municipality
  const province = address.state || address.province

  const hasAccuracy = typeof accuracy === 'number' && !Number.isNaN(accuracy)
  const tier = !hasAccuracy ? 'low' : accuracy <= 50 ? 'high' : accuracy <= 150 ? 'mid' : 'low'

  let parts
  if (tier === 'high') {
    parts = [road, neighborhood, city].filter(Boolean)
  } else if (tier === 'mid') {
    parts = [neighborhood, city].filter(Boolean)
  } else {
    parts = [city, province].filter(Boolean)
  }

  const text = parts.length ? parts.join(', ') : (displayName || null)
  return { text, precision: tier }
}

/**
 * Reverse-geocodes a coordinate pair into a short, accuracy-appropriate
 * label. Never throws — resolves to a fallback object on any failure so
 * callers can always render *something* (the raw coordinates).
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number|null} accuracy meters, optional
 * @returns {Promise<{ address: string|null, qualifier: 'Detected Location'|'Approximate Location', precision: 'high'|'mid'|'low'|'unknown', raw: object|null }>}
 */
export async function reverseGeocode(lat, lng, accuracy = null) {
  const key = cacheKey(lat, lng)
  if (cache.has(key)) return cache.get(key)
  if (inFlight.has(key)) return inFlight.get(key)

  const qualifier = (typeof accuracy === 'number' && accuracy <= 50) ? 'Detected Location' : 'Approximate Location'

  const promise = fetch(
    `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`
  )
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      const { text, precision } = pickLabel(data?.address, data?.display_name, accuracy)
      const result = {
        address: text,
        qualifier,
        precision,
        raw: data?.address || null,
        fullAddress: data?.display_name || null,
      }
      cache.set(key, result)
      return result
    })
    .catch(() => {
      const result = { address: null, qualifier, precision: 'unknown', raw: null, fullAddress: null }
      // Don't cache failures — connectivity may recover on next render.
      return result
    })
    .finally(() => inFlight.delete(key))

  inFlight.set(key, promise)
  return promise
}