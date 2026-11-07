import jsPDF from 'jspdf'
import lucenaSealUrl from '../assets/print/client-header-lucena-seal.png'
import tmeoSealUrl from '../assets/print/client-header-tmeo-seal.png'
import phoneIconUrl from '../assets/print/client-header-phone-icon.png'
import emailIconUrl from '../assets/print/client-header-email-icon.png'
import { TMEO_EMAIL, TMEO_PHONE } from '../constants/publicOffice'

/**
 * Archive / Full Database export → PDF  (layout V2).
 *
 *   buildArchiveExportPdf(payload, { scope })  →  Promise<{ doc, warnings }>
 *
 * `payload` is the response of the Admin-only pdf-data endpoints
 *   { columns: [{key,label}], records: [{key: value}], meta: {...} }
 *
 * The document has two parts:
 *   PART A  VIOLATION SUMMARY REGISTER — one readable table row per record
 *           (# · Ticket ID · OVR No. · Date Issued · Violator · Plate No. ·
 *           Violation Type(s) · Penalty · Status), repeating its heading on
 *           every continuation page.
 *   PART B  RECORD DETAILS — one structured page per record: a summary box
 *           (Ticket ID, OVR No., Date Issued, Penalty, Status, Violation
 *           Type(s)) followed by section cards (Violator & License, Vehicle,
 *           Location & Remarks, Enforcement, Payment, Assessment, Record
 *           Dates, Other Details). Long text gets a full-width card.
 *
 * Every field the backend export contract holds (36 Full / 41 Archived) is
 * drawn somewhere; a field without a predefined section lands in "Other
 * Details". Genuinely blank detail values are omitted; 0, false and every
 * populated value are kept.
 *
 * Canonical paper is A4 landscape; printing on another paper size is the PDF
 * viewer's normal "Fit to printable area". Only the existing jsPDF dependency
 * is used. All units are millimetres.
 */

// ── Page geometry ──────────────────────────────────────────────────────
const PAGE_W = 297
const MX = 12
const USABLE_W = PAGE_W - MX * 2                 // 273
const BODY_BOTTOM = 189                        // footer zone starts below
const FOOT_RULE_Y = 191.5

// ── Palette (government navy / blue; every cue also has a text label) ──
const NAVY = [12, 52, 110]
const NAVY_DEEP = [8, 42, 92]
const BLUE = [37, 99, 235]
const BLUE_50 = [239, 246, 255]
const BLUE_100 = [219, 234, 254]
const INK = [15, 23, 42]
const SLATE_700 = [51, 65, 85]
const SLATE_600 = [100, 116, 139]
const SLATE_300 = [203, 213, 225]
const SLATE_200 = [226, 232, 240]
const SLATE_50 = [248, 250, 252]
const WHITE = [255, 255, 255]

const PT = 0.3528                                // pt → mm
const lh = (pt) => pt * PT * 1.32                // line height (mm)
const baseOf = (top, pt) => top + pt * PT * 0.82 // text baseline from a line's top

/**
 * Large-export threshold. Each record gets its own detail page, so a PDF is
 * roughly (records + records/12) pages. Benchmarked — see delivery report.
 * It is a warning, never a block.
 */
export const LARGE_EXPORT_RECORDS = 250

// ── Definitions ────────────────────────────────────────────────────────
// widths in mm; the nine summary columns fill the 273 mm usable width.
export const SUMMARY_COLUMNS = [
  { key: '#',               label: '#',                 w: 9,  align: 'center' },
  { key: 'id',              label: 'Ticket ID',         w: 17 },
  { key: 'ovr_number',      label: 'OVR No.',           w: 33 },
  { key: 'date_issued',     label: 'Date Issued',       w: 30, kind: 'stamp' },
  { key: 'violator_name',   label: 'Violator',          w: 50 },
  { key: 'plate_number',    label: 'Plate No.',         w: 26 },
  { key: 'violation_types', label: 'Violation Type(s)', w: 56 },
  { key: 'penalty_amount',  label: 'Penalty',           w: 27, kind: 'money', align: 'right' },
  { key: 'status',          label: 'Status',            w: 25, kind: 'status', align: 'center' },
]

// Shown in the record summary box at the top of every detail page.
export const RECORD_SUMMARY_KEYS = ['id', 'ovr_number', 'date_issued', 'penalty_amount', 'status', 'violation_types']

// Every other field belongs to one of these sections. A field in none of them
// (e.g. a column added to the model later) still prints, under "Other Details".
export const DETAIL_SECTIONS = [
  { title: 'Violator & License', icon: 'user', keys: ['violator_name', 'license_number', 'license_status', 'confiscated_document_type', 'confiscated_document_name', 'confiscated_document_number', 'address'] },
  { title: 'Vehicle', icon: 'car', keys: ['plate_number', 'registration_number', 'vehicle_type', 'vehicle_brand', 'vehicle_model', 'vehicle_use'] },
  { title: 'Location & Remarks', icon: 'pin', keys: ['location', 'remarks'] },
  { title: 'Enforcement', icon: 'shield', keys: ['source', 'enforcer_name', 'enforcer_name_snapshot', 'enforcer_role_snapshot', 'enforcer_id_number_snapshot', 'enforcer_badge_snapshot', 'enforcer_snapshot_source', 'imported_by', 'client_offline_id'] },
  { title: 'Payment', icon: 'card', keys: ['or_number', 'amount_paid', 'date_paid', 'received_by', 'assessed_by_processed'] },
  { title: 'Assessment', icon: 'doc', keys: ['assessed_by_name', 'assessed_at', 'assessment_notes', 'is_printed'] },
  { title: 'Record Dates', icon: 'clock', keys: ['created_at', 'updated_at', 'archived_at'] },
]
const OTHER_SECTION = { title: 'Other Details', icon: 'grid' }

/**
 * Archived exports must never show the assessor. The backend already omits
 * "Assessed By"; this is a second lock so no fallback ("Other Details") or
 * future snapshot key can reintroduce it. `assessed_by_processed` (the
 * payment processor) and `assessed_at` are different, allowed fields.
 */
const ARCHIVED_BLOCKED = /^(assessed_by(?!_processed)|assessor)/

const MONEY_KEYS = new Set(['penalty_amount', 'amount_paid'])
const STAMP_KEYS = new Set(['date_issued', 'assessed_at', 'created_at', 'updated_at', 'archived_at', 'date_paid'])

// ── Value formatting ───────────────────────────────────────────────────
const SOURCE_LABELS = {
  enforcer_ovr: 'Enforcer-Issued OVR',
  staff_walk_in: 'Staff Walk-in Complaint',
  imported: 'Admin Excel Import',
}
const DOC_LABELS = {
  drivers_license: "Driver's License", bir: 'BIR-related ID/document', umid: 'UMID',
  company_id: 'Company ID', philhealth: 'PhilHealth ID', others: 'Others',
}
const CODE_KEYS = new Set(['enforcer_role_snapshot', 'enforcer_snapshot_source', 'vehicle_use'])

export const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

/** Standard PDF fonts are WinAnsi (Latin-1 + cp1252 punctuation). Anything
 *  outside it would corrupt the stream, so it is replaced by '?' — visibly,
 *  never silently dropped. Peso sign becomes "PHP". */
const CP1252_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'])
export function pdfSafe(value) {
  const s = String(value)
    .normalize('NFC')
    .replace(/\u20B1/g, 'PHP ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\t/g, ' ')
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (ch === '\n' || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || CP1252_EXTRA.has(ch)) out += ch
    else if (c < 32 || c === 127) continue
    else out += '?'
  }
  return out
}

/** PHP 1,234.00 — a true zero is PHP 0.00; a missing amount is "Unavailable". */
export function formatPhp(value) {
  if (isBlank(value)) return 'Unavailable'
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''))
  if (!Number.isFinite(n)) return 'Unavailable'
  const [int, dec] = Math.abs(n).toFixed(2).split('.')
  return `${n < 0 ? '-' : ''}PHP ${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`
}

const titleCaseCode = (s) => s.replace(/_/g, ' ').replace(/\b[a-z]/g, (m) => m.toUpperCase())

/** Backend timestamps are already Asia/Manila 'YYYY-MM-DD HH:MM:SS' strings —
 *  they are reshaped, never re-parsed through Date (no timezone drift). */
export function stampText(value, { seconds = false } = {}) {
  if (isBlank(value)) return ''
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?/)
  if (!m) return String(value)
  if (!m[2]) return m[1]
  return `${m[1]} ${m[2]}${seconds && m[3] ? `:${m[3]}` : ''}`
}

function detailText(key, value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (MONEY_KEYS.has(key)) return formatPhp(value)
  if (key === 'source') return SOURCE_LABELS[value] || String(value)
  if (key === 'confiscated_document_type') return DOC_LABELS[value] || String(value)
  if (CODE_KEYS.has(key) && typeof value === 'string' && /^[a-z]+(_[a-z]+)*$/.test(value)) return titleCaseCode(value)
  if (STAMP_KEYS.has(key)) return stampText(value, { seconds: true })
  return String(value)
}


/** Restrained status colour — the status text is always printed too. */
function statusStyle(text) {
  const t = String(text ?? '').trim().toLowerCase()

  // Only fully paid records should receive the green status indicator.
  if (t === 'paid' || t === 'fully paid') {
    return { fill: [220, 252, 231], ink: [22, 101, 52] }
  }

  if (
    t.includes('unpaid') ||
    t.includes('not paid') ||
    t.includes('partially paid') ||
    t.includes('pending') ||
    t.includes('review')
  ) {
    return { fill: [254, 243, 199], ink: [146, 64, 14] }
  }

  if (t.includes('approved') || t.includes('assessed')) {
    return { fill: [219, 234, 254], ink: [30, 64, 175] }
  }

  if (
    t.includes('reject') ||
    t.includes('dismiss') ||
    t.includes('cancel') ||
    t.includes('void')
  ) {
    return { fill: [254, 226, 226], ink: [153, 27, 27] }
  }

  return { fill: [241, 245, 249], ink: [51, 65, 85] }
}


// ── Text measuring / wrapping ──────────────────────────────────────────
function setFont(doc, size, style = 'normal', family = 'helvetica') {
  doc.setFont(family, style)
  doc.setFontSize(size)
}

/** Greedy word wrap that also breaks a single over-long token by character,
 *  so no text can ever run out of its cell. */
function wrapText(doc, text, width) {
  const out = []
  for (const para of pdfSafe(text).split('\n')) {
    if (para === '') { out.push(''); continue }
    let line = ''
    for (const word of para.split(/ +/)) {
      const trial = line ? `${line} ${word}` : word
      if (doc.getTextWidth(trial) <= width) { line = trial; continue }
      if (line) { out.push(line); line = '' }
      if (doc.getTextWidth(word) <= width) { line = word; continue }
      let chunk = ''
      for (const ch of word) {
        if (doc.getTextWidth(chunk + ch) > width && chunk) { out.push(chunk); chunk = ch } else chunk += ch
      }
      line = chunk
    }
    out.push(line)
  }
  return out.length ? out : ['']
}

// ── Image loading (seals / icons) ──────────────────────────────────────
async function loadDataUrl(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}

async function loadHeaderImages(provided, warnings) {
  const sources = provided || {
    lucena: lucenaSealUrl, tmeo: tmeoSealUrl, phone: phoneIconUrl, email: emailIconUrl,
  }
  const images = {}
  await Promise.all(Object.entries(sources).map(async ([name, src]) => {
    if (!src) return
    try {
      images[name] = src.startsWith('data:') ? src : await loadDataUrl(src)
    } catch {
      warnings.push(`The ${name} header image could not be loaded; the PDF was generated without it.`)
    }
  }))
  return images
}

/** Fit an image inside a square box without stretching. The alias makes jsPDF
 *  embed each seal once, however many pages repeat it. */
function placeImage(doc, images, name, x, y, box) {
  const dataUrl = images[name]
  if (!dataUrl) return
  // Decoding a PNG header is slow; do it once per image, not once per page.
  const cache = (images.__props ||= {})
  const props = (cache[name] ||= doc.getImageProperties(dataUrl))
  const ratio = Math.min(box / props.width, box / props.height)
  const w = props.width * ratio
  const h = props.height * ratio
  doc.addImage(dataUrl, props.fileType || 'PNG', x + (box - w) / 2, y + (box - h) / 2, w, h, `tmeo-${name}`, 'FAST')
}

// ── Tiny vector icons (no image assets needed) ─────────────────────────
function drawIcon(doc, name, x, y, s, color) {
  doc.setDrawColor(...color); doc.setFillColor(...color); doc.setLineWidth(0.35)
  const c = s / 2
  switch (name) {
    case 'user':
      doc.circle(x + c, y + s * 0.32, s * 0.19, 'F')
      doc.roundedRect(x + s * 0.2, y + s * 0.58, s * 0.6, s * 0.34, s * 0.14, s * 0.14, 'F')
      break
    case 'car':
      doc.roundedRect(x + s * 0.06, y + s * 0.34, s * 0.88, s * 0.34, s * 0.1, s * 0.1, 'F')
      doc.roundedRect(x + s * 0.22, y + s * 0.14, s * 0.56, s * 0.28, s * 0.1, s * 0.1, 'F')
      doc.setFillColor(...WHITE)
      doc.circle(x + s * 0.28, y + s * 0.72, s * 0.12, 'F'); doc.circle(x + s * 0.72, y + s * 0.72, s * 0.12, 'F')
      doc.setFillColor(...color)
      doc.circle(x + s * 0.28, y + s * 0.72, s * 0.075, 'F'); doc.circle(x + s * 0.72, y + s * 0.72, s * 0.075, 'F')
      break
    case 'pin':
      doc.circle(x + c, y + s * 0.38, s * 0.28, 'F')
      doc.lines([[s * 0.2, s * 0.3], [-s * 0.4, 0]], x + c - s * 0.2, y + s * 0.5, [1, 1], 'F', true)
      doc.setFillColor(...WHITE); doc.circle(x + c, y + s * 0.38, s * 0.1, 'F')
      break
    case 'shield':
      doc.lines([[s * 0.34, s * 0.12], [0, s * 0.32], [-s * 0.34, s * 0.34], [-s * 0.34, -s * 0.34], [0, -s * 0.32]], x + c - s * 0.34, y + s * 0.08, [1, 1], 'F', true)
      break
    case 'card':
      doc.roundedRect(x + s * 0.04, y + s * 0.2, s * 0.92, s * 0.6, s * 0.1, s * 0.1, 'F')
      doc.setFillColor(...WHITE); doc.rect(x + s * 0.04, y + s * 0.34, s * 0.92, s * 0.12, 'F')
      break
    case 'doc':
      doc.roundedRect(x + s * 0.18, y + s * 0.06, s * 0.64, s * 0.88, s * 0.08, s * 0.08, 'F')
      doc.setDrawColor(...WHITE); doc.setLineWidth(0.3)
      doc.line(x + s * 0.3, y + s * 0.34, x + s * 0.7, y + s * 0.34)
      doc.line(x + s * 0.3, y + s * 0.52, x + s * 0.7, y + s * 0.52)
      doc.line(x + s * 0.3, y + s * 0.7, x + s * 0.58, y + s * 0.7)
      break
    case 'clock':
      doc.circle(x + c, y + c, s * 0.44, 'S')
      doc.line(x + c, y + c, x + c, y + s * 0.2); doc.line(x + c, y + c, x + s * 0.7, y + c)
      break
    case 'calendar':
      doc.roundedRect(x + s * 0.08, y + s * 0.16, s * 0.84, s * 0.74, s * 0.1, s * 0.1, 'S')
      doc.rect(x + s * 0.08, y + s * 0.16, s * 0.84, s * 0.22, 'F')
      doc.rect(x + s * 0.28, y + s * 0.5, s * 0.14, s * 0.14, 'F'); doc.rect(x + s * 0.56, y + s * 0.5, s * 0.14, s * 0.14, 'F')
      break
    case 'database':
      for (let i = 0; i < 3; i++) doc.ellipse(x + c, y + s * (0.26 + i * 0.24), s * 0.38, s * 0.13, i === 0 ? 'F' : 'S')
      break
    case 'grid':
      for (const [dx, dy] of [[0.1, 0.1], [0.55, 0.1], [0.1, 0.55], [0.55, 0.55]]) doc.roundedRect(x + s * dx, y + s * dy, s * 0.35, s * 0.35, s * 0.06, s * 0.06, 'F')
      break
    default:
      break
  }
}

// ── Date / name helpers for the header and file name ───────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The backend's generated_at is an ISO string already carrying +08:00.
 *  Reshape it without a Date round-trip so the wall clock is Manila's. */
export function generatedParts(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  if (!m) return null
  const [, y, mo, d, hh, mm] = m
  const h12 = ((Number(hh) + 11) % 12) + 1
  return {
    date: `${y}-${mo}-${d}`,
    file: `${y}-${mo}-${d}_${hh}-${mm}`,
    pretty: `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y} ${h12}:${mm} ${Number(hh) < 12 ? 'AM' : 'PM'} (Asia/Manila)`,
  }
}

export function archiveExportFileName({ scope, year, generatedAt }) {
  const parts = generatedParts(generatedAt)
  const stamp = parts ? parts.file : 'export'
  if (scope === 'archived') return `TMEO_Archived_Records_${year || 'All'}_${stamp}.pdf`
  return `TMEO_Full_Database_${stamp}.pdf`
}

// ═════════════════════════════════════════════════════════════════════
//  PAGE FURNITURE
// ═════════════════════════════════════════════════════════════════════

/** Full official header (first page). Returns the y below it. */
function drawOfficialHeader(doc, images) {
  const seal = 20
  const top = 7
  placeImage(doc, images, 'lucena', MX, top, seal)
  placeImage(doc, images, 'tmeo', PAGE_W - MX - seal, top, seal)

  const cx = PAGE_W / 2
  doc.setTextColor(...INK)
  setFont(doc, 11, 'italic', 'times')
  doc.text('City Government of Lucena', cx, top + 4.4, { align: 'center' })
  setFont(doc, 12.5, 'bold', 'times')
  doc.text('OFFICE OF THE CITY MAYOR', cx, top + 9.2, { align: 'center' })
  setFont(doc, 11.5, 'normal', 'times')
  doc.text('Traffic Management and Enforcement Office', cx, top + 13.8, { align: 'center' })
  setFont(doc, 7.6, 'normal', 'helvetica')
  doc.text('2nd Floor, Old City Hall Building, ML Tagarao Street, Barangay 5, Lucena City', cx, top + 17.6, { align: 'center' })

  // phone + email line, icon left of each text
  setFont(doc, 7.6, 'normal', 'helvetica')
  const icon = 3.1
  const gap = 9
  const wPhone = doc.getTextWidth(TMEO_PHONE)
  const wEmail = doc.getTextWidth(TMEO_EMAIL)
  const total = (images.phone ? icon + 1 : 0) + wPhone + gap + (images.email ? icon + 1 : 0) + wEmail
  let x = cx - total / 2
  const baseline = top + 21.4
  if (images.phone) { placeImage(doc, images, 'phone', x, baseline - 2.5, icon); x += icon + 1 }
  doc.text(TMEO_PHONE, x, baseline); x += wPhone + gap
  if (images.email) { placeImage(doc, images, 'email', x, baseline - 2.5, icon); x += icon + 1 }
  doc.text(TMEO_EMAIL, x, baseline)

  return top + seal + 1.5
}

/** Compact official header (continuation pages). Returns the y below it. */
function drawCompactHeader(doc, images) {
  const seal = 11
  const top = 6
  placeImage(doc, images, 'lucena', MX, top, seal)
  placeImage(doc, images, 'tmeo', PAGE_W - MX - seal, top, seal)
  const cx = PAGE_W / 2
  doc.setTextColor(...INK)
  setFont(doc, 8.6, 'italic', 'times')
  doc.text('City Government of Lucena', cx, top + 3.2, { align: 'center' })
  setFont(doc, 9.6, 'bold', 'times')
  doc.text('OFFICE OF THE CITY MAYOR', cx, top + 6.8, { align: 'center' })
  setFont(doc, 9, 'normal', 'times')
  doc.text('Traffic Management and Enforcement Office', cx, top + 10.2, { align: 'center' })
  doc.setDrawColor(...NAVY); doc.setLineWidth(0.4)
  doc.line(MX, top + seal + 1, PAGE_W - MX, top + seal + 1)
  return top + seal + 1
}

/** Navy title band; optional right-hand text lines (record counter etc.). */
function drawTitleBand(doc, y, h, title, subtitle, rightTop, rightBottom) {
  const big = h > 14
  doc.setFillColor(...NAVY_DEEP)
  doc.roundedRect(MX, y, USABLE_W, h, 1.6, 1.6, 'F')
  doc.setTextColor(...WHITE)
  setFont(doc, big ? 19 : 14, 'bold')
  doc.text(title, MX + 5, y + (big ? 8.2 : 6.2))
  setFont(doc, big ? 9.6 : 8, 'normal')
  doc.text(subtitle, MX + 5, y + (big ? 13.6 : 9.7))
  if (rightTop) {
    setFont(doc, big ? 13 : 11, 'bold')
    doc.text(rightTop, PAGE_W - MX - 5, y + (big ? 7.6 : 5.8), { align: 'right' })
  }
  if (rightBottom) {
    setFont(doc, big ? 9.6 : 8.6, 'bold')
    doc.text(rightBottom, PAGE_W - MX - 5, y + (big ? 13.2 : 9.8), { align: 'right' })
  }
  return y + h
}

/** Light-blue export metadata box: Generated · Generated By · Scope · Total. */
function drawMetaBox(doc, y, { generated, generatedBy, scopeLines, total }) {
  const h = 17
  doc.setFillColor(...BLUE_50); doc.setDrawColor(...BLUE_100); doc.setLineWidth(0.3)
  doc.roundedRect(MX, y, USABLE_W, h, 1.6, 1.6, 'FD')
  setFont(doc, 8.6, 'normal')
  const cells = [
    { icon: 'calendar', label: 'Generated', lines: wrapText(doc, generated, 52) },
    { icon: 'user', label: 'Generated By', lines: wrapText(doc, generatedBy, 52) },
    { icon: 'database', label: 'Scope', lines: scopeLines },
    { icon: 'doc', label: 'Total Records', big: total },
  ]
  const w = USABLE_W / cells.length
  cells.forEach((c, i) => {
    const x = MX + i * w
    if (i) { doc.setDrawColor(...BLUE_100); doc.line(x, y + 3, x, y + h - 3) }
    drawIcon(doc, c.icon, x + 4, y + 5.2, 6.4, BLUE)
    const tx = x + 13
    doc.setTextColor(...INK); setFont(doc, 8.4, 'bold')
    doc.text(c.label, tx, y + 5.4)
    if (c.big) {
      setFont(doc, 15, 'bold'); doc.setTextColor(...NAVY)
      doc.text(c.big, tx, y + 12.2)
      const bw = doc.getTextWidth(c.big)
      setFont(doc, 7.6, 'normal'); doc.setTextColor(...SLATE_600)
      doc.text('violation record(s)', tx + bw + 1.8, y + 12.2)
    } else {
      setFont(doc, 8.6, 'normal'); doc.setTextColor(...SLATE_700)
      c.lines.slice(0, 2).forEach((line, li) => doc.text(line, tx, y + 9.6 + li * 3.7))
    }
  })
  return y + h
}

function drawSectionHeading(doc, y, text) {
  const h = 8.4
  doc.setFillColor(...BLUE_100)
  doc.roundedRect(MX, y, USABLE_W, h, 1.4, 1.4, 'F')
  doc.setTextColor(...NAVY); setFont(doc, 11, 'bold')
  doc.text(text, MX + 4, y + 5.8)
  return y + h
}

function drawFooter(doc, { archived, generatedText, generatedBy, page, pages }) {
  doc.setDrawColor(...NAVY); doc.setLineWidth(0.4)
  doc.line(MX, FOOT_RULE_Y, PAGE_W - MX, FOOT_RULE_Y)
  doc.setTextColor(...INK); setFont(doc, 7, 'bold')
  doc.text('CONFIDENTIAL:', MX, FOOT_RULE_Y + 3.8)
  const w = doc.getTextWidth('CONFIDENTIAL: ')
  setFont(doc, 7, 'normal')
  doc.text('Contains personal information of violators and vehicle owners. For authorized TMEO use only; store and handle this file securely.', MX + w, FOOT_RULE_Y + 3.8)
  doc.setTextColor(...SLATE_600); setFont(doc, 7, 'normal')
  doc.text(pdfSafe(`TMEO ${archived ? 'Archived Records' : 'Full Database'} Export  |  Generated ${generatedText} by ${generatedBy}`), MX, FOOT_RULE_Y + 8)
  setFont(doc, 8, 'bold'); doc.setTextColor(...INK)
  doc.text(`Page ${page} of ${pages}`, PAGE_W - MX, FOOT_RULE_Y + 8, { align: 'right' })
}

// ═════════════════════════════════════════════════════════════════════
//  PART A — SUMMARY REGISTER
// ═════════════════════════════════════════════════════════════════════
const S_FS = 8.2
const S_PAD_X = 1.8
const S_PAD_Y = 2.3

function summaryCellText(col, rec, index) {
  if (col.key === '#') return String(index + 1)
  const v = rec[col.key]
  if (col.kind === 'money') return formatPhp(v)
  if (isBlank(v)) return '—'
  if (col.kind === 'stamp') return stampText(v)
  return String(v)
}

function buildSummaryRow(doc, rec, index, cols) {
  let maxLines = 1
  const cells = cols.map((col) => {
    setFont(doc, S_FS, col.kind === 'money' ? 'bold' : 'normal')
    const text = summaryCellText(col, rec, index)
    const lines = col.kind === 'status' ? [text] : wrapText(doc, text, col.w - S_PAD_X * 2)
    maxLines = Math.max(maxLines, lines.length)
    return lines
  })
  return { cells, h: S_PAD_Y * 2 + maxLines * lh(S_FS) + (maxLines === 1 ? 0.6 : 0) }
}

function drawSummaryHead(doc, y, cols) {
  const h = 8
  doc.setFillColor(...NAVY)
  doc.rect(MX, y, USABLE_W, h, 'F')
  doc.setTextColor(...WHITE); setFont(doc, 8, 'bold')
  cols.forEach((c) => {
    const ty = y + 5.3
    if (c.align === 'right') doc.text(c.label, c.x + c.w - S_PAD_X, ty, { align: 'right' })
    else if (c.align === 'center') doc.text(c.label, c.x + c.w / 2, ty, { align: 'center' })
    else doc.text(c.label, c.x + S_PAD_X, ty)
  })
  return y + h
}

function drawStatusPill(doc, text, cx, midY, maxW) {
  const st = statusStyle(text)
  setFont(doc, 7.4, 'bold')
  const label = wrapText(doc, text, maxW - 4)[0]
  const w = Math.min(maxW, doc.getTextWidth(label) + 5)
  const h = 4.8
  doc.setFillColor(...st.fill)
  doc.roundedRect(cx - w / 2, midY - h / 2, w, h, 2.4, 2.4, 'F')
  doc.setTextColor(...st.ink)
  doc.text(label, cx, midY + 1.15, { align: 'center' })
}

function drawSummaryRow(doc, row, y, cols, zebra, rec) {
  if (zebra) { doc.setFillColor(...SLATE_50); doc.rect(MX, y, USABLE_W, row.h, 'F') }
  doc.setDrawColor(...SLATE_200); doc.setLineWidth(0.2)
  doc.line(MX, y + row.h, MX + USABLE_W, y + row.h)
  cols.forEach((c, i) => {
    if (c.kind === 'status') {
      if (isBlank(rec.status)) {
        doc.setTextColor(...INK); setFont(doc, S_FS, 'normal')
        doc.text('—', c.x + c.w / 2, y + row.h / 2 + 1.2, { align: 'center' })
      } else drawStatusPill(doc, String(rec.status), c.x + c.w / 2, y + row.h / 2, c.w - 2)
      return
    }
    setFont(doc, S_FS, c.kind === 'money' ? 'bold' : 'normal')
    doc.setTextColor(...INK)
    const lines = row.cells[i]
    const top = y + (row.h - lines.length * lh(S_FS)) / 2
    lines.forEach((line, li) => {
      const ly = baseOf(top + li * lh(S_FS), S_FS)
      if (c.align === 'right') doc.text(line, c.x + c.w - S_PAD_X, ly, { align: 'right' })
      else if (c.align === 'center') doc.text(line, c.x + c.w / 2, ly, { align: 'center' })
      else doc.text(line, c.x + S_PAD_X, ly)
    })
  })
}

// ═════════════════════════════════════════════════════════════════════
//  PART B — RECORD DETAILS
// ═════════════════════════════════════════════════════════════════════
const GAP = 6
const CARD_W = (USABLE_W - GAP) / 2
const LABEL_W = 47
const D_FS = 8.4
const D_LABEL_FS = 7.8
const D_PAD_X = 2.2
const D_PAD_Y = 0.72
const CARD_HEAD_H = 6.4
const CARD_GAP = 2.4

/** Build the cards for one record. Returns { cards, wide }: `wide` are
 *  full-width text cards for values too long for a two-column row. */
function buildCards(doc, rec, sections, labelOf, omitBlank) {
  const cards = []
  const wide = []
  const valueW = CARD_W - LABEL_W - D_PAD_X * 2
  for (const sec of sections) {
    const rows = []
    for (const key of sec.keys) {
      if (!(key in labelOf)) continue
      const raw = rec[key]
      if (omitBlank && isBlank(raw)) continue
      const text = pdfSafe(isBlank(raw) ? '—' : detailText(key, raw))
      setFont(doc, D_FS, 'normal')
      const vLines = wrapText(doc, text, valueW)
      if (vLines.length > 8) { wide.push({ title: labelOf[key], icon: sec.icon, text }); continue }
      setFont(doc, D_LABEL_FS, 'normal')
      const lLines = wrapText(doc, labelOf[key], LABEL_W - D_PAD_X * 2)
      const n = Math.max(vLines.length, lLines.length)
      rows.push({ lLines, vLines, h: D_PAD_Y * 2 + n * lh(D_FS) })
    }
    if (rows.length) cards.push({ title: sec.title, icon: sec.icon, rows })
  }
  return { cards, wide }
}

const cardHeight = (card) => CARD_HEAD_H + card.rows.reduce((a, r) => a + r.h, 0) + 0.6

/**
 * Assign each card (by height) to the left (0) or right (1) column so the
 * taller column is as short as possible. Cards keep their order inside a
 * column. Returns null when no assignment fits in `room`, or when there are
 * too many cards to search (the caller then flows greedily across pages).
 */
function balanceColumns(heights, room) {
  const n = heights.length
  if (!n || n > 14) return null
  let best = null
  let bestMax = Infinity
  // bit i set = card i goes right; card 0 always stays left (no mirrored layouts)
  for (let mask = 0; mask < (1 << n); mask += 2) {
    const col = [0, 0]
    const cnt = [0, 0]
    for (let i = 0; i < n; i++) {
      const c = (mask >> i) & 1
      col[c] += heights[i] + CARD_GAP
      cnt[c]++
    }
    const tallest = Math.max(col[0] ? col[0] - CARD_GAP : 0, col[1] ? col[1] - CARD_GAP : 0)
    // a strictly shorter result wins; a tie keeps the earlier (more natural) mask
    if (tallest < bestMax - 0.01) { bestMax = tallest; best = mask }
  }
  if (best === null || bestMax > room) return null
  return heights.map((_, i) => (best >> i) & 1)
}

/** A card taller than `limit` is split by rows so it can always be placed. */
function splitCard(card, limit) {
  if (cardHeight(card) <= limit) return [card]
  const parts = []
  let cur = []
  let h = CARD_HEAD_H + 0.6
  for (const r of card.rows) {
    if (cur.length && h + r.h > limit) { parts.push(cur); cur = []; h = CARD_HEAD_H + 0.6 }
    cur.push(r); h += r.h
  }
  if (cur.length) parts.push(cur)
  return parts.map((rows, i) => ({ ...card, title: i ? `${card.title} (cont.)` : card.title, rows }))
}

function drawCardFrame(doc, title, icon, x, y, w, h) {
  doc.setFillColor(...WHITE); doc.setDrawColor(...SLATE_300); doc.setLineWidth(0.25)
  doc.roundedRect(x, y, w, h, 1.4, 1.4, 'FD')
  doc.setFillColor(...BLUE_100)
  doc.roundedRect(x, y, w, CARD_HEAD_H, 1.4, 1.4, 'F')
  doc.rect(x, y + CARD_HEAD_H - 1.6, w, 1.6, 'F')
  drawIcon(doc, icon, x + 2.4, y + (CARD_HEAD_H - 4.8) / 2, 4.8, BLUE)
  doc.setTextColor(...NAVY); setFont(doc, 9.2, 'bold')
  doc.text(title.toUpperCase(), x + 9, y + CARD_HEAD_H / 2 + 1.15)
}

function drawCard(doc, card, x, y) {
  drawCardFrame(doc, card.title, card.icon, x, y, CARD_W, cardHeight(card))
  let ry = y + CARD_HEAD_H
  card.rows.forEach((r, i) => {
    if (i % 2 === 1) { doc.setFillColor(...SLATE_50); doc.rect(x + 0.2, ry, CARD_W - 0.4, r.h, 'F') }
    doc.setDrawColor(...SLATE_200); doc.setLineWidth(0.15)
    doc.line(x + 0.2, ry, x + CARD_W - 0.2, ry)
    doc.line(x + LABEL_W, ry, x + LABEL_W, ry + r.h)
    doc.setTextColor(...SLATE_600); setFont(doc, D_LABEL_FS, 'normal')
    r.lLines.forEach((line, li) => doc.text(line, x + D_PAD_X, baseOf(ry + D_PAD_Y + li * lh(D_FS), D_LABEL_FS) + 0.2))
    doc.setTextColor(...INK); setFont(doc, D_FS, 'normal')
    r.vLines.forEach((line, li) => doc.text(line, x + LABEL_W + D_PAD_X, baseOf(ry + D_PAD_Y + li * lh(D_FS), D_FS)))
    ry += r.h
  })
}

/** Record summary box: Ticket ID · OVR No. · Date Issued · Penalty · Status,
 *  then the violation types on their own wrapped line(s). */
function buildRecordSummary(doc, rec, labelOf) {
  const widths = [40, 72, 54, 52, USABLE_W - 40 - 72 - 54 - 52]
  setFont(doc, 10.5, 'bold')
  const ovrLines = wrapText(doc, isBlank(rec.ovr_number) ? '—' : String(rec.ovr_number), widths[1] - 6)
  const topH = 4.2 + 4.4 + Math.max(1, ovrLines.length) * lh(10.5) + 0.4
  setFont(doc, 10.2, 'bold')
  const typeLines = wrapText(doc, isBlank(rec.violation_types) ? '—' : String(rec.violation_types), USABLE_W - 10)
  const typeH = 5.8 + typeLines.length * lh(10.2) + 1.4
  return { widths, ovrLines, topH, typeLines, h: topH + typeH, typeLabel: labelOf.violation_types || 'Violation Type(s)' }
}

function drawRecordSummary(doc, rs, rec, y) {
  doc.setFillColor(...BLUE_50); doc.setDrawColor(...BLUE_100); doc.setLineWidth(0.3)
  doc.roundedRect(MX, y, USABLE_W, rs.h, 1.8, 1.8, 'FD')
  const labels = ['Ticket ID', 'OVR No.', 'Date Issued', 'Penalty', 'Status']
  let x = MX
  labels.forEach((label, i) => {
    const w = rs.widths[i]
    if (i) { doc.setDrawColor(...BLUE_100); doc.line(x, y + 3, x, y + rs.topH - 2.5) }
    doc.setTextColor(...SLATE_700); setFont(doc, 8, 'bold')
    doc.text(label, x + 4, y + 4.2)
    const vy = y + 4.2 + 5.2
    doc.setTextColor(...INK)
    if (i === 0) {
      setFont(doc, 16, 'bold'); doc.setTextColor(...NAVY)
      doc.text(isBlank(rec.id) ? '—' : pdfSafe(rec.id), x + 4, vy + 1)
    } else if (i === 1) {
      setFont(doc, 10.5, 'bold')
      rs.ovrLines.forEach((line, li) => doc.text(line, x + 4, vy + li * lh(10.5)))
    } else if (i === 2) {
      setFont(doc, 10.5, 'bold')
      doc.text(isBlank(rec.date_issued) ? '—' : stampText(rec.date_issued), x + 4, vy)
    } else if (i === 3) {
      setFont(doc, 10.5, 'bold')
      doc.text(formatPhp(rec.penalty_amount), x + 4, vy)
    } else if (isBlank(rec.status)) {
      setFont(doc, 10.5, 'bold'); doc.text('—', x + 4, vy)
    } else {
      const pw = Math.min(w - 8, 26)
      drawStatusPill(doc, String(rec.status), x + 4 + pw / 2, vy - 1.4, pw)
    }
    x += w
  })
  const ty = y + rs.topH
  doc.setDrawColor(...BLUE_100); doc.line(MX + 3, ty, MX + USABLE_W - 3, ty)
  doc.setTextColor(...SLATE_700); setFont(doc, 8, 'bold')
  doc.text(rs.typeLabel, MX + 4, ty + 4.2)
  doc.setTextColor(...INK); setFont(doc, 10.2, 'bold')
  rs.typeLines.forEach((line, li) => doc.text(line, MX + 4, baseOf(ty + 5.8 + li * lh(10.2), 10.2)))
}

// ═════════════════════════════════════════════════════════════════════
//  MAIN BUILDER
// ═════════════════════════════════════════════════════════════════════
/**
 * @param {object} payload   pdf-data endpoint response
 * @param {object} options
 *   scope             'full' | 'archived'
 *   omitBlankDetails  default true — skip detail fields that are genuinely
 *                     empty (null / '' / whitespace). 0, false and every
 *                     populated value are always kept.
 *   images            optional { lucena, tmeo, phone, email } data URLs/URLs
 *   compress          default true (tests pass false to read the stream)
 */
export async function buildArchiveExportPdf(payload, {
  scope = 'full', omitBlankDetails = true, images: providedImages, compress = true,
} = {}) {
  const warnings = []
  const archived = scope === 'archived'
  const { records = [], meta = {} } = payload || {}
  // Defensive lock: an archived export never prints the assessor.
  const columns = (payload?.columns || []).filter((c) => !(archived && ARCHIVED_BLOCKED.test(c.key)))
  const labelOf = Object.fromEntries(columns.map((c) => [c.key, c.label]))

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress })
  const images = await loadHeaderImages(providedImages, warnings)

  const title = archived ? 'ARCHIVED RECORDS EXPORT' : 'FULL DATABASE EXPORT'
  const subtitle = archived
    ? 'Archived violation records, read from the archive snapshots'
    : 'All active violation records in the current database'
  const gen = generatedParts(meta.generated_at)
  const generatedText = gen ? gen.pretty : '—'
  const generatedBy = pdfSafe(meta.generated_by || '—')
  const total = records.length

  // sections: predefined ones, then "Other Details" for anything unplaced
  const placed = new Set(RECORD_SUMMARY_KEYS)
  const sections = DETAIL_SECTIONS.map((s) => ({ ...s, keys: s.keys.filter((k) => k in labelOf) }))
  sections.forEach((s) => s.keys.forEach((k) => placed.add(k)))
  const otherKeys = columns.map((c) => c.key).filter((k) => !placed.has(k))
  if (otherKeys.length) sections.push({ ...OTHER_SECTION, keys: otherKeys })

  // summary columns with absolute x
  const cols = []
  let cx = MX
  SUMMARY_COLUMNS.forEach((c) => { cols.push({ ...c, x: cx }); cx += c.w })

  setFont(doc, 8.6, 'normal')
  const scopeLines = archived
    ? ['Archived Records', meta.year ? `Year: ${meta.year}` : 'All Years']
    : wrapText(doc, meta.scope || 'Full Database (Active Records)', 62)

  // ── PART A: page 1 ──
  let y = drawOfficialHeader(doc, images) + 2
  y = drawTitleBand(doc, y, 17, title, subtitle) + 3
  y = drawMetaBox(doc, y, { generated: generatedText, generatedBy, scopeLines, total: total.toLocaleString('en-US') }) + 4
  y = drawSectionHeading(doc, y, 'VIOLATION SUMMARY REGISTER') + 1.5
  y = drawSummaryHead(doc, y, cols)

  const summaryNewPage = () => {
    doc.addPage()
    const hy = drawCompactHeader(doc, images)
    const yy = drawSectionHeading(doc, hy + 3, 'VIOLATION SUMMARY REGISTER (continued)') + 1.5
    return drawSummaryHead(doc, yy, cols)
  }

  if (!total) {
    doc.setTextColor(...INK); setFont(doc, 9.5, 'normal')
    doc.text('No records to export.', MX + 3, y + 8)
  }

  const NOTE_H = 7
  records.forEach((rec, i) => {
    const row = buildSummaryRow(doc, rec, i, cols)
    const isLast = i === total - 1
    if (y + row.h + (isLast ? NOTE_H : 0) > BODY_BOTTOM) y = summaryNewPage()
    drawSummaryRow(doc, row, y, cols, i % 2 === 1, rec)
    y += row.h
  })
  if (total) {
    doc.setTextColor(...SLATE_600); setFont(doc, 7.6, 'italic')
    doc.text('Note: This is a summary of all records. Each record\u2019s complete details are shown in the RECORD DETAILS pages that follow.', MX, y + 4.6)
  }

  // ── PART B: record details (one record per page, more if it needs) ──
  const detailNewPage = (index, continued) => {
    doc.addPage()
    const hy = drawCompactHeader(doc, images)
    const by = drawTitleBand(doc, hy + 1.6, 11.6, title, subtitle, 'RECORD DETAILS',
      `Record ${(index + 1).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}${continued ? ' (continued)' : ''}`)
    return by + 2.2
  }
  const cardLimit = 100

  records.forEach((rec, index) => {
    let top = detailNewPage(index, false)
    const rs = buildRecordSummary(doc, rec, labelOf)
    drawRecordSummary(doc, rs, rec, top)
    top += rs.h + CARD_GAP

    const { cards, wide } = buildCards(doc, rec, sections, labelOf, omitBlankDetails)
    const colY = [top, top]
    let pageTop = top
    const continueRecord = () => {
      pageTop = detailNewPage(index, true)
      doc.setFillColor(...BLUE_50)
      doc.roundedRect(MX, pageTop, USABLE_W, 6, 1.2, 1.2, 'F')
      doc.setTextColor(...NAVY); setFont(doc, 8.4, 'bold')
      doc.text(pdfSafe(`Ticket ${isBlank(rec.id) ? '' : rec.id}${isBlank(rec.violator_name) ? '' : ` - ${rec.violator_name}`} (details continued)`), MX + 3, pageTop + 4.2)
      pageTop += 9
      colY[0] = pageTop; colY[1] = pageTop
    }

    // two-column section cards. When every card fits on this page, balance the
    // two columns (shortest tallest-column wins) so a fully populated record
    // stays on one page; otherwise flow greedily and continue on a new page.
    const placeable = cards.flatMap((c) => splitCard(c, cardLimit))
    const plan = balanceColumns(placeable.map(cardHeight), BODY_BOTTOM - top)
    if (plan) {
      placeable.forEach((card, i) => {
        const c = plan[i]
        drawCard(doc, card, MX + c * (CARD_W + GAP), colY[c])
        colY[c] += cardHeight(card) + CARD_GAP
      })
    } else {
      for (const card of placeable) {
        const h = cardHeight(card)
        let c = colY[0] <= colY[1] ? 0 : 1
        if (colY[c] + h > BODY_BOTTOM) {
          if (colY[1 - c] + h <= BODY_BOTTOM) c = 1 - c
          else { continueRecord(); c = 0 }
        }
        drawCard(doc, card, MX + c * (CARD_W + GAP), colY[c])
        colY[c] += h + CARD_GAP
      }
    }

    // full-width text cards (long remarks / notes), flowing across pages
    for (const w of wide) {
      setFont(doc, D_FS, 'normal')
      let lines = wrapText(doc, w.text, USABLE_W - D_PAD_X * 2 - 2)
      let first = true
      while (lines.length) {
        let yy = Math.max(colY[0], colY[1])
        const room = () => Math.floor((BODY_BOTTOM - yy - CARD_HEAD_H - D_PAD_Y * 2 - 1) / lh(D_FS))
        let avail = room()
        if (avail < Math.min(4, lines.length)) { continueRecord(); yy = pageTop; avail = room() }
        const take = lines.slice(0, avail)
        lines = lines.slice(avail)
        const h = CARD_HEAD_H + D_PAD_Y * 2 + take.length * lh(D_FS) + 1
        drawCardFrame(doc, first ? w.title : `${w.title} (cont.)`, w.icon, MX, yy, USABLE_W, h)
        doc.setTextColor(...INK); setFont(doc, D_FS, 'normal')
        take.forEach((line, li) => doc.text(line, MX + D_PAD_X + 1, baseOf(yy + CARD_HEAD_H + D_PAD_Y + li * lh(D_FS), D_FS)))
        colY[0] = yy + h + CARD_GAP; colY[1] = colY[0]
        first = false
        if (lines.length) continueRecord()
      }
    }
  })

  // ── footer pass: after every page exists, so "of Y" is always right ──
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    drawFooter(doc, { archived, generatedText, generatedBy, page: p, pages })
  }

  doc.setProperties({
    title: `TMEO ${archived ? 'Archived Records' : 'Full Database'} Export`,
    subject: meta.scope || title,
    author: 'Traffic Management and Enforcement Office, Lucena City',
    creator: 'TMEO System',
  })
  return { doc, warnings }
}

/** Trigger a browser download of a finished jsPDF document. */
export function downloadPdf(doc, filename) {
  const blob = doc.output('blob')
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}