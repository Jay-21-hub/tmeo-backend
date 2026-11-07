// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

// ── mocks for the ArchiveManagement wiring tests ───────────────────────
const get = vi.fn()
const post = vi.fn()
const del = vi.fn()
vi.mock('../services/api', () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), delete: (...a) => del(...a), patch: vi.fn() },
}))
const toast = { success: vi.fn(), danger: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../context/useToast', () => ({ useToast: () => toast }))

const downloadSpy = vi.fn()
vi.mock('./archiveExportPdf', async (importActual) => {
  const actual = await importActual()
  return { ...actual, downloadPdf: (...a) => downloadSpy(...a) }
})

import {
  buildArchiveExportPdf, archiveExportFileName, formatPhp, pdfSafe, stampText, generatedParts,
  SUMMARY_COLUMNS, DETAIL_SECTIONS, RECORD_SUMMARY_KEYS, LARGE_EXPORT_RECORDS,
} from './archiveExportPdf'
import ArchiveManagement from '../pages/admin/sections/ArchiveManagement'

// ── synthetic payloads (mirror the backend contract: 36 Full / 41 Archived) ──
const FULL_KEYS = [
  ['id', 'Ticket ID'], ['source', 'Source'], ['violator_name', 'Violator Name'], ['license_number', 'License Number'],
  ['license_status', 'License Status'], ['confiscated_document_type', 'Confiscated Document Type'],
  ['confiscated_document_name', 'Confiscated Document Name'], ['confiscated_document_number', 'Confiscated Document Number'],
  ['plate_number', 'Plate Number'], ['registration_number', 'Registration Number'], ['vehicle_type', 'Vehicle Type'],
  ['vehicle_brand', 'Vehicle Brand'], ['vehicle_model', 'Vehicle Model'], ['vehicle_use', 'Vehicle Use'],
  ['address', 'Address'], ['ovr_number', 'OVR Number'], ['client_offline_id', 'Client Offline Id'],
  ['location', 'Location'], ['date_issued', 'Date Issued'], ['remarks', 'Remarks'], ['penalty_amount', 'Penalty Amount'],
  ['status', 'Status'], ['imported_by', 'Imported By'], ['enforcer_name_snapshot', 'Enforcer Name Snapshot'],
  ['enforcer_role_snapshot', 'Enforcer Role Snapshot'], ['enforcer_id_number_snapshot', 'Enforcer Id Number Snapshot'],
  ['enforcer_badge_snapshot', 'Enforcer Badge Snapshot'], ['enforcer_snapshot_source', 'Enforcer Snapshot Source'],
  ['assessed_at', 'Assessed At'], ['assessment_notes', 'Assessment Notes'], ['is_printed', 'Is Printed'],
  ['created_at', 'Created At'], ['updated_at', 'Updated At'], ['violation_types', 'Violation Type(s)'],
  ['enforcer_name', 'Filed By (Enforcer)'], ['assessed_by_name', 'Assessed By'],
]
const ARCH_EXTRA = [
  ['or_number', 'OR Number'], ['amount_paid', 'Amount Paid'], ['date_paid', 'Date Paid'],
  ['received_by', 'Received By'], ['assessed_by_processed', 'Payment Processed By'], ['archived_at', 'Archived At'],
]
const fullColumns = FULL_KEYS.map(([key, label]) => ({ key, label }))
const archivedColumns = [...FULL_KEYS.filter(([k]) => k !== 'assessed_by_name'), ...ARCH_EXTRA].map(([key, label]) => ({ key, label }))

const META = { generated_at: '2026-10-08T15:42:10.123456+08:00', generated_by: 'Admin Uploader', scope: 'Full Database (Active Records)', year: null }

function record(i, over = {}) {
  const r = {
    id: i, source: 'enforcer_ovr', violator_name: `Violator ${i}`, license_number: `N01-${i}`, license_status: 'Not Confiscated',
    confiscated_document_type: '', confiscated_document_name: '', confiscated_document_number: '',
    plate_number: `ABC ${1000 + i}`, registration_number: '', vehicle_type: 'Car', vehicle_brand: 'Toyota', vehicle_model: 'Vios',
    vehicle_use: 'private', address: 'Barangay 5, Lucena City', ovr_number: `OVR-${i}`, client_offline_id: '', location: 'Perez Park',
    date_issued: '2025-03-04 08:30:00', remarks: '', penalty_amount: 1000, status: 'Paid', imported_by: '',
    enforcer_name_snapshot: 'Enforcer Santos', enforcer_role_snapshot: 'enforcer', enforcer_id_number_snapshot: 'ENF-1',
    enforcer_badge_snapshot: '', enforcer_snapshot_source: 'event', assessed_at: '', assessment_notes: '', is_printed: false,
    created_at: '2025-03-04 08:00:00', updated_at: '2025-03-04 09:00:00', violation_types: 'No Helmet, Illegal Parking',
    enforcer_name: 'Enforcer Santos', assessed_by_name: 'Staff Assessor',
  }
  return { ...r, ...over }
}
function archivedRecord(i, over = {}) {
  const r = record(i)
  delete r.assessed_by_name
  return {
    ...r, or_number: `OR-${i}`, amount_paid: 1000, date_paid: '2025-03-05', received_by: 'Cashier Reyes',
    assessed_by_processed: 'Admin Uploader', archived_at: '2026-10-05 10:15:00', ...over,
  }
}
const payloadFull = (records, extraColumns = []) => ({ columns: [...fullColumns, ...extraColumns], records, meta: { ...META }, record_count: records.length })
const payloadArchived = (records, year = 2025) => ({
  columns: archivedColumns, records, record_count: records.length,
  meta: { ...META, scope: 'Archived Records', year },
})

// 1×1 transparent PNG so the header images exercise the real addImage path.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const IMAGES = { lucena: PIXEL, tmeo: PIXEL, phone: PIXEL, email: PIXEL }
const build = (payload, scope = 'full', opts = {}) => buildArchiveExportPdf(payload, { scope, images: IMAGES, compress: false, ...opts })

// Text-show operators of the (uncompressed) content streams, in order.
const runs = (doc) => [...doc.output().matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1].replace(/\\([()\\])/g, '$1'))
const has = (doc, text) => runs(doc).some((r) => r.includes(text))
const count = (doc, text) => runs(doc).filter((r) => r === text).length

// ── pure helpers ───────────────────────────────────────────────────────
describe('formatPhp', () => {
  it('formats money as PHP 1,234.00', () => {
    expect(formatPhp(1234)).toBe('PHP 1,234.00')
    expect(formatPhp(1234567.5)).toBe('PHP 1,234,567.50')
    expect(formatPhp('500')).toBe('PHP 500.00')
    expect(formatPhp(0.5)).toBe('PHP 0.50')
  })
  it('keeps a true zero as PHP 0.00 and shows Unavailable only when missing', () => {
    expect(formatPhp(0)).toBe('PHP 0.00')
    expect(formatPhp('0')).toBe('PHP 0.00')
    for (const v of [null, undefined, '', '  ', 'abc', NaN]) expect(formatPhp(v)).toBe('Unavailable')
  })
})

describe('pdfSafe', () => {
  it('keeps Filipino/Latin-1 text and common punctuation', () => {
    expect(pdfSafe('Jose Ñañez – Reyes “Jr.”')).toBe('Jose Ñañez – Reyes “Jr.”')
  })
  it('replaces the peso sign, drops control characters and marks unsupported characters', () => {
    expect(pdfSafe('₱500')).toBe('PHP 500')
    expect(pdfSafe('a\u0000b\u0007c')).toBe('abc')
    expect(pdfSafe('日本')).toBe('??')
  })
})

describe('timestamps', () => {
  it('reshapes backend Manila timestamps without timezone drift', () => {
    expect(stampText('2024-06-02 04:00:00')).toBe('2024-06-02 04:00')
    expect(stampText('2024-06-02 04:00:00', { seconds: true })).toBe('2024-06-02 04:00:00')
    expect(stampText('2024-06-05')).toBe('2024-06-05')
    expect(stampText('')).toBe('')
  })
  it('formats the generated stamp in Manila wall-clock time', () => {
    expect(generatedParts('2026-10-08T15:42:10.123+08:00').pretty).toBe('Oct 8, 2026 3:42 PM (Asia/Manila)')
    expect(generatedParts('2026-10-08T00:05:00+08:00').pretty).toBe('Oct 8, 2026 12:05 AM (Asia/Manila)')
    expect(generatedParts('2026-10-08T12:00:00+08:00').pretty).toBe('Oct 8, 2026 12:00 PM (Asia/Manila)')
    expect(generatedParts('nope')).toBeNull()
  })
  it('builds the download file names', () => {
    expect(archiveExportFileName({ scope: 'full', generatedAt: META.generated_at })).toBe('TMEO_Full_Database_2026-10-08_15-42.pdf')
    expect(archiveExportFileName({ scope: 'archived', year: 2025, generatedAt: META.generated_at })).toBe('TMEO_Archived_Records_2025_2026-10-08_15-42.pdf')
    expect(archiveExportFileName({ scope: 'archived', year: null, generatedAt: META.generated_at })).toBe('TMEO_Archived_Records_All_2026-10-08_15-42.pdf')
  })
})

describe('layout contract', () => {
  it('has nine summary columns that fill the 273 mm usable width', () => {
    expect(SUMMARY_COLUMNS.map((c) => c.label)).toEqual(
      ['#', 'Ticket ID', 'OVR No.', 'Date Issued', 'Violator', 'Plate No.', 'Violation Type(s)', 'Penalty', 'Status'],
    )
    expect(SUMMARY_COLUMNS.reduce((a, c) => a + c.w, 0)).toBe(273)
  })
  it('places every one of the 36 / 41 export fields (summary box or a detail section)', () => {
    const covered = new Set([...RECORD_SUMMARY_KEYS, ...DETAIL_SECTIONS.flatMap((g) => g.keys)])
    expect(fullColumns).toHaveLength(36)
    expect(archivedColumns).toHaveLength(41)
    for (const c of fullColumns) expect(covered.has(c.key), c.key).toBe(true)
    for (const c of archivedColumns) expect(covered.has(c.key), c.key).toBe(true)
  })
  it('exposes a sane large-export threshold', () => {
    expect(LARGE_EXPORT_RECORDS).toBeGreaterThan(0)
  })
})

// ── PDF generation ─────────────────────────────────────────────────────
const manyFull = (n) => payloadFull(Array.from({ length: n }, (_, i) => record(i + 1)))

describe('buildArchiveExportPdf — document', () => {
  it('is A4 landscape', async () => {
    const { doc } = await build(payloadFull([record(1)]))
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(297, 1)
    expect(doc.internal.pageSize.getHeight()).toBeCloseTo(210, 1)
  })

  it('prints the official header with the real address, phone and email, and none of the rejected text', async () => {
    const { doc, warnings } = await build(payloadFull([record(1)]))
    expect(warnings).toEqual([])
    expect(has(doc, 'City Government of Lucena')).toBe(true)
    expect(has(doc, 'OFFICE OF THE CITY MAYOR')).toBe(true)
    expect(has(doc, 'Traffic Management and Enforcement Office')).toBe(true)
    expect(has(doc, '2nd Floor, Old City Hall Building, ML Tagarao Street, Barangay 5, Lucena City')).toBe(true)
    expect(has(doc, '0936-956-8050')).toBe(true)
    expect(has(doc, 'tmeslucena@gmail.com')).toBe(true)
    const all = runs(doc).join(' ')
    expect(all).not.toMatch(/Republic of the Philippines/i)
    expect(all).not.toMatch(/Dalahican/i)
    expect(all).not.toMatch(/tmeolucena/i)
    expect((doc.output().match(/\/Subtype \/Image/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  it('embeds each seal once even though every page repeats it', async () => {
    const { doc } = await build(manyFull(30))
    expect(doc.getNumberOfPages()).toBeGreaterThan(10)
    expect((doc.output().match(/\/Subtype \/Image/g) || []).length).toBeLessThanOrEqual(8)
  })

  it('prints the title band and the real generated date/time, user, scope and record count (Full)', async () => {
    const { doc } = await build(payloadFull([record(1), record(2)]))
    expect(has(doc, 'FULL DATABASE EXPORT')).toBe(true)
    expect(has(doc, 'VIOLATION SUMMARY REGISTER')).toBe(true)
    expect(has(doc, 'Oct 8, 2026 3:42 PM (Asia/Manila)')).toBe(true)
    expect(has(doc, 'Admin Uploader')).toBe(true)
    expect(has(doc, 'Full Database (Active Records)')).toBe(true)
    expect(count(doc, '2')).toBeGreaterThanOrEqual(1)
  })

  it('prints the selected archive year, or All Years (Archived)', async () => {
    const one = await build(payloadArchived([archivedRecord(1)], 2025), 'archived')
    expect(has(one.doc, 'ARCHIVED RECORDS EXPORT')).toBe(true)
    expect(has(one.doc, 'Year: 2025')).toBe(true)
    const all = await build(payloadArchived([archivedRecord(1)], null), 'archived')
    expect(has(all.doc, 'All Years')).toBe(true)
  })

  it('numbers every page "Page X of Y" with the true page count', async () => {
    const { doc } = await build(manyFull(60))
    const pages = doc.getNumberOfPages()
    expect(pages).toBeGreaterThan(20)
    const labels = runs(doc).filter((r) => /^Page \d+ of \d+$/.test(r))
    expect(labels).toHaveLength(pages)
    labels.forEach((l, i) => expect(l).toBe(`Page ${i + 1} of ${pages}`))
  })

  it('puts the confidentiality footer and an official header on every page', async () => {
    const { doc } = await build(manyFull(30))
    const pages = doc.getNumberOfPages()
    expect(count(doc, 'CONFIDENTIAL:')).toBe(pages)
    expect(count(doc, 'OFFICE OF THE CITY MAYOR')).toBe(pages)   // full on p1, compact after
  })

  it('handles an empty export without failing', async () => {
    const { doc } = await build(payloadFull([]))
    expect(has(doc, 'No records to export.')).toBe(true)
    expect(doc.getNumberOfPages()).toBe(1)
  })
})

describe('buildArchiveExportPdf — summary register (Part A)', () => {
  it('draws the nine-column heading once on a one-page register (both exports)', async () => {
    for (const [scope, payload] of [['full', manyFull(3)], ['archived', payloadArchived([archivedRecord(1), archivedRecord(2)])]]) {
      const { doc } = await build(payload, scope)
      for (const h of ['#', 'Plate No.', 'Violator']) expect(count(doc, h), `${scope} ${h}`).toBe(1)
      expect(count(doc, 'OR No.')).toBe(0)           // payment data is in the detail cards, not the register
    }
  })

  it('repeats the heading and a "(continued)" title on every register continuation page', async () => {
    const { doc } = await build(manyFull(60))
    const first = count(doc, 'VIOLATION SUMMARY REGISTER')
    const cont = count(doc, 'VIOLATION SUMMARY REGISTER (continued)')
    expect(first).toBe(1)
    expect(cont).toBeGreaterThanOrEqual(2)
    expect(count(doc, '#')).toBe(1 + cont)              // one column heading row per register page
  })

  it('lists every record exactly once, numbered in order, with the closing note', async () => {
    const { doc } = await build(manyFull(30))
    expect(has(doc, 'Note: This is a summary of all records.')).toBe(true)
    const counters = runs(doc).filter((r) => /^Record \d+ of 30$/.test(r))
    expect(counters).toHaveLength(30)
    counters.forEach((c, i) => expect(c).toBe(`Record ${i + 1} of 30`))
    for (let i = 1; i <= 30; i++) expect(count(doc, `OVR-${i}`), `OVR-${i}`).toBe(2)   // summary row + detail box
  })

  it('never truncates a long violation-type list', async () => {
    const types = Array.from({ length: 14 }, (_, i) => `Violation Number ${i + 1} Of Many`).join(', ')
    const { doc } = await build(payloadFull([record(1, { violation_types: types })]))
    const all = runs(doc).join(' ')
    expect(all).toContain('Violation Number 1 Of Many')
    expect(all).toContain('Violation Number 14 Of Many')
  })

  it('shows a restrained status pill plus the status text', async () => {
    const { doc } = await build(payloadFull([record(1, { status: 'Pending' }), record(2, { status: 'Paid' })]))
    expect(has(doc, 'Pending')).toBe(true)
    expect(has(doc, 'Paid')).toBe(true)
  })

  it('formats money as PHP, keeps a true zero and shows Unavailable for a missing amount', async () => {
    const { doc } = await build(payloadFull([
      record(1, { penalty_amount: 1234 }), record(2, { penalty_amount: 0 }), record(3, { penalty_amount: '' }),
    ]))
    expect(has(doc, 'PHP 1,234.00')).toBe(true)
    expect(has(doc, 'PHP 0.00')).toBe(true)
    expect(has(doc, 'Unavailable')).toBe(true)
  })
})

describe('buildArchiveExportPdf — record details (Part B)', () => {
  const FULL_ALL = (over = {}) => record(1, {
    confiscated_document_type: 'umid', confiscated_document_name: 'Sample ID', confiscated_document_number: 'D-77',
    registration_number: 'MV-9', client_offline_id: 'off-123', remarks: 'Short remark.', imported_by: 'Admin Uploader',
    enforcer_badge_snapshot: 'B-9', assessed_at: '2025-03-04 10:00:00', assessment_notes: 'Notes here', is_printed: true, ...over,
  })

  it('starts RECORD DETAILS after the register: one page per record, "Record i of N"', async () => {
    const { doc } = await build(manyFull(3))
    expect(has(doc, 'RECORD DETAILS')).toBe(true)
    expect(count(doc, 'RECORD DETAILS')).toBe(3)
    expect(runs(doc).filter((r) => /^Record \d of 3$/.test(r))).toEqual(['Record 1 of 3', 'Record 2 of 3', 'Record 3 of 3'])
    expect(doc.getNumberOfPages()).toBe(1 + 3)
  })

  it('prints the record summary box and every section card', async () => {
    const { doc } = await build(payloadFull([FULL_ALL()]))
    for (const t of ['VIOLATOR & LICENSE', 'VEHICLE', 'LOCATION & REMARKS', 'ENFORCEMENT', 'ASSESSMENT', 'RECORD DATES']) expect(has(doc, t), t).toBe(true)
    expect(has(doc, 'PAYMENT')).toBe(false)             // no payment fields in the Full export
  })

  it('Full: every populated one of the 36 fields is on the page', async () => {
    const { doc } = await build(payloadFull([FULL_ALL()]))
    const summaryLabels = new Set(['Ticket ID', 'OVR Number', 'Date Issued', 'Penalty Amount', 'Status', 'Violation Type(s)'])
    for (const c of fullColumns) {
      if (summaryLabels.has(c.label)) continue
      expect(has(doc, c.label), c.label).toBe(true)
    }
    for (const v of ['Violator 1', 'N01-1', 'MV-9', 'off-123', 'Short remark.', 'Notes here', 'D-77', 'Staff Assessor']) expect(has(doc, v), v).toBe(true)
  })

  it('Archived: every populated one of the 41 fields is on the page, and nothing about the assessor', async () => {
    const rec = archivedRecord(1, {
      confiscated_document_type: 'umid', confiscated_document_name: 'Sample ID', confiscated_document_number: 'D-77',
      registration_number: 'MV-9', client_offline_id: 'off-123', remarks: 'Short remark.', imported_by: 'Admin Uploader',
      enforcer_badge_snapshot: 'B-9', assessed_at: '2025-03-04 10:00:00', assessment_notes: 'Notes here', is_printed: true,
    })
    const { doc } = await build(payloadArchived([rec]), 'archived')
    const summaryLabels = new Set(['Ticket ID', 'OVR Number', 'Date Issued', 'Penalty Amount', 'Status', 'Violation Type(s)'])
    for (const c of archivedColumns) {
      if (summaryLabels.has(c.label)) continue
      expect(has(doc, c.label), c.label).toBe(true)
    }
    expect(has(doc, 'PAYMENT')).toBe(true)
    expect(has(doc, 'Assessed By')).toBe(false)
    expect(has(doc, 'Staff Assessor')).toBe(false)
  })

  it('Archived: even a payload that wrongly carries assessor fields never prints them', async () => {
    const cols = [...archivedColumns, { key: 'assessed_by_name', label: 'Assessed By' }, { key: 'assessor_name_snapshot', label: 'Assessor Name Snapshot' }]
    const rec = { ...archivedRecord(1), assessed_by_name: 'Secret Assessor', assessor_name_snapshot: 'Secret Snapshot' }
    const { doc } = await build({ columns: cols, records: [rec], meta: { ...META, year: 2025 } }, 'archived')
    const all = runs(doc).join(' ')
    expect(all).not.toContain('Secret Assessor')
    expect(all).not.toContain('Secret Snapshot')
    expect(has(doc, 'Assessed By')).toBe(false)
    expect(has(doc, 'Assessor Name Snapshot')).toBe(false)
    expect(has(doc, 'Payment Processed By')).toBe(true)  // the payment processor is a different, allowed field
    expect(has(doc, 'Admin Uploader')).toBe(true)
  })

  it('Full: still prints the assessor (the lock applies to Archived only)', async () => {
    const { doc } = await build(payloadFull([FULL_ALL({ assessed_by_name: 'Staff Assessor' })]))
    expect(has(doc, 'Assessed By')).toBe(true)
    expect(has(doc, 'Staff Assessor')).toBe(true)
  })

  it('omits genuinely blank detail fields but keeps zero, false and populated values', async () => {
    const extra = [{ key: 'extra_count', label: 'Extra Count' }, { key: 'extra_note', label: 'Extra Note' }]
    const { doc } = await build(payloadFull([{ ...record(1), extra_count: 0, extra_note: null }], extra))
    expect(has(doc, 'Is Printed')).toBe(true)         // false is meaningful
    expect(has(doc, 'No')).toBe(true)
    expect(has(doc, 'Extra Count')).toBe(true)        // 0 is meaningful
    expect(has(doc, '0')).toBe(true)
    expect(has(doc, 'Extra Note')).toBe(false)        // null is blank
    expect(has(doc, 'Client Offline Id')).toBe(false) // '' is blank
    expect(has(doc, 'Imported By')).toBe(false)
    expect(has(doc, 'Registration Number')).toBe(false)
    expect(has(doc, 'License Number')).toBe(true)
  })

  it('with omitBlankDetails off, blank details are still shown (as a dash)', async () => {
    const { doc } = await build(payloadFull([record(1)]), 'full', { omitBlankDetails: false })
    expect(has(doc, 'Client Offline Id')).toBe(true)
  })

  it('a field added to the model later still prints, under "Other Details"', async () => {
    const { doc } = await build(payloadFull([{ ...record(1), vehicle_color: 'Maroon' }], [{ key: 'vehicle_color', label: 'Vehicle Color' }]))
    expect(has(doc, 'OTHER DETAILS')).toBe(true)
    expect(has(doc, 'Vehicle Color')).toBe(true)
    expect(has(doc, 'Maroon')).toBe(true)
  })

  it('archived payment money: amount paid shows PHP; a missing one is simply omitted, a true zero is kept', async () => {
    const a = await build(payloadArchived([archivedRecord(1, { amount_paid: 750 })]), 'archived')
    expect(has(a.doc, 'PHP 750.00')).toBe(true)
    expect(has(a.doc, 'OR-1')).toBe(true)
    expect(has(a.doc, 'Cashier Reyes')).toBe(true)
    const z = await build(payloadArchived([archivedRecord(1, { amount_paid: 0 })]), 'archived')
    expect(has(z.doc, 'Amount Paid')).toBe(true)
    expect(runs(z.doc).filter((r) => r === 'PHP 0.00').length).toBeGreaterThanOrEqual(1)
    const m = await build(payloadArchived([archivedRecord(1, { amount_paid: '', or_number: '' })]), 'archived')
    expect(has(m.doc, 'Amount Paid')).toBe(false)
  })

  it('shows readable source / document labels instead of raw codes', async () => {
    const { doc } = await build(payloadFull([record(1, { source: 'staff_walk_in', confiscated_document_type: 'drivers_license' })]))
    expect(has(doc, 'Staff Walk-in Complaint')).toBe(true)
    expect(has(doc, "Driver's License")).toBe(true)
    expect(has(doc, 'staff_walk_in')).toBe(false)
  })

  it('Archived: does not invent values the snapshot does not hold', async () => {
    const { doc } = await build(payloadArchived([archivedRecord(1, { imported_by: '' })]), 'archived')
    expect(has(doc, 'Imported By')).toBe(false)
  })
})

describe('buildArchiveExportPdf — no lost text, no broken pagination', () => {
  it('prints a very long remark in full across a full-width card and continuation pages', async () => {
    const remark = Array.from({ length: 2500 }, (_, i) => `word${i}`).join(' ') + ' ENDMARK'
    const { doc } = await build(payloadFull([record(1, { remarks: remark })]))
    const all = runs(doc).join(' ')
    expect(all).toContain('word0')
    expect(all).toContain('word1250')
    expect(all).toContain('word2499')
    expect(all).toContain('ENDMARK')
    expect(doc.getNumberOfPages()).toBeGreaterThan(3)
    expect(has(doc, 'REMARKS (CONT.)')).toBe(true)
    expect(has(doc, 'Ticket 1 - Violator 1 (details continued)')).toBe(true)
    expect(has(doc, 'Record 1 of 1 (continued)')).toBe(true)
  })

  it('wraps a medium remark inside its card without a continuation', async () => {
    const { doc } = await build(payloadFull([record(1, { remarks: 'Violator was cooperative. '.repeat(8).trim() })]))
    expect(runs(doc).some((r) => r.includes('(continued)'))).toBe(false)
    expect(doc.getNumberOfPages()).toBe(2)
  })

  it('breaks a single over-long unbroken token instead of letting it run out of its cell', async () => {
    const token = 'X'.repeat(200)
    const { doc } = await build(payloadFull([record(1, { violator_name: token, location: token })]))
    const letters = runs(doc).filter((r) => /^X+$/.test(r))
    expect(letters.length).toBeGreaterThan(4)
    expect(letters.join('').length).toBeGreaterThanOrEqual(600)   // violator (summary + detail) + location (detail), 200 chars each
  })

  it('keeps an ordinary record on one page (no spill for a normally populated record)', async () => {
    const { doc } = await build(manyFull(20))
    expect(runs(doc).some((r) => r.includes('(continued)') && r.startsWith('Record'))).toBe(false)
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(21)
  })

  it('keeps a fully populated record (all 36 Full / 41 Archived fields) on a single detail page', async () => {
    const populated = {
      confiscated_document_type: 'umid', confiscated_document_name: 'Sample ID', confiscated_document_number: 'D-77',
      registration_number: 'MV-9', client_offline_id: 'off-123', remarks: 'Short remark.', imported_by: 'Admin Uploader',
      enforcer_badge_snapshot: 'B-9', assessed_at: '2025-03-04 10:00:00', assessment_notes: 'Notes here', is_printed: true,
    }
    const full = await build(payloadFull([record(1, populated)]))
    expect(full.doc.getNumberOfPages()).toBe(2)                 // summary + one detail page
    const arch = await build(payloadArchived([archivedRecord(1, populated)]), 'archived')
    expect(arch.doc.getNumberOfPages()).toBe(2)
    expect(runs(arch.doc).some((r) => r.includes('(continued)') && r.startsWith('Record'))).toBe(false)
    // balanced columns keep the cards in reading order: Violator & License is drawn first
    const titles = runs(arch.doc).filter((r) => ['VIOLATOR & LICENSE', 'VEHICLE', 'PAYMENT', 'RECORD DATES'].includes(r))
    expect(titles[0]).toBe('VIOLATOR & LICENSE')
  })

  it('survives text outside the PDF font (marks it, does not corrupt the file)', async () => {
    const { doc } = await build(payloadFull([record(1, { remarks: 'Tagalog: kailangan ng \u20B1 \u65E5\u672C sign' })]))
    expect(has(doc, 'PHP')).toBe(true)
    expect(doc.output().startsWith('%PDF-')).toBe(true)
  })

  it('still builds, with a warning, when a header image cannot be loaded', async () => {
    const { doc, warnings } = await buildArchiveExportPdf(payloadFull([record(1)]), {
      scope: 'full', compress: false, images: { lucena: 'http://127.0.0.1:9/missing.png', tmeo: PIXEL, phone: PIXEL, email: PIXEL },
    })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toMatch(/lucena/)
    expect(doc.getNumberOfPages()).toBe(2)
  })
})

// ── ArchiveManagement wiring ───────────────────────────────────────────
const URLS = {
  overview: '/api/database/archive/overview/',
  years: '/api/database/archive/years/',
  fields: '/api/database/export/fields/',
  archFields: '/api/database/archive/export/fields/',
  fullPdf: '/api/database/export/full/pdf-data/',
  archPdf: '/api/database/archive/export/pdf-data/',
}

function mockApi({ activeCount = 12, archivedCount = 7, fullPdf, archPdf } = {}) {
  get.mockImplementation((url, cfg) => {
    if (url === URLS.overview) return Promise.resolve({ data: { active_count: 0, eligible_count: 0, in_progress_count: 0, year_breakdown: [], already_archived_count: archivedCount, delete_enabled: false } })
    if (url === URLS.years) return Promise.resolve({ data: { years: [2025, 2024] } })
    if (url === URLS.fields) return Promise.resolve({ data: { field_count: 36, labels: [], active_record_count: activeCount } })
    if (url === URLS.archFields) return Promise.resolve({ data: { field_count: 41, labels: [], archived_record_count: archivedCount, year: null } })
    if (url === URLS.fullPdf) return fullPdf ? fullPdf() : Promise.resolve({ data: payloadFull([record(1)]) })
    if (url === URLS.archPdf) {
      const year = cfg?.params?.year ? Number(cfg.params.year) : null
      return archPdf ? archPdf() : Promise.resolve({ data: payloadArchived([archivedRecord(1)], year) })
    }
    return Promise.resolve({ data: {} })
  })
}

async function openExportTab() {
  render(createElement(ArchiveManagement))
  fireEvent.click(await screen.findByRole('button', { name: /^Export$/ }))
  await screen.findByText('Full Database Export')
  await waitFor(() => expect(screen.getByText(/Will export 12 record\(s\) across 36 fields\./)).toBeTruthy())
}

const exportCalls = (url) => get.mock.calls.filter(([u]) => u === url)

beforeEach(() => {
  get.mockReset(); post.mockReset(); del.mockReset(); downloadSpy.mockReset()
  Object.values(toast).forEach((f) => f.mockReset())
  mockApi()
})
afterEach(() => { cleanup(); document.body.style.overflow = '' })

describe('ArchiveManagement — PDF export wiring', () => {
  it('shows PDF (not Excel) on the Export tab and in both confirmation modals', async () => {
    await openExportTab()
    const text = document.body.textContent
    expect(text).toMatch(/as a PDF file/)
    expect(text).not.toMatch(/Excel|\.xlsx/i)

    fireEvent.click(screen.getByRole('button', { name: /Export Full Database/ }))
    await screen.findByText('Export Full Database (Active Records)')
    expect(screen.getByText('PDF (A4 landscape)')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Excel|\.xlsx/i)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    fireEvent.click(screen.getByRole('button', { name: /Export Archived Records/ }))
    await screen.findByText('Export Archived Records', { selector: '.confirm-heading-title' })
    expect(screen.getByText('PDF (A4 landscape)')).toBeTruthy()
  })

  it('keeps the privacy reminder in the modal', async () => {
    await openExportTab()
    fireEvent.click(screen.getByRole('button', { name: /Export Full Database/ }))
    await screen.findByText(/including personal information/)
    expect(screen.getByText(/Make sure to store and handle the file securely/)).toBeTruthy()
    expect(screen.getByText(/Nothing in the system will be modified/)).toBeTruthy()
  })

  it('starts nothing until the Admin confirms, and nothing at all on Cancel', async () => {
    await openExportTab()
    fireEvent.click(screen.getByRole('button', { name: /Export Full Database/ }))
    await screen.findByText('PDF (A4 landscape)')
    expect(exportCalls(URLS.fullPdf)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('PDF (A4 landscape)')).toBeNull())
    expect(exportCalls(URLS.fullPdf)).toHaveLength(0)
    expect(downloadSpy).not.toHaveBeenCalled()
  })

  it('Full export: one pdf-data request, then a PDF download with the right name', async () => {
    await openExportTab()
    fireEvent.click(screen.getByRole('button', { name: /Export Full Database/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Download Export' }))
    await waitFor(() => expect(downloadSpy).toHaveBeenCalledTimes(1))
    expect(exportCalls(URLS.fullPdf)).toHaveLength(1)
    const [doc, filename] = downloadSpy.mock.calls[0]
    expect(filename).toBe('TMEO_Full_Database_2026-10-08_15-42.pdf')
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1)
    expect(toast.success).toHaveBeenCalledWith('Full database export (PDF) downloaded.')
  })

  it('Archived export: All Years sends no year, a selected year sends it', async () => {
    await openExportTab()
    fireEvent.click(screen.getByRole('button', { name: /Export Archived Records/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Download Export' }))
    await waitFor(() => expect(downloadSpy).toHaveBeenCalledTimes(1))
    expect(exportCalls(URLS.archPdf)[0][1]).toEqual({ params: {} })
    expect(downloadSpy.mock.calls[0][1]).toBe('TMEO_Archived_Records_All_2026-10-08_15-42.pdf')

    fireEvent.change(screen.getByDisplayValue('All Years'), { target: { value: '2025' } })
    await waitFor(() => expect(screen.getByText('Year 2025 only')).toBeTruthy())
    await waitFor(() => expect(screen.getByRole('button', { name: /Export Archived Records/ }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: /Export Archived Records/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Download Export' }))
    await waitFor(() => expect(downloadSpy).toHaveBeenCalledTimes(2))
    expect(exportCalls(URLS.archPdf)[1][1]).toEqual({ params: { year: '2025' } })
  })

  it('prevents duplicate requests: both export buttons are locked while one export runs', async () => {
    let release
    mockApi({ fullPdf: () => new Promise((res) => { release = () => res({ data: payloadFull([record(1)]) }) }) })
    await openExportTab()
    fireEvent.click(screen.getByRole('button', { name: /Export Full Database/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Download Export' }))
    await waitFor(() => expect(exportCalls(URLS.fullPdf)).toHaveLength(1))

    expect(screen.getByRole('button', { name: /Exporting/ }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /Export Archived Records/ }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Exporting/ }))
    fireEvent.click(screen.getByRole('button', { name: /Export Archived Records/ }))
    expect(screen.queryByText('PDF (A4 landscape)')).toBeNull()
    expect(exportCalls(URLS.fullPdf)).toHaveLength(1)
    expect(exportCalls(URLS.archPdf)).toHaveLength(0)

    release()
    await waitFor(() => expect(downloadSpy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: /Export Archived Records/ }).disabled).toBe(false))
  })

  it('reports a failed export and allows a retry', async () => {
    let fail = true
    mockApi({
      fullPdf: () => (fail
        ? Promise.reject({ response: { data: { error: 'Export failed. Please try again.' } } }) // eslint-disable-line prefer-promise-reject-errors
        : Promise.resolve({ data: payloadFull([record(1)]) })),
    })
    await openExportTab()
    fireEvent.click(screen.getByRole('button', { name: /Export Full Database/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Download Export' }))
    await waitFor(() => expect(toast.danger).toHaveBeenCalledWith('Export failed. Please try again.'))
    expect(downloadSpy).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: /Export Full Database/ }).disabled).toBe(false))

    fail = false
    fireEvent.click(screen.getByRole('button', { name: /Export Full Database/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Download Export' }))
    await waitFor(() => expect(downloadSpy).toHaveBeenCalledTimes(1))
  })

  it('never calls the legacy Excel endpoints from the Admin UI', async () => {
    await openExportTab()
    fireEvent.click(screen.getByRole('button', { name: /Export Full Database/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Download Export' }))
    await waitFor(() => expect(downloadSpy).toHaveBeenCalledTimes(1))
    const urls = get.mock.calls.map(([u]) => u)
    expect(urls).not.toContain('/api/database/export/full/')
    expect(urls).not.toContain('/api/database/archive/export/')
    expect(get.mock.calls.some(([, cfg]) => cfg && cfg.responseType === 'blob')).toBe(false)
  })

  it('warns before a large export and offers to cancel (recommends a year for All Years)', async () => {
    mockApi({ archivedCount: LARGE_EXPORT_RECORDS + 500 })
    await openExportTab()
    fireEvent.click(screen.getByRole('button', { name: /Export Archived Records/ }))
    await screen.findByText(/This is a large export/)
    expect(screen.getByText(/select a specific archive year first/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(exportCalls(URLS.archPdf)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText(/This is a large export/)).toBeNull())
    expect(exportCalls(URLS.archPdf)).toHaveLength(0)
  })

  it('does not warn below the threshold', async () => {
    mockApi({ archivedCount: LARGE_EXPORT_RECORDS - 1 })
    await openExportTab()
    fireEvent.click(screen.getByRole('button', { name: /Export Archived Records/ }))
    await screen.findByText('PDF (A4 landscape)')
    expect(screen.queryByText(/This is a large export/)).toBeNull()
  })
})