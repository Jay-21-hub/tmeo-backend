import { useState } from 'react'
import { AlertCircle, Trash2, CheckCircle } from 'lucide-react'
import Modal from '../../../../components/ui/Modal'
import Button from '../../../../components/ui/Button'
import Alert from '../../../../components/ui/Alert'
import { displayUserName } from './userDisplayName'

export function UserConfirmDialog({ message, onConfirm, onCancel, danger }) {
  return (
    <Modal
      open onClose={onCancel} width={360}
      footer={<>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>Confirm</Button>
      </>}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ background: danger ? 'var(--danger-50)' : 'var(--blue-50)', borderRadius: '50%', padding: 8, display: 'flex' }}>
          <AlertCircle size={20} color={danger ? 'var(--danger-600)' : 'var(--blue-600)'} />
        </div>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--slate-950)' }}>Confirm Action</h3>
      </div>
      <p style={{ margin: 0, fontSize: 14, color: 'var(--slate-600)', lineHeight: 1.6 }}>{message}</p>
    </Modal>
  )
}

export function UserDeleteAccountModal({ user, onConfirm, onCancel, loading }) {
  const [typed, setTyped] = useState('')
  // Display-only "First Middle Last". The admin types this same text to confirm.
  const shownName = user ? displayUserName(user) : ''
  const name = shownName === '—' ? '' : shownName
  const confirmed = typed.trim().toLowerCase() === name.trim().toLowerCase()

  return (
    <Modal
      open={!!user} onClose={onCancel} width={420}
      footer={<>
        <Button variant="secondary" onClick={onCancel} disabled={loading}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm} disabled={!confirmed} loading={loading} icon={Trash2}>
          {loading ? 'Deleting...' : 'Delete Permanently'}
        </Button>
      </>}
    >
      <div style={{ margin: '-24px -24px 20px', padding: '20px 24px', background: 'var(--danger-50)', borderBottom: '1px solid var(--danger-100)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ background: 'var(--danger-100)', borderRadius: 'var(--radius-md)', padding: 8, display: 'flex', flexShrink: 0 }}>
          <Trash2 size={20} color="var(--danger-600)" />
        </div>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--slate-950)' }}>Permanently Delete Account</h3>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--danger-600)', fontWeight: 500 }}>This action cannot be undone</p>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Alert tone="warning"><strong>Permanent delete</strong> only works for an account that has no historical system records (violations, assessments, audit trail, schedules, archive or role history). If the account has any, deletion is refused and the records are kept. To stop an account from signing in, use <strong>Deactivate</strong> instead &mdash; it keeps all history.</Alert>
      </div>

      <div style={{ background: 'var(--slate-50)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '12px 14px', marginBottom: 16 }}>
        <p className="text-label" style={{ margin: '0 0 4px' }}>Account to be deleted</p>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--slate-950)' }}>{name}</p>
        <p className="text-caption" style={{ margin: '2px 0 0' }}>{user?.email}</p>
      </div>

      <div className="field">
        <label className="field-label">Type <strong style={{ color: 'var(--danger-600)' }}>{name}</strong> to confirm:</label>
        <input
          className={`input ${typed.length > 0 ? (confirmed ? '' : 'input-error') : ''}`}
          value={typed} onChange={e => setTyped(e.target.value)} placeholder={name} autoFocus
          style={{ background: typed.length > 0 && confirmed ? 'var(--success-50)' : undefined, borderColor: typed.length > 0 && confirmed ? 'var(--success-300, #86efac)' : undefined }}
        />
        {typed.length > 0 && !confirmed && <span className="field-error-text">Name does not match</span>}
        {confirmed && <span style={{ fontSize: 11, color: 'var(--success-600)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}><CheckCircle size={11} /> Confirmed</span>}
      </div>
    </Modal>
  )
}