// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'

const get = vi.fn()
const post = vi.fn()
vi.mock('../../../../services/api', () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a) },
}))
const toast = { success: vi.fn(), danger: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../../context/useToast', () => ({ useToast: () => toast }))

import CustodyDetail from '../components/CustodyDetail'
import { detailOf, apiError, routeGet } from './custodyTestUtils'

const EVENT = (o = {}) => ({
  id: 1, event_type: 'marked_ready', created_at: '2024-01-14T07:15:00Z', actor_name: 'Staff User',
  from_status: 'confiscated', to_status: 'ready_for_release', ...o,
})

const setup = (role, detail, timeline = [], extra = {}) => {
  routeGet(get, { detail, timeline: { results: timeline }, ...extra })
  const onBack = vi.fn()
  render(<CustodyDetail role={role} recordKey={detail.key || 'v1'} onBack={onBack} />)
  return { onBack }
}

const btn = (name) => screen.getByRole('button', { name })
const dialog = () => screen.getByRole('dialog')
const detailCalls = () => get.mock.calls.filter(([u]) => /\/v1\/$/.test(u)).length
const timelineCalls = () => get.mock.calls.filter(([u]) => u.endsWith('/timeline/')).length

beforeEach(() => {
  get.mockReset(); post.mockReset()
  Object.values(toast).forEach((f) => f.mockReset())
  window.innerWidth = 1280
})
afterEach(() => { cleanup(); document.body.style.overflow = '' })

describe('CustodyDetail — content', () => {
  it('shows identity, effective license number, status and the custody history', async () => {
    setup('staff', detailOf({ status: 'ready_for_release', ready_marked_at: '2024-01-14T07:15:00Z', ready_marked_by: 'Staff User' }), [EVENT()])
    expect(await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })).toBeTruthy()
    expect(screen.getAllByText('D01-23-456789').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Ready for Release').length).toBeGreaterThan(0)
    expect(screen.getByText(/OVR OVR-2024-00123/)).toBeTruthy()
    const history = within(screen.getByRole('table', { name: /custody history/i }))
    expect(history.getByText('Marked ready for release')).toBeTruthy()
    expect(history.getByText('Staff User')).toBeTruthy()
  })

  it('does not fabricate an "initial confiscation" event or a payment status', async () => {
    setup('staff', detailOf(), [])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    expect(screen.getByText(/no custody actions have been recorded yet/i)).toBeTruthy()
    expect(screen.queryByText(/payment status/i)).toBeNull()
    expect(screen.queryByText(/initial confiscation/i)).toBeNull()
  })

  it('Staff history has no reasons/before-after column', async () => {
    setup('staff', detailOf(), [EVENT()])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    expect(screen.queryByRole('columnheader', { name: /details/i })).toBeNull()
  })

  it('Admin history shows reasons and before/after, and shows the effective license number from the backend only', async () => {
    const events = [EVENT({
      id: 2, event_type: 'license_number_corrected', actor_name: 'Admin User', actor_role: 'admin', from_status: 'confiscated', to_status: 'confiscated',
      details: { reason: 'Typo on ticket', before: { license_number: 'D01-OLD-111' }, after: { license_number: 'D01-23-456789' } },
    })]
    setup('admin', detailOf(), events)
    expect(await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })).toBeTruthy()
    // No reconstructed "original" value anywhere outside the event's own before/after details
    expect(screen.queryByText('Original license number')).toBeNull()
    expect(screen.queryByText('Corrected')).toBeNull()
    expect(screen.getAllByText('D01-23-456789').length).toBeGreaterThan(0)
    expect(screen.getByText('D01-OLD-111 → D01-23-456789')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: /details/i })).toBeTruthy()
    expect(screen.getByText('Typo on ticket')).toBeTruthy()
  })

  it('Staff never sees an original-license row', async () => {
    setup('staff', detailOf(), [EVENT({ id: 2, event_type: 'license_number_corrected' })])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    expect(screen.queryByText('Original license number')).toBeNull()
  })

  it('shows release details with the masked claimant ID once released', async () => {
    setup('staff', detailOf({
      status: 'released',
      release: {
        released_at: '2024-01-15T02:00:00Z', released_by: 'Staff User', released_to_name: 'Juan Dela Cruz',
        claimant_id_type: 'passport', claimant_id: '••••1234', authorization_reference: 'SPA-2024-7', remarks: 'Returned to owner.',
      },
    }), [])
    expect(await screen.findByText('Release Details')).toBeTruthy()
    expect(screen.getByText('Passport')).toBeTruthy()
    expect(screen.getByText('••••1234')).toBeTruthy()
    expect(screen.getByText('SPA-2024-7')).toBeTruthy()
  })

  it('flags legacy records that need verification, and excluded ones', async () => {
    setup('staff', detailOf({ doc_type_status: 'pending', legacy: true, document_type_unverified: true }), [])
    expect(await screen.findByText('Legacy record needs verification')).toBeTruthy()
    cleanup()
    setup('admin', detailOf({ doc_type_status: 'excluded', legacy: true }), [])
    expect(await screen.findByText('Excluded from custody')).toBeTruthy()
  })

  it('labels archived records', async () => {
    setup('admin', detailOf({ key: 'a9', record_kind: 'archived', can_correct: false }), [])
    expect(await screen.findByText('Archived record')).toBeTruthy()
  })

  it('has no license photo or upload UI', async () => {
    setup('admin', detailOf(), [])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    expect(document.querySelector('img, input[type="file"]')).toBeNull()
  })
})

describe('CustodyDetail — states', () => {
  it('404 shows "Record not found" with a way back', async () => {
    routeGet(get, { detail: () => Promise.reject(apiError(404, { code: 'not_found', detail: 'x' })), timeline: { results: [] } })
    const onBack = vi.fn()
    render(<CustodyDetail role="staff" recordKey="v404" onBack={onBack} />)
    expect(await screen.findByText('Record not found')).toBeTruthy()
    fireEvent.click(btn(/back to confiscated licenses/i))
    expect(onBack).toHaveBeenCalled()
  })

  it('a server error shows a safe message and Retry', async () => {
    let fail = true
    routeGet(get, { detail: () => (fail ? Promise.reject(apiError(500, { detail: 'Traceback' })) : detailOf()), timeline: { results: [] } })
    render(<CustodyDetail role="staff" recordKey="v1" onBack={() => {}} />)
    expect(await screen.findByText(/could not load this record/i)).toBeTruthy()
    expect(screen.queryByText(/Traceback/)).toBeNull()
    fail = false
    fireEvent.click(btn(/retry/i))
    expect(await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })).toBeTruthy()
  })

  it('a failed history call does not hide the record, and the history can be retried', async () => {
    setup('staff', detailOf(), [], { timeline: () => Promise.reject(apiError(500, {})) })
    expect(await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })).toBeTruthy()
    expect(await screen.findByText(/could not load custody history/i)).toBeTruthy()
  })
})

describe('CustodyDetail — role and state dependent actions', () => {
  it('Staff, In Custody: Mark Ready enabled; Release, Verify disabled with a reason; no Correct', async () => {
    setup('staff', detailOf(), [])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    expect(btn('Mark Ready for Release').disabled).toBe(false)
    expect(btn('Release License').disabled).toBe(true)
    expect(btn('Verify Legacy Document').disabled).toBe(true)
    expect(screen.getByText(/must be marked ready first/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /correct license number/i })).toBeNull()
    expect(screen.getByText('Available Actions (Staff)')).toBeTruthy()
  })

  it('Admin, active record: Correct License Number is available', async () => {
    setup('admin', detailOf(), [])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    expect(btn('Correct License Number').disabled).toBe(false)
    expect(screen.getByText('Available Actions (Admin)')).toBeTruthy()
  })

  it('Admin, archived record: Correct is disabled with an explanation', async () => {
    setup('admin', detailOf({ key: 'a9', record_kind: 'archived', can_correct: false }), [])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    expect(btn('Correct License Number').disabled).toBe(true)
    expect(screen.getByText(/archived records cannot be corrected/i)).toBeTruthy()
  })

  it('Ready: Release is the enabled action and Mark Ready is closed', async () => {
    setup('staff', detailOf({ status: 'ready_for_release', version: 1 }), [])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    expect(btn('Release License').disabled).toBe(false)
    expect(btn('Mark Ready for Release').disabled).toBe(true)
  })

  it('Released: every action is closed', async () => {
    setup('admin', detailOf({ status: 'released', version: 2, release: { released_at: '2024-01-15T02:00:00Z', released_by: 'S', released_to_name: 'J', claimant_id_type: 'other', claimant_id: '', authorization_reference: 'R', remarks: '' } }), [])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    for (const n of ['Mark Ready for Release', 'Release License', 'Verify Legacy Document']) expect(btn(n).disabled).toBe(true)
  })

  it('Pending legacy: Verify is enabled and Mark Ready is blocked', async () => {
    setup('staff', detailOf({ doc_type_status: 'pending', legacy: true }), [])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    expect(btn('Verify Legacy Document').disabled).toBe(false)
    expect(btn('Mark Ready for Release').disabled).toBe(true)
  })
})

describe('CustodyDetail — Mark Ready flow', () => {
  it('posts the real payload, then refreshes the record and history; success toast only after the backend confirms', async () => {
    let version = 0
    setup('staff', () => detailOf({ version, status: version ? 'ready_for_release' : 'confiscated' }), [])
    post.mockImplementation(() => { version = 1; return Promise.resolve({ data: detailOf({ version: 1, status: 'ready_for_release', replayed: false }) }) })
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    const before = { d: detailCalls(), t: timelineCalls() }

    fireEvent.click(btn('Mark Ready for Release'))
    expect(within(dialog()).getByText(/payment must already be confirmed/i)).toBeTruthy()
    expect(toast.success).not.toHaveBeenCalled()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mark as Ready' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('License marked ready for release.'))
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/api/violations/confiscated-licenses/v1/mark-ready/')
    expect(Object.keys(body).sort()).toEqual(['client_request_id', 'expected_version'])
    expect(body.expected_version).toBe(0)
    expect(body.client_request_id).toMatch(/^[0-9a-f-]{36}$/)
    await waitFor(() => expect(detailCalls()).toBe(before.d + 1))
    expect(timelineCalls()).toBe(before.t + 1)
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(btn('Release License').disabled).toBe(false))
  })

  it('payment_required stays in the dialog as an inline warning: no success toast, no refresh', async () => {
    setup('staff', detailOf(), [])
    post.mockRejectedValue(apiError(409, { code: 'payment_required', detail: 'The violation must be paid before ...' }))
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    const calls = get.mock.calls.length
    fireEvent.click(btn('Mark Ready for Release'))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mark as Ready' }))
    expect(await within(dialog()).findByText('Payment not confirmed')).toBeTruthy()
    expect(within(dialog()).getByText(/must be paid/i)).toBeTruthy()
    expect(toast.success).not.toHaveBeenCalled()
    expect(get.mock.calls.length).toBe(calls)
    // The user can close it and nothing changed
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('blocks duplicate submits while a request is pending, and Escape does not dismiss it', async () => {
    setup('staff', detailOf(), [])
    let resolve
    post.mockImplementation(() => new Promise((r) => { resolve = r }))
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    fireEvent.click(btn('Mark Ready for Release'))
    const confirm = within(dialog()).getByRole('button', { name: 'Mark as Ready' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(post).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(within(dialog()).getByRole('button', { name: 'Cancel' }).disabled).toBe(true)
    resolve({ data: detailOf({ version: 1, status: 'ready_for_release' }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('a stale version closes the dialog, warns, and reloads the latest record', async () => {
    setup('staff', detailOf(), [])
    post.mockRejectedValue(apiError(409, { code: 'version_conflict', detail: 'Reload and try again.', current_version: 3 }))
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    const before = detailCalls()
    fireEvent.click(btn('Mark Ready for Release'))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mark as Ready' }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    expect(toast.warning.mock.calls[0][0]).toMatch(/changed by someone else/i)
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(detailCalls()).toBe(before + 1))
  })

  it('a replayed response is reported as already recorded', async () => {
    setup('staff', detailOf(), [])
    post.mockResolvedValue({ data: detailOf({ version: 1, status: 'ready_for_release', replayed: true }) })
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    fireEvent.click(btn('Mark Ready for Release'))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mark as Ready' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/already recorded/i)))
  })

  it('after a dropped connection, retrying sends the SAME client_request_id', async () => {
    setup('staff', detailOf(), [])
    post.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { request: {} }))
    post.mockResolvedValueOnce({ data: detailOf({ version: 1, status: 'ready_for_release' }) })
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    fireEvent.click(btn('Mark Ready for Release'))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mark as Ready' }))
    expect(await within(dialog()).findByText(/may not have been saved/i)).toBeTruthy()
    expect(toast.success).not.toHaveBeenCalled()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mark as Ready' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls[1][1].client_request_id).toBe(post.mock.calls[0][1].client_request_id)
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })
})

describe('CustodyDetail — Release flow', () => {
  const ready = () => detailOf({ status: 'ready_for_release', version: 4, ready_marked_at: '2024-01-14T07:15:00Z' })
  const open = async () => {
    setup('staff', ready(), [])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    fireEvent.click(btn('Release License'))
  }
  const confirm = () => within(dialog()).getByRole('button', { name: 'Release License' })

  it('requires the fields the backend requires, and only those', async () => {
    await open()
    expect(confirm().disabled).toBe(true)
    fireEvent.change(within(dialog()).getByLabelText(/^released to/i), { target: { value: 'Juan Dela Cruz' } })
    expect(confirm().disabled).toBe(true)
    fireEvent.change(within(dialog()).getByLabelText(/claimant id type/i), { target: { value: 'passport' } })
    expect(confirm().disabled).toBe(true)
    fireEvent.change(within(dialog()).getByLabelText(/authorization reference/i), { target: { value: '   ' } })
    expect(confirm().disabled).toBe(true)
    fireEvent.change(within(dialog()).getByLabelText(/authorization reference/i), { target: { value: 'SPA-2024-7' } })
    expect(confirm().disabled).toBe(false)
  })

  it('sends exactly the accepted fields, trims them, and caps the ID to 4 alphanumerics', async () => {
    await open()
    post.mockResolvedValue({ data: detailOf({ status: 'released', version: 5 }) })
    fireEvent.change(within(dialog()).getByLabelText(/^released to/i), { target: { value: '  Juan Dela Cruz ' } })
    fireEvent.change(within(dialog()).getByLabelText(/claimant id type/i), { target: { value: 'umid' } })
    fireEvent.change(within(dialog()).getByLabelText(/last 4 characters/i), { target: { value: 'ab-12-9999' } })
    fireEvent.change(within(dialog()).getByLabelText(/authorization reference/i), { target: { value: ' SPA-2024-7 ' } })
    fireEvent.change(within(dialog()).getByLabelText(/remarks/i), { target: { value: ' Returned to owner. ' } })
    expect(within(dialog()).getByLabelText(/last 4 characters/i).value).toBe('ab12')
    fireEvent.click(confirm())
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/api/violations/confiscated-licenses/v1/release/')
    expect(body).toMatchObject({
      expected_version: 4, released_to_name: 'Juan Dela Cruz', claimant_id_type: 'umid', claimant_id_last4: 'ab12',
      authorization_reference: 'SPA-2024-7', release_remarks: 'Returned to owner.',
    })
    expect(Object.keys(body).sort()).toEqual([
      'authorization_reference', 'claimant_id_last4', 'claimant_id_type', 'client_request_id',
      'expected_version', 'release_remarks', 'released_to_name',
    ])
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('License released.'))
  })

  it('shows backend field errors next to the fields', async () => {
    await open()
    post.mockRejectedValue(apiError(400, { authorization_reference: ['Enter the authorization reference.'], claimant_id_last4: ['Enter at most the last 4 letters/digits of the ID.'] }))
    fireEvent.change(within(dialog()).getByLabelText(/^released to/i), { target: { value: 'Juan' } })
    fireEvent.change(within(dialog()).getByLabelText(/claimant id type/i), { target: { value: 'other' } })
    fireEvent.change(within(dialog()).getByLabelText(/authorization reference/i), { target: { value: 'x' } })
    fireEvent.click(confirm())
    expect(await within(dialog()).findByText('Enter the authorization reference.')).toBeTruthy()
    expect(within(dialog()).getByText(/at most the last 4/i)).toBeTruthy()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('already_released closes the dialog and reloads instead of retrying', async () => {
    await open()
    post.mockRejectedValue(apiError(409, { code: 'already_released', detail: 'This license was already released.' }))
    fireEvent.change(within(dialog()).getByLabelText(/^released to/i), { target: { value: 'Juan' } })
    fireEvent.change(within(dialog()).getByLabelText(/claimant id type/i), { target: { value: 'other' } })
    fireEvent.change(within(dialog()).getByLabelText(/authorization reference/i), { target: { value: 'x' } })
    fireEvent.click(confirm())
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('This license was already released.'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('CustodyDetail — Legacy verification', () => {
  const pending = () => detailOf({ doc_type_status: 'pending', legacy: true, document_type_unverified: true, version: 2 })

  it('Staff: only "Confirm as driver\'s license" is offered (no exclusion), reason required', async () => {
    setup('staff', pending(), [])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    fireEvent.click(btn('Verify Legacy Document'))
    const d = within(dialog())
    expect(d.getAllByRole('radio').length).toBe(1)
    expect(d.getByRole('radio', { name: /confirm as driver/i }).checked).toBe(true)
    expect(d.queryByRole('radio', { name: /exclude/i })).toBeNull()
    expect(d.getByRole('button', { name: 'Submit Verification' }).disabled).toBe(true)
    post.mockResolvedValue({ data: detailOf({ doc_type_status: 'confirmed_drivers_license', version: 3 }) })
    fireEvent.change(d.getByLabelText(/^reason/i), { target: { value: ' Seen in legacy ledger ' } })
    fireEvent.click(d.getByRole('button', { name: 'Submit Verification' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/api/violations/confiscated-licenses/v1/verify-document-type/')
    expect(body).toMatchObject({ expected_version: 2, decision: 'drivers_license', reason: 'Seen in legacy ledger' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Legacy record confirmed as a driver's license."))
  })

  it('Admin: both decisions are offered, none preselected, and exclusion warns it is permanent', async () => {
    setup('admin', pending(), [])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    fireEvent.click(btn('Verify Legacy Document'))
    const d = within(dialog())
    expect(d.getAllByRole('radio').length).toBe(2)
    expect(d.getAllByRole('radio').some((r) => r.checked)).toBe(false)
    fireEvent.change(d.getByLabelText(/^reason/i), { target: { value: 'Not a license' } })
    expect(d.getByRole('button', { name: 'Submit Verification' }).disabled).toBe(true)
    fireEvent.click(d.getByRole('radio', { name: /exclude/i }))
    expect(d.getByText(/cannot be undone from this screen/i)).toBeTruthy()
    post.mockResolvedValue({ data: detailOf({ doc_type_status: 'excluded', version: 3 }) })
    fireEvent.click(d.getByRole('button', { name: 'Submit Verification' }))
    await waitFor(() => expect(post.mock.calls[0][1].decision).toBe('not_drivers_license'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Legacy record excluded from custody.'))
  })

  it('a 403 admin_required from the server is shown inline', async () => {
    setup('staff', pending(), [])
    post.mockRejectedValue(apiError(403, { code: 'admin_required', detail: 'Only an Administrator may exclude a record as not a driver\'s license.' }))
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    fireEvent.click(btn('Verify Legacy Document'))
    fireEvent.change(within(dialog()).getByLabelText(/^reason/i), { target: { value: 'x' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Submit Verification' }))
    expect(await within(dialog()).findByText(/only an administrator/i)).toBeTruthy()
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('CustodyDetail — Admin correction', () => {
  const open = async (detail = detailOf({ version: 6 })) => {
    setup('admin', detail, [])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    fireEvent.click(btn('Correct License Number'))
  }
  const save = () => within(dialog()).getByRole('button', { name: 'Save Correction' })

  it('shows the current effective value and the preservation notice', async () => {
    await open()
    expect(within(dialog()).getByText('Current license number')).toBeTruthy()
    expect(within(dialog()).getAllByText('D01-23-456789').length).toBeGreaterThan(0)
    expect(within(dialog()).getByText(/original violation record and its archive history are preserved/i)).toBeTruthy()
  })

  it('requires a new number and a reason, and refuses an unchanged number client-side', async () => {
    await open()
    expect(save().disabled).toBe(true)
    fireEvent.change(within(dialog()).getByLabelText(/new license number/i), { target: { value: 'D01-23-456789' } })
    fireEvent.change(within(dialog()).getByLabelText(/reason for correction/i), { target: { value: 'typo' } })
    expect(save().disabled).toBe(true)
    expect(within(dialog()).getByText(/different from the current one/i)).toBeTruthy()
    fireEvent.change(within(dialog()).getByLabelText(/new license number/i), { target: { value: 'D01-23-456780' } })
    expect(save().disabled).toBe(false)
  })

  it('posts license_number + reason, then confirms', async () => {
    await open()
    post.mockResolvedValue({ data: detailOf({ version: 7, license_number: 'D01-23-456780' }) })
    fireEvent.change(within(dialog()).getByLabelText(/new license number/i), { target: { value: ' D01-23-456780 ' } })
    fireEvent.change(within(dialog()).getByLabelText(/reason for correction/i), { target: { value: ' Typo on ticket ' } })
    fireEvent.click(save())
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/api/violations/confiscated-licenses/v1/correct/')
    expect(body).toMatchObject({ expected_version: 6, license_number: 'D01-23-456780', reason: 'Typo on ticket' })
    expect(Object.keys(body).sort()).toEqual(['client_request_id', 'expected_version', 'license_number', 'reason'])
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('License number corrected.'))
  })

  it('no_change from the server stays inline and does not refresh', async () => {
    await open()
    post.mockRejectedValue(apiError(409, { code: 'no_change', detail: 'The license number is already recorded as entered.' }))
    fireEvent.change(within(dialog()).getByLabelText(/new license number/i), { target: { value: 'D01-23-456780' } })
    fireEvent.change(within(dialog()).getByLabelText(/reason for correction/i), { target: { value: 'typo' } })
    const calls = get.mock.calls.length
    fireEvent.click(save())
    expect(await within(dialog()).findByText(/already recorded as entered/i)).toBeTruthy()
    expect(toast.success).not.toHaveBeenCalled()
    expect(get.mock.calls.length).toBe(calls)
  })

  it('a stale version closes the dialog and reloads; a 403 stays inline', async () => {
    await open()
    post.mockRejectedValueOnce(apiError(403, { detail: 'You do not have permission to perform this action.' }))
    fireEvent.change(within(dialog()).getByLabelText(/new license number/i), { target: { value: 'D01-23-456780' } })
    fireEvent.change(within(dialog()).getByLabelText(/reason for correction/i), { target: { value: 'typo' } })
    fireEvent.click(save())
    expect(await within(dialog()).findByText(/do not have permission/i)).toBeTruthy()
    post.mockRejectedValueOnce(apiError(409, { code: 'version_conflict', detail: 'x', current_version: 9 }))
    fireEvent.click(save())
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('CustodyDetail — modal accessibility', () => {
  it('is a labelled modal dialog that closes on Escape when idle, and restores focus', async () => {
    setup('staff', detailOf(), [])
    await screen.findByRole('heading', { name: 'JUAN DELA CRUZ' })
    const trigger = btn('Mark Ready for Release')
    trigger.focus()
    fireEvent.click(trigger)
    const d = dialog()
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(within(d).getByText('Mark as Ready for Release')).toBeTruthy()
    // confirmation dialogs start on the safe choice
    expect(document.activeElement.textContent).toBe('Cancel')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})