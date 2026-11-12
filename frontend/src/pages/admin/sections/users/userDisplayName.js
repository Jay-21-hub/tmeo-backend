/**
 * Display-only name formatting for the User Management screens.
 *
 * The stored `full_name` stays "Last, First Middle" (built by the backend's
 * build_full_name(); it is the canonical name used by audit logs, history
 * snapshots and records). These helpers only change how the name is SHOWN:
 * "First Middle Last". Nothing here is ever sent to the backend.
 */

/** "First Middle Last" from separate parts (blank parts are skipped). */
export const buildDisplayName = (first, middle, last) =>
    [first, middle, last].map(s => (s || '').trim()).filter(Boolean).join(' ')
  
  /**
   * Display name for a user record.
   *  - When both first_name and last_name exist, they are used directly.
   *  - Otherwise (older accounts) the stored full_name is read:
   *      "Last, First Middle"  ->  "First Middle Last"
   *      no comma              ->  shown as stored (e.g. "Jaynard Diosay")
   */
  export function displayUserName(user) {
    if (!user) return '—'
    const first = (user.first_name || '').trim()
    const last = (user.last_name || '').trim()
    if (first && last) return buildDisplayName(first, user.middle_name, last)
  
    const full = (user.full_name || user.name || '').trim()
    if (!full) return '—'
    if (full.includes(',')) {
      const [lastPart, ...rest] = full.split(',')
      const given = rest.join(',').trim()
      return buildDisplayName(given, '', lastPart) || full
    }
    return full
  }