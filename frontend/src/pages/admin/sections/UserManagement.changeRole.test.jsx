// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'

const get = vi.fn()
const changeUserRole = vi.fn()
vi.mock('../../../services/api', () => ({
  default: { get: (...a) => get(...a), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  changeUserRole: (...a) => changeUserRole(...a),
}))

const toast = { success: vi.fn(), danger: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../context/useToast', () => ({ useToast: () => toast }))

// jsdom has no layout, so give the "⋯" menu a fixed position.
vi.mock('../../../hooks/useFloatingPosition', () => ({
  default: (_ref, open) => (open ? { left: 10, width: 184, top: 10, bottom: 10, placement: 'bottom', maxHeight: 300 } : null),
}))
// Heavy / unrelated children
vi.mock('../../../components/common/Avatar', () => ({ default: () => <span /> }))
vi.mock('../../../components/common/AvatarUploader', () => ({ default: () => <span /> }))
vi.mock('./users/AddUserModal', () => ({ default: () => null }))

import UserManagement from './UserManagement'

const ME = { id: 1, role: 'admin', full_name: 'Admin, Ada', email: 'ada@example.com', is_active: true, employment_status: 'active' }
const STAFF = { id: 2, role: 'staff', full_name: 'Staff, Sam', email: 'sam@example.com', is_active: true, employment_status: 'active', id_number: 'STF-1' }
const ENF = { id: 3, role: 'enforcer', full_name: 'Enf, Eli', email: 'eli@example.com', is_active: true, employment_status: 'active', id_number: 'ENF-1' }
const GONE = { id: 4, role: 'staff', full_name: 'Gone, Gina', email: 'gina@example.com', is_active: true, employment_status: 'resigned' }
const OFF = { id: 5, role: 'enforcer', full_name: 'Off, Ora', email: 'ora@example.com', is_active: false, employment_status: 'active' }

const listResponse = (users) => ({ data: { results: users, count: users.length, stats: {} } })
const openMenu = (name) => fireEvent.click(screen.getByRole('button', { name: `More actions for ${name}` }))

beforeEach(() => {
  get.mockReset(); changeUserRole.mockReset()
  Object.values(toast).forEach(f => f.mockReset())
  localStorage.setItem('user', JSON.stringify({ id: 1, role: 'admin' }))
  get.mockResolvedValue(listResponse([ME, STAFF, ENF, GONE, OFF]))
})
afterEach(() => { cleanup(); localStorage.clear(); document.body.style.overflow = '' })

describe('UserManagement — Change Role', () => {
  it('offers Change Role only for active staff/enforcer rows that are not the signed-in admin', async () => {
    render(<UserManagement />)
    await screen.findByText('Staff, Sam')

    openMenu('Staff, Sam')
    expect(screen.getByRole('menuitem', { name: /change role/i })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    for (const name of ['Admin, Ada', 'Gone, Gina', 'Off, Ora']) {
      openMenu(name)
      expect(screen.queryByRole('menuitem', { name: /change role/i })).toBeNull()
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    }
    openMenu('Enf, Eli')
    expect(screen.getByRole('menuitem', { name: /change role/i })).toBeTruthy()
  })

  const SUCCESS = {
    message: 'Staff, Sam is now Traffic Enforcer. They must sign in again with their new ID number.',
    user: { id: 2, full_name: 'Staff, Sam', role: 'enforcer', id_number: '2024-ENF-0002', hired_year: 2024 },
    previous: { role: 'staff', id_number: 'STF-1' },
    effective_at: '2026-10-07T00:00:00Z',
    sessions_invalidated: true,
  }
  const submitChange = async () => {
    openMenu('Staff, Sam')
    fireEvent.click(screen.getByRole('menuitem', { name: /change role/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/reason for change/i), { target: { value: 'Field duty' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^change role$/i }))
    await screen.findByTestId('crm-success')
  }

  it('changes the role, toasts, refreshes the list and keeps the modal open showing the NEW ID', async () => {
    changeUserRole.mockResolvedValue({ data: SUCCESS })
    render(<UserManagement />)
    await screen.findByText('Staff, Sam')
    const callsBefore = get.mock.calls.length

    await submitChange()

    expect(changeUserRole).toHaveBeenCalledWith(2, { newRole: 'enforcer', reason: 'Field duty', expectedRole: 'staff' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(SUCCESS.message))
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(callsBefore))
    // still open, still showing the server's new ID even after the list refreshed
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('crm-new-id').textContent).toBe('2024-ENF-0002')
    expect(screen.getByTestId('crm-prev-id').textContent).toBe('STF-1')
  })

  it('Done closes the success state; outside click does not', async () => {
    changeUserRole.mockResolvedValue({ data: SUCCESS })
    render(<UserManagement />)
    await screen.findByText('Staff, Sam')
    await submitChange()

    fireEvent.mouseDown(document.querySelector('.modal-overlay'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByTestId('crm-success')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps the current search when the list refreshes after a successful change', async () => {
    changeUserRole.mockResolvedValue({ data: SUCCESS })
    render(<UserManagement />)
    await screen.findByText('Staff, Sam')
    fireEvent.change(screen.getByPlaceholderText(/search users/i), { target: { value: 'sam' } })
    await waitFor(() => expect(get.mock.calls.at(-1)[1].params.search).toBe('sam'))
    await screen.findByText('Staff, Sam')
    const callsBefore = get.mock.calls.length

    await submitChange()

    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(callsBefore))
    const last = get.mock.calls.at(-1)[1].params
    expect(last.search).toBe('sam')
    expect(last.page).toBe(1)
  })

  it('keeps the modal open and the list unchanged on a refused change', async () => {
    changeUserRole.mockImplementation(() => Promise.reject({ response: { status: 409, data: { code: 'schedules_exist', error: 'This enforcer still has schedules dated today or later. Remove them before changing the role.' } } }))
    render(<UserManagement />)
    await screen.findByText('Enf, Eli')
    const callsBefore = get.mock.calls.length

    openMenu('Enf, Eli')
    fireEvent.click(screen.getByRole('menuitem', { name: /change role/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/reason for change/i), { target: { value: 'Desk' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^change role$/i }))

    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/schedules dated today or later/i)
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(get.mock.calls.length).toBe(callsBefore)
  })

  it('reloads the list when the server says the row is stale', async () => {
    changeUserRole.mockImplementation(() => Promise.reject({ response: { status: 409, data: { code: 'stale_request', error: 'stale' } } }))
    render(<UserManagement />)
    await screen.findByText('Staff, Sam')
    const callsBefore = get.mock.calls.length

    openMenu('Staff, Sam')
    fireEvent.click(screen.getByRole('menuitem', { name: /change role/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/reason for change/i), { target: { value: 'x' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^change role$/i }))

    await within(dialog).findByRole('alert')
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(callsBefore))
  })

  it('Cancel closes the modal without calling the API', async () => {
    render(<UserManagement />)
    await screen.findByText('Staff, Sam')
    openMenu('Staff, Sam')
    fireEvent.click(screen.getByRole('menuitem', { name: /change role/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(changeUserRole).not.toHaveBeenCalled()
  })
})