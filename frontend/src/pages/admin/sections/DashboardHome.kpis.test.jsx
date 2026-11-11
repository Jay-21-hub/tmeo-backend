// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'

const get = vi.fn()
vi.mock('../../../services/api', () => ({ default: { get: (...a) => get(...a) } }))
// recharts needs layout; the KPI row is what is under test.
vi.mock('recharts', () => {
  const Stub = () => null
  return {
    AreaChart: Stub, Area: Stub, XAxis: Stub, YAxis: Stub, CartesianGrid: Stub, Tooltip: Stub,
    ResponsiveContainer: Stub, PieChart: Stub, Pie: Stub, Cell: Stub,
  }
})

import DashboardHome from './DashboardHome'

const BASE = {
  total: 3, pending: 1, paid: 1, total_collected: 500, active_enforcers: 2, on_duty_enforcers: 1,
  daily_data: [], type_data: [], hotspots: [], top_enforcers: [],
}
const mockApi = (stats) => get.mockImplementation((url) => (
  String(url ?? '').includes('stats')
    ? Promise.resolve({ data: stats })
    : Promise.resolve({ data: { results: [] } })
))

beforeEach(() => get.mockReset())
afterEach(cleanup)

describe('Admin dashboard — cumulative vs operational KPIs', () => {
  it('shows all-time figures (incl. archived) for Total / Revenue / Paid and active-only for Pending', async () => {
    mockApi({ ...BASE, historical: { total: 40, paid: 25, total_collected: 12000, pending: 1 } })
    render(<DashboardHome user={{ full_name: 'Ada' }} setPage={() => {}} />)

    expect(await screen.findByText('40')).toBeTruthy()          // cumulative total, not the active 3
    expect(screen.getByText('25')).toBeTruthy()                 // cumulative paid, not the active 1
    expect(within(document.querySelector('.dash-kpis')).getAllByText('This month · incl. archived')).toHaveLength(3)
    expect(screen.getAllByText('Active cases only')).toHaveLength(1)   // Pending Violations
  })

  it('falls back to the active-table figures, labelled as such, when the backend sends no historical block', async () => {
    mockApi(BASE)
    render(<DashboardHome user={{ full_name: 'Ada' }} setPage={() => {}} />)

    expect(await screen.findByText('3')).toBeTruthy()
    expect(screen.queryByText('All-time, incl. archived')).toBeNull()
    expect(screen.getAllByText('Active records only')).toHaveLength(3)
  })
})