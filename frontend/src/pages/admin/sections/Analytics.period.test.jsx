// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import Analytics from './Analytics'
import { periodParams } from '../../../components/dashboard/periodRange'

const get = vi.fn()
vi.mock('../../../services/api', () => ({ default: { get: (...a) => get(...a) } }))
vi.mock('recharts', () => {
  const Stub = () => null
  return {
    BarChart: Stub, Bar: Stub, PieChart: Stub, Pie: Stub, Cell: Stub,
    XAxis: Stub, YAxis: Stub, CartesianGrid: Stub, Tooltip: Stub, ResponsiveContainer: Stub, Legend: Stub,
  }
})
vi.mock('./analytics/AnalyticsMap', () => ({ default: () => null }))

const analyticsCalls = () => get.mock.calls.filter(([url]) => String(url).includes('/api/violations/analytics/') && !String(url).includes('year_comparison'))

const payload = (total) => ({
  total, total_penalty: 100, total_collected: 40,
  by_status: { pending: 1, processing: 0, paid: 1 },
  status_distribution: { items: [], total: total },
  by_day: [{ date: '03/20', day: 'Fri', iso_date: '2026-03-20', count: total }],
  by_category: [], by_vehicle_type: [], top_enforcers: [], hotspots: [],
  common_violations: [], repeat_offenders: [], year_comparison: [],
  comparison: { label: 'vs yesterday', total_pct: 0, total_penalty_pct: 0, total_collected_pct: 0, pending_pct: 0, paid_pct: 0 },
  scope: { label: 'Active + archived records', mode: 'all', active_count: total, archived_count: 0, range: { start: '2026-03-20', end: '2026-03-20' }, note: '' },
  filter_options: { locations: [], categories: [], vehicle_types: [], statuses: [] },
  penalty_aging: { as_of: '2026-03-20', total_count: 2, total_amount: 50, buckets: [] },
  peak_hours: [], by_weekday: [],
})

beforeEach(() => get.mockReset())
afterEach(cleanup)

const periodGroup = () => screen.getByRole('group', { name: 'Period' })

describe('Analytics period wiring', () => {
  it('loads Today, and This week sends Monday-through-today params', async () => {
    get.mockResolvedValue({ data: payload(4) })
    render(<Analytics />)
    expect(await screen.findByText('Outstanding Tickets by Age')).toBeTruthy()
    expect(analyticsCalls()[0][1].params).toEqual({ ...periodParams('today', new Date()), scope: 'all' })

    fireEvent.click(within(periodGroup()).getByRole('button', { name: 'This week' }))
    await waitFor(() => {
      expect(analyticsCalls().at(-1)[1].params).toEqual({ ...periodParams('week', new Date()), scope: 'all' })
    })
  })

  it('does not request analytics while a custom range is being typed', async () => {
    get.mockResolvedValue({ data: payload(4) })
    render(<Analytics />)
    await screen.findByText('Outstanding Tickets by Age')
    const before = analyticsCalls().length
    fireEvent.click(within(periodGroup()).getByRole('button', { name: 'Custom' }))
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2024-05-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2024-05-04' } })
    expect(analyticsCalls()).toHaveLength(before)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => {
      expect(analyticsCalls().at(-1)[1].params).toEqual({
        date_from: '2024-05-01', date_to: '2024-05-04', scope: 'all',
      })
    })
  })

  it('ignores a slower response from the previous period', async () => {
    let resolveFirst
    let n = 0
    get.mockImplementation((url) => {
      if (String(url).includes('year_comparison')) return Promise.resolve({ data: {} })
      n += 1
      if (n === 1) return new Promise((resolve) => { resolveFirst = () => resolve({ data: payload(77) }) })
      return Promise.resolve({ data: payload(88) })
    })
    render(<Analytics />)
    fireEvent.click(await screen.findByRole('button', { name: 'This week' }))
    expect(await screen.findByText('88')).toBeTruthy()
    await act(async () => { resolveFirst() })
    expect(screen.queryByText('77')).toBeNull()
    expect(screen.getByText('88')).toBeTruthy()
  })
})
