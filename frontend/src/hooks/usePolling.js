import { useEffect, useRef } from 'react'

/**
 * usePolling(task, { intervalMs, enabled })
 *
 * Calls `task()` repeatedly, `intervalMs` AFTER the previous call has finished
 * (a chained setTimeout, not setInterval), so two calls can never overlap even
 * when the network or server is slow. `task` should return its promise.
 *
 * - Pauses while the tab is hidden; polls once immediately when it becomes
 *   visible again, and when the browser comes back online.
 * - Always calls the latest `task` passed in (no stale closures).
 * - A throwing/rejecting task never stops the loop (tasks own their error UI).
 * - Cleans up every timer and listener on unmount.
 *
 * It does NOT run `task` at mount: callers do their own initial load.
 */
export default function usePolling(task, { intervalMs = 15000, enabled = true } = {}) {
  const taskRef = useRef(task)
  useEffect(() => { taskRef.current = task })

  useEffect(() => {
    if (!enabled) return undefined

    let stopped = false
    let inFlight = false
    let timer = null

    const clear = () => {
      if (timer !== null) { clearTimeout(timer); timer = null }
    }

    const schedule = () => {
      clear()
      if (stopped || document.hidden) return
      timer = setTimeout(run, intervalMs)
    }

    async function run() {
      clear()
      if (stopped || inFlight) return
      inFlight = true
      try {
        await taskRef.current?.()
      } catch {
        /* the task handles its own errors; keep polling */
      } finally {
        inFlight = false
        schedule()
      }
    }

    const onVisibility = () => {
      if (document.hidden) { clear(); return }
      if (!inFlight) run()
    }
    const onOnline = () => {
      if (!document.hidden && !inFlight) run()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    schedule()

    return () => {
      stopped = true
      clear()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }, [intervalMs, enabled])
}