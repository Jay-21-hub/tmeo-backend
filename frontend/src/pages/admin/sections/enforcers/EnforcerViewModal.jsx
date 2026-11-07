import { User, Hash, Phone, MapPin, Calendar, FileText } from 'lucide-react'
import Modal from '../../../../components/ui/Modal'
import Button from '../../../../components/ui/Button'
import { Select } from '../../../../components/ui/Field'
import { getInitials } from '../../../../utils/helpers'
import { EnforcerStatusBadge, ALL_STATUSES } from './enforcerStatus'

export default function EnforcerViewModal({ enforcer, statusHistory, onStatusChange, onClose }) {
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
            <EnforcerStatusBadge status={enforcer.status} />
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

      <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--slate-100)' }}>
        <p className="text-label" style={{ marginBottom: 12 }}>Change Status</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Select value={enforcer.status} onChange={e => onStatusChange(enforcer.id, e.target.value)} style={{ maxWidth: 200 }}>
            {ALL_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
        </div>
      </div>

      <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--slate-100)' }}>
        <p className="text-label" style={{ marginBottom: 12 }}>Status History</p>
        {statusHistory.length === 0 ? (
          <p className="text-caption">No status changes recorded.</p>
        ) : (
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {statusHistory.map((h, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--slate-50)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--blue-600)', marginTop: 4, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <EnforcerStatusBadge status={h.new_status} />
                    <span className="text-caption">{h.changed_at ? new Date(h.changed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</span>
                  </div>
                  <p className="text-caption" style={{ margin: '3px 0 0' }}>Changed by {h.changed_by || 'Admin'}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}