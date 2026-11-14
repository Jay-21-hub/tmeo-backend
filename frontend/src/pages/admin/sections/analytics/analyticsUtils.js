import { useEffect, useState } from 'react'
import { CHART_PALETTE } from './analyticsConfig'

export const OTHERS_KEY = 'Others'
export const OTHERS_COLOR = '#94A3B8'

/* Turn an existing Row × Violation Type matrix into top rows, each split into
   the leading violation types plus one Others count. The matrix is already
   sorted by total, and `other` already holds every type past the matrix columns. */
export function stackedMix(crosstab, { topRows = 8, topTypes = 5 } = {}) {
  const names = Array.isArray(crosstab?.type_names) ? crosstab.type_names : []
  const codes = crosstab?.type_codes || {}
  const kept = names.slice(0, topTypes)
  const dropped = new Set(names.slice(topTypes))
  const rows = (Array.isArray(crosstab?.rows) ? crosstab.rows : [])
    .slice(0, topRows)
    .map((r) => {
      const byName = new Map((r.types || []).map((t) => [t.name, t]))
      const segments = kept.map((name) => {
        const t = byName.get(name)
        return { name, code: t?.code || codes[name] || null, count: Number(t?.count) || 0 }
      })
      let others = Number(r.other) || 0
      for (const t of r.types || []) {
        if (dropped.has(t.name)) others += Number(t.count) || 0
      }
      return { label: r.label, total: Number(r.total) || 0, segments, others }
    })
  return {
    rows,
    typeNames: kept,
    typeCodes: Object.fromEntries(kept.map((name) => [name, codes[name] || null])),
  }
}

/* Same violation type keeps the same colour on every chart that shares this map. */
export function mixColorMap(mixes, palette = CHART_PALETTE) {
  const names = []
  for (const mix of mixes || []) {
    for (const name of mix?.typeNames || []) {
      if (name && !names.includes(name)) names.push(name)
    }
  }
  const map = { [OTHERS_KEY]: OTHERS_COLOR }
  names.forEach((name, i) => { map[name] = palette[i % palette.length] })
  return map
}

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