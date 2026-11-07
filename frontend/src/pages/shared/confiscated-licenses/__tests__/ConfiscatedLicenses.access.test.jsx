// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const get = vi.fn()
vi.mock('../../../../services/api', () => ({ default: { get: (...a) => get(...a), post: vi.fn() } }))
vi.mock('../../../../context/useToast', () => ({ useToast: () => ({ success: vi.fn(), danger: vi.fn(), warning: vi.fn(), info: vi.fn() }) }))

import ConfiscatedLicenses from '../ConfiscatedLicenses'
import Sidebar from '../../../../components/layout/Sidebar'
import { listBody, SUMMARY, routeGet } from './custodyTestUtils'

beforeEach(() => { get.mockReset(); window.innerWidth = 1280; routeGet(get, { list: listBody([]), summary: SUMMARY }) })
afterEach(cleanup)

const nav = (role) => {
  render(<Sidebar page="dashboard" setPage={() => {}} role={role} onLogout={() => {}} isOpen collapsed={false} onToggleCollapse={() => {}} />)
  return screen.queryByRole('button', { name: /confiscated licenses/i })
}

describe('module access', () => {
  it('Enforcer gets an access-restricted message and no request is made', () => {
    render(<ConfiscatedLicenses role="enforcer" />)
    expect(screen.getByText('Access restricted')).toBeTruthy()
    expect(get).not.toHaveBeenCalled()
  })

  it('unknown role is also refused', () => {
    render(<ConfiscatedLicenses role={undefined} />)
    expect(screen.getByText('Access restricted')).toBeTruthy()
  })

  it.each(['staff', 'admin'])('%s sees the Confiscated Licenses page', async (role) => {
    render(<ConfiscatedLicenses role={role} />)
    expect(await screen.findByRole('heading', { name: 'Confiscated Licenses' })).toBeTruthy()
  })
})

describe('sidebar integration', () => {
  it('Staff and Admin have the nav item; Enforcer does not', () => {
    expect(nav('staff')).toBeTruthy()
    cleanup()
    expect(nav('admin')).toBeTruthy()
    cleanup()
    expect(nav('enforcer')).toBeNull()
  })
})

describe('shell wiring', () => {
  const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
  it('Staff and Admin dashboards route "custody" with their own role; Enforcer dashboard never mounts it', () => {
    expect(read('../../../staff/StaffDashboard.jsx')).toMatch(/case 'custody': return <ConfiscatedLicenses role="staff" \/>/)
    expect(read('../../../admin/AdminDashboard.jsx')).toMatch(/case 'custody':\s+return <ConfiscatedLicenses role="admin" \/>/)
    expect(read('../../../enforcer/EnforcerDashboard.jsx')).not.toMatch(/confiscated/i)
  })
})