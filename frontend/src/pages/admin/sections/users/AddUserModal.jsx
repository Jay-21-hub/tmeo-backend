import { useState } from 'react'
import { Hash, Plus, Save, CheckCircle, ArrowRight, ArrowLeft } from 'lucide-react'
import api from '../../../../services/api'
import Modal from '../../../../components/ui/Modal'
import Button from '../../../../components/ui/Button'
import Alert from '../../../../components/ui/Alert'
import { Field, TextInput, Select } from '../../../../components/ui/Field'
import {
  EMPTY_FORM, ROLE_LABELS, CIVIL_STATUS_OPTIONS,
  EMPLOYMENT_STATUS_OPTIONS,
} from './userManagementConfig'
import { buildDisplayName, displayUserName } from './userDisplayName'
import { toTitleCase, isValidPHPhone } from '../../../../utils/helpers'

const STEPS = [
  { num: 1, label: 'Personal Info' },
  { num: 2, label: 'Role & Employment' },
  { num: 3, label: 'Account Setup' },
]

/* Same visual pattern as AssessmentFormSteps' StepIndicator, scoped locally
   since the labels/step count here are specific to this wizard. */
function StepIndicator({ current, steps }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 24, flexWrap: 'wrap' }}>
      {steps.map((step, idx) => {
        const done = current > step.num
        const active = current === step.num
        return (
          <div key={step.num} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <div style={{
                width: 38, height: 38, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 700, fontSize: 14, transition: 'all 0.2s',
                background: done ? 'var(--success-600)' : active ? 'var(--blue-600)' : 'var(--slate-200)',
                color: done || active ? '#fff' : 'var(--slate-400)',
                boxShadow: active ? 'var(--shadow-focus)' : 'none',
              }}>
                {done ? '✓' : step.num}
              </div>
              <span style={{ fontSize: 11, fontWeight: active ? 700 : 500, color: active ? 'var(--blue-600)' : done ? 'var(--success-600)' : 'var(--slate-400)', whiteSpace: 'nowrap', textAlign: 'center', maxWidth: 90 }}>{step.label}</span>
            </div>
            {idx < steps.length - 1 && <div style={{ width: 56, height: 2, background: current > step.num ? 'var(--success-600)' : 'var(--slate-200)', margin: '0 4px 20px', transition: 'background 0.3s', flexShrink: 0 }} />}
          </div>
        )
      })}
    </div>
  )
}

/* A field the backend won't accept an edit for (role, hired_year —
   not part of UpdateUserSerializer). Shown read-only so the admin still sees
   the value without being able to change it here. */
function ReadOnlyField({ label, value }) {
  return (
    <Field label={label} helper="Not editable here">
      {id => <TextInput id={id} value={value ?? ''} disabled readOnly />}
    </Field>
  )
}

function userToFormValues(user) {
  return {
    last_name: user.last_name || '',
    first_name: user.first_name || '',
    middle_name: user.middle_name || '',
    email: user.email || '',
    phone_number: user.phone_number || '',
    address: user.address || '',
    date_of_birth: user.date_of_birth || '',
    civil_status: user.civil_status || '',
    role: user.role || 'enforcer',
    badge_number: user.badge_number || '',
    assigned_area: user.assigned_area || '',
    hired_year: user.hired_year || new Date().getFullYear(),
    employment_status: user.employment_status || 'active',
  }
}

export default function AddUserModal({ onClose, onSuccess, mode = 'create', user = null }) {
  const isEdit = mode === 'edit'
  const steps = isEdit ? STEPS.map(s => s.num === 3 ? { ...s, label: 'Review' } : s) : STEPS

  const [step, setStep] = useState(1)
  const [form, setForm] = useState(isEdit && user ? userToFormValues(user) : EMPTY_FORM)
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState({})
  const [createdUser, setCreatedUser] = useState(null)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const validateStep1 = () => {
    const e = {}
    if (!form.first_name.trim()) e.first_name = 'First name is required'
    if (!form.last_name.trim()) e.last_name = 'Last name is required'
    if (!form.email.trim()) e.email = 'Email is required'
    if (form.phone_number.trim() && !isValidPHPhone(form.phone_number)) e.phone_number = 'Must be 11 digits starting with 09'
    if (!form.address.trim()) e.address = 'Address is required'
    if (!form.date_of_birth) e.date_of_birth = 'Date of birth is required'
    if (!form.civil_status) e.civil_status = 'Civil status is required'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const validateStep2 = () => {
    const e = {}
    if (form.role === 'enforcer' && !form.badge_number.trim()) e.badge_number = 'Badge number is required'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const validateStep3 = () => {
    if (isEdit) return true
    const e = {}
    if (!form.password.trim()) e.password = 'Password is required'
    if (form.password.length > 0 && form.password.length < 6) e.password = 'At least 6 characters'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const goNext = () => {
    const ok = step === 1 ? validateStep1() : validateStep2()
    if (!ok) return
    setErrors({})
    setStep(s => s + 1)
  }

  const goBack = () => {
    setErrors({})
    setStep(s => s - 1)
  }

  const handleCreate = async () => {
    const payload = { ...form }
    if (form.role !== 'enforcer') {
      delete payload.badge_number
      delete payload.assigned_area
    }
    const res = await api.post('/api/auth/users/', payload)
    setCreatedUser(res.data)
    onSuccess('User created successfully!')
  }

  const handleEdit = async () => {
    const payload = {
      last_name: form.last_name,
      first_name: form.first_name,
      middle_name: form.middle_name,
      phone_number: form.phone_number,
      address: form.address,
      date_of_birth: form.date_of_birth,
      civil_status: form.civil_status,
      employment_status: form.employment_status,
    }
    // Email is sent only when the admin actually changed it, so an unrelated
    // edit never touches it (and never creates an email change in the audit log).
    const newEmail = form.email.trim()
    if (newEmail !== (user.email || '')) payload.email = newEmail
    if (form.role === 'enforcer') {
      payload.badge_number = form.badge_number
      payload.assigned_area = form.assigned_area
    }
    await api.patch(`/api/auth/users/${user.id}/`, payload)
    onSuccess('User updated successfully!')
    onClose()
  }

  const handleSubmit = async () => {
    if (!validateStep3()) return
    setLoading(true)
    try {
      if (isEdit) await handleEdit()
      else await handleCreate()
    } catch (err) {
      const firstFieldError = err.response?.data && typeof err.response.data === 'object'
        ? Object.values(err.response.data)[0]
        : null
      const msg = err.response?.data?.detail
        || (Array.isArray(firstFieldError) ? firstFieldError[0] : firstFieldError)
        || `Failed to ${isEdit ? 'update' : 'create'} user`
      setErrors({ submit: msg })
    } finally {
      setLoading(false)
    }
  }

  /* ── Success screen (create only) — shows generated ID + password ── */
  if (createdUser) {
    return (
      <Modal open onClose={onClose} width={440} footer={<Button onClick={onClose} fullWidth>Done</Button>}>
        <div style={{ margin: '-24px -24px 20px', padding: '20px 24px', background: 'var(--success-50)', borderBottom: '1px solid var(--success-100)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ background: 'var(--success-100)', borderRadius: '50%', padding: 8, display: 'flex', flexShrink: 0 }}>
            <CheckCircle size={22} color="var(--success-600)" />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--slate-950)' }}>Account Created!</h2>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--success-600)', fontWeight: 500 }}>Share the login credentials below with the user</p>
          </div>
        </div>

        <div style={{ background: 'var(--navy-800)', borderRadius: 'var(--radius-lg)', padding: '20px 24px', marginBottom: 16 }}>
          <p style={{ margin: '0 0 16px', fontSize: 11, fontWeight: 700, color: '#93c5fd', textTransform: 'uppercase', letterSpacing: '0.08em' }}>🔑 Login Credentials</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <p style={{ margin: '0 0 4px', fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>ID Number (use this to log in)</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="mono" style={{ fontSize: 22, fontWeight: 800, color: '#facc15', letterSpacing: '0.05em' }}>{createdUser.id_number}</span>
                <button onClick={() => navigator.clipboard?.writeText(createdUser.id_number)} title="Copy ID Number" style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: '#93c5fd', fontSize: 11, fontWeight: 600 }}>Copy</button>
              </div>
            </div>
            <div>
              <p style={{ margin: '0 0 4px', fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>Password</p>
              <span className="mono" style={{ fontSize: 15, fontWeight: 700, color: '#a5f3fc' }}>{form.password}</span>
            </div>
          </div>
        </div>

        <div style={{ background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', overflow: 'hidden' }}>
          {[
            { label: 'Full Name', value: displayUserName(createdUser) },
            { label: 'Email', value: createdUser.email },
            { label: 'Role', value: ROLE_LABELS[createdUser.role] || createdUser.role },
            ...(createdUser.role === 'enforcer' ? [{ label: 'Badge No.', value: createdUser.badge_number || '—' }] : []),
          ].map(({ label, value }, i, arr) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: i < arr.length - 1 ? '1px solid var(--slate-100)' : 'none' }}>
              <span className="text-caption" style={{ fontWeight: 500 }}>{label}</span>
              <span style={{ fontSize: 13, color: 'var(--slate-950)', fontWeight: 600 }}>{value}</span>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 14 }}>
          <Alert tone="warning">Make sure to note the <strong>ID Number</strong> — this is what the user will type in the login screen. It cannot be changed.</Alert>
        </div>
      </Modal>
    )
  }

  const footer = (
    <>
      {step === 1 ? (
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      ) : (
        <Button variant="secondary" onClick={goBack} icon={ArrowLeft}>Back</Button>
      )}
      {step < 3 ? (
        <Button onClick={goNext} iconRight={ArrowRight}>Next</Button>
      ) : (
        <Button onClick={handleSubmit} loading={loading} icon={isEdit ? Save : Plus}>
          {loading ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save Changes' : 'Create User')}
        </Button>
      )}
    </>
  )

  return (
    <Modal open onClose={onClose} width={520} title={isEdit ? 'Edit User' : 'Add New User'} footer={footer}>
      <p className="text-caption" style={{ marginTop: -12, marginBottom: 4 }}>
        {isEdit ? `Update ${user ? displayUserName(user) : 'user'}'s account details` : 'Fill in user account details'}
      </p>

      <StepIndicator current={step} steps={steps} />

      {errors.submit && <div style={{ marginBottom: 14 }}><Alert tone="danger">{errors.submit}</Alert></div>}

      {step === 1 && (
        <div style={{ display: 'grid', gap: 14 }}>
          <Field label="First Name" required error={errors.first_name}>
            {id => <TextInput id={id} value={form.first_name} onChange={e => set('first_name', e.target.value)} onBlur={e => set('first_name', toTitleCase(e.target.value))} placeholder="First Name" error={!!errors.first_name} />}
          </Field>
          <Field label="Middle Name" helper="Optional">
            {id => <TextInput id={id} value={form.middle_name} onChange={e => set('middle_name', e.target.value)} onBlur={e => set('middle_name', toTitleCase(e.target.value))} placeholder="Middle Name" />}
          </Field>
          <Field label="Last Name" required error={errors.last_name}>
            {id => <TextInput id={id} value={form.last_name} onChange={e => set('last_name', e.target.value)} onBlur={e => set('last_name', toTitleCase(e.target.value))} placeholder="Last Name" error={!!errors.last_name} />}
          </Field>
          <Field
            label="Email"
            required
            error={errors.email}
            helper={isEdit ? 'Password resets are sent to this address. Change it first if the old one is no longer accessible.' : undefined}
          >
            {id => <TextInput id={id} type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="Email" error={!!errors.email} />}
          </Field>
          <Field label="Phone" error={errors.phone_number} helper="11 digits, starts with 09">
            {id => <TextInput id={id} value={form.phone_number} onChange={e => set('phone_number', e.target.value.replace(/\D/g, '').slice(0, 11))} placeholder="09xxxxxxxxx" error={!!errors.phone_number} inputMode="numeric" maxLength={11} />}
          </Field>
          <Field label="Address" required error={errors.address}>
            {id => <TextInput id={id} value={form.address} onChange={e => set('address', e.target.value)} placeholder="House No., Street, Barangay, City" error={!!errors.address} />}
          </Field>
          <Field label="Date of Birth" required error={errors.date_of_birth}>
            {id => <TextInput id={id} type="date" value={form.date_of_birth} onChange={e => set('date_of_birth', e.target.value)} error={!!errors.date_of_birth} />}
          </Field>
          <Field label="Civil Status" required error={errors.civil_status}>
            {id => (
              <Select id={id} value={form.civil_status} onChange={e => set('civil_status', e.target.value)} error={!!errors.civil_status}>
                <option value="">Select civil status</option>
                {CIVIL_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            )}
          </Field>
        </div>
      )}

      {step === 2 && (
        <div style={{ display: 'grid', gap: 14 }}>
          {!isEdit && (
            <div style={{ marginBottom: 2 }}>
              <Alert tone="info">
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <Hash size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>The <strong>ID Number</strong> (used for login) will be <strong>auto-generated</strong> based on the role and hired year. It will be shown after the account is created.</span>
                </div>
              </Alert>
            </div>
          )}
          {isEdit ? (
            <>
              <ReadOnlyField label="Role" value={ROLE_LABELS[form.role] || form.role} />
              <ReadOnlyField label="Hired Year" value={form.hired_year} />
              <Field label="Employment Status">
                {id => (
                  <Select id={id} value={form.employment_status} onChange={e => set('employment_status', e.target.value)}>
                    {EMPLOYMENT_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                )}
              </Field>
            </>
          ) : (
            <>
              <Field label="Role">
                {id => (
                  <Select id={id} value={form.role} onChange={e => set('role', e.target.value)}>
                    <option value="enforcer">Traffic Enforcer</option>
                    <option value="staff">Assessment Staff</option>
                    <option value="admin">Administrator</option>
                  </Select>
                )}
              </Field>
              <Field label="Hired Year">
                {id => <TextInput id={id} type="number" value={form.hired_year} onChange={e => set('hired_year', parseInt(e.target.value) || new Date().getFullYear())} min="2000" max={new Date().getFullYear()} />}
              </Field>
            </>
          )}
          {form.role === 'enforcer' && (
            <>
              <Field label="Badge Number" required error={errors.badge_number}>
                {id => <TextInput id={id} value={form.badge_number} onChange={e => set('badge_number', e.target.value)} placeholder="Badge Number" error={!!errors.badge_number} />}
              </Field>
              <Field label="Assigned Area" helper="Field deployment area — enforcers only">
                {id => <TextInput id={id} value={form.assigned_area} onChange={e => set('assigned_area', e.target.value)} placeholder="e.g. Barangay 1–5, City Center" />}
              </Field>
            </>
          )}
        </div>
      )}

      {step === 3 && (
        <div style={{ display: 'grid', gap: 16 }}>
          {!isEdit && (
            <Field label="Password" required error={errors.password}>
              {id => <TextInput id={id} type="password" value={form.password} onChange={e => set('password', e.target.value)} placeholder="Min. 6 characters" error={!!errors.password} />}
            </Field>
          )}

          <div>
            <p className="text-label" style={{ marginBottom: 8 }}>Review</p>
            <div style={{ background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', overflow: 'hidden' }}>
              {[
                { label: 'Full Name', value: buildDisplayName(form.first_name, form.middle_name, form.last_name) || '—' },
                { label: 'Email', value: form.email || '—' },
                { label: 'Phone', value: form.phone_number || '—' },
                { label: 'Address', value: form.address || '—' },
                { label: 'Date of Birth', value: form.date_of_birth || '—' },
                { label: 'Civil Status', value: CIVIL_STATUS_OPTIONS.find(o => o.value === form.civil_status)?.label || '—' },
                { label: 'Role', value: ROLE_LABELS[form.role] || form.role },
                ...(form.role === 'enforcer' ? [
                  { label: 'Badge Number', value: form.badge_number || '—' },
                  { label: 'Assigned Area', value: form.assigned_area || '—' },
                ] : []),
                { label: 'Hired Year', value: form.hired_year },
                ...(isEdit ? [{ label: 'Employment Status', value: EMPLOYMENT_STATUS_OPTIONS.find(o => o.value === form.employment_status)?.label || '—' }] : []),
              ].map(({ label, value }, i, arr) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 14px', borderBottom: i < arr.length - 1 ? '1px solid var(--slate-100)' : 'none' }}>
                  <span className="text-caption" style={{ fontWeight: 500 }}>{label}</span>
                  <span style={{ fontSize: 13, color: 'var(--slate-950)', fontWeight: 600 }}>{value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}