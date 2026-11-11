/**
 * Filters violation types by the vehicle type picked on the form.
 *
 * `form.vehicle_type` holds the vehicle CATEGORY LABEL (e.g. "Motorcycles"),
 * while each violation type carries `vehicle_category` as a key
 * (e.g. "motorcycle"). A violation type with no vehicle_category is not
 * assigned yet and is offered for every vehicle type. A vehicle type that
 * cannot be resolved (free-typed) shows every violation type.
 */

const CATEGORY_LABELS = {
    motorcycle: 'Motorcycles',
    car: 'Cars',
    puv: 'Public Utility Vehicles',
    truck: 'Trucks & Heavy Vehicles',
    special: 'Special/ Other',
  }
  
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '')
  
  /** Vehicle type text -> category key ('' when it cannot be resolved). */
  export function vehicleCategoryKey(vehicleType, vehicles = []) {
    const t = norm(vehicleType)
    if (!t) return ''
    for (const v of vehicles || []) {
      if (v?.category && (norm(v.categoryLabel) === t || norm(v.category) === t)) return v.category
    }
    for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
      if (t === norm(key) || t === norm(label)) return key
    }
    return ''
  }
  
  export function violationTypeMatchesVehicle(type, categoryKey) {
    if (!categoryKey) return true
    if (!type?.vehicle_category) return true
    return type.vehicle_category === categoryKey
  }
  
  /** Violation types that apply to the chosen vehicle type. */
  export function filterTypesByVehicle(types, vehicleType, vehicles = []) {
    const key = vehicleCategoryKey(vehicleType, vehicles)
    return (types || []).filter((t) => violationTypeMatchesVehicle(t, key))
  }
  
  /** Drop already-selected ids that no longer apply after the vehicle type changed. */
  export function pruneSelectedIds(selectedIds, types, vehicleType, vehicles = []) {
    const key = vehicleCategoryKey(vehicleType, vehicles)
    const allowed = new Set(
      (types || []).filter((t) => violationTypeMatchesVehicle(t, key)).map((t) => t.id)
    )
    return (selectedIds || []).filter((id) => allowed.has(id))
  }