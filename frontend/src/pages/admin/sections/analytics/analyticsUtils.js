import { useEffect, useState } from 'react'

/* ─── Recharts v3 click helper ───
   Chart-level onClick in Recharts 3 no longer provides `activePayload`; it
   provides `activeTooltipIndex`. This resolves the clicked row from either
   shape so click handlers work on both. */
export function rowFromChartEvent(data, state) {
  if (!state || !Array.isArray(data)) return null
  const viaPayload = state.activePayload?.[0]?.payload
  if (viaPayload) return viaPayload
  const i = Number(state.activeTooltipIndex ?? state.activeIndex)
  return Number.isInteger(i) && i >= 0 && i < data.length ? data[i] : null
}

/* ─── Element width hook ───
   Measures the Analytics page itself (not the window), so layouts react to the real content width
   even when the sidebar is expanded, collapsed or replaced by a drawer. Returns 0 until measured. */
export function useElementWidth(el) {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!el) return undefined
    if (typeof ResizeObserver === 'undefined') return undefined // first measurement arrives from the observer itself
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return width
}