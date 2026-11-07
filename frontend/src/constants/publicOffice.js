/**
 * publicOffice.js
 *
 * Official TMEO office/contact details used across the public landing
 * pages (About / Contact). These are static public-service facts, not
 * secrets, so they live in source rather than the API.
 *
 * The Facebook page URL below is the official TMEO page link supplied by the client.
 */

export const TMEO_OFFICE_NAME = 'Traffic Management & Enforcement Office'
export const TMEO_OFFICE_CITY = 'Lucena City'

export const TMEO_ADDRESS_LINES = [
  '2nd Floor, Old City Hall Building,',
  'M.L. Tagarao Street, Barangay 5,',
  'Lucena City, Philippines, 4301',
]
export const TMEO_ADDRESS_FULL =
  '2nd Floor, Old City Hall Building, M.L. Tagarao Street, Barangay 5, Lucena City, Philippines, 4301'

export const TMEO_EMAIL = 'tmeslucena@gmail.com'
// Opens a Gmail compose window addressed to TMEO directly (new tab).
export const TMEO_GMAIL_URL = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(TMEO_EMAIL)}`

export const TMEO_FACEBOOK_NAME = 'Lucena Traffic Management and Enforcement Office'
// Official TMEO Facebook page — every Facebook / "Have a Concern?" link opens this directly.
export const TMEO_FACEBOOK_URL = 'https://www.facebook.com/profile.php?id=61575241196065'

// Official TMEO phone number — exactly as printed in the client-supplied
// official header (Header.docx / OfficialTmeoPrintHeader). Display format is
// the client's; TMEO_PHONE_TEL is the digits-only value for tel: links.
export const TMEO_PHONE = '0936-956-8050'
export const TMEO_PHONE_TEL = TMEO_PHONE.replace(/[^\d+]/g, '')

// Google Maps — pinned to a single exact spot. Searching the street address returns a LIST of
// nearby places, so we query the Plus Code of Old Lucena City Hall instead (Google resolves a
// Plus Code + city to one pin). If Google's own share link for the exact TMEO place becomes
// available, set VITE_TMEO_MAPS_URL to it and it takes priority for the "open in Maps" links.
export const TMEO_MAPS_QUERY = 'WJP6+JJJ Lucena City, Quezon'
export const TMEO_MAPS_SEARCH_URL =
  import.meta.env.VITE_TMEO_MAPS_URL ||
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(TMEO_MAPS_QUERY)}`
export const TMEO_MAPS_EMBED_URL =
  `https://www.google.com/maps?q=${encodeURIComponent(TMEO_MAPS_QUERY)}&output=embed`

export const TMEO_MISSION =
  'To ensure safe, orderly, and efficient movement of people and vehicles in Lucena City through consistent enforcement of traffic laws, responsive traffic management, and public education, while upholding professionalism, integrity, and respect for all road users.'

export const TMEO_VISION =
  'A progressive and traffic-disciplined Lucena City where roads are safe, accessible, and efficiently managed, supported by a highly competent, technology-driven, and community-trusted Traffic Management and Enforcement Office.'