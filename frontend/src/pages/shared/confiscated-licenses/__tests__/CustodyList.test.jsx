// @vitest-environment jsdom
import { useState, useCallback } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'

const get = vi.fn()
const post = vi.fn()
vi.mock('../../../../services/api', () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a) },
}))
const toast = { success: vi.fn(), danger: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../../context/useToast', () => ({ useToast: () => toast }))

import CustodyList from '../components/CustodyList'
import { DEFAULT_FILTERS } from '../utils/custodyConfig'
import { row, listBody, SUMMARY, apiError, routeGet, lastListParams, lastSummaryParams } from './custodyTestUtils'

function Harness({ role = 'staff', onOpen = () => {}, initial = {} }) {
  const [filters, setFilters] = useState({ ...DEFAULT_FILTERS, ...initial })
  const patch = useCallback((p) => setFilters((f) => ({ ...f, ...p })), [])
  return <CustodyList role={role} filters={filters} onFiltersChange={patch} onOpen={onOpen} />
}

const ROWS = [
  row({ key: 'v1', owner_name: 'JUAN DELA CRUZ', license_number: 'D01-23-456789', status: 'confiscated' }),
  row({ key: 'v2', owner_name: 'MARIA SANTOS', license_number: 'N02-88-765432', status: 'ready_for_release', version: 1 }),
  row({ key: 'v3', owner_name: 'PEDRO REYES', license_number: 'C03-11-223344', status: 'confiscated', doc_type_status: 'pending', legacy: true, document_type_unverified: true }),
  row({ key: 'a4', owner_name: 'ANA GARCIA', license_number: 'D04-55-667788', status: 'released', record_kind: 'archived' }),
]

const withDays = (rows) => rows.map((r, i) => ({ ...r, days_held: 5 + i }))

beforeEach(() => {
  get.mockReset(); post.mockReset()
  Object.values(toast).forEach((f) => f.mockReset())
  window.innerWidth = 1280
  routeGet(get, { list: listBody(ROWS), summary: SUMMARY })
})
afterEach(() => { cleanup(); document.body.style.overflow = '' })

describe('CustodyList — Staff', () => {
  it('loads with the In Custody tab, real status filter and paging params', async () => {
    render(<Harness />)
    await screen.findByText('JUAN DELA CRUZ')
    expect(lastListParams(get)).toEqual({ status: 'confiscated', page: 1, page_size: 10 })
  })

  it('shows only the three Staff tabs, with counts from the summary endpoint (never the active tab)', async () => {
    render(<Harness />)
    await screen.findByText('JUAN DELA CRUZ')
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['In Custody7', 'Ready for Release3', 'Released2'])
    expect(screen.queryByRole('tab', { name: /all records/i })).toBeNull()
    expect(lastSummaryParams(get)).toEqual({})
  })

  it('never shows days held or the admin-only excluded toggle, and never sends include_excluded', async () => {
    render(<Harness />)
    await screen.findByText('JUAN DELA CRUZ')
    expect(screen.queryByRole('columnheader', { name: /days held/i })).toBeNull()
    expect(screen.queryByLabelText(/include excluded/i)).toBeNull()
    expect(lastListParams(get).include_excluded).toBeUndefined()
  })

  it('has no payment column (the backend does not supply one)', async () => {
    render(<Harness />)
    await screen.findByText('JUAN DELA CRUZ')
    expect(screen.queryByRole('columnheader', { name: /payment/i })).toBeNull()
  })

  it('switching tabs requests that status and resets to page 1', async () => {
    render(<Harness initial={{ page: 1 }} />)
    await screen.findByText('JUAN DELA CRUZ')
    fireEvent.click(screen.getByRole('tab', { name: /ready for release/i }))
    await waitFor(() => expect(lastListParams(get).status).toBe('ready_for_release'))
    fireEvent.click(screen.getByRole('tab', { name: /^released/i }))
    await waitFor(() => expect(lastListParams(get).status).toBe('released'))
    expect(screen.getByRole('tab', { name: /^released/i }).getAttribute('aria-selected')).toBe('true')
  })

  it('supports arrow-key navigation between tabs', async () => {
    render(<Harness />)
    await screen.findByText('JUAN DELA CRUZ')
    fireEvent.keyDown(screen.getByRole('tab', { name: /in custody/i }), { key: 'ArrowRight' })
    await waitFor(() => expect(lastListParams(get).status).toBe('ready_for_release'))
  })

  it('debounces search, and sends it to the backend once', async () => {
    render(<Harness />)
    await screen.findByText('JUAN DELA CRUZ')
    const before = get.mock.calls.length
    fireEvent.change(screen.getByLabelText(/search by license number/i), { target: { value: 'maria' } })
    fireEvent.change(screen.getByLabelText(/search by license number/i), { target: { value: 'maria s' } })
    expect(get.mock.calls.length).toBe(before) // nothing yet: debounced
    await waitFor(() => expect(lastListParams(get).search).toBe('maria s'), { timeout: 2000 })
    expect(get.mock.calls.filter(([u]) => u.endsWith('/confiscated-licenses/') ).filter(([, c]) => c.params.search).length).toBe(1)
  })

  it('Enter applies the search immediately', async () => {
    render(<Harness />)
    await screen.findByText('JUAN DELA CRUZ')
    const box = screen.getByLabelText(/search by license number/i)
    fireEvent.change(box, { target: { value: 'OVR-1' } })
    fireEvent.submit(box.closest('form'))
    await waitFor(() => expect(lastListParams(get).search).toBe('OVR-1'))
  })

  it('maps record type and date range to legacy / date_from / date_to', async () => {
    render(<Harness />)
    await screen.findByText('JUAN DELA CRUZ')
    fireEvent.change(screen.getByLabelText('Record type'), { target: { value: 'only' } })
    await waitFor(() => expect(lastListParams(get).legacy).toBe('only'))
    fireEvent.change(screen.getByLabelText(/confiscated from/i), { target: { value: '2024-01-01' } })
    await waitFor(() => expect(lastListParams(get).date_from).toBe('2024-01-01'))
    fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: '2024-01-31' } })
    await waitFor(() => expect(lastListParams(get).date_to).toBe('2024-01-31'))
    // Filters narrow the list but the tab counts query keeps them too (without status)
    expect(lastSummaryParams(get)).toEqual({ legacy: 'only', date_from: '2024-01-01', date_to: '2024-01-31' })
  })

  it('warns when the date range is reversed', async () => {
    render(<Harness initial={{ dateFrom: '2024-02-01', dateTo: '2024-01-01' }} />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/after the “to” date/i)
  })

  it('Clear filters restores defaults but keeps the tab', async () => {
    render(<Harness initial={{ tab: 'released', legacy: 'only' }} />)
    await screen.findByText('JUAN DELA CRUZ')
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }))
    await waitFor(() => expect(lastListParams(get)).toEqual({ status: 'released', page: 1, page_size: 10 }))
  })

  it('shows real values only: license, driver, OVR, status and legacy badge', async () => {
    render(<Harness />)
    const table = await screen.findByRole('table')
    const t = within(table)
    expect(t.getByText('N02-88-765432')).toBeTruthy()
    expect(t.getByText('MARIA SANTOS')).toBeTruthy()
    expect(t.getAllByText('OVR-2024-00123').length).toBe(4)
    expect(t.getByText('Verification needed')).toBeTruthy()
    expect(t.getAllByText('Ready for Release').length).toBe(1)
  })

  it('offers contextual quick actions only where the state allows them', async () => {
    const onOpen = vi.fn()
    render(<Harness onOpen={onOpen} />)
    await screen.findByText('MARIA SANTOS')
    // Release: only the ready, verified row
    expect(screen.getAllByRole('button', { name: /^release license/i }).length).toBe(1)
    // Verify: only the pending legacy row
    expect(screen.getAllByRole('button', { name: /verify legacy document/i }).length).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'View license N02-88-765432' }))
    expect(onOpen).toHaveBeenCalledWith('v2')
  })

  it('shows an empty state with clear wording per tab', async () => {
    routeGet(get, { list: listBody([]), summary: { ...SUMMARY, confiscated: 0 } })
    render(<Harness />)
    expect(await screen.findByText(/no licenses are currently in custody/i)).toBeTruthy()
  })

  it('shows a filtered-empty message when filters match nothing', async () => {
    routeGet(get, { list: listBody([]), summary: SUMMARY })
    render(<Harness initial={{ search: 'zzz' }} />)
    expect(await screen.findByText(/no records match your search or filters/i)).toBeTruthy()
  })

  it('shows an error state with Retry, then recovers', async () => {
    let fail = true
    routeGet(get, { list: () => (fail ? Promise.reject(apiError(500, { detail: 'boom' })) : listBody(ROWS)), summary: SUMMARY })
    render(<Harness />)
    expect(await screen.findByText(/could not load confiscated licenses/i)).toBeTruthy()
    expect(screen.queryByText(/boom/)).toBeNull()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(await screen.findByText('JUAN DELA CRUZ')).toBeTruthy()
  })

  it('still lists records when only the counts call fails (tabs just lose their numbers)', async () => {
    routeGet(get, { list: listBody(ROWS), summary: () => Promise.reject(apiError(500, {})) })
    render(<Harness />)
    await screen.findByText('JUAN DELA CRUZ')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['In Custody', 'Ready for Release', 'Released'])
  })

  it('paginates with the real count and requests the next page', async () => {
    routeGet(get, { list: listBody(ROWS, 25), summary: SUMMARY })
    render(<Harness />)
    await screen.findByText('JUAN DELA CRUZ')
    expect(screen.getByText(/of/).textContent).toMatch(/Showing 1–10 of 25 records/)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(lastListParams(get).page).toBe(2))
  })

  it('steps back when the current page no longer exists', async () => {
    routeGet(get, { list: (u, c) => (c.params.page > 1 ? listBody([], 3) : listBody(ROWS, 3)), summary: SUMMARY })
    render(<Harness initial={{ page: 3 }} />)
    await waitFor(() => expect(lastListParams(get).page).toBe(1))
    expect(await screen.findByText('JUAN DELA CRUZ')).toBeTruthy()
  })

  it('renders cards instead of a table on a phone', async () => {
    window.innerWidth = 375
    render(<Harness />)
    await screen.findByText('MARIA SANTOS')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getAllByRole('article').length).toBe(4)
  })
})

describe('CustodyList — Admin', () => {
  beforeEach(() => routeGet(get, { list: listBody(withDays(ROWS)), summary: SUMMARY }))

  it('offers All Records and shows days held as information only', async () => {
    render(<Harness role="admin" />)
    await screen.findByText('JUAN DELA CRUZ')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['In Custody7', 'Ready for Release3', 'Released2', 'All Records12'])
    expect(screen.getByRole('columnheader', { name: /days held/i })).toBeTruthy()
    expect(screen.getByText(/does not indicate an overdue status/i)).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /overdue/i })).toBeNull()
  })

  it('All Records sends no status filter', async () => {
    render(<Harness role="admin" />)
    await screen.findByText('JUAN DELA CRUZ')
    fireEvent.click(screen.getByRole('tab', { name: /all records/i }))
    await waitFor(() => expect(lastListParams(get)).toEqual({ page: 1, page_size: 10 }))
  })

  it('"Include excluded records" sends include_excluded=1 (admin only)', async () => {
    render(<Harness role="admin" />)
    await screen.findByText('JUAN DELA CRUZ')
    fireEvent.click(screen.getByLabelText(/include excluded records/i))
    await waitFor(() => expect(lastListParams(get).include_excluded).toBe('1'))
    expect(lastSummaryParams(get).include_excluded).toBe('1')
  })

  it('hides the days column on cards for staff payloads but shows it for admin', async () => {
    window.innerWidth = 375
    render(<Harness role="admin" />)
    await screen.findByText('MARIA SANTOS')
    expect(screen.getAllByText('Days held').length).toBe(4)
  })
})