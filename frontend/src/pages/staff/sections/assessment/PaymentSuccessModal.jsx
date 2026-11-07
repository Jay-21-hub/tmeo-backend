import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Printer, FilePlus2, X } from 'lucide-react'
import Button from '../../../../components/ui/Button'
import {
  PAPER_SIZES, PAPER_SIZE_ORDER, loadPaperSize, savePaperSize,
} from '../../../../components/print/assessmentPaperSizes'
import './assessmentFlow.css'

/**
 * Payment Successful — shown after the EXISTING Confirm Payment succeeds.
 * Presentation only: every value comes from the server response (paidRecord)
 * or the form state. Exactly two actions (New Assessment, Print Assessment
 * Form) plus a compact Paper Size setting, which is stored with the same
 * helper (savePaperSize) the print template reads.
 * The corner X is a convenience for the same "finish" path as New Assessment
 * (this modal is mounted by paidRecord, so closing it = leaving the paid form).
 */
export default function PaymentSuccessModal({ form, violationsText, paidRecord, formatCurrency, onNewAssessment, onPrint }) {
  const [paperId, setPaperId] = useState(loadPaperSize)
  const printBtnRef = useRef(null)
  const a = paidRecord?.assessment || {}

  useEffect(() => { printBtnRef.current?.focus() }, [])

  const fmtDate = (d) => d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
  const rows = [
    ['Violator', paidRecord?.violator_name || form.full_name],
    ['Plate Number', paidRecord?.plate_number || form.plate_number],
    ['Violation Type', violationsText],
    ['Amount Paid', a.amount_paid != null ? formatCurrency(a.amount_paid) : formatCurrency(a.penalty ?? paidRecord?.penalty_amount)],
    ['Date Paid', fmtDate(a.date_paid)],
    ['O.R. No.', a.or_number],
  ].filter(([, v]) => v && v !== '—')

  const handlePaper = (e) => { setPaperId(e.target.value); savePaperSize(e.target.value) }

  return createPortal(
    <div className="af-overlay">
      <div className="af-success" role="dialog" aria-modal="true" aria-labelledby="af-success-title" aria-describedby="af-success-desc">
        <button type="button" className="af-close" onClick={onNewAssessment} aria-label="Close and start a new assessment" title="Close">
          <X size={18} />
        </button>
        <div className="af-check" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        </div>
        <h2 id="af-success-title">Payment Successful</h2>
        <p id="af-success-desc" className="af-lead">The payment is recorded and the violation is now Paid.</p>

        <dl className="af-summary">
          {rows.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
        </dl>

        <div className="af-paper">
          <label htmlFor="af-paper-size">Paper size</label>
          <select id="af-paper-size" className="select" value={paperId} onChange={handlePaper}>
            {PAPER_SIZE_ORDER.map(id => (
              <option key={id} value={id}>{PAPER_SIZES[id].label} — {PAPER_SIZES[id].detail}</option>
            ))}
          </select>
        </div>

        <div className="af-success-actions">
          <Button variant="secondary" icon={FilePlus2} onClick={onNewAssessment}>New Assessment</Button>
          <Button ref={printBtnRef} icon={Printer} onClick={onPrint}>Print Assessment Form</Button>
        </div>
      </div>
    </div>,
    document.body
  )
}