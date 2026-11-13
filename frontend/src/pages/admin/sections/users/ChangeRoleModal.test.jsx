// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'

const changeUserRole = vi.fn()
vi.mock('../../../../services/api', () => ({ changeUserRole: (...a) => changeUserRole(...a) }))

import ChangeRoleModal from './ChangeRoleModal'
import { getRoleChangeError } from './roleChangeErrors'

const staffUser = { id: 9, role: 'staff', full_name: 'Dela Cruz, Juan', email: 'juan@example.com', id_number: 'STF-2024-0001' }
const enforcerUser = { ...staffUser, role: 'enforcer', id_number: 'ENF-2024-0001' }

const SUCCESS = {
  message: 'Dela Cruz, Juan is now Traffic Enforcer. They must sign in again with their new ID number.',
  user: { id: 9, full_name: 'Dela Cruz, Juan', role: 'enforcer', id_number: '2024-ENF-0002', hired_year: 2024 },
  previous: { role: 'staff', id_number: '2024-STF-0001' },
  effective_at: '2026-10-07T00:00:00Z',
  sessions_invalidated: true,
}

const setup = (user = staffUser, props = {}) => {
  const handlers = { onClose: vi.fn(), onChanged: vi.fn(), onStale: vi.fn(), ...props }
  render(<ChangeRoleModal user={user} {...handlers} />)
  return handlers
}
const reasonBox = () => screen.getByLabelText(/reason for change/i)
const submitBtn = () => screen.getByRole('button', { name: /^change role$|changing/i })
const apiError = (status, data) => ({ response: { status, data } })

beforeEach(() => changeUserRole.mockReset())
afterEach(() => { cleanup(); document.body.style.overflow = '' })

describe('ChangeRoleModal', () => {
  it('shows the account, the fixed current -> new role, and what will happen', () => {
    setup()
    expect(screen.getByText('Juan Dela Cruz')).toBeTruthy()
    expect(screen.getByText(/STF-2024-0001/)).toBeTruthy()
    expect(screen.getByText('Assessment Staff')).toBeTruthy()
    expect(screen.getByText('Traffic Enforcer')).toBeTruthy()
    expect(screen.getAllByText(/new ID number/i, { selector: 'strong' }).length).toBeGreaterThan(0)
  })

  it('goes enforcer -> staff for an enforcer', () => {
    setup(enforcerUser)
    const roles = screen.getAllByText(/Assessment Staff|Traffic Enforcer/).map(n => n.textContent)
    expect(roles).toEqual(['Traffic Enforcer', 'Assessment Staff'])
  })

  it('has no ID number input (the server assigns it)', () => {
    setup()
    expect(screen.queryByLabelText(/id number/i)).toBeNull()
    expect(document.querySelectorAll('input').length).toBe(0)
  })

  it('keeps submit disabled until a non-blank reason is typed', () => {
    setup()
    expect(submitBtn().disabled).toBe(true)
    fireEvent.change(reasonBox(), { target: { value: '    ' } })
    expect(submitBtn().disabled).toBe(true)
    fireEvent.change(reasonBox(), { target: { value: 'Reassigned' } })
    expect(submitBtn().disabled).toBe(false)
  })

  it('caps the reason at 500 characters and shows a counter', () => {
    setup()
    expect(reasonBox().maxLength).toBe(500)
    fireEvent.change(reasonBox(), { target: { value: 'abc' } })
    expect(screen.getByText('3/500')).toBeTruthy()
  })

  it('submits the trimmed reason with expectedRole and reports the server response', async () => {
    changeUserRole.mockResolvedValue({ data: SUCCESS })
    const h = setup()
    fireEvent.change(reasonBox(), { target: { value: '  Field duty  ' } })
    fireEvent.click(submitBtn())
    await waitFor(() => expect(h.onChanged).toHaveBeenCalledWith(SUCCESS))
    expect(changeUserRole).toHaveBeenCalledTimes(1)
    expect(changeUserRole).toHaveBeenCalledWith(9, { newRole: 'enforcer', reason: 'Field duty', expectedRole: 'staff' })
    expect(h.onStale).not.toHaveBeenCalled()
  })

  it('blocks a double submit and dismissal while the request is in flight', async () => {
    let resolve
    changeUserRole.mockReturnValue(new Promise(r => { resolve = r }))
    const h = setup()
    fireEvent.change(reasonBox(), { target: { value: 'Reason' } })
    fireEvent.click(submitBtn())
    await waitFor(() => expect(screen.getByRole('button', { name: /changing/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /changing/i }))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.mouseDown(document.querySelector('.modal-overlay'))
    fireEvent.click(screen.getByRole('button', { name: /close dialog/i }))
    expect(screen.getByRole('button', { name: /^cancel$/i }).disabled).toBe(true)
    expect(h.onClose).not.toHaveBeenCalled()
    expect(changeUserRole).toHaveBeenCalledTimes(1)
    resolve({ data: SUCCESS })
    await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1))
  })

  it('closes via Cancel and Escape when idle', () => {
    const h = setup()
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(h.onClose).toHaveBeenCalledTimes(2)
  })

  it('shows the backend message, keeps the modal open and the reason, and allows retry', async () => {
    changeUserRole.mockRejectedValueOnce(apiError(409, {
      code: 'schedules_exist', error: 'This enforcer still has schedules dated today or later. Remove them before changing the role.',
    }))
    const h = setup(enforcerUser)
    fireEvent.change(reasonBox(), { target: { value: 'Desk work' } })
    fireEvent.click(submitBtn())
    expect((await screen.findByRole('alert')).textContent).toMatch(/schedules dated today or later/i)
    expect(h.onChanged).not.toHaveBeenCalled()
    expect(h.onStale).not.toHaveBeenCalled()
    expect(reasonBox().value).toBe('Desk work')
    expect(submitBtn().disabled).toBe(false)

    changeUserRole.mockResolvedValueOnce({ data: SUCCESS })
    fireEvent.click(submitBtn())
    await waitFor(() => expect(h.onChanged).toHaveBeenCalledWith(SUCCESS))
  })

  it('asks the page to refresh after a stale_request', async () => {
    changeUserRole.mockRejectedValueOnce(apiError(409, { code: 'stale_request', error: "This account's role has changed since you loaded it. Refresh and try again." }))
    const h = setup()
    fireEvent.change(reasonBox(), { target: { value: 'x' } })
    fireEvent.click(submitBtn())
    await screen.findByRole('alert')
    expect(h.onStale).toHaveBeenCalledTimes(1)
  })

  it('shows a network message when the server cannot be reached', async () => {
    changeUserRole.mockRejectedValueOnce(new Error('Network Error'))
    setup()
    fireEvent.change(reasonBox(), { target: { value: 'x' } })
    fireEvent.click(submitBtn())
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i)
  })

  it('renders nothing for an account with no supported transition (admin)', () => {
    setup({ ...staffUser, role: 'admin' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

const succeed = async (data = SUCCESS, user = staffUser) => {
  changeUserRole.mockResolvedValue({ data })
  const h = setup(user)
  fireEvent.change(reasonBox(), { target: { value: 'Field duty' } })
  fireEvent.click(submitBtn())
  await screen.findByTestId('crm-success')
  return h
}

describe('ChangeRoleModal success state', () => {
  let writeText
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  })

  it('keeps the modal open in a success state instead of closing', async () => {
    const h = await succeed()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByLabelText(/reason for change/i)).toBeNull()
    expect(h.onClose).not.toHaveBeenCalled()
    expect(h.onChanged).toHaveBeenCalledWith(SUCCESS)
  })

  it('shows the backend-returned NEW ID prominently', async () => {
    await succeed()
    expect(screen.getByTestId('crm-new-id').textContent).toBe('2024-ENF-0002')
  })

  it('shows the previous ID, and the previous and new roles, from the response', async () => {
    await succeed()
    expect(screen.getByTestId('crm-prev-id').textContent).toBe('2024-STF-0001')
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Previous role').nextSibling.textContent).toBe('Assessment Staff')
    expect(within(dialog).getByText('New role').nextSibling.textContent).toBe('Traffic Enforcer')
    expect(within(dialog).getByText('Juan Dela Cruz')).toBeTruthy()
  })

  it('explains the sessions were invalidated and the user must sign in with the new ID', async () => {
    await succeed()
    expect(screen.getByText(/existing sessions .* were invalidated/i)).toBeTruthy()
    expect(screen.getByText(/must sign in using the/i)).toBeTruthy()
  })

  it('omits the sessions line when the server did not report invalidation', async () => {
    await succeed({ ...SUCCESS, sessions_invalidated: false })
    expect(screen.queryByText(/existing sessions .* were invalidated/i)).toBeNull()
  })

  it('Copy ID copies the NEW ID (not the previous one) and confirms', async () => {
    await succeed()
    fireEvent.click(screen.getByRole('button', { name: /copy id/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('2024-ENF-0002'))
    expect(writeText).not.toHaveBeenCalledWith('2024-STF-0001')
    expect(await screen.findByRole('button', { name: /copied/i })).toBeTruthy()
  })

  it('tells the admin when copying is not possible', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    const exec = vi.fn().mockReturnValue(false)
    document.execCommand = exec
    await succeed()
    fireEvent.click(screen.getByRole('button', { name: /copy id/i }))
    expect(await screen.findByText(/could not copy automatically/i)).toBeTruthy()
  })

  it('Done is the deliberate way out and calls onClose', async () => {
    const h = await succeed()
    expect(h.onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))
    expect(h.onClose).toHaveBeenCalledTimes(1)
  })

  it('does not allow accidental dismissal: outside click, Escape and the header X do nothing', async () => {
    const h = await succeed()
    fireEvent.mouseDown(document.querySelector('.modal-overlay'))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /close dialog/i }))
    expect(h.onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('crm-success')).toBeTruthy()
  })

  it('never generates or infers an ID: a response without one shows none and disables Copy', async () => {
    await succeed({ ...SUCCESS, user: { id: 9, full_name: 'Dela Cruz, Juan', role: 'enforcer' } })
    expect(screen.queryByTestId('crm-new-id')).toBeNull()
    expect(screen.getByTestId('crm-new-id-missing')).toBeTruthy()
    expect(screen.getByRole('button', { name: /copy id/i }).disabled).toBe(true)
    // the account's OLD id from the row must not be presented as the new one
    expect(screen.queryByText('STF-2024-0001')).toBeNull()
  })

  it('shows exactly what the server returned, not a value derived from the row', async () => {
    await succeed({ ...SUCCESS, user: { ...SUCCESS.user, id_number: 'SERVER-CHOSEN-777' } })
    expect(screen.getByTestId('crm-new-id').textContent).toBe('SERVER-CHOSEN-777')
  })

  it('sends only new_role-equivalent fields: newRole, reason, expectedRole', async () => {
    await succeed()
    const [, payload] = changeUserRole.mock.calls[0]
    expect(Object.keys(payload).sort()).toEqual(['expectedRole', 'newRole', 'reason'])
  })

  it('works for enforcer -> staff too', async () => {
    await succeed({
      ...SUCCESS,
      user: { ...SUCCESS.user, role: 'staff', id_number: '2024-STF-0002' },
      previous: { role: 'enforcer', id_number: '2024-ENF-0001' },
    }, enforcerUser)
    expect(screen.getByTestId('crm-new-id').textContent).toBe('2024-STF-0002')
    expect(screen.getByTestId('crm-prev-id').textContent).toBe('2024-ENF-0001')
  })
})

describe('getRoleChangeError', () => {
  it('uses the backend message for a known code', () => {
    expect(getRoleChangeError(apiError(409, { code: 'role_unchanged', error: 'This account already has that role.' })))
      .toEqual({ code: 'role_unchanged', message: 'This account already has that role.', refresh: true })
  })
  it('falls back to the mapped message when the server sent none or failed with 5xx', () => {
    expect(getRoleChangeError(apiError(500, { code: 'id_conflict', error: 'trace...' })).message)
      .toBe('Could not allocate a new ID number. Please try again.')
    expect(getRoleChangeError(apiError(409, { code: 'account_inactive' })).refresh).toBe(true)
  })
  it('maps bare 403/404 and hides unknown/5xx internals', () => {
    expect(getRoleChangeError(apiError(403, {})).code).toBe('permission_denied')
    expect(getRoleChangeError(apiError(404, {})).refresh).toBe(true)
    const generic = getRoleChangeError(apiError(500, { error: 'Traceback (most recent call last)' }))
    expect(generic.message).toBe('Failed to change role. Please try again.')
  })
  it('flags no refresh for validation errors', () => {
    expect(getRoleChangeError(apiError(400, { code: 'reason_required', error: 'A reason for the role change is required.' })).refresh).toBe(false)
  })
})