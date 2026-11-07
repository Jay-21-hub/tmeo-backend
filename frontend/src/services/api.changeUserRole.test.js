import { describe, it, expect, vi, afterEach } from 'vitest'
import api, { changeUserRole } from './api'

afterEach(() => vi.restoreAllMocks())

describe('changeUserRole', () => {
  it('POSTs new_role, reason and expected_role to the change-role endpoint', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { message: 'ok' } })
    const res = await changeUserRole(42, { newRole: 'enforcer', reason: 'Field duty', expectedRole: 'staff' })
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/api/auth/users/42/change-role/', {
      new_role: 'enforcer', reason: 'Field duty', expected_role: 'staff',
    })
    expect(res.data.message).toBe('ok')
  })

  it('omits expected_role when it is not provided', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} })
    await changeUserRole(7, { newRole: 'staff', reason: 'Desk role' })
    expect(post.mock.calls[0][1]).toEqual({ new_role: 'staff', reason: 'Desk role' })
  })

  it('never sends an ID number or hired year (the server assigns them)', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} })
    await changeUserRole(7, { newRole: 'staff', reason: 'x', expectedRole: 'enforcer', id_number: 'X', hired_year: 1999 })
    const body = post.mock.calls[0][1]
    expect(Object.keys(body).sort()).toEqual(['expected_role', 'new_role', 'reason'])
  })

  it('propagates server errors to the caller', async () => {
    const err = { response: { status: 409, data: { code: 'stale_request' } } }
    vi.spyOn(api, 'post').mockRejectedValue(err)
    await expect(changeUserRole(1, { newRole: 'staff', reason: 'r' })).rejects.toBe(err)
  })
})