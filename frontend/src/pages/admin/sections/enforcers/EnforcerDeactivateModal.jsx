import { UserX } from 'lucide-react'
import Modal from '../../../../components/ui/Modal'
import Button from '../../../../components/ui/Button'

export default function EnforcerDeactivateModal({ enforcer, onConfirm, onCancel }) {
  return (
    <Modal
      open={!!enforcer} onClose={onCancel} width={380}
      footer={<>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm}>Confirm Deactivate</Button>
      </>}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ width: 42, height: 42, borderRadius: 'var(--radius-md)', background: 'var(--danger-50)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <UserX size={20} color="var(--danger-600)" />
        </div>
        <div>
          <div className="text-title" style={{ fontSize: 15 }}>Deactivate Enforcer</div>
          <div className="text-caption">This will revoke their system access</div>
        </div>
      </div>

      <div style={{ padding: '12px 14px', background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', marginBottom: 8 }}>
        <p className="text-label" style={{ margin: 0 }}>Enforcer</p>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--slate-950)', fontWeight: 700 }}>
          {enforcer?.full_name || `${enforcer?.last_name}, ${enforcer?.first_name}`}
        </p>
      </div>
      <div style={{ padding: '12px 14px', background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
        <p className="text-label" style={{ margin: 0 }}>Enforcer ID</p>
        <p className="mono" style={{ margin: 0, fontSize: 13, color: 'var(--blue-600)', fontWeight: 600 }}>{enforcer?.enforcer_id || '—'}</p>
      </div>
    </Modal>
  )
}
