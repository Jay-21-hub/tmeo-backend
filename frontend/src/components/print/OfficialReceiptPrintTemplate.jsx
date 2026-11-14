import { useState, useRef, useLayoutEffect, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X, Printer } from 'lucide-react'
import OfficialTmeoPrintHeader, { OFFICIAL_TMEO_HEADER_CSS } from './OfficialTmeoPrintHeader'
import { waitForPrintImages } from './waitForPrintImages'
import {
  PAPER_SIZES, PAPER_SIZE_ORDER, FIT_TIERS, getPaperSize, paperSizeCssVars,
  fitSheet, loadPaperSize, savePaperSize,
} from './assessmentPaperSizes'

/**
 * OfficialReceiptPrintTemplate
 *
 * Print target for the Assessment Form (UI name: "Print Assessment Form"). The
 * enforcer's OVR is a different document (see OVRPrintTemplate.jsx).
 *
 * VISUAL SOURCE OF TRUTH: the physical "ASSESSMENT FORM" paper (OR.jpg) —
 * Office of the City Mayor / Traffic Enforcement Section, Lucena City.
 * Fields: NAME, ADDRESS, VIOLATION, TYPE OF VEHICLE, Date, Time, Place,
 * PENALTY, O.R. No., Amount Paid, Received by, Date Paid, Assessed by.
 * No License / Plate / OVR number on this form. Header: the client-supplied
 * standard TMEO header (OfficialTmeoPrintHeader.jsx) - the single shared
 * institutional header; this file owns only the document body.
 *
 * PAPER SIZES + ADAPTIVE TWO-COPY LAYOUT
 * The sheet size is selectable: A4, Letter/Short, Legal, Long (exact
 * physical dimensions in assessmentPaperSizes.js). For EVERY size the sheet
 * holds TWO complete copies, each with EVERY official field. Each size has
 * its own margins, column and label widths, gaps and seal size — an adapted
 * layout, not a scaled A4. Long values wrap; nothing is truncated,
 * ellipsized, hidden or clipped (no overflow:hidden on sheet or copies).
 * Before printing, fitSheet() picks the first density tier where both
 * copies fit their half of the sheet: whitespace shrinks first, text size
 * only after that (never below 9 pt); for very long values the side
 * blocks stack under the main fields so long text gets full line width. The on-screen preview and the print
 * target render the same <PrintSheet>, so they cannot drift apart.
 *
 * APPROVED WORKFLOW: "Received by" prints ONLY the Treasury Personnel chosen at
 * Confirm Payment, and is blank when none was chosen (the Staff/Admin account
 * name is never printed there). "O.R. No." always renders; it prints the
 * stored value and is blank when there is none.
 *
 * PRINT TARGET: the printable sheet is portaled to document.body
 * (.or-print-portal) so no ancestor transform (AppShell's page-shell-inner
 * animation) can become the containing block of position:fixed. On screen
 * it is parked off-screen (but laid out, so it can be measured); under
 * @media print everything else is hidden.
 *
 * Printing NEVER changes payment state. This component only exposes an
 * optional onPrinted() callback, fired synchronously when "Print Assessment
 * Form" is clicked, next to window.print(). Callers wire it to the
 * mark-printed audit hook, which records the first print as PRINTED and
 * every later one as REPRINTED — it touches no amount, date or status.
 *
 * Data-shape notes: two call sites build slightly different `ticket` shapes
 * (full_name / place_of_violation / violations string / date + time vs raw
 * violator_name / location / items[] / date_issued). Both are normalized
 * once here.
 *
 * Props:
 *  - ticket: either shape described above
 *  - formatCurrency: fn — same formatter the calling screen uses
 *  - onClose: fn — closes the modal
 *  - onPrinted: optional fn() — see above
 *
 * Used by: Staff Assessment Form (AssessmentDirectPrint, AssessmentTicketModal)
 * and Staff Digital Tickets (DigitalTickets). All three print this same
 * Assessment Form body under the same standard header.
 *
 * Printing waits (waitForPrintImages) until every header image in the print
 * sheet is loaded + decoded, so Print Preview never opens with blank seals.
 */

const FONT_STACK = "Calibri, Carlito, 'Segoe UI', Arial, 'Liberation Sans', sans-serif"
const MM_TO_PX = 96 / 25.4

function getViolationsText(ticket) {
  if (ticket.violations) return ticket.violations
  if (Array.isArray(ticket.items) && ticket.items.length) {
    return ticket.items.map(i => i.violation_type?.name).filter(Boolean).join(', ')
  }
  if (Array.isArray(ticket.violation_types) && ticket.violation_types.length) {
    return ticket.violation_types.map(v => v.name).filter(Boolean).join(', ')
  }
  return ''
}

function formatDateStr(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d)) return String(value).slice(0, 10)
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

// One labelled line. The value wraps (never truncated); the label and colon
// always render, even when the value is blank.
function Field({ label, value, labelWidth, className = '', prefix }) {
  return (
    <div className={`or-row ${className}`} data-field={label}>
      <span className="or-l" style={labelWidth ? { flexBasis: labelWidth } : undefined}>{label}</span>
      <span className="or-c">:</span>
      <span className="or-v">{value || prefix || '\u00A0'}</span>
    </div>
  )
}

// One copy of the form — used twice per sheet, identical. Pure presentation.
function ReceiptCopy({ data }) {
  const {
    violatorName, address, placeOfViolation, violationsText, timeStr,
    dateIssuedStr, penaltyAmount, amountPaid,
    orNumber, datePaidStr, receivedBy, assessedBy, vehicleType,
  } = data

  return (
    <div className="or-copy">
      <OfficialTmeoPrintHeader />

      <p className="or-title">ASSESSMENT FORM</p>


      <div className="or-cols">
        <div className="or-main">
          <Field label="NAME" value={violatorName} />
          <Field label="ADDRESS" value={address} />
          <Field label="VIOLATION" value={violationsText} />
          <Field label="TYPE OF VEHICLE" value={vehicleType} />
        </div>
        <div className="or-side">
          <Field label="Date" value={dateIssuedStr} labelWidth="var(--or-slw)" />
          <Field label="Time" value={timeStr} labelWidth="var(--or-slw)" />
          <Field label="Place" value={placeOfViolation} labelWidth="var(--or-slw)" />
        </div>
      </div>

      <div className="or-cols or-lower">
        <div className="or-main">
          <Field label="PENALTY" value={penaltyAmount} />
          <Field label="O.R. No." value={orNumber} />
          <Field label="Amount Paid" value={amountPaid} prefix="P" />
          <Field label="Received by" value={receivedBy} />
          <Field label="Date Paid" value={datePaidStr} />
        </div>
        <div className="or-side or-assessed">
          <Field label="Assessed by" value={assessedBy} labelWidth="auto" className="or-nowrap-label" />
        </div>
      </div>
    </div>
  )
}

// The whole sheet: margins + copy 1 + cut band + copy 2, sized in mm for the
// selected paper. Used for BOTH the on-screen preview and the print target.
function PrintSheet({ paper, data, sheetRef }) {
  return (
    <div className="or-sheet" ref={sheetRef} style={paperSizeCssVars(paper)} data-paper={paper.id}>
      <ReceiptCopy data={data} />
      <div className="or-cut" aria-hidden="true"><span>✂ cut here</span></div>
      <ReceiptCopy data={data} />
    </div>
  )
}

// Screen-only: shows the real-size sheet scaled to the modal width.
function ScaledPreview({ paper, data, onTier }) {
  const boxRef = useRef(null)
  const sheetRef = useRef(null)
  const [scale, setScale] = useState(1)
  const sheetW = paper.widthMm * MM_TO_PX
  const sheetH = (paper.heightMm - 1) * MM_TO_PX

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return undefined
    const update = () => setScale(Math.min(1, el.clientWidth / sheetW))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [sheetW])

  const dataKey = JSON.stringify(data)
  useLayoutEffect(() => {
    onTier(fitSheet(sheetRef.current))
    let cancelled = false
    document.fonts?.ready?.then(() => { if (!cancelled) onTier(fitSheet(sheetRef.current)) })
    return () => { cancelled = true }
  }, [paper, dataKey, onTier])

  return (
    <div ref={boxRef} style={{ width: '100%' }}>
      <div style={{ width: sheetW * scale, height: sheetH * scale, margin: '0 auto', boxShadow: '0 0 0 1px var(--slate-200)' }}>
        <div style={{ width: sheetW, height: sheetH, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          <PrintSheet paper={paper} data={data} sheetRef={sheetRef} />
        </div>
      </div>
    </div>
  )
}

export default function OfficialReceiptPrintTemplate({ ticket, formatCurrency, onClose, onPrinted }) {
  const t = ticket || {}
  const [paperId, setPaperId] = useState(loadPaperSize)
  const [previewTier, setPreviewTier] = useState(0)
  const portalSheetRef = useRef(null)
  const paper = getPaperSize(paperId)

  const violatorName = t.full_name || t.violator_name || ''
  const address = t.address || ''
  const placeOfViolation = t.place_of_violation || t.location || ''
  const violationsText = getViolationsText(t)

  // AssessmentTicketModal supplies `date` + `time` already split; DigitalTickets'
  // raw Violation shape only has `date_issued` (full ISO timestamp).
  const dateIssuedStr = t.date ? formatDateStr(t.date) : formatDateStr(t.date_issued)
  const issuedAt = !t.time && t.date_issued ? new Date(t.date_issued) : null
  const timeStr = t.time || (issuedAt && !isNaN(issuedAt) ? issuedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '')

  const penaltyAmount = formatCurrency ? formatCurrency(t.penalty_amount) : (t.penalty_amount ?? '')
  const amountPaid = t.amount_paid != null ? (formatCurrency ? formatCurrency(t.amount_paid) : t.amount_paid) : ''

  // Normalized once, shared by BOTH copies and by preview + print target.
  // Received by prints the Treasury Personnel recorded at Confirm Payment;
  // blank when none was chosen. Never the Staff/Admin/assessor.
  const data = useMemo(() => ({
    violatorName, address, placeOfViolation, violationsText, timeStr,
    dateIssuedStr, penaltyAmount: String(penaltyAmount ?? ''), amountPaid: String(amountPaid ?? ''),
    orNumber: t.or_number || '',
    datePaidStr: formatDateStr(t.date_paid),
    receivedBy: t.received_by || '',
    assessedBy: t.assessed_by || t.assessed_by_name || '',
    vehicleType: t.vehicle_type || '',
  }), [violatorName, address, placeOfViolation, violationsText, timeStr, dateIssuedStr,
    penaltyAmount, amountPaid, t.or_number, t.date_paid, t.received_by, t.assessed_by, t.assessed_by_name, t.vehicle_type])

  const dataKey = JSON.stringify(data)

  // Fit the portaled print sheet (kept laid-out off-screen so it can be
  // measured) whenever paper/data change, after fonts load, and right
  // before any print — including Ctrl+P.
  useLayoutEffect(() => {
    fitSheet(portalSheetRef.current)
    let cancelled = false
    document.fonts?.ready?.then(() => { if (!cancelled) fitSheet(portalSheetRef.current) })
    return () => { cancelled = true }
  }, [paperId, dataKey])

  useEffect(() => {
    const refit = () => fitSheet(portalSheetRef.current)
    window.addEventListener('beforeprint', refit)
    return () => window.removeEventListener('beforeprint', refit)
  }, [])

  const handlePaperChange = e => {
    setPaperId(e.target.value)
    savePaperSize(e.target.value)
  }

  // Waits until both seals (and icons) in the print sheet are loaded +
  // decoded, then fits and prints. Cached images resolve immediately.
  const printingRef = useRef(false)
  const aliveRef = useRef(true)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])
  const handlePrintClick = async () => {
    if (printingRef.current) return
    printingRef.current = true
    try {
      await waitForPrintImages(portalSheetRef.current)
      if (!aliveRef.current) return
      fitSheet(portalSheetRef.current)
      onPrinted?.()
      window.print()
    } finally {
      printingRef.current = false
    }
  }

  const reducedFont = FIT_TIERS[previewTier]?.fs < 12

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.() }}>
      <div style={{ background: 'var(--white)', borderRadius: 'var(--radius-xl)', width: '100%', maxWidth: 720, maxHeight: '90vh', overflowY: 'auto', boxShadow: 'var(--shadow-xl)' }}>

        {/* On-screen chrome — hidden on print */}
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--slate-100)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--slate-950)' }}>Assessment Form Print Preview</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--slate-400)', cursor: 'pointer', padding: 4 }} aria-label="Close"><X size={20} /></button>
        </div>

        <div style={{ padding: '12px 24px 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label htmlFor="or-paper-size" style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-600)' }}>Paper size</label>
          <select id="or-paper-size" value={paperId} onChange={handlePaperChange}
            style={{ fontSize: 13, padding: '6px 10px', border: '1px solid var(--slate-200)', borderRadius: 'var(--radius-md)', background: 'var(--white)' }}>
            {PAPER_SIZE_ORDER.map(id => (
              <option key={id} value={id}>{PAPER_SIZES[id].label} — {PAPER_SIZES[id].detail}</option>
            ))}
          </select>
          <span style={{ fontSize: 12, color: 'var(--slate-400)' }}>Two copies per sheet</span>
        </div>
        {reducedFont && (
          <p style={{ margin: '8px 24px 0', fontSize: 12, color: 'var(--warning-600)' }}>
            Long content: text size was reduced so every field still fits on one sheet.
          </p>
        )}

        {/* On-screen PREVIEW (not what is printed — see portal below) */}
        <div style={{ margin: 16 }}>
          <ScaledPreview paper={paper} data={data} onTier={setPreviewTier} />
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--slate-100)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={handlePrintClick}><Printer size={14} /> Print Assessment Form</button>
        </div>
      </div>

      {/* THE print target — direct child of <body>, outside every app
          ancestor. Off-screen + invisible on screen but still laid out so
          fitSheet() can measure it; shown only under @media print. */}
      {createPortal(
        <div className="or-print-portal">
          <PrintSheet paper={paper} data={data} sheetRef={portalSheetRef} />
        </div>,
        document.body
      )}

      <style>{`
        @page { size: ${paper.widthMm}mm ${paper.heightMm}mm; margin: 0; }

        .or-sheet {
          --or-fs: 12pt; --or-k: 1;
          box-sizing: border-box;
          width: var(--or-w); height: var(--or-h);
          padding: var(--or-mt) var(--or-mr) var(--or-mb) var(--or-ml);
          display: flex; flex-direction: column;
          background: #fff; color: #000;
          font-family: ${FONT_STACK}; font-size: var(--or-fs); line-height: 1.2;
          break-inside: avoid; page-break-after: avoid;
          -webkit-print-color-adjust: exact; print-color-adjust: exact;
        }
        .or-sheet *, .or-sheet *::before, .or-sheet *::after { box-sizing: border-box; }
        .or-sheet p { margin: 0; }

        .or-copy {
          flex: 1 1 0; min-height: 0;
          padding: calc(var(--or-cpt) * var(--or-k)) var(--or-cpx) calc(var(--or-cpb) * var(--or-k));
          display: flex; flex-direction: column;
        }
        .or-copy > * { flex-shrink: 0; }

        .or-cut { flex: 0 0 var(--or-cut); position: relative; }
        .or-cut::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; border-top: 0.3mm dashed #888; }
        .or-cut span { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); background: #fff; color: #777; font-size: 7pt; line-height: 1; padding: 0 2mm; white-space: nowrap; }

        ${OFFICIAL_TMEO_HEADER_CSS}
        .or-title { text-align: center; font-weight: 700; font-size: 1.2em; margin: calc(var(--or-tg) * var(--or-k)) 0 !important; }

        .or-cols { display: grid; grid-template-columns: var(--or-main) minmax(0, 1fr); column-gap: var(--or-cg); align-items: start; }
        .or-main, .or-side { min-width: 0; }
        .or-lower { margin-top: calc(var(--or-bg) * var(--or-k)); }
        .or-lower .or-assessed { align-self: end; }
        .or-sheet[data-stack="1"] .or-cols { grid-template-columns: minmax(0, 1fr); }
        .or-sheet[data-stack="1"] .or-side { margin-top: calc(var(--or-rg) * var(--or-k)); }
        .or-sheet[data-stack="1"] .or-lower .or-assessed { justify-self: end; width: 62%; margin-top: calc(var(--or-bg) * var(--or-k)); }

        .or-row { display: flex; align-items: baseline; margin-bottom: calc(var(--or-rg) * var(--or-k)); }
        .or-row:last-child { margin-bottom: 0; }
        .or-l { flex: 0 0 var(--or-lw); white-space: nowrap; }
        .or-nowrap-label .or-l { flex: 0 0 auto; }
        .or-c { flex: 0 0 auto; margin: 0 1.6mm 0 0.6mm; }
        .or-v {
          flex: 1 1 0; min-width: 0; min-height: 1.2em;
          border-bottom: 0.25mm solid #000; padding-bottom: 0.3mm;
          overflow-wrap: anywhere; word-break: break-word; white-space: normal;
        }

        .or-print-portal { position: fixed; left: -10000px; top: 0; visibility: hidden; pointer-events: none; }
        @media print {
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
          body > *:not(.or-print-portal) { display: none !important; }
          .or-print-portal { position: static; left: auto; top: auto; visibility: visible; pointer-events: auto; }
        }
      `}</style>
    </div>
  )
}