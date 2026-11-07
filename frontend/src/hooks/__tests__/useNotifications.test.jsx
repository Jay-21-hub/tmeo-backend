// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

const get = vi.fn()
const post = vi.fn()
vi.mock('../../services/api', () => ({ default: { get: (...a) => get(...a), post: (...a) => post(...a) } }))

import useNotifications, { NOTIF_POLL_MS } from '../useNotifications'

const n = (id, extra = {}) => ({ id, notif_type: 'new_violation', title: `T${id}`, message: 'm', is_read: false, time_ago: '1m ago', ...extra })
const payload = (list, unread = list.filter(x => !x.is_read).length) => ({ data: { notifications: list, unread_count: unread } })
const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const tick = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

let hidden = false
let EventSourceSpy

beforeEach(() => {
  vi.useFakeTimers()
  get.mockReset(); post.mockReset()
  localStorage.clear(); localStorage.setItem('access_token', 'tok')
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  EventSourceSpy = vi.fn()
  vi.stubGlobal('EventSource', EventSourceSpy)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('useNotifications (polling, no SSE)', () => {
  it('polls every 15 s', () => expect(NOTIF_POLL_MS).toBe(15000))

  it('loads on mount and exposes the same shape as before', async () => {
    get.mockResolvedValue(payload([n(1), n(2, { is_read: true })]))
    const { result } = renderHook(() => useNotifications())
    await flush()
    expect(get).toHaveBeenCalledWith('/api/notifications/')
    expect(result.current.notifications).toHaveLength(2)
    expect(result.current.unreadCount).toBe(1)
    expect(typeof result.current.markRead).toBe('function')
    expect(typeof result.current.refetch).toBe('function')
  })

  it('never opens an EventSource', async () => {
    get.mockResolvedValue(payload([]))
    renderHook(() => useNotifications())
    await flush(); await tick(60000)
    expect(EventSourceSpy).not.toHaveBeenCalled()
  })

  it('a new notification appears on the next poll and the unread count follows', async () => {
    get.mockResolvedValueOnce(payload([n(1)])).mockResolvedValue(payload([n(2), n(1)]))
    const { result } = renderHook(() => useNotifications())
    await flush()
    expect(result.current.unreadCount).toBe(1)
    await tick(15000)
    expect(get).toHaveBeenCalledTimes(2)
    expect(result.current.notifications.map(x => x.id)).toEqual([2, 1])   // no duplicates
    expect(result.current.unreadCount).toBe(2)
  })

  it('does not start a request while the previous one is still running', async () => {
    const d = deferred()
    get.mockReturnValueOnce(d.promise).mockResolvedValue(payload([]))
    renderHook(() => useNotifications())
    await tick(90000)
    expect(get).toHaveBeenCalledTimes(1)
    d.resolve(payload([]))
    await flush()
    await tick(15000)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('pauses while hidden and refreshes when the tab is shown', async () => {
    get.mockResolvedValue(payload([]))
    renderHook(() => useNotifications())
    await flush()
    hidden = true; document.dispatchEvent(new Event('visibilitychange'))
    await tick(120000)
    expect(get).toHaveBeenCalledTimes(1)
    hidden = false; document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('markRead(id) updates the list and unread count immediately', async () => {
    get.mockResolvedValue(payload([n(5), n(6)]))
    post.mockResolvedValue({ data: { status: 'ok' } })
    const { result } = renderHook(() => useNotifications())
    await flush()
    await act(async () => { await result.current.markRead(5) })
    expect(post).toHaveBeenCalledWith('/api/notifications/5/read/')
    expect(result.current.unreadCount).toBe(1)
    expect(result.current.notifications.find(x => x.id === 5).is_read).toBe(true)
  })

  it('markRead() with no id marks all as read', async () => {
    get.mockResolvedValue(payload([n(5), n(6)]))
    post.mockResolvedValue({ data: { status: 'ok' } })
    const { result } = renderHook(() => useNotifications())
    await flush()
    await act(async () => { await result.current.markRead() })
    expect(post).toHaveBeenCalledWith('/api/notifications/read/')
    expect(result.current.unreadCount).toBe(0)
    expect(result.current.notifications.every(x => x.is_read)).toBe(true)
  })

  it('a poll that started BEFORE markRead cannot bring the unread badge back', async () => {
    const stale = deferred()
    get.mockResolvedValueOnce(payload([n(5)]))              // initial: 1 unread
        .mockReturnValueOnce(stale.promise)                  // poll in flight (server snapshot predates the click)
        .mockResolvedValue(payload([n(5, { is_read: true })]))
    post.mockResolvedValue({ data: { status: 'ok' } })
    const { result } = renderHook(() => useNotifications())
    await flush()
    await tick(15000)                                        // poll starts, still pending
    await act(async () => { await result.current.markRead(5) })
    expect(result.current.unreadCount).toBe(0)
    stale.resolve(payload([n(5)]))                           // stale answer arrives late
    await flush()
    expect(result.current.unreadCount).toBe(0)               // discarded
    expect(result.current.notifications[0].is_read).toBe(true)
    await tick(15000)                                        // next poll is consistent
    expect(result.current.unreadCount).toBe(0)
  })

  it('a failed poll keeps the current list and polling continues', async () => {
    get.mockResolvedValueOnce(payload([n(1)])).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(payload([n(2), n(1)]))
    const { result } = renderHook(() => useNotifications())
    await flush()
    await tick(15000)
    expect(result.current.notifications).toHaveLength(1)     // unchanged
    await tick(15000)
    expect(result.current.notifications).toHaveLength(2)
  })

  it('without an access token it does not keep polling (same rule the SSE stream had)', async () => {
    localStorage.removeItem('access_token')
    get.mockResolvedValue(payload([]))
    renderHook(() => useNotifications())
    await flush(); await tick(120000)
    expect(get).toHaveBeenCalledTimes(1)                     // the initial load only, as before
  })

  it('stops polling on unmount', async () => {
    get.mockResolvedValue(payload([]))
    const { unmount } = renderHook(() => useNotifications())
    await flush()
    unmount()
    await tick(120000)
    expect(get).toHaveBeenCalledTimes(1)
  })
})