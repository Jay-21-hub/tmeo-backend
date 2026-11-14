import { useState, useEffect } from 'react'
import { Plus, Pencil, Check, X } from 'lucide-react'
import api from '../../../../services/api'
import { API } from '../../../../constants'
import { useToast } from '../../../../context/useToast'
import Modal from '../../../../components/ui/Modal'
import Button from '../../../../components/ui/Button'
import Alert from '../../../../components/ui/Alert'
import { Field, TextInput } from '../../../../components/ui/Field'
import { StatusBadge } from '../../../../components/ui/Badge'

/**
 * Admin-only manager for the "Received by" pick-list (Treasury Personnel).
 * These people are NOT system users and never log in. Staff choose one at
 * Confirm Payment. Renaming/deactivating never rewrites old payments (each
 * payment keeps its own name snapshot), so there is no delete here — only
 * Deactivate / Activate.
 */
function errorText(err, fallback) {
  const d = err?.response?.data
  if (!d) return fallback
  if (typeof d === 'string') return d
  if (d.error) return d.error
  const first = Object.values(d)[0]
  return Array.isArray(first) ? first[0] : String(first || fallback)
}

export default function TreasuryPersonnelModal({ onClose }) {
  const toast = useToast()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState({ full_name: '', position: '' })
  const [editId, setEditId] = useState(null)
  const [editDraft, setEditDraft] = useState({ full_name: '', position: '' })
  const [busy, setBusy] = useState(false)

  const applyRows = (data) => setRows(Array.isArray(data) ? data : data.results || [])

  // Reload after a change (called from event handlers only).
  const reload = async () => {
    try {
      const r = await api.get(API.TREASURY_PERSONNEL)
      applyRows(r.data)
      setError('')
    } catch (err) {
      setError(errorText(err, 'Failed to load Treasury Personnel.'))
    }
  }

  useEffect(() => {
    let alive = true
    api.get(API.TREASURY_PERSONNEL)
      .then(r => { if (alive) applyRows(r.data) })
      .catch(err => { if (alive) setError(errorText(err, 'Failed to load Treasury Personnel.')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const add = async () => {
    if (!draft.full_name.trim()) { setError('Name is required.'); return }
    setBusy(true)
    try {
      await api.post(API.TREASURY_PERSONNEL, { full_name: draft.full_name, position: draft.position })
      setDraft({ full_name: '', position: '' })
      toast.success('Treasury Personnel added.')
      await reload()
    } catch (err) { setError(errorText(err, 'Failed to add.')) } finally { setBusy(false) }
  }

  const patch = async (id, body, okMsg) => {
    setBusy(true)
    try {
      await api.patch(API.TREASURY_PERSONNEL_DETAIL(id), body)
      setEditId(null)
      toast.success(okMsg)
      await reload()
    } catch (err) { setError(errorText(err, 'Failed to save.')) } finally { setBusy(false) }
  }

  return (
    <Modal open onClose={onClose} width={640} title="Treasury Personnel" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <p className="text-caption" style={{ marginTop: -12, marginBottom: 12 }}>
        People Staff can choose as “Received by” when confirming a payment. They do not have system accounts.
      </p>
      {error && <div style={{ marginBottom: 12 }}><Alert tone="danger">{error}</Alert></div>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <Field label="Full name" style={{ flex: '2 1 180px' }}>
          {id => <TextInput id={id} value={draft.full_name} maxLength={150} onChange={e => setDraft(d => ({ ...d, full_name: e.target.value }))} />}
        </Field>
        <Field label="Position (optional)" style={{ flex: '1 1 140px' }}>
          {id => <TextInput id={id} value={draft.position} maxLength={100} onChange={e => setDraft(d => ({ ...d, position: e.target.value }))} />}
        </Field>
        <Button icon={Plus} onClick={add} loading={busy && !editId}>Add</Button>
      </div>

      {loading ? <p className="text-caption">Loading…</p> : rows.length === 0 ? (
        <p className="text-caption">No Treasury Personnel yet. Add one above.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Position</th><th>Status</th><th style={{ width: 150 }}>Actions</th></tr></thead>
            <tbody>
              {rows.map(p => editId === p.id ? (
                <tr key={p.id}>
                  <td><TextInput aria-label="Full name" value={editDraft.full_name} maxLength={150} onChange={e => setEditDraft(d => ({ ...d, full_name: e.target.value }))} /></td>
                  <td><TextInput aria-label="Position" value={editDraft.position} maxLength={100} onChange={e => setEditDraft(d => ({ ...d, position: e.target.value }))} /></td>
                  <td><StatusBadge status={p.is_active ? 'active' : 'inactive'} label={p.is_active ? 'Active' : 'Inactive'} /></td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button size="sm" icon={Check} loading={busy} onClick={() => patch(p.id, editDraft, 'Treasury Personnel updated.')}>Save</Button>
                      <Button size="sm" variant="secondary" icon={X} onClick={() => setEditId(null)} disabled={busy}>Cancel</Button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={p.id}>
                  <td>{p.full_name}</td>
                  <td>{p.position || '—'}</td>
                  <td><StatusBadge status={p.is_active ? 'active' : 'inactive'} label={p.is_active ? 'Active' : 'Inactive'} /></td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button size="sm" variant="secondary" icon={Pencil} disabled={busy}
                        onClick={() => { setEditId(p.id); setEditDraft({ full_name: p.full_name, position: p.position || '' }); setError('') }}>Edit</Button>
                      <Button size="sm" variant="secondary" disabled={busy}
                        onClick={() => patch(p.id, { is_active: !p.is_active }, p.is_active ? 'Deactivated.' : 'Activated.')}>
                        {p.is_active ? 'Deactivate' : 'Activate'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}