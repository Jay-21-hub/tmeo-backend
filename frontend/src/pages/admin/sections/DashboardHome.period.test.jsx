// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import DashboardHome from './DashboardHome'
import { periodParams } from '../../../components/dashboard/periodRange'

const get = vi.fn()
vi.mock('../../../services/api', () => ({ default: { get: (...a) => get(...a) } }))
vi.mock('recharts', () => {
  const Stub = () => null
  return {
    AreaChart: Stub, Area: Stub, XAxis: Stub, YAxis: Stub, CartesianGrid: Stub, Tooltip: Stub,
    ResponsiveContainer: Stub, PieChart: Stub, Pie: Stub, Cell: Stub,
  }
})

const statsCalls = () => get.mock.calls.filter(([url]) => String(url).includes('stats'))

const reply = (stats) => get.mockImplementation((url) => (
  String(url ?? '').includes('stats')
    ? Promise.resolve({ data: stats })
    : Promise.resolve({ data: { results: [] } })
))

const body = (total, extra = {}) => ({
  total: 3, pending: 4, paid: 1, total_collected: 500, active_enforcers: 2, on_duty_enforcers: 1,
  daily_data: [{ date: '11/02', total: 1, paid: 0 }],
  historical: { total, paid: 1, total_collected: 800, pending: 4 },
  ...extra,
})

beforeEach(() => get.mockReset())
afterEach(cleanup)

const periodGroup = () => screen.getByRole('group', { name: 'Period' })

describe('Admin dashboard period wiring', () => {
  it('loads This month, then sends Today and All time params', async () => {
    reply(body(15))
    render(<DashboardHome user={{ full_name: 'Ada' }} setPage={() => {}} />)
    expect(await screen.findByText('15')).toBeTruthy()
    expect(statsCalls()[0][1].params).toEqual(periodParams('month', new Date()))

    fireEvent.click(within(periodGroup()).getByRole('button', { name: 'Today' }))
    await waitFor(() => {
      expect(statsCalls().at(-1)[1].params).toEqual(periodParams('today', new Date()))
    })

    fireEvent.click(within(periodGroup()).getByRole('button', { name: 'All time' }))
    await waitFor(() => {
      expect(statsCalls().at(-1)[1].params).toEqual({ range: 'all' })
    })
  })

  it('does not request stats while a custom range is being typed', async () => {
    reply(body(15))
    render(<DashboardHome user={{ full_name: 'Ada' }} setPage={() => {}} />)
    await screen.findByText('15')
    const before = statsCalls().length

    fireEvent.click(within(periodGroup()).getByRole('button', { name: 'Custom' }))
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2024-05-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2024-05-04' } })
    expect(statsCalls()).toHaveLength(before)

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => {
      expect(statsCalls().at(-1)[1].params).toEqual({ date_from: '2024-05-01', date_to: '2024-05-04' })
    })
  })

  it('ignores a slower response from the previous period', async () => {
    let resolveMonth
    let n = 0
    get.mockImplementation((url) => {
      if (!String(url).includes('stats')) return Promise.resolve({ data: { results: [] } })
      n += 1
      if (n === 1) return new Promise((resolve) => { resolveMonth = () => resolve({ data: body(77000) }) })
      return Promise.resolve({ data: body(88000) })
    })
    render(<DashboardHome user={{ full_name: 'Ada' }} setPage={() => {}} />)
    fireEvent.click(within(periodGroup()).getByRole('button', { name: 'Today' }))
    expect(await screen.findByText('88,000')).toBeTruthy()
    await act(async () => { resolveMonth() })
    expect(screen.queryByText('77,000')).toBeNull()
    expect(screen.getByText('88,000')).toBeTruthy()
  })

  it('shows the empty state instead of a zero total, and This year switches the request', async () => {
    reply(body(0, { daily_data: [{ date: '11/01', total: 0, paid: 0 }] }))
    render(<DashboardHome user={{ full_name: 'Ada' }} setPage={() => {}} />)
    expect(await screen.findByText('Walang data sa napiling panahon. Try a wider range.')).toBeTruthy()
    expect(screen.queryByText('₱0')).toBeNull()
    expect(screen.getByText('4')).toBeTruthy()

    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'This year' }))
    await waitFor(() => {
      expect(statsCalls().at(-1)[1].params).toEqual(periodParams('year', new Date()))
    })
  })
})
