import { describe, it, expect } from 'vitest'
import {
  pickPanel, LABEL_CUMULATIVE, LABEL_THIS_MONTH, LABEL_ACTIVE_ONLY, LABEL_ACTIVE_THIS_MONTH,
} from './historicalPanels'

describe('pickPanel', () => {
  const active = [{ name: 'active-row', count: 1 }]

  it('uses the archived-inclusive rows and the server label when sent', () => {
    const hist = { type_data: [{ name: 'h', count: 9 }], period: { type_data: { label: 'Server label' } } }
    expect(pickPanel(hist, 'type_data', active, LABEL_CUMULATIVE, LABEL_ACTIVE_ONLY))
      .toEqual({ rows: [{ name: 'h', count: 9 }], label: 'Server label', includesArchived: true })
  })

  it('falls back to the default historical label when the server sends none', () => {
    const hist = { top_enforcers: [] }
    const p = pickPanel(hist, 'top_enforcers', active, LABEL_THIS_MONTH, LABEL_ACTIVE_THIS_MONTH)
    expect(p.label).toBe('This month · includes archived')
    expect(p.includesArchived).toBe(true)
  })

  it('an EMPTY archived-inclusive list is still archived-inclusive (never swapped for active rows)', () => {
    const p = pickPanel({ hotspots: [] }, 'hotspots', active, LABEL_CUMULATIVE, LABEL_ACTIVE_ONLY)
    expect(p.rows).toEqual([])
    expect(p.includesArchived).toBe(true)
  })

  it('falls back to the active rows with an active-only label when historical is missing or partial', () => {
    for (const hist of [null, undefined, {}, { total: 5 }, { type_data: null }]) {
      const p = pickPanel(hist, 'type_data', active, LABEL_CUMULATIVE, LABEL_ACTIVE_ONLY)
      expect(p).toEqual({ rows: active, label: 'Active only · archive not included', includesArchived: false })
    }
  })

  it('never returns a non-array', () => {
    expect(pickPanel(null, 'x', undefined, 'a', 'b').rows).toEqual([])
    expect(pickPanel(null, 'x', 'oops', 'a', 'b').rows).toEqual([])
  })

  it('uses the approved wording', () => {
    expect(LABEL_CUMULATIVE).toBe('Cumulative · includes archived')
    expect(LABEL_THIS_MONTH).toBe('This month · includes archived')
  })
})