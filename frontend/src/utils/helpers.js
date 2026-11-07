export const formatDate = (dateStr) => {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric'
  })
}

export const formatDateTime = (dateStr) => {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

export const formatPeso = (amount) => {
  if (!amount && amount !== 0) return '—'
  return `₱${parseFloat(amount).toLocaleString('en-PH', {
    minimumFractionDigits: 2
  })}`
}

export const getInitials = (name = '') =>
  name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()

// APP_TIMEZONE matches the backend's settings.TIME_ZONE. Never derive
// "today" from toISOString(), which is UTC: between midnight and 8am in
// Lucena that returns YESTERDAY's date, so "Today's Activity" would show
// the wrong day every single morning.
export const APP_TIMEZONE = 'Asia/Manila'

// YYYY-MM-DD for the current date in Manila ('en-CA' formats that way).
export const todayDateString = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())

// Current hour (0-23) in Manila — used for the time-based greeting.
export const manilaHour = () =>
  Number(new Intl.DateTimeFormat('en-PH', {
    timeZone: APP_TIMEZONE, hour: 'numeric', hour12: false,
  }).format(new Date())) % 24

export const todayTimeString = () =>
  new Date().toTimeString().slice(0, 5)

/** Display-only: "HH:MM" or "HH:MM:SS" (24-hour, as the API/DB store it) ->
 * "h:MM AM/PM" with no leading zero on the hour. Returns '' for anything that
 * is not a valid time so callers choose their own fallback. Never use the
 * result for comparisons or calculations -- the canonical value stays 24-hour.
 *   00:00 -> 12:00 AM   12:00 -> 12:00 PM   13:00 -> 1:00 PM   23:45 -> 11:45 PM */
export const formatTime12h = (value) => {
  if (typeof value !== 'string') return ''
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim())
  if (!m) return ''
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return ''
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${m[2]} ${period}`
}

/** Title-cases a name/address string for consistent, professional display —
 * capitalizes the first letter of each word, lowercases the rest. Matches
 * PH government document convention (PSA, PhilID) where surname particles
 * like "Dela Cruz", "De Guzman", "San Jose" are always fully capitalized.
 * Safe to call on already-correct input (idempotent). */
export const toTitleCase = (str = '') => {
  if (!str) return str
  return str.trim().split(/\s+/)
    .map(word => {
      // Preserve initials with a period ("R." stays "R.", not "R.")
      if (/^[A-Za-z]\.$/.test(word)) return word.toUpperCase()
      return word
        .split('-')
        .map(part => part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part)
        .join('-')
    })
    .join(' ')
}

/** Applies toTitleCase() to each comma-separated segment — for combined
 * "Last, First M.I." style strings where you still want every part
 * title-cased independently. */
export const toTitleCaseName = (str = '') =>
  str.split(',').map(part => toTitleCase(part.trim())).join(', ')

// PH mobile numbers: exactly 11 digits, starting with 09 (e.g. 09171234567).
export const PH_PHONE_REGEX = /^09\d{9}$/

export const isValidPHPhone = (value = '') => PH_PHONE_REGEX.test(String(value).replace(/[\s-]/g, ''))