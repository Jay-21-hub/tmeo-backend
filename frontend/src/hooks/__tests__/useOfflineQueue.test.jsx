// @vitest-environment jsdom
// Runtime test for Batch 0 (D7). Needs devDependencies:
//   vitest jsdom fake-indexeddb @testing-library/react
// Run:  npx vitest run src/hooks/__tests__/useOfflineQueue.test.jsx
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const post = vi.fn()
vi.mock('../../services/api', () => ({ default: { post: (...a) => post(...a) } }))

import useOfflineQueue from '../useOfflineQueue'
import { saveOfflineEvidence, getAllOfflineEvidence } from '../../services/offlineEvidenceDB'

const ENF_A = { id: 1, role: 'enforcer', full_name: 'Enf A' }
const ENF_B = { id: 2, role: 'enforcer', full_name: 'Enf B' }
const STAFF = { id: 1, role: 'staff', full_name: 'Enf A (now staff)' }
const login = (u) => localStorage.setItem('user', JSON.stringify(u))
const item = (id, extra = {}) => ({
  id, client_offline_id: id, violator_name: 'X', violation_type_ids: [1],
  date_issued: '2026-10-04T10:00', syncStatus: 'queued', source: 'enforcer_ovr', ...extra,
})
const queue = () => JSON.parse(localStorage.getItem('tmeo_offline_reports') || '[]')
const blob = () => new Blob(['x'], { type: 'image/jpeg' })
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)) })

beforeEach(async () => {
  localStorage.clear(); post.mockReset()
  for (const e of await getAllOfflineEvidence()) {
    const { deleteOfflineEvidence } = await import('../../services/offlineEvidenceDB')
    await deleteOfflineEvidence(e.id)
  }
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

describe('user scoping', () => {
  it('add() stamps owner_user_id from the live session, ignoring the caller', () => {
    login(ENF_A); post.mockResolvedValue({ data: { id: 10 } })
    const { result } = renderHook(() => useOfflineQueue())
    act(() => result.current.add({ ...item('offline_1'), owner_user_id: 99 }))
    expect(queue()[0].owner_user_id).toBe(1)
  })

  it('A queues, B logs in: nothing is POSTed and the item is quarantined, not deleted', async () => {
    localStorage.setItem('tmeo_offline_reports', JSON.stringify([item('offline_1', { owner_user_id: 1 })]))
    login(ENF_B)
    const { result } = renderHook(() => useOfflineQueue())
    await settle()
    expect(post).not.toHaveBeenCalled()
    expect(result.current.reports).toHaveLength(0)
    expect(result.current.quarantined).toHaveLength(1)
    expect(result.current.pendingCount).toBe(0)
    expect(queue()).toHaveLength(1)
    expect(queue()[0].syncStatus).toBe('queued')
  })

  it('A logs back in: the item syncs under A', async () => {
    localStorage.setItem('tmeo_offline_reports', JSON.stringify([item('offline_1', { owner_user_id: 1 })]))
    login(ENF_A); post.mockResolvedValue({ data: { id: 10 } })
    renderHook(() => useOfflineQueue())
    await waitFor(() => expect(queue()[0].syncStatus).toBe('synced'))
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][1].client_offline_id).toBe('offline_1')
  })

  it('A) legacy item (no owner_user_id, enforcer=A): A logs in -> NO POST, stays quarantined, unchanged', async () => {
    const legacy = item('offline_1', { enforcer: 1, enforcer_name: 'Enf A' })
    localStorage.setItem('tmeo_offline_reports', JSON.stringify([legacy]))
    login(ENF_A)
    const { result } = renderHook(() => useOfflineQueue()); await settle()
    expect(post).not.toHaveBeenCalled()
    expect(result.current.reports).toHaveLength(0)
    expect(result.current.quarantined).toHaveLength(1)
    expect(queue()).toEqual([legacy])            // not deleted, not mutated, no owner_user_id added
    expect('owner_user_id' in queue()[0]).toBe(false)
  })

  it('B) same legacy item: B logs in -> NO POST, stays quarantined, unchanged', async () => {
    const legacy = item('offline_1', { enforcer: 1, enforcer_name: 'Enf A' })
    localStorage.setItem('tmeo_offline_reports', JSON.stringify([legacy]))
    login(ENF_B)
    const { result } = renderHook(() => useOfflineQueue()); await settle()
    expect(post).not.toHaveBeenCalled()
    expect(result.current.quarantined).toHaveLength(1)
    expect(queue()).toEqual([legacy])
  })

  it('legacy item survives a new item being added by the same user, still unclaimed', async () => {
    const legacy = item('offline_old', { enforcer: 1 })
    localStorage.setItem('tmeo_offline_reports', JSON.stringify([legacy]))
    login(ENF_A); post.mockResolvedValue({ data: { id: 12 } })
    const { result } = renderHook(() => useOfflineQueue())
    act(() => result.current.add(item('offline_new')))
    await act(async () => { await result.current.sync() })   // SyncData triggers sync after add()
    await waitFor(() => expect(queue().find(r => r.id === 'offline_new').syncStatus).toBe('synced'))
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][1].client_offline_id).toBe('offline_new')
    expect(queue().find(r => r.id === 'offline_old')).toEqual(legacy)
  })

  it('C) new properly stamped A item: A can sync', async () => {
    login(ENF_A); post.mockResolvedValue({ data: { id: 10 } })
    const { result } = renderHook(() => useOfflineQueue())
    act(() => result.current.add(item('offline_c')))
    await act(async () => { await result.current.sync() })   // SyncData triggers sync after add()
    await waitFor(() => expect(queue()[0].syncStatus).toBe('synced'))
    expect(queue()[0].owner_user_id).toBe(1)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('D) new properly stamped A item: B cannot sync it', async () => {
    login(ENF_A)
    const a = renderHook(() => useOfflineQueue())
    post.mockImplementation(() => new Promise(() => {}))   // never resolves; keep A's own pass inert
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    act(() => a.result.current.add(item('offline_d')))
    a.unmount()
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    post.mockReset(); post.mockResolvedValue({ data: { id: 13 } })
    login(ENF_B)
    const b = renderHook(() => useOfflineQueue()); await settle()
    expect(post).not.toHaveBeenCalled()
    expect(b.result.current.reports).toHaveLength(0)
    expect(b.result.current.quarantined).toHaveLength(1)
    expect(queue()[0]).toMatchObject({ id: 'offline_d', owner_user_id: 1, syncStatus: 'queued' })
  })

  it('same pk but role changed to staff: queue is never synced', async () => {
    localStorage.setItem('tmeo_offline_reports', JSON.stringify([item('offline_1', { owner_user_id: 1 })]))
    login(STAFF)
    renderHook(() => useOfflineQueue()); await settle()
    expect(post).not.toHaveBeenCalled()
    expect(queue()[0].syncStatus).toBe('queued')
  })

  it('clearSynced and remove never touch another user\'s items', () => {
    localStorage.setItem('tmeo_offline_reports', JSON.stringify([
      item('offline_1', { owner_user_id: 1, syncStatus: 'synced' }),
      item('offline_2', { owner_user_id: 2, syncStatus: 'synced' }),
    ]))
    login(ENF_B)
    const { result } = renderHook(() => useOfflineQueue())
    act(() => result.current.remove('offline_1'))
    act(() => result.current.clearSynced())
    expect(queue().map(r => r.id)).toEqual(['offline_1'])
  })
})

describe('evidence reliability', () => {
  const seed = async (owner = 1) => {
    localStorage.setItem('tmeo_offline_reports', JSON.stringify([item('offline_1', { owner_user_id: owner })]))
    login(owner === 1 ? ENF_A : ENF_B)
    await saveOfflineEvidence('offline_1', blob(), { capturedAt: '2026-10-04T10:00:00Z', latitude: 1, longitude: 2 })
  }

  it('upload fails (403): photo stays in IndexedDB', async () => {
    await seed()
    post.mockImplementation(async (url) => {
      if (url.includes('create')) return { data: { id: 10 } }
      throw Object.assign(new Error('forbidden'), { response: { status: 403 } })
    })
    renderHook(() => useOfflineQueue())
    await waitFor(() => expect(queue()[0].syncStatus).toBe('synced'))
    await settle()
    expect(await getAllOfflineEvidence()).toHaveLength(1)
  })

  it('upload succeeds: photo is deleted', async () => {
    await seed()
    post.mockResolvedValue({ data: { id: 10 } })
    renderHook(() => useOfflineQueue())
    await waitFor(async () => expect(await getAllOfflineEvidence()).toHaveLength(0))
  })

  it('failed photo is retried on a later pass using the saved server id', async () => {
    await seed()
    let evidenceOk = false
    post.mockImplementation(async (url) => {
      if (url.includes('create')) return { data: { id: 10 } }
      if (!evidenceOk) throw new Error('500')
      return { data: {} }
    })
    const first = renderHook(() => useOfflineQueue())
    await waitFor(() => expect(queue()[0].syncStatus).toBe('synced'))
    await settle()
    expect(queue()[0].serverViolationId).toBe(10)
    expect(await getAllOfflineEvidence()).toHaveLength(1)
    first.unmount()
    evidenceOk = true
    renderHook(() => useOfflineQueue())
    await waitFor(async () => expect(await getAllOfflineEvidence()).toHaveLength(0))
    const evCalls = post.mock.calls.filter(c => !c[0].includes('create'))
    expect(evCalls.at(-1)[1].get('violation')).toBe('10')
  })

  it('B logs in: A\'s standalone and OVR-linked photos are not uploaded', async () => {
    await seed(1)
    await saveOfflineEvidence(null, blob(), { capturedAt: '2026-10-04T10:01:00Z', latitude: null, longitude: null })
    login(ENF_B)
    renderHook(() => useOfflineQueue()); await settle()
    expect(post).not.toHaveBeenCalled()
    expect(await getAllOfflineEvidence()).toHaveLength(2)
  })

  it('unstamped legacy standalone photo is never uploaded by anyone', async () => {
    login(ENF_A)
    const { deleteOfflineEvidence } = await import('../../services/offlineEvidenceDB')
    localStorage.removeItem('user')           // save with no session -> no owner stamp
    await saveOfflineEvidence(null, blob(), { capturedAt: '2026-10-04T10:00:00Z' })
    login(ENF_A)
    renderHook(() => useOfflineQueue()); await settle()
    expect(post).not.toHaveBeenCalled()
    const all = await getAllOfflineEvidence(); expect(all).toHaveLength(1)
    await deleteOfflineEvidence(all[0].id)
  })

  it('own standalone photo uploads and is deleted', async () => {
    login(ENF_A)
    await saveOfflineEvidence(null, blob(), { capturedAt: '2026-10-04T10:00:00Z' })
    post.mockResolvedValue({ data: {} })
    renderHook(() => useOfflineQueue())
    await waitFor(async () => expect(await getAllOfflineEvidence()).toHaveLength(0))
  })
})
describe('archived ticket late re-sync (already_archived)', () => {
  // The server answers 200 {id: null, already_archived: true, client_offline_id}
  // when the ticket was ARCHIVED after the original POST. No code change is
  // needed in the hook; these tests pin the behaviour so it cannot regress.
  const ARCHIVED = { data: { id: null, already_archived: true, client_offline_id: 'offline_1' } }
  const seedArchived = async () => {
    localStorage.setItem('tmeo_offline_reports', JSON.stringify([item('offline_1', { owner_user_id: 1 })]))
    login(ENF_A)
    await saveOfflineEvidence('offline_1', blob(), { capturedAt: '2026-10-04T10:00:00Z', latitude: 1, longitude: 2 })
  }
  const evidencePosts = () => post.mock.calls.filter(c => !c[0].includes('create'))

  it('marks the item synced with serverViolationId = null (no retry loop, not failed)', async () => {
    await seedArchived(); post.mockResolvedValue(ARCHIVED)
    renderHook(() => useOfflineQueue())
    await waitFor(() => expect(queue()[0].syncStatus).toBe('synced'))
    expect(queue()[0].serverViolationId).toBeNull()
    expect(queue()[0].syncStatus).not.toBe('failed')
  })

  it('makes no evidence POST: queued photos are neither attached nor uploaded as standalone', async () => {
    await seedArchived(); post.mockResolvedValue(ARCHIVED)
    renderHook(() => useOfflineQueue())
    await waitFor(() => expect(queue()[0].syncStatus).toBe('synced'))
    await settle()
    expect(evidencePosts()).toHaveLength(0)
  })

  it('keeps the queued photos in IndexedDB (nothing is silently deleted)', async () => {
    await seedArchived(); post.mockResolvedValue(ARCHIVED)
    renderHook(() => useOfflineQueue())
    await waitFor(() => expect(queue()[0].syncStatus).toBe('synced'))
    await settle()
    const left = await getAllOfflineEvidence()
    expect(left).toHaveLength(1)
    expect(left[0].local_ovr_id).toBe('offline_1')
  })

  it('does not POST the create again on the next sync pass', async () => {
    await seedArchived(); post.mockResolvedValue(ARCHIVED)
    const { result } = renderHook(() => useOfflineQueue())
    await waitFor(() => expect(queue()[0].syncStatus).toBe('synced'))
    await settle()
    const createCalls = () => post.mock.calls.filter(c => c[0].includes('create')).length
    expect(createCalls()).toBe(1)
    await act(async () => { await result.current.sync() })
    await settle()
    expect(createCalls()).toBe(1)
    expect(evidencePosts()).toHaveLength(0)
  })
})