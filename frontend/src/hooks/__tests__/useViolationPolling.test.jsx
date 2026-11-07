// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import useViolationPolling, { STAFF_POLL_MS } from '../useViolationPolling'

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  vi.stubGlobal('EventSource', vi.fn())
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('useViolationPolling (Staff lock/status refresh)', () => {
  it('refreshes every STAFF_POLL_MS (5 s) so the Locked badge cannot go stale', async () => {
    expect(STAFF_POLL_MS).toBe(5000)
    const refresh = vi.fn().mockResolvedValue()
    renderHook(() => useViolationPolling(refresh))
    await vi.advanceTimersByTimeAsync(STAFF_POLL_MS * 3)
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('does not overlap a slow refresh', async () => {
    let release
    const refresh = vi.fn().mockReturnValueOnce(new Promise(r => { release = r })).mockResolvedValue()
    renderHook(() => useViolationPolling(refresh))
    await vi.advanceTimersByTimeAsync(STAFF_POLL_MS * 10)
    expect(refresh).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(STAFF_POLL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('never opens an EventSource and stops on unmount', async () => {
    const refresh = vi.fn().mockResolvedValue()
    const { unmount } = renderHook(() => useViolationPolling(refresh))
    await vi.advanceTimersByTimeAsync(STAFF_POLL_MS)
    unmount()
    await vi.advanceTimersByTimeAsync(STAFF_POLL_MS * 5)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(globalThis.EventSource).not.toHaveBeenCalled()
  })
})