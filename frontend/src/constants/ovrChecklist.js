/**
 * ovrChecklist.js
 *
 * Fixed checklist printed on the physical "Ordinance Violation Receipt (OVR)"
 * booklet (Section 5, City Ordinance No. 2510, Series of 2014). The labels,
 * order, and two-column grouping below are copied verbatim from that paper
 * form so the printed OVR_PRINT_TEMPLATE looks identical to the real ticket.
 *
 * This list is intentionally static (NOT sourced from the ViolationType
 * table) because the physical booklet is pre-printed and cannot change
 * without a new print run.
 *
 * ── Matching strategy (deterministic, code-based — reviewed & accepted) ────
 * The seeded TMEO `ViolationType` catalog (SV-xx/TV-xx/OV-xx, see
 * backend/violations/management/commands/seed_violations.py) is a DIFFERENT
 * taxonomy from this OVR booklet checklist — it's general motorist
 * safety/traffic violations, while the OVR targets PUV/franchise-ordinance
 * violations (colorum, overcharging, truck ban, etc.). Overlap is partial.
 *
 * `ViolationType.code` is a unique, stable CharField — so instead of loose
 * keyword/substring matching against free-text names (which risks checking
 * the wrong box), CODE_TO_OVR_LABEL below is an explicit, hand-reviewed
 * mapping. Only codes with a clear, unambiguous real-world equivalence are
 * included. Anything not in this table (including deliberately-excluded
 * ambiguous cases — see notes) falls under "Others" and is listed by its
 * actual violation name instead of being silently mischecked.
 */

export const OVR_CHECKLIST_LEFT = [
  'Obstruction',
  'Disregarding Traffic Officer / Sign',
  'Truck Ban',
  'Operating during Banned Days',
  'Emitting Excessive Smoke',
  'Refusal to Convey Passenger(s)',
  'Overcharging',
  'Smoking Inside Vehicle (CO No. 1838)',
  'Reckless Driving',
  'Arrogance',
  'Driving without/ invalid License',
]

export const OVR_CHECKLIST_RIGHT = [
  'Loading / Unloading in Prohibited Zone',
  'Driving in Prohibited Street',
  'Illegal Parking/ Terminal',
  'Not Wearing Helmet',
  'Colorum',
  'OR/CR not carried',
  'Unregistered Motor Vehicle',
  'Wearing Slippers/Shorts/Sleeve-less',
  'One way',
  'Illegal U-turn',
  'Others',
]

export const OVR_CHECKLIST_ALL = [...OVR_CHECKLIST_LEFT, ...OVR_CHECKLIST_RIGHT]

/**
 * Explicit ViolationType.code → OVR checklist label mapping.
 * Confidence notes kept inline per entry — pending items (flagged to Jay,
 * not yet finalized) are marked accordingly and can be removed/changed
 * without touching the matching logic below.
 */
const CODE_TO_OVR_LABEL = {
  // ── High confidence: same real-world violation, accepted ──────────────
  'TV-03': 'Obstruction',                              // Obstruction of Traffic
  'TV-06': 'Reckless Driving',                         // exact wording match
  'TV-04': 'Illegal U-turn',                           // Illegal U-Turn (case only)
  'TV-02': 'Illegal Parking/ Terminal',                // Illegal Parking
  'TV-18': 'Loading / Unloading in Prohibited Zone',   // Illegal Loading / Unloading
  'SV-01': 'Not Wearing Helmet',                       // No Helmet (Driver)
  'SV-02': 'Not Wearing Helmet',                       // No Helmet (Passenger)
  'TV-10': 'Driving without/ invalid License',         // No Driver's License
  'TV-11': 'Driving without/ invalid License',         // Expired Driver's License

  // ── PENDING Jay's confirmation — same concept, different official wording.
  //    Left active for now; remove the line if he rejects a given one. ────
  'TV-19': 'Disregarding Traffic Officer / Sign',      // Disobeying Traffic Signs/Signals — no "Officer" concept in TV-19
  'TV-13': 'OR/CR not carried',                        // No OR/CR — "none exists" vs "not carried" may differ legally
  'OV-01': 'Emitting Excessive Smoke',                 // Smoke Belching

  // ── Deliberately NOT mapped (do not add without explicit review) ───────
  // 'TV-08': Counterflow — NOT mapped to "One way". Counterflow can occur
  //   on two-way roads (overtaking into oncoming lane), not only one-way
  //   streets, so it isn't reliably the same violation.
  // 'TV-12': Expired Registration — NOT mapped to "Unregistered Motor
  //   Vehicle". Expired ≠ unregistered; treated as legally distinct here.
}

/**
 * @param {Array<{violation_type?: {code?: string, name?: string}, code?: string, name?: string}>} violationItems
 *   Accepts either raw ViolationItem objects (with a nested violation_type)
 *   or already-flattened {code, name} objects — whichever shape the caller
 *   has on hand (e.g. Violation.items from the detail serializer).
 * @returns {{ checked: Set<string>, othersList: string[] }}
 *   checked    — set of fixed checklist labels (from OVR_CHECKLIST_ALL) that
 *                should render as [X] on the printed form.
 *   othersList — names of violation items with no entry in
 *                CODE_TO_OVR_LABEL; these get printed next to "Others".
 */
export function getCheckedOvrItems(violationItems = []) {
  const checked = new Set()
  const othersList = []

  for (const item of violationItems) {
    const code = item?.violation_type?.code ?? item?.code
    const name = item?.violation_type?.name ?? item?.name ?? code ?? ''

    const label = code ? CODE_TO_OVR_LABEL[code] : undefined
    if (label) {
      checked.add(label)
    } else if (name) {
      checked.add('Others')
      othersList.push(name)
    }
  }

  return { checked, othersList }
}