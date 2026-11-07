import { APP_TIMEZONE } from '../../utils/helpers'

/**
 * Pure display helpers for the shared Profile modal. Nothing here changes
 * stored data — every function only formats what the backend returned.
 */

// Authoritative role comes from user.role (backend). These are the labels the
// app already established (Topbar / Sidebar); unknown roles fall back to the
// backend's own role_display.
export const ROLE_LABEL = { admin: 'Administrator', staff: 'Assessment Staff', enforcer: 'Traffic Enforcer' }

export const EMPLOYMENT_TONE = {
  active: 'success', on_leave: 'warning', suspended: 'danger', resigned: 'neutral',
  retired: 'neutral', terminated: 'danger', dropped: 'danger', deceased: 'neutral', coterminous: 'neutral',
}
export const DUTY_TONE = { on_duty: 'success', off_duty: 'neutral', on_break: 'warning' }

export function formatLabel(str) {
  if (!str) return ''
  return String(str).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

const isValid = (d) => d instanceof Date && !Number.isNaN(d.getTime())

/** "May 2, 2026" — date only, in the app's timezone. Empty string if missing/invalid. */
export function formatProfileDate(value) {
  if (!value) return ''
  const d = new Date(value)
  if (!isValid(d)) return ''
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: APP_TIMEZONE })
}

/**
 * "July 22, 2026 · 3:42 PM". last_login is a real timestamp in the backend,
 * so the time is shown; a date-only value (no time part) shows the date alone
 * instead of inventing a time.
 */
export function formatLastLogin(value) {
  if (!value) return ''
  const d = new Date(value)
  if (!isValid(d)) return ''
  const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: dateOnly ? 'UTC' : APP_TIMEZONE })
  if (dateOnly) return date
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: APP_TIMEZONE })
  return `${date} · ${time}`
}

/**
 * "2026 · Less than 1 year in service" / "2025 · 1 year in service" /
 * "2022 · 4 years in service". Only the hire YEAR is stored, so no month or
 * day is implied. `now` is injectable for tests; the current year is never
 * hardcoded.
 */
export function formatYearHired(hiredYear, now = new Date()) {
  const year = Number(hiredYear)
  if (!hiredYear || !Number.isInteger(year)) return ''
  const years = now.getFullYear() - year
  if (years < 0) return String(year)            // future year: show it, claim no tenure
  if (years === 0) return `${year} · Less than 1 year in service`
  return `${year} · ${years} ${years === 1 ? 'year' : 'years'} in service`
}