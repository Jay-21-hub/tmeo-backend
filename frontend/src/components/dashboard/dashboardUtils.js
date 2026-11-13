import { APP_TIMEZONE, manilaHour } from '../../utils/helpers'

export const greetingFor = () => {
  const h = manilaHour()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/** Given name for the greeting. Uses first_name when the account has it
 *  ("Jay Nard"); older accounts fall back to the stored full_name, which is
 *  "Last, First Middle", so the part after the comma is read, never the
 *  surname. Display only. */
export const firstNameOf = (user, fallback = 'there') => {
  const first = (user?.first_name || '').trim()
  if (first) return first
  const full = (user?.full_name || '').trim()
  if (!full) return fallback
  const given = full.includes(',') ? full.slice(full.indexOf(',') + 1).trim() : full
  return given.split(/\s+/)[0] || fallback
}

const manila = (date, opts) => date.toLocaleString('en-PH', { timeZone: APP_TIMEZONE, ...opts })

/** "Sep 15 – Sep 21, 2026": the 7 days ending today (Manila), the same
 *  window /api/violations/stats/ uses for its daily figures. */
export function last7DaysLabel() {
  const end = new Date()
  const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000)
  const md = { month: 'short', day: 'numeric' }
  return `${manila(start, md)} – ${manila(end, { ...md, year: 'numeric' })}`
}

/** Whole-number % change, or null when there is nothing to compare to
 *  (previous period was 0) — never invent a figure. */
export const pctChange = (now, prev) => (prev > 0 ? Math.round(((now - prev) / prev) * 100) : null)

export const formatDateParts = (iso) => (iso
  ? {
      date: manila(new Date(iso), { year: 'numeric', month: 'short', day: 'numeric' }),
      time: manila(new Date(iso), { hour: '2-digit', minute: '2-digit' }),
    }
  : { date: '—', time: '' })

/** Today → clock time, yesterday → "Yesterday", older → "Sep 19". */
export function formatRelativeDay(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const day = (x) => manila(x, { year: 'numeric', month: '2-digit', day: '2-digit' })
  const today = new Date()
  if (day(d) === day(today)) return manila(d, { hour: '2-digit', minute: '2-digit' })
  if (day(d) === day(new Date(today.getTime() - 24 * 60 * 60 * 1000))) return 'Yesterday'
  return manila(d, { month: 'short', day: 'numeric' })
}

export const violationLabel = (types) => {
  const names = (types || []).map(t => t.violation_type?.name || t.name).filter(Boolean)
  return names.length === 0 ? '—' : names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`
}

/** ₱62,400 (whole pesos) or ₱62,400.50 — no trailing ".00", so big
 *  amounts fit a KPI card. */
export const formatPesoCompact = (amount) => {
  const v = Number(amount || 0)
  return `₱${v.toLocaleString('en-PH', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`
}