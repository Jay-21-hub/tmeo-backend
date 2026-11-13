import { useState } from 'react'
import { X, Printer } from 'lucide-react'
import AssessmentDirectPrint from './AssessmentDirectPrint'
import { shown, orNumberDisplay, receivedByDisplay, withReason } from './ticketDisplay'

const Row = ({ label, value, danger }) => (
  <div>
    <p style={{ margin: 0, fontSize: 11, color: 'var(--slate-400)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</p>
    <p style={{ margin: '2px 0 0', fontSize: 14, color: danger ? 'var(--danger-600)' : 'var(--slate-950)', fontWeight: 600 }}>{value || '— Not provided'}</p>
  </div>
)

export default function AssessmentTicketModal({ ticket, formatCurrency, onClose, onPrinted }) {
  // "Print Ticket" used to call window.print() straight off this
  // dashboard-styled preview card (rounded corners, colored badges) —
  // not an official document. It now opens the plain black-on-white
  // Official Receipt print template instead; this card stays purely an
  // on-screen preview and is never itself printed.
  //
  // Reached via AssessmentForm's handleViewExistingTicket (view/reprint of
  // an existing ticket from repeat-violator history). Printing is only
  // offered once payment is confirmed; `onPrinted` just logs the reprint
  // audit event — it never changes any payment data.
  const [showReceipt, setShowReceipt] = useState(false)

  const isPaid = ticket.payment_status?.toLowerCase() === 'paid'

  const paymentTone = ticket.payment_status?.toLowerCase() === 'paid'
    ? { background: 'var(--success-50)', color: 'var(--success-600)', border: '1px solid var(--success-100)' }
    : ticket.payment_status?.toLowerCase() === 'partial'
    ? { background: 'var(--warning-50)', color: 'var(--warning-600)', border: '1px solid var(--warning-100)' }
    : { background: 'var(--danger-50)', color: 'var(--danger-600)', border: '1px solid var(--danger-100)' }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div id="printable-ticket" style={{ background: 'var(--white)', borderRadius: 'var(--radius-xl)', width: '100%', maxWidth: 640, maxHeight: '88vh', overflowY: 'auto', boxShadow: 'var(--shadow-xl)' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--slate-100)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 12px', background: 'var(--blue-50)', border: '1px solid var(--blue-100)', borderRadius: 'var(--radius-md)', marginBottom: 8 }}>
              <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--blue-600)' }}>TICKET #{ticket.ticket_number}</span>
            </div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--slate-950)' }}>Digital Ticket Preview</h2>
            <p className="text-caption" style={{ marginTop: 2 }}>
              Generated {new Date(ticket.generated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--slate-400)', cursor: 'pointer', padding: 4 }} aria-label="Close"><X size={20} /></button>
        </div>

        <div style={{ padding: '20px 24px' }}>
          <p className="text-label" style={{ marginBottom: 10 }}>Violator Information</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
            {[['Full Name', ticket.full_name], ['Address', ticket.address], ['License Number', ticket.license_number], ['License Status', ticket.license_status], ['Plate Number', ticket.plate_number], ['Registration No.', ticket.registration_number]].map(([l, v]) => <Row key={l} label={l} value={shown(v)} />)}
            <Row label="OVR Number" value={shown(ticket.ovr_number, ticket.source === 'staff_walk_in' ? 'Not issued for a walk-in' : 'Not provided')} />
          </div>

          <div style={{ paddingTop: 16, borderTop: '1px solid var(--slate-100)', marginBottom: 20 }}>
            <p className="text-label" style={{ marginBottom: 10 }}>Violation Details</p>
            <div style={{ marginBottom: 10 }}><Row label="Violations" value={shown(ticket.violations)} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {[['Vehicle Type', ticket.vehicle_type], ['Date', ticket.date], ['Time', ticket.time]].map(([l, v]) => <Row key={l} label={l} value={shown(v, 'Not recorded')} />)}
              <div style={{ gridColumn: '1 / -1' }}><Row label="Place of Violation" value={shown(ticket.place_of_violation)} /></div>
            </div>
          </div>

          <div style={{ paddingTop: 16, borderTop: '1px solid var(--slate-100)', marginBottom: 20 }}>
            <p className="text-label" style={{ marginBottom: 10 }}>Penalty &amp; Payment</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <Row label="Penalty Amount" value={ticket.penalty_amount ? formatCurrency(ticket.penalty_amount) : withReason('Not assessed')} danger />
              <Row label="Amount Paid" value={ticket.amount_paid ? formatCurrency(ticket.amount_paid) : withReason(isPaid ? 'Not recorded' : 'Not paid yet')} />
              <Row label="O.R. Number" value={orNumberDisplay(ticket.payment_status || ticket.status, ticket.assessment?.or_number || ticket.or_number)} />
              <Row label="Date Paid" value={ticket.date_paid ? shown(ticket.date_paid) : withReason(isPaid ? 'Not recorded' : 'Not paid yet')} />
              <Row label="Received By" value={receivedByDisplay({
                acknowledgment: ticket.assessment?.received_by,
                issuerName: ticket.enforcer?.full_name || '',
                recordedAtLabel: ticket.date_issued
                  ? new Date(ticket.date_issued).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                  : [ticket.date, ticket.time].filter(Boolean).join(' '),
              })} />
              <Row label="Assessed By" value={shown(ticket.assessed_by, 'Not recorded')} />
            </div>
          </div>

          <div style={{ paddingTop: 12, borderTop: '1px solid var(--slate-100)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-600)' }}>Payment Status:</span>
            <span className="badge" style={{ ...paymentTone }}>{ticket.payment_status || 'Unpaid'}</span>
          </div>
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--slate-100)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-primary" disabled={!isPaid} title={isPaid ? undefined : 'Available once payment is confirmed'} onClick={() => setShowReceipt(true)}><Printer size={14} /> Print Assessment Form</button>
        </div>
      </div>

      {/* Print opens the NATIVE browser print preview directly through the hidden
          AssessmentDirectPrint layer; it unmounts when the dialog closes, so this
          modal (the meaningful context) is all that stays behind the confirmation. */}
      {showReceipt && (
        <AssessmentDirectPrint
          ticket={ticket}
          formatCurrency={formatCurrency}
          onPrinted={onPrinted}
          onDone={() => setShowReceipt(false)}
        />
      )}
    </div>
  )
}