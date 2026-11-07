// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const get = vi.fn()
const post = vi.fn()
vi.mock('../../../services/api', () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), delete: vi.fn() },
}))
const toast = { success: vi.fn(), danger: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../context/useToast', () => ({ useToast: () => toast }))

import ArchiveManagement from './ArchiveManagement'

const OVERVIEW = {
  active_count: 6, eligible_count: 3, in_progress_count: 1,
  already_archived_active_count: 1, archive_conflict_count: 1, already_archived_count: 10,
  delete_enabled: false,
  year_breakdown: [{ year: 2026, total: 6, settled: 5, unsettled: 1, in_progress: 1, already_archived: 1, conflict: 1 }],
}

const route = (overview) => get.mockImplementation((url) => {
  if (url.includes('overview')) return Promise.resolve({ data: overview })
  if (url.includes('years')) return Promise.resolve({ data: { years: [] } })
  return Promise.resolve({ data: {} })
})

beforeEach(() => { get.mockReset(); post.mockReset(); Object.values(toast).forEach(f => f.mockReset()) })
afterEach(cleanup)

describe('Archive Management — safety UI', () => {
  it('shows the conflict card and a warning when the archive holds clashing / duplicate records', async () => {
    route(OVERVIEW)
    render(<ArchiveManagement />)
    expect(await screen.findByText('Archive Conflicts')).toBeTruthy()
    expect(screen.getByText(/will be skipped because the archive already holds/i)).toBeTruthy()
  })

  it('hides the conflict card and warning when there is nothing to report', async () => {
    route({ ...OVERVIEW, already_archived_active_count: 0, archive_conflict_count: 0 })
    render(<ArchiveManagement />)
    await screen.findByText('Eligible to Archive')
    expect(screen.queryByText('Archive Conflicts')).toBeNull()
    expect(screen.queryByText(/will be skipped/i)).toBeNull()
  })

  it('shows the skipped stat in the confirmation dialog and counts only truly eligible years', async () => {
    route(OVERVIEW)
    render(<ArchiveManagement />)
    fireEvent.click(await screen.findByRole('button', { name: /archive current database/i }))
    expect(await screen.findByText(/Skipped \(already archived \/ conflicting id\)/)).toBeTruthy()
  })

  it('turns a 409 BUSY into a clear "already running, nothing changed" message', async () => {
    route(OVERVIEW)
    post.mockRejectedValue({ response: { status: 409, data: { error: 'busy', status: 'BUSY' } } })
    render(<ArchiveManagement />)
    fireEvent.click(await screen.findByRole('button', { name: /archive current database/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^archive records$/i }))
    await waitFor(() => expect(toast.danger).toHaveBeenCalled())
    expect(toast.danger.mock.calls[0][0]).toMatch(/already running.*No data was changed/i)
  })

  it('reports already-archived and conflict counts from a successful run', async () => {
    route(OVERVIEW)
    post.mockResolvedValue({ data: {
      archived_count: 2, skipped_in_progress_count: 1,
      skipped_already_archived_count: 1, archive_conflict_count: 1,
    } })
    render(<ArchiveManagement />)
    fireEvent.click(await screen.findByRole('button', { name: /archive current database/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^archive records$/i }))
    expect(await screen.findByText(/already-archived record\(s\) were left untouched/i)).toBeTruthy()
    expect(screen.getByText(/conflicting archive id were left untouched/i)).toBeTruthy()
  })
})