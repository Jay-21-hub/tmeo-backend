import { describe, it, expect } from 'vitest'
import {
  getRoleChangeTarget, canChangeRole, ROLE_CHANGE_REASON_MAX, SEPARATED_EMPLOYMENT_STATUSES,
} from './userManagementConfig'

describe('getRoleChangeTarget', () => {
  it('maps staff <-> enforcer only', () => {
    expect(getRoleChangeTarget('staff')).toBe('enforcer')
    expect(getRoleChangeTarget('enforcer')).toBe('staff')
  })
  it('offers nothing for admin or unknown roles', () => {
    expect(getRoleChangeTarget('admin')).toBeNull()
    expect(getRoleChangeTarget('Administrator')).toBeNull()
    expect(getRoleChangeTarget(undefined)).toBeNull()
  })
})

describe('canChangeRole', () => {
  const base = { id: 5, role: 'staff', is_active: true, employment_status: 'active' }

  it('allows an active staff/enforcer account', () => {
    expect(canChangeRole(base, 1)).toBe(true)
    expect(canChangeRole({ ...base, role: 'enforcer' }, 1)).toBe(true)
  })
  it('refuses admins', () => {
    expect(canChangeRole({ ...base, role: 'admin' }, 1)).toBe(false)
  })
  it('refuses the signed-in admin\'s own row (string or number id)', () => {
    expect(canChangeRole(base, 5)).toBe(false)
    expect(canChangeRole(base, '5')).toBe(false)
  })
  it('still offers it when the current user id is unknown (server remains the authority)', () => {
    expect(canChangeRole(base, null)).toBe(true)
    expect(canChangeRole(base)).toBe(true)
  })
  it('refuses inactive accounts', () => {
    expect(canChangeRole({ ...base, is_active: false }, 1)).toBe(false)
  })
  it('refuses every separated employment status', () => {
    for (const status of SEPARATED_EMPLOYMENT_STATUSES) {
      expect(canChangeRole({ ...base, employment_status: status }, 1)).toBe(false)
    }
  })
  it('does not treat on_leave/suspended as separated (backend decides)', () => {
    expect(canChangeRole({ ...base, employment_status: 'on_leave' }, 1)).toBe(true)
    expect(canChangeRole({ ...base, employment_status: 'suspended' }, 1)).toBe(true)
  })
  it('handles a missing user', () => {
    expect(canChangeRole(null, 1)).toBe(false)
  })
  it('exposes the 500 character reason limit used by the backend', () => {
    expect(ROLE_CHANGE_REASON_MAX).toBe(500)
  })
})