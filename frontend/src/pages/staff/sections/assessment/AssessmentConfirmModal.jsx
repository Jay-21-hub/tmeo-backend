import { ShieldAlert } from 'lucide-react'
import Modal from '../../../../components/ui/Modal'
import Button from '../../../../components/ui/Button'

export default function AssessmentConfirmModal({ type, form, selectedViolations, totalPenalty, formatCurrency, onConfirm, onCancel, loading }) {
  const isDraft = type === 'draft'
  const isPaid = type === 'paid'
  const title = isDraft ? 'Save as Draft' : isPaid ? 'Confirm Payment' : 'Approve & Generate Ticket'
  const subtitle = isDraft
    ? 'This will save the assessment as a pending draft.'
    : isPaid
    ? 'This records the payment and marks the violation as Paid. Printing the Assessment Form is a separate step.'
    : 'This will approve the violation and generate a digital ticket.'
  const btnStyle = isPaid ? { background: '#7c3aed', color: '#fff', border: 'none' } : isDraft ? {} : { background: 'var(--success-600)', color: '#fff', border: 'none' }

  return (
    <Modal
      open onClose={onCancel} width={520}
      footer={<>
        <Button variant="secondary" onClick={onCancel} disabled={!!loading}>Cancel</Button>
        <Button onClick={onConfirm} loading={!!loading} style={btnStyle}>{title}</Button>
      </>}
    >
      <div style={{ margin: '-24px -24px 20px', padding: '18px 24px', background: 'var(--navy-800)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <ShieldAlert size={20} color="#facc15" />
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>{title}</div>
          <div style={{ fontSize: 11, color: '#93c5fd', marginTop: 2 }}>{subtitle}</div>
        </div>
      </div>

      <p className="text-label" style={{ marginBottom: 8 }}>Violator Information</p>
      <div style={{ background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', overflow: 'hidden', marginBottom: 16 }}>
        {[
          { label: 'Full Name', value: form.full_name || '—' },
          { label: 'License No.', value: form.license_number || '—' },
          { label: 'Plate No.', value: form.plate_number || '—' },
          { label: 'Vehicle', value: [form.vehicle_type, form.vehicle_brand, form.vehicle_model].filter(Boolean).join(' · ') || '—' },
          { label: 'Location', value: form.place_of_violation || '—' },
          { label: 'Date & Time', value: `${form.date || '—'} ${form.time || ''}`.trim() },
          ...(isPaid ? [
            { label: 'O.R. No.', value: form.or_number?.trim() || 'Not entered (optional)' },
            { label: 'Date Paid', value: 'Recorded automatically today' },
          ] : []),
        ].map((row, i, arr) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderBottom: i < arr.length - 1 ? '1px solid var(--slate-100)' : 'none' }}>
            <span className="text-caption" style={{ fontWeight: 500 }}>{row.label}</span>
            <span style={{ fontSize: 13, color: 'var(--slate-950)', fontWeight: 600, textAlign: 'right', maxWidth: '60%' }}>{row.value}</span>
          </div>
        ))}
      </div>

      <p className="text-label" style={{ marginBottom: 8 }}>Violations ({selectedViolations.length})</p>
      <div style={{ background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', overflow: 'hidden' }}>
        {selectedViolations.map((vt, i) => (
          <div key={vt.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderBottom: i < selectedViolations.length - 1 ? '1px solid var(--slate-100)' : 'none' }}>
            <div>
              <div style={{ fontSize: 13, color: 'var(--slate-950)', fontWeight: 500 }}>{vt.name}</div>
              <div style={{ fontSize: 10, color: 'var(--slate-400)' }}>{vt.code}</div>
            </div>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--success-700)' }}>₱{Number(vt.penalty_amount).toLocaleString()}</span>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'var(--navy-800)' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#93c5fd' }}>{isPaid ? 'Amount to be Paid' : 'Total Penalty'}</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: '#facc15' }}>{formatCurrency(totalPenalty)}</span>
        </div>
      </div>
    </Modal>
  )
}