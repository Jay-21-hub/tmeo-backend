import { User, Hash, Phone, MapPin, Calendar, FileText } from 'lucide-react'
import Modal from '../../../../components/ui/Modal'
import Button from '../../../../components/ui/Button'
import { getInitials } from '../../../../utils/helpers'
import { EnforcerStatusBadge, dutyStatusLabel } from './enforcerStatus'

export default function EnforcerViewModal({ enforcer, onClose }) {
  if (!enforcer) return null

  const fullName = enforcer.full_name || `${enforcer.last_name}, ${enforcer.first_name} ${enforcer.middle_name || ''}`.trim()

  const fields = [
    { icon: Hash, label: 'Badge Number', value: enforcer.badge_number },
    { icon: Phone, label: 'Contact', value: enforcer.contact },
    { icon: MapPin, label: 'Address', value: enforcer.address },
    { icon: Calendar, label: 'Date Hired', value: enforcer.date_hired },
    { icon: FileText, label: 'Violations Issued', value: enforcer.violation_count ?? '—' },
  ]

  return (
    <Modal
      open onClose={onClose} width={620}
      title="Enforcer Details"
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--warning-50)', border: '2px solid var(--warning-100)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {enforcer.badge_number
            ? <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--warning-700)' }}>{getInitials(fullName)}</span>
            : <User size={24} color="var(--warning-700)" />}
        </div>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--slate-950)' }}>{fullName || '—'}</h3>
          <div style={{ marginTop: 6 }}>
            <EnforcerStatusBadge status={dutyStatusLabel(enforcer)} />
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {fields.map(({ icon, label, value }) => {
          const Icon = icon
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <Icon size={15} color="var(--slate-400)" />
              <div>
                <p className="text-label" style={{ margin: 0 }}>{label}</p>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--slate-950)', fontWeight: 500 }}>{value || '—'}</p>
              </div>
            </div>
          )
        })}
      </div>

      <p className="text-caption" style={{ marginTop: 16 }}>
        Duty status follows today’s assigned shift in Asia/Manila. On Duty means the current time is inside that shift. It cannot be changed by hand.
      </p>
    </Modal>
  )
}