// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import usePolling from '../usePolling'

let hidden = false
const setHidden = (v) => {
  hidden = v
  document.dispatchEvent(new Event('visibilitychange'))
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('usePolling', () => {
  it('does not run at mount, then runs once per interval', async () => {
    const task = vi.fn().mockResolvedValue()
    renderHook(() => usePolling(task, { intervalMs: 1000 }))
    expect(task).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('never overlaps: the next run is scheduled only after the previous one finished', async () => {
    const d = deferred()
    const task = vi.fn().mockReturnValueOnce(d.promise).mockResolvedValue()
    renderHook(() => usePolling(task, { intervalMs: 1000 }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60000)            // slow request still pending
    expect(task).toHaveBeenCalledTimes(1)
    d.resolve()
    await vi.advanceTimersByTimeAsync(999)
    expect(task).toHaveBeenCalledTimes(1)               // interval counts from completion
    await vi.advanceTimersByTimeAsync(1)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('keeps polling after a rejected task', async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue()
    renderHook(() => usePolling(task, { intervalMs: 1000 }))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('pauses while the tab is hidden and polls immediately when it is shown again', async () => {
    const task = vi.fn().mockResolvedValue()
    renderHook(() => usePolling(task, { intervalMs: 1000 }))
    setHidden(true)
    await vi.advanceTimersByTimeAsync(10000)
    expect(task).not.toHaveBeenCalled()
    setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('becoming visible does not start a second, duplicate polling chain', async () => {
    const task = vi.fn().mockResolvedValue()
    renderHook(() => usePolling(task, { intervalMs: 1000 }))
    await vi.advanceTimersByTimeAsync(500)              // a timer is pending
    setHidden(true); setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(task).toHaveBeenCalledTimes(4)               // 1 immediate + one per second, not two per second
  })

  it('a visibility change while a request is in flight does not start another request', async () => {
    const d = deferred()
    const task = vi.fn().mockReturnValue(d.promise)
    renderHook(() => usePolling(task, { intervalMs: 1000 }))
    await vi.advanceTimersByTimeAsync(1000)
    setHidden(true); setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('polls immediately when the browser comes back online', async () => {
    const task = vi.fn().mockResolvedValue()
    renderHook(() => usePolling(task, { intervalMs: 60000 }))
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('stops completely on unmount', async () => {
    const task = vi.fn().mockResolvedValue()
    const { unmount } = renderHook(() => usePolling(task, { intervalMs: 1000 }))
    unmount()
    await vi.advanceTimersByTimeAsync(10000)
    setHidden(true); setHidden(false)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(10000)
    expect(task).not.toHaveBeenCalled()
  })

  it('does nothing when disabled', async () => {
    const task = vi.fn().mockResolvedValue()
    renderHook(() => usePolling(task, { intervalMs: 1000, enabled: false }))
    await vi.advanceTimersByTimeAsync(10000)
    expect(task).not.toHaveBeenCalled()
  })

  it('always calls the latest task (no stale closure)', async () => {
    const first = vi.fn().mockResolvedValue()
    const second = vi.fn().mockResolvedValue()
    const { rerender } = renderHook(({ t }) => usePolling(t, { intervalMs: 1000 }), { initialProps: { t: first } })
    rerender({ t: second })
    await vi.advanceTimersByTimeAsync(1000)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})