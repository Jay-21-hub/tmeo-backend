import { useState } from 'react'
import api from '../../services/api'
import { API } from '../../constants'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Alert from '../ui/Alert'
import { Field, TextInput, Select } from '../ui/Field'
import { FormSection } from '../ui/FormSection'

const CIVIL_STATUS = [
  { value: '',          label: 'Select...' },
  { value: 'single',    label: 'Single' },
  { value: 'married',   label: 'Married' },
  { value: 'widowed',   label: 'Widowed' },
  { value: 'separated', label: 'Separated' },
  { value: 'divorced',  label: 'Divorced' },
]

/**
 * ProfileEditForm — self-service edit of personal details only. Deliberately
 * does NOT expose employment_status or badge_number here: those stay
 * admin-managed via UserDetailView, matching the pre-existing backend
 * boundary (UpdateUserSerializer is shared, but MeView only ever acts on
 * request.user, so a self-edit couldn't reach another user's employment
 * fields anyway — this just keeps the self-service UI honest about that).
 *
 * Full Name and Date of Birth are shown READ-ONLY: SelfUpdateUserSerializer
 * only accepts phone_number, address, civil_status (and profile_photo), so
 * the previous editable inputs were silently ignored by the server and the
 * Profile appeared not to update. Only the fields the backend really saves
 * are sent.
 */
export default function ProfileEditForm({ user, open, onClose, onUpdated }) {
  const [form, setForm] = useState({
    full_name:     user?.full_name || '',
    phone_number:  user?.phone_number || '',
    address:       user?.address || '',
    date_of_birth: user?.date_of_birth || '',
    civil_status:  user?.civil_status || '',
  })
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleChange = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }))

  const handleClose = () => {
    if (submitting) return
    setError('')
    onClose?.()
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const { phone_number, address, civil_status } = form
      const res = await api.patch(API.ME, { phone_number, address, civil_status })
      onUpdated?.(res.data.user)
      handleClose()
    } catch (err) {
      const data = err.response?.data
      setError(
        typeof data === 'string' ? data
        : data ? Object.values(data).flat().join(' ')
        : 'Could not update profile. Please try again.'
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="Edit Profile" width={480}>
      <form onSubmit={handleSubmit}>
        {error && <div style={{ marginBottom: 16 }}><Alert tone="danger">{error}</Alert></div>}

        <FormSection title="Personal Information" columns={2}>
          <Field label="Full Name" helper="Managed by the administrator" style={{ gridColumn: '1 / -1' }}>
            {(id) => <TextInput id={id} value={form.full_name} readOnly aria-readonly="true" style={{ background: 'var(--slate-100)', color: 'var(--slate-600)', cursor: 'not-allowed' }} />}
          </Field>
          <Field label="Phone Number">
            {(id) => <TextInput id={id} value={form.phone_number} onChange={handleChange('phone_number')} placeholder="09XX XXX XXXX" />}
          </Field>
          <Field label="Date of Birth" helper="Managed by the administrator">
            {(id) => <TextInput id={id} type="date" value={form.date_of_birth || ''} readOnly aria-readonly="true" style={{ background: 'var(--slate-100)', color: 'var(--slate-600)', cursor: 'not-allowed' }} />}
          </Field>
          <Field label="Civil Status">
            {(id) => (
              <Select id={id} value={form.civil_status} onChange={handleChange('civil_status')}>
                {CIVIL_STATUS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Address" style={{ gridColumn: '1 / -1' }}>
            {(id) => <TextInput id={id} value={form.address} onChange={handleChange('address')} />}
          </Field>
        </FormSection>

        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <Button type="button" variant="secondary" fullWidth onClick={handleClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" variant="primary" fullWidth loading={submitting}>Save Changes</Button>
        </div>
      </form>
    </Modal>
  )
}