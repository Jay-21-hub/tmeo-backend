import { useState } from 'react'
import { CheckCircle2, Send, ShieldCheck, Pencil } from 'lucide-react'
import Modal from '../../../../components/ui/Modal'
import Button from '../../../../components/ui/Button'
import Alert from '../../../../components/ui/Alert'
import { Field, TextInput, Select, Textarea } from '../../../../components/ui/Field'
import { formatDateTime } from '../../../../utils/helpers'
import useCustodyAction from '../hooks/useCustodyAction'
import { markReady, releaseLicense, verifyDocumentType, correctLicenseNumber } from '../services/custodyApi'
import { CLAIMANT_ID_TYPES, LIMITS, statusLabel } from '../utils/custodyConfig'
import { CustodyStatusBadge } from './CustodyBadges'
import '../ConfiscatedLicenses.css'

/*
 * Four confirmation dialogs, one per backend write endpoint. Each submits ONLY
 * the fields its serializer accepts (plus expected_version / client_request_id,
 * added by useCustodyAction).
 *
 * Shared props:
 *   record     custody record ({ key, version, license_number, owner_name, ... })
 *   onClose    dismiss without changes
 *   onSuccess  (responseBody) => void   - backend confirmed; parent closes + refreshes
 *   onStale    (parsedError)  => void   - record changed under the user; parent closes + reloads
 */

const READY_FIELDS = []
const RELEASE_FIELDS = ['released_to_name', 'claimant_id_type', 'claimant_id_last4', 'authorization_reference', 'release_remarks']
const VERIFY_FIELDS = ['decision', 'reason']
const CORRECT_FIELDS = ['license_number', 'reason']

function Summary({ rows }) {
  return (
    <dl className="cl-summary">
      {rows.filter(Boolean).map(([label, value]) => (
        <div key={label} className="cl-summary-row">
          <dt>{label}</dt>
          <dd>{value || '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

function ActionError({ error }) {
  if (!error) return null
  const tone = error.code === 'payment_required' || error.unknownOutcome ? 'warning' : 'danger'
  const title = error.code === 'payment_required' ? 'Payment not confirmed' : undefined
  return <Alert tone={tone} title={title} className="cl-modal-alert">{error.message}</Alert>
}

function Footer({ onClose, submitting, submitLabel, onSubmit, disabled, icon }) {
  return (
    <>
      <Button variant="secondary" onClick={onClose} disabled={submitting} data-cancel>Cancel</Button>
      <Button icon={icon} onClick={onSubmit} loading={submitting} disabled={disabled}>{submitLabel}</Button>
    </>
  )
}

const Counter = ({ value, max }) => <span className="cl-counter" aria-hidden="true">{value.length}/{max}</span>

/* ───────────────────────────── Mark Ready ───────────────────────────── */

export function MarkReadyModal({ record, onClose, onSuccess, onStale }) {
  const { submit, submitting, error } = useCustodyAction({ record, call: markReady, fields: READY_FIELDS, onSuccess, onStale })

  return (
    <Modal
      open onClose={onClose} width={520} mobileFullScreen={false} dismissible={!submitting}
      title="Mark as Ready for Release" titleId="cl-ready-title" initialFocus="[data-cancel]"
      footer={<Footer onClose={onClose} submitting={submitting} submitLabel="Mark as Ready" icon={CheckCircle2} onSubmit={() => submit({})} />}
    >
      <Summary rows={[
        ['License number', <span className="mono" key="l">{record.license_number}</span>],
        ['Driver name', record.owner_name],
        ['OVR / ticket no.', record.ticket_number],
        ['Current status', <CustodyStatusBadge key="s" status={record.status} />],
      ]} />
      <Alert tone="info" className="cl-modal-alert">
        Payment must already be confirmed for this violation. The system checks payment when you
        confirm, and marking a license ready does not release it — release is a separate step.
      </Alert>
      <ActionError error={error} />
    </Modal>
  )
}

/* ───────────────────────────── Release ───────────────────────────── */

export function ReleaseModal({ record, onClose, onSuccess, onStale }) {
  const [form, setForm] = useState({
    releasedToName: '', claimantIdType: '', claimantIdLast4: '', authorizationReference: '', releaseRemarks: '',
  })
  const { submit, submitting, error } = useCustodyAction({ record, call: releaseLicense, fields: RELEASE_FIELDS, onSuccess, onStale })

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  // The backend accepts at most the last 4 letters/digits of the claimant's ID, never the full number.
  const setLast4 = (e) => setForm((f) => ({ ...f, claimantIdLast4: e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, LIMITS.claimantIdLast4) }))

  const values = {
    releasedToName: form.releasedToName.trim(),
    claimantIdType: form.claimantIdType,
    claimantIdLast4: form.claimantIdLast4.trim(),
    authorizationReference: form.authorizationReference.trim(),
    releaseRemarks: form.releaseRemarks.trim(),
  }
  const valid = !!(values.releasedToName && values.claimantIdType && values.authorizationReference)
  const fe = error?.fieldErrors || {}

  return (
    <Modal
      open onClose={onClose} width={560} mobileFullScreen={false} dismissible={!submitting}
      title="Release License" titleId="cl-release-title" initialFocus="[data-autofocus]"
      footer={<Footer onClose={onClose} submitting={submitting} submitLabel="Release License" icon={Send} disabled={!valid} onSubmit={() => valid && submit(values)} />}
    >
      <Summary rows={[
        ['License number', <span className="mono" key="l">{record.license_number}</span>],
        ['Driver name', record.owner_name],
        ['Current status', <CustodyStatusBadge key="s" status={record.status} />],
        record.ready_marked_at && ['Ready since', formatDateTime(record.ready_marked_at)],
      ]} />
      <p className="cl-modal-note">
        Confirming records the actual release. The release date and time are set by the system and cannot be changed afterwards.
      </p>

      <div className="cl-form-grid">
        <Field label="Released to" required error={fe.released_to_name}>
          {(id) => <TextInput id={id} data-autofocus value={form.releasedToName} onChange={set('releasedToName')} maxLength={LIMITS.releasedToName} autoComplete="off" error={!!fe.released_to_name} />}
        </Field>
        <Field label="Claimant ID type" required error={fe.claimant_id_type}>
          {(id) => (
            <Select id={id} value={form.claimantIdType} onChange={set('claimantIdType')} error={!!fe.claimant_id_type}>
              <option value="">Select ID type</option>
              {CLAIMANT_ID_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Last 4 characters of ID" helper="Optional. Never enter the full ID number." error={fe.claimant_id_last4}>
          {(id) => <TextInput id={id} className="mono" value={form.claimantIdLast4} onChange={setLast4} maxLength={LIMITS.claimantIdLast4} inputMode="text" autoComplete="off" error={!!fe.claimant_id_last4} />}
        </Field>
        <Field label="Authorization reference" required helper="Reference of the authorization letter / SPA — not an ID number." error={fe.authorization_reference}>
          {(id) => <TextInput id={id} value={form.authorizationReference} onChange={set('authorizationReference')} maxLength={LIMITS.authorizationReference} autoComplete="off" error={!!fe.authorization_reference} />}
        </Field>
      </div>
      <Field label="Remarks (optional)" error={fe.release_remarks}>
        {(id) => <Textarea id={id} rows={3} value={form.releaseRemarks} onChange={set('releaseRemarks')} maxLength={LIMITS.releaseRemarks} placeholder="e.g., License returned to owner." error={!!fe.release_remarks} />}
      </Field>
      <ActionError error={error} />
    </Modal>
  )
}

/* ───────────────────────── Legacy verification ───────────────────────── */

const DECISIONS = {
  confirm: { value: 'drivers_license', label: "Confirm as driver's license" },
  exclude: { value: 'not_drivers_license', label: 'Exclude from custody (not a driver’s license)' },
}

/**
 * `canExclude` is true only for Admin. Staff are shown (and can only send)
 * "Confirm as driver's license"; the backend also rejects a Staff exclusion
 * with 403 `admin_required`.
 */
export function VerifyDocumentModal({ record, canExclude, onClose, onSuccess, onStale }) {
  const [decision, setDecision] = useState(canExclude ? '' : DECISIONS.confirm.value)
  const [reason, setReason] = useState('')
  const { submit, submitting, error } = useCustodyAction({ record, call: verifyDocumentType, fields: VERIFY_FIELDS, onSuccess, onStale })

  const options = canExclude ? [DECISIONS.confirm, DECISIONS.exclude] : [DECISIONS.confirm]
  const values = { decision, reason: reason.trim() }
  const valid = !!(values.decision && values.reason)
  const fe = error?.fieldErrors || {}

  return (
    <Modal
      open onClose={onClose} width={540} mobileFullScreen={false} dismissible={!submitting}
      title="Verify Legacy Document" titleId="cl-verify-title" initialFocus="[data-autofocus]"
      footer={<Footer onClose={onClose} submitting={submitting} submitLabel="Submit Verification" icon={ShieldCheck} disabled={!valid} onSubmit={() => valid && submit(values)} />}
    >
      <Summary rows={[
        ['License number', <span className="mono" key="l">{record.license_number}</span>],
        ['Driver name', record.owner_name],
        ['Record source', 'Legacy record'],
      ]} />
      <p className="cl-modal-note">
        The document type of this legacy record was not recorded. It cannot be marked ready or released until it is verified.
      </p>

      <fieldset className="cl-fieldset" aria-describedby={canExclude ? undefined : 'cl-verify-staff-note'}>
        <legend className="field-label">Decision <span className="field-required" aria-hidden="true">*</span></legend>
        {options.map((o, i) => (
          <label key={o.value} className="cl-radio">
            <input
              type="radio" name="cl-decision" value={o.value}
              checked={decision === o.value} onChange={() => setDecision(o.value)}
              {...(i === 0 ? { 'data-autofocus': true } : {})}
            />
            <span>{o.label}</span>
          </label>
        ))}
        {fe.decision && <span className="field-error-text" role="alert">{fe.decision}</span>}
        {!canExclude && (
          <span id="cl-verify-staff-note" className="field-helper">Only an Administrator can exclude a record as not a driver&rsquo;s license.</span>
        )}
      </fieldset>

      {decision === DECISIONS.exclude.value && (
        <Alert tone="warning" className="cl-modal-alert">
          Excluded records are hidden from the default list and can no longer be marked ready or released.
          This cannot be undone from this screen.
        </Alert>
      )}

      <Field label="Reason" required error={fe.reason}>
        {(id) => (
          <>
            <Textarea id={id} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reason} placeholder="Enter verification reason..." error={!!fe.reason} />
            <Counter value={reason} max={LIMITS.reason} />
          </>
        )}
      </Field>
      <ActionError error={error} />
    </Modal>
  )
}

/* ───────────────────── Admin: correct license number ───────────────────── */

export function CorrectLicenseModal({ record, onClose, onSuccess, onStale }) {
  const [licenseNumber, setLicenseNumber] = useState('')
  const [reason, setReason] = useState('')
  const { submit, submitting, error } = useCustodyAction({ record, call: correctLicenseNumber, fields: CORRECT_FIELDS, onSuccess, onStale })

  const values = { licenseNumber: licenseNumber.trim(), reason: reason.trim() }
  const unchanged = values.licenseNumber !== '' && values.licenseNumber === record.license_number
  const valid = !!(values.licenseNumber && values.reason) && !unchanged
  const fe = error?.fieldErrors || {}

  return (
    <Modal
      open onClose={onClose} width={540} mobileFullScreen={false} dismissible={!submitting}
      title="Correct License Number" titleId="cl-correct-title" initialFocus="[data-autofocus]"
      footer={<Footer onClose={onClose} submitting={submitting} submitLabel="Save Correction" icon={Pencil} disabled={!valid} onSubmit={() => valid && submit(values)} />}
    >
      <Alert tone="warning" className="cl-modal-alert">
        This updates the license number used for custody only. The original violation record and its
        archive history are preserved, and every correction is logged.
      </Alert>
      <Summary rows={[
        ['Driver name', record.owner_name],
        ['Current license number', <span className="mono" key="l">{record.license_number}</span>],
        ['Status', statusLabel(record.status)],
      ]} />

      <Field label="New license number" required error={fe.license_number || (unchanged ? 'Enter a number different from the current one.' : undefined)}>
        {(id) => <TextInput id={id} data-autofocus className="mono" value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} maxLength={LIMITS.licenseNumber} autoComplete="off" error={!!fe.license_number || unchanged} />}
      </Field>
      <Field label="Reason for correction" required error={fe.reason}>
        {(id) => (
          <>
            <Textarea id={id} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reason} placeholder="Enter reason for correction..." error={!!fe.reason} />
            <Counter value={reason} max={LIMITS.reason} />
          </>
        )}
      </Field>
      <ActionError error={error} />
    </Modal>
  )
}