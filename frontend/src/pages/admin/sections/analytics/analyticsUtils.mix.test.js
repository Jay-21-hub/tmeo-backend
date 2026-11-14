import { describe, expect, it } from 'vitest'
import { mixColorMap, OTHERS_KEY, stackedMix } from './analyticsUtils'

function row(label, total, counts, other = 0) {
  return {
    label,
    total,
    other,
    types: Object.entries(counts).map(([name, count]) => ({ name, code: name.toLowerCase(), count })),
  }
}

const names = ['No Helmet', 'Speeding', 'No License', 'Illegal Parking', 'No Plate', 'Reckless', 'Obstruction']
const codes = Object.fromEntries(names.map((name) => [name, name.slice(0, 2).toUpperCase()]))

describe('stackedMix', () => {
  it('keeps the top 8 rows and folds every type past the top 5 into Others', () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(
      `Row ${i + 1}`,
      30 - i,
      { 'No Helmet': 8, Speeding: 4, 'No License': 3, 'Illegal Parking': 2, 'No Plate': 1, Reckless: 2, Obstruction: 1 },
      3,
    ))
    const mix = stackedMix({ type_names: names, type_codes: codes, rows })
    expect(mix.rows).toHaveLength(8)
    expect(mix.rows.map((r) => r.label)).not.toContain('Row 9')
    expect(mix.typeNames).toEqual(names.slice(0, 5))
    expect(mix.rows[0].segments.map((s) => s.count)).toEqual([8, 4, 3, 2, 1])
    expect(mix.rows[0].others).toBe(2 + 1 + 3)
    expect(mix.typeCodes['No Helmet']).toBe('NO')
  })

  it('returns no rows when the matrix is empty', () => {
    expect(stackedMix(null).rows).toEqual([])
    expect(stackedMix({ rows: [], type_names: [] }).typeNames).toEqual([])
  })
})

describe('mixColorMap', () => {
  it('gives one violation type the same colour on both charts', () => {
    const vehicle = stackedMix({
      type_names: ['No Helmet', 'Speeding'],
      type_codes: { 'No Helmet': 'NH', Speeding: 'SP' },
      rows: [row('Motorcycles', 3, { 'No Helmet': 2, Speeding: 1 })],
    })
    const location = stackedMix({
      type_names: ['Speeding', 'No Plate'],
      type_codes: { Speeding: 'SP', 'No Plate': 'NP' },
      rows: [row('Perez Park', 4, { Speeding: 3, 'No Plate': 1 })],
    })
    const colors = mixColorMap([vehicle, location])
    expect(colors.Speeding).toBe(colors.Speeding)
    expect(colors['No Helmet']).not.toBe(colors.Speeding)
    expect(colors['No Plate']).toBeTruthy()
    expect(colors[OTHERS_KEY]).toBeTruthy()
    const again = mixColorMap([vehicle, location])
    expect(again.Speeding).toBe(colors.Speeding)
    expect(again['No Plate']).toBe(colors['No Plate'])
  })
})
