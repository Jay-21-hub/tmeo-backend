/**
 * Admin Dashboard - labels and row selection for the archived-inclusive panels
 * (Violations by Type, Top Locations, Top Enforcers).
 *
 * The backend sends the exact label in stats.historical.period.<panel>.label.  The constants
 * below are only the defaults used when it is absent and must match the approved wording.
 */
export const LABEL_CUMULATIVE = 'Cumulative · includes archived'
export const LABEL_THIS_MONTH = 'This month · includes archived'
export const LABEL_ACTIVE_ONLY = 'Active only · archive not included'
export const LABEL_ACTIVE_THIS_MONTH = 'This month · active only, archive not included'

/**
 * One panel's rows + honest label.  The archived-inclusive list is used only when the backend
 * really sent it (an array); otherwise the active-only top-level list is used with an
 * active-only label, so a label can never claim more than the numbers contain.
 */
export function pickPanel(hist, key, activeRows, historicalLabel, activeLabel) {
  const rows = hist?.[key]
  if (Array.isArray(rows)) {
    return { rows, label: hist?.period?.[key]?.label || historicalLabel, includesArchived: true }
  }
  return { rows: Array.isArray(activeRows) ? activeRows : [], label: activeLabel, includesArchived: false }
}