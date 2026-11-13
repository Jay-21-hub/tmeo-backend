/** Split "Last, First MI." into the Issue OVR name fields. */
export function splitViolatorName(name) {
  const raw = String(name || '').trim()
  if (!raw) return { last_name: '', first_name: '', middle_initial: '' }
  if (!raw.includes(',')) return { last_name: raw, first_name: '', middle_initial: '' }
  const [last, rest] = raw.split(',', 2)
  const parts = rest.trim().split(/\s+/).filter(Boolean)
  const middle = parts.slice(1).join(' ').replace(/\./g, '')
  return {
    last_name: last.trim(),
    first_name: parts[0] || '',
    middle_initial: middle,
  }
}

export function hasPersonalDetails(personal) {
  if (!personal) return false
  return Boolean(String(personal.violator_name || '').trim() || String(personal.address || '').trim())
}

export function hasVehicleDetails(vehicle) {
  if (!vehicle) return false
  return ['vehicle_type', 'vehicle_brand', 'vehicle_model', 'registration_number', 'vehicle_use']
    .some((key) => String(vehicle[key] || '').trim())
}
