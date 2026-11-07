// Landing-page "Road Safety Reminders" carousel (max 5 slides).
//
// LIVE MODE (normal): the carousel loads the most frequently issued ACTIVE violation types from the
// system (GET /api/violations/public/types/) and turns each into a slide. The name, description and
// standard fine come from the Violation Types records, so editing a type in the system updates its slide.
// Dates, counts, violators and plates are never part of this data.
//
// FALLBACK MODE: if that request fails or returns nothing, ROAD_SAFETY_SLIDES (below) is shown instead.
//
// Pictures: the database has no image field, so the picture is chosen by matching the type's code/name
// against ICON_RULES. Types that match nothing get a generic picture for their category.
// OPTIONAL: add `image: '/road-safety/<file>.jpg'` to a rule to use your own photo (put the file in
// frontend/public/road-safety/). The photo becomes the blurred glass background of that slide.

export const MAX_ROAD_SAFETY_SLIDES = 5

// `match` is tested against "<code> <name>" (lower-case). First rule that matches wins.
export const ICON_RULES = [
  { icon: 'redLight', accent: '#e5484d', match: /red\s*light|traffic\s*(light|signal)\b/,
    title: 'Stop on red.', text: 'Entering an intersection after the signal turns red puts crossing drivers and pedestrians at risk. Slow down early and wait for the green.', tip: 'Ease off the throttle as soon as the light turns yellow.' },
  { icon: 'helmet', accent: '#e2a93b', match: /helmet/,
    title: 'Wear your helmet, every ride.', text: 'A properly worn helmet protects the head in a crash. It matters for the rider and for the passenger.', tip: 'Fasten the chin strap. An unfastened helmet can come off on impact.' },
  { icon: 'parking', accent: '#e5484d', match: /\bpark(ing|ed)?\b/,
    title: 'Park only where it is allowed.', text: 'Parking at no-parking zones, crosswalks or in front of driveways blocks traffic and can delay emergency vehicles.', tip: 'Look for signs and curb markings before you leave your vehicle.' },
  { icon: 'pedestrian', accent: '#3fb8af', match: /pedestrian|crosswalk|give\s*way|right\s*of\s*way/,
    title: 'Give way at the crosswalk.', text: 'Pedestrians cross at marked lanes and intersections. Slow down and let them pass before you move.', tip: 'Stop before the crosswalk line, not on it.' },
  { icon: 'phone', accent: '#5b8def', match: /phone|mobile|cellular|texting/,
    title: 'Eyes on the road.', text: 'Calling or texting while driving takes your attention off the road. Pull over safely before you use your phone.', tip: 'Set up your navigation before you start moving.' },
]

// Used when a type matches no rule.
export const CATEGORY_FALLBACK = {
  safety: { icon: 'shield', accent: '#3fb8af', label: 'Safety Violation', tip: 'Safety rules protect you and the people around you.' },
  traffic: { icon: 'road', accent: '#5b8def', label: 'Traffic Violation', tip: 'Follow road signs and markings at all times.' },
  other: { icon: 'sign', accent: '#e2a93b', label: 'Road Rule', tip: 'When in doubt, ask the TMEO office.' },
}
const GENERIC_TEXT = 'Know this rule and follow it on the road. For official rules and penalties, please contact the TMEO office.'

/** Display a fine as Philippine pesos, or null when there is nothing meaningful to show. */
export function formatFine(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return null
  return `₱${n.toLocaleString('en-PH', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`
}

/** API violation types -> carousel slides (max 5). Returns [] when the input is unusable. */
export function buildSlidesFromTypes(types) {
  if (!Array.isArray(types)) return []
  return types
    .filter((t) => t && typeof t.name === 'string' && t.name.trim())
    .slice(0, MAX_ROAD_SAFETY_SLIDES)
    .map((t, i) => {
      const hay = `${t.code || ''} ${t.name}`.toLowerCase()
      const rule = ICON_RULES.find((r) => r.match.test(hay))
      const cat = CATEGORY_FALLBACK[t.category] || CATEGORY_FALLBACK.other
      const description = typeof t.description === 'string' ? t.description.trim() : ''
      return {
        id: `${t.code || 'type'}-${i}`,
        icon: rule ? rule.icon : cat.icon,
        accent: rule ? rule.accent : cat.accent,
        image: rule?.image,
        violation: t.name.trim(),
        kicker: rule ? undefined : cat.label,
        title: rule ? rule.title : t.name.trim(),
        text: description || (rule ? rule.text : GENERIC_TEXT),
        tip: rule ? rule.tip : cat.tip,
        fine: formatFine(t.penalty_amount),
      }
    })
}

// Fallback slides (no fines, no legal citations, so nothing here can go out of date).
export const ROAD_SAFETY_SLIDES = ICON_RULES.map((r, i) => ({
  id: ['red-light', 'helmet', 'parking', 'pedestrian', 'phone'][i],
  icon: r.icon,
  accent: r.accent,
  violation: ['Beating Red Light', 'No Helmet', 'Illegal Parking', 'Failure to Give Way to Pedestrian', 'Mobile Phone While Driving'][i],
  title: r.title,
  text: r.text,
  tip: r.tip,
}))