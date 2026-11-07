import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import api from '../../services/api'
import { API } from '../../constants'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Alert from '../ui/Alert'
import { Field, TextInput } from '../ui/Field'

const initialForm = { old_password: '', new_password: '', confirm_password: '' }

export default function ChangePasswordModal({ open, onClose }) {
  const [form, setForm] = useState(initialForm)
  const [errors, setErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  const handleClose = () => {
    if (submitting) return
    setForm(initialForm)
    setErrors({})
    setSuccess(false)
    onClose?.()
  }

  const handleChange = (field) => (e) => {
    setForm(f => ({ ...f, [field]: e.target.value }))
    setErrors(er => ({ ...er, [field]: undefined }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (form.new_password.length < 8) {
      setErrors({ new_password: 'New password must be at least 8 characters.' })
      return
    }
    if (form.new_password !== form.confirm_password) {
      setErrors({ confirm_password: 'Passwords do not match.' })
      return
    }

    setSubmitting(true)
    setErrors({})
    try {
      await api.post(API.CHANGE_PASSWORD, form)
      setSuccess(true)
      setForm(initialForm)
    } catch (err) {
      setErrors(err.response?.data || { old_password: 'Something went wrong. Please try again.' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="Change Password" width={420}>
      {success ? (
        <div style={{ textAlign: 'center', padding: '8px 0 4px' }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%', background: 'var(--success-100)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px',
          }}>
            <KeyRound size={22} color="var(--success-600)" aria-hidden="true" />
          </div>
          <div className="text-h3" style={{ marginBottom: 6 }}>Password Changed</div>
          <div className="text-caption" style={{ color: 'var(--slate-500)', marginBottom: 20 }}>
            Your password has been updated successfully.
          </div>
          <Button variant="primary" fullWidth onClick={handleClose}>Done</Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          {errors.old_password && typeof errors.old_password === 'string' && !errors.new_password && !errors.confirm_password && (
            <div style={{ marginBottom: 16 }}><Alert tone="danger">{errors.old_password}</Alert></div>
          )}
          <Field label="Current Password" required error={typeof errors.old_password === 'string' ? errors.old_password : undefined}>
            {(id) => (
              <TextInput
                id={id} type="password" autoComplete="current-password"
                value={form.old_password} onChange={handleChange('old_password')} required
              />
            )}
          </Field>
          <Field label="New Password" required error={errors.new_password} helper="At least 8 characters." style={{ marginTop: 14 }}>
            {(id) => (
              <TextInput
                id={id} type="password" autoComplete="new-password"
                value={form.new_password} onChange={handleChange('new_password')} required minLength={8}
              />
            )}
          </Field>
          <Field label="Confirm New Password" required error={errors.confirm_password} style={{ marginTop: 14 }}>
            {(id) => (
              <TextInput
                id={id} type="password" autoComplete="new-password"
                value={form.confirm_password} onChange={handleChange('confirm_password')} required minLength={8}
              />
            )}
          </Field>

          <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
            <Button type="button" variant="secondary" fullWidth onClick={handleClose} disabled={submitting}>Cancel</Button>
            <Button type="submit" variant="primary" fullWidth loading={submitting}>Change Password</Button>
          </div>
        </form>
      )}
    </Modal>
  )
}