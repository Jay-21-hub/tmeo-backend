// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const get = vi.fn()
vi.mock('../../../services/api', () => ({ default: { get: (...a) => get(...a) } }))
vi.mock('recharts', () => {
  const Stub = () => null
  return {
    AreaChart: Stub, Area: Stub, XAxis: Stub, YAxis: Stub, CartesianGrid: Stub, Tooltip: Stub,
    ResponsiveContainer: Stub, PieChart: Stub, Pie: Stub, Cell: Stub,
  }
})

import DashboardHome from './DashboardHome'

const ACTIVE = {
  total: 3, pending: 1, paid: 1, total_collected: 500, active_enforcers: 2, on_duty_enforcers: 1, daily_data: [],
  type_data: [{ name: 'Active-only type', count: 3 }],
  hotspots: [{ area: 'Active-only place', count: 3, trend: null }],
  top_enforcers: [{ id: 1, name: 'Active Only Person', badge: '', tickets: 3, rate: 100 }],
}
const HISTORICAL = {
  total: 40, paid: 25, total_collected: 12000, pending: 1,
  type_data: [{ name: 'Archived-incl type', count: 40 }, { name: 'Other', count: 7 }],
  hotspots: [{ area: 'Archived-incl place', count: 41, trend: null }],
  top_enforcers: [{ id: 2, name: 'Archived Incl Person', badge: 'B-7', tickets: 12, rate: 100 }],
  period: {
    type_data: { scope: 'all_time', includes_archived: true, label: 'Cumulative · includes archived' },
    hotspots: { scope: 'all_time', includes_archived: true, label: 'Cumulative · includes archived' },
    top_enforcers: { scope: 'month', includes_archived: true, label: 'This month · includes archived' },
  },
}
const mockApi = (stats) => get.mockImplementation((url) => (
  String(url ?? '').includes('stats')
    ? Promise.resolve({ data: stats })
    : Promise.resolve({ data: { results: [] } })
))

beforeEach(() => get.mockReset())
afterEach(cleanup)

const renderIt = () => render(<DashboardHome user={{ full_name: 'Ada' }} setPage={() => {}} />)

describe('Admin dashboard - archived-inclusive panels', () => {
  it('shows the archived-inclusive rows with the approved labels', async () => {
    mockApi({ ...ACTIVE, historical: HISTORICAL })
    renderIt()
    expect(await screen.findByText('Archived-incl type')).toBeTruthy()
    expect(screen.getByText('Archived-incl place')).toBeTruthy()
    expect(screen.getByText('Archived Incl Person')).toBeTruthy()
    // active-only top-level rows are NOT shown when historical rows exist
    expect(screen.queryByText('Active-only type')).toBeNull()
    expect(screen.queryByText('Active-only place')).toBeNull()
    expect(screen.queryByText('Active Only Person')).toBeNull()
    expect(screen.getAllByText('Cumulative · includes archived')).toHaveLength(2)        // Type + Locations
    expect(screen.getAllByText('This month · includes archived')).toHaveLength(1)        // Top Enforcers
    // the old over-claiming subtitles are gone
    expect(screen.queryByText('All recorded violations')).toBeNull()
    expect(screen.queryByText('Where most OVRs are issued')).toBeNull()
    expect(screen.queryByText('Most OVRs issued this month')).toBeNull()
    expect(screen.getByText('Badge B-7')).toBeTruthy()
  })

  it('the donut total is the sum of the archived-inclusive rows', async () => {
    mockApi({ ...ACTIVE, historical: HISTORICAL })
    renderIt()
    expect(await screen.findByText('47')).toBeTruthy()          // 40 + 7 ("Other")
  })

  it('uses the label the server sends (e.g. another hist_period)', async () => {
    const h = { ...HISTORICAL, period: { ...HISTORICAL.period,
      top_enforcers: { scope: 'year', includes_archived: true, label: 'This year · includes archived' } } }
    mockApi({ ...ACTIVE, historical: h })
    renderIt()
    expect(await screen.findByText('This year · includes archived')).toBeTruthy()
  })

  it('falls back per panel to the active-only lists, honestly labelled, when there is no historical block', async () => {
    mockApi(ACTIVE)
    renderIt()
    expect(await screen.findByText('Active-only type')).toBeTruthy()
    expect(screen.getByText('Active-only place')).toBeTruthy()
    expect(screen.getByText('Active Only Person')).toBeTruthy()
    expect(screen.getAllByText('Active only · archive not included')).toHaveLength(2)    // Type + Locations
    expect(screen.getByText('This month · active only, archive not included')).toBeTruthy()
    expect(screen.getAllByText('Active records only')).toHaveLength(3)                   // KPI subtitles unchanged
    expect(screen.queryByText('Cumulative · includes archived')).toBeNull()
    expect(screen.queryByText('This month · includes archived')).toBeNull()
  })

  it('a historical block WITHOUT the panel keys (older backend) never claims "includes archived" for them', async () => {
    mockApi({ ...ACTIVE, historical: { total: 40, paid: 25, total_collected: 12000, pending: 1 } })
    renderIt()
    expect(await screen.findByText('Active-only type')).toBeTruthy()
    expect(screen.queryByText('Cumulative · includes archived')).toBeNull()
    expect(screen.getAllByText('All-time, incl. archived')).toHaveLength(3)   // KPI cards keep their own label
  })

  it('an empty archived-inclusive list shows the empty state, not the active rows', async () => {
    mockApi({ ...ACTIVE, historical: { ...HISTORICAL, type_data: [], hotspots: [], top_enforcers: [] } })
    renderIt()
    expect(await screen.findByText('No violations recorded yet.')).toBeTruthy()
    expect(screen.getByText('No location data yet.')).toBeTruthy()
    expect(screen.getByText('No OVRs issued this month yet.')).toBeTruthy()
    expect(screen.queryByText('Active-only type')).toBeNull()
  })

  it('does not add query parameters to the stats request (API contract unchanged)', async () => {
    mockApi({ ...ACTIVE, historical: HISTORICAL })
    renderIt()
    await screen.findByText('Archived-incl type')
    const statsCall = get.mock.calls.find(([u]) => String(u).includes('stats'))
    expect(statsCall).toHaveLength(1)                                 // url only, no params object
    expect(String(statsCall[0])).not.toContain('hist_period')
  })
})