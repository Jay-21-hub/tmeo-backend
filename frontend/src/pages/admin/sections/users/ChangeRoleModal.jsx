import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowLeftRight, CheckCircle2, Copy, Check } from 'lucide-react'
import Modal from '../../../../components/ui/Modal'
import Button from '../../../../components/ui/Button'
import Alert from '../../../../components/ui/Alert'
import { Field, Textarea } from '../../../../components/ui/Field'
import { changeUserRole } from '../../../../services/api'
import { ROLE_LABELS, ROLE_CHANGE_REASON_MAX, getRoleChangeTarget } from './userManagementConfig'
import { getRoleChangeError } from './roleChangeErrors'
import './ChangeRoleModal.css'

const roleLabel = (role) => ROLE_LABELS[role] || role || '—'

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true }
  } catch { /* fall through to the legacy path */ }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

/**
 * ChangeRoleModal — Admin → User Management → "Change Role".
 *
 * Staff <-> Enforcer only. The new role is fixed by the account's current role
 * (the only supported transition), the reason is required, and the NEW ID number
 * is never entered here: the server generates it and the target's sessions are
 * invalidated, so they sign in again with the new ID.
 *
 * After a successful change the SAME modal switches to a success state that shows
 * the server's authoritative result (POST .../change-role/ response:
 * user.{full_name, role, id_number}, previous.{role, id_number}, sessions_invalidated).
 * The new ID is read ONLY from that response, never generated or inferred here, and
 * the modal stays open until the admin deliberately presses Done.
 *
 * Props:
 *  - user      - the row being changed ({ id, role, full_name, email, id_number, ... })
 *  - onClose   - dismiss (blocked while submitting and during the success state, except Done)
 *  - onChanged - (responseData) called once after the server confirms the change
 *                (the page refreshes its list; the modal is NOT closed by this)
 *  - onStale   - called after an error that means the list is out of date
 */
export default function ChangeRoleModal({ user, onClose, onChanged, onStale }) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [copyState, setCopyState] = useState('idle') // idle | copied | failed
  const inFlight = useRef(false)
  const doneRef = useRef(null)

  const newRole = getRoleChangeTarget(user?.role)
  const name = user?.full_name || user?.name || '—'
  const trimmed = reason.trim()
  const canSubmit = !!newRole && trimmed.length > 0 && reason.length <= ROLE_CHANGE_REASON_MAX && !submitting && !result

  // Move focus to the deliberate Done button once the success state appears.
  useEffect(() => { if (result) doneRef.current?.focus() }, [result])

  const submit = async () => {
    if (!canSubmit || inFlight.current) return
    inFlight.current = true
    setSubmitting(true)
    setError('')
    try {
      const { data } = await changeUserRole(user.id, { newRole, reason: trimmed, expectedRole: user.role })
      setResult(data || {})
      setSubmitting(false)
      onChanged?.(data)
    } catch (err) {
      const { message, refresh } = getRoleChangeError(err)
      setError(message)
      setSubmitting(false)
      if (refresh) onStale?.()
    } finally {
      inFlight.current = false
    }
  }

  // Authoritative values from the backend response only.
  const newId = result?.user?.id_number || ''
  const copyNewId = async () => {
    if (!newId) return
    setCopyState((await copyText(newId)) ? 'copied' : 'failed')
  }

  if (!user || !newRole) return null

  const toEnforcer = newRole === 'enforcer'

  if (result) {
    const resName = result.user?.full_name || name
    return (
      <Modal
        open
        onClose={onClose}
        dismissible={false}
        width={460}
        title="Role changed"
        footer={<Button ref={doneRef} variant="primary" onClick={onClose}>Done</Button>}
      >
        <div className="crm" data-testid="crm-success">
          <div className="crm-success-head">
            <CheckCircle2 size={22} color="var(--success-600)" aria-hidden="true" />
            <p className="crm-user-name">{resName}</p>
          </div>

          <div className="crm-transition" aria-label="Role change result">
            <div className="crm-role">
              <p className="crm-role-label">Previous role</p>
              <p className="crm-role-value">{roleLabel(result.previous?.role)}</p>
            </div>
            <span className="crm-arrow" aria-hidden="true"><ArrowRight size={18} /></span>
            <div className="crm-role crm-role--to">
              <p className="crm-role-label">New role</p>
              <p className="crm-role-value">{roleLabel(result.user?.role)}</p>
            </div>
          </div>

          <div className="crm-ids">
            <div className="crm-id-prev">
              <p className="crm-role-label">Previous ID number</p>
              <p className="crm-id-prev-value" data-testid="crm-prev-id">{result.previous?.id_number || '—'}</p>
            </div>
            <div className="crm-id-new">
              <p className="crm-role-label">New ID number</p>
              {newId ? (
                <p className="crm-id-new-value" data-testid="crm-new-id">{newId}</p>
              ) : (
                <p className="crm-id-missing" data-testid="crm-new-id-missing">
                  The server did not return the new ID number. Open the user's details to read it.
                </p>
              )}
              <Button
                variant="secondary"
                size="sm"
                icon={copyState === 'copied' ? Check : Copy}
                onClick={copyNewId}
                disabled={!newId}
              >
                {copyState === 'copied' ? 'Copied' : 'Copy ID'}
              </Button>
              <span className="crm-copy-status" role="status">
                {copyState === 'copied' && 'New ID copied to clipboard.'}
                {copyState === 'failed' && 'Could not copy automatically. Select the ID and copy it manually.'}
              </span>
            </div>
          </div>

          <Alert tone="info" title="Next step">
            <ul className="crm-notes">
              {result.sessions_invalidated && <li>All existing sessions for {resName} were invalidated. They are signed out.</li>}
              <li>{resName} must sign in using the <strong>new ID number</strong> shown above. The previous ID will no longer work for this account.</li>
            </ul>
          </Alert>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!submitting}
      width={460}
      title="Change Role"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button variant="primary" icon={ArrowLeftRight} onClick={submit} disabled={!canSubmit} loading={submitting}>
          {submitting ? 'Changing...' : 'Change Role'}
        </Button>
      </>}
    >
      <div className="crm">
        <div className="crm-user">
          <p className="crm-user-name">{name}</p>
          <p className="crm-user-meta">{user.email || '—'}{user.id_number ? ` · ID ${user.id_number}` : ''}</p>
        </div>

        <div className="crm-transition" aria-label="Role change">
          <div className="crm-role">
            <p className="crm-role-label">Current role</p>
            <p className="crm-role-value">{roleLabel(user.role)}</p>
          </div>
          <span className="crm-arrow" aria-hidden="true"><ArrowRight size={18} /></span>
          <div className="crm-role crm-role--to">
            <p className="crm-role-label">New role</p>
            <p className="crm-role-value">{ROLE_LABELS[newRole]}</p>
          </div>
        </div>

        <Alert tone="warning" title="What happens">
          <ul className="crm-notes">
            <li>A <strong>new ID number</strong> is generated by the system. You cannot enter one.</li>
            <li>{name} is signed out and must sign in again with the <strong>new ID number</strong>.</li>
            <li>The change is recorded in the role history and the audit trail.</li>
            {toEnforcer
              ? <li>Any assessment locks held by this account are released.</li>
              : <li>Duty and break status is cleared. Not allowed while the enforcer has schedules dated today or later.</li>}
          </ul>
        </Alert>

        <Field label="Reason for change" required helper="Kept in the role history and the audit trail.">
          {(id) => (
            <>
              <Textarea
                id={id}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={ROLE_CHANGE_REASON_MAX}
                rows={3}
                disabled={submitting}
                placeholder="e.g. Reassigned to field duty"
              />
              <div className={`crm-counter ${reason.length >= ROLE_CHANGE_REASON_MAX ? 'crm-counter--limit' : ''}`} aria-live="off">
                {reason.length}/{ROLE_CHANGE_REASON_MAX}
              </div>
            </>
          )}
        </Field>

        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  )
}