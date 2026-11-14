// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import * as charts from './AnalyticsCharts'

const EXPECTED = [
  'TrendChart',
  'DonutChart',
  'RankedBarChart',
  'StackedMixChart',
  'PeakHoursChart',
  'WeekdayChart',
  'BusiestSlotsChart',
  'PaymentDurationChart',
  'AgingChart',
  'RepeatDistributionChart',
]

const crosstab = {
  type_names: ['No Helmet', 'Speeding'],
  type_codes: { 'No Helmet': 'NH', Speeding: 'SP' },
  rows: [{
    label: 'Motorcycles',
    total: 3,
    other: 1,
    types: [
      { name: 'No Helmet', code: 'NH', count: 2 },
      { name: 'Speeding', code: 'SP', count: 1 },
    ],
  }],
}

const cases = {
  TrendChart: [
    { data: [{ date: '03/20', count: 4 }] },
    { data: [] },
    { data: null },
    { data: undefined },
    { data: [{ date: undefined, count: undefined }] },
  ],
  DonutChart: [
    { data: [{ status: 'paid', count: 2 }], colorFor: () => '#10B981' },
    { data: [], colorFor: () => '#10B981' },
    { data: null },
    { data: undefined },
    { data: [{ status: undefined, count: undefined }], colorFor: () => undefined },
  ],
  RankedBarChart: [
    { data: [{ name: 'Motorcycles', count: 3 }] },
    { data: [] },
    { data: null },
    { data: undefined },
    { data: [{ name: undefined, count: undefined }] },
  ],
  StackedMixChart: [
    { crosstab, colors: { 'No Helmet': '#2563EB', Speeding: '#7C3AED', Others: '#94A3B8' } },
    { crosstab: { rows: [], type_names: [] } },
    { crosstab: null },
    { crosstab: undefined },
    { crosstab: { type_names: [undefined], type_codes: null, rows: [{ label: undefined, types: null, other: undefined }] } },
  ],
  PeakHoursChart: [
    { data: [{ hour: 8, label: '8:00 AM–9:00 AM', count: 2 }] },
    { data: [] },
    { data: null },
    { data: undefined },
    { data: [{ hour: undefined, label: undefined, count: undefined }] },
  ],
  WeekdayChart: [
    { data: [{ weekday: 1, name: 'Monday', count: 2 }] },
    { data: [] },
    { data: null },
    { data: undefined },
    { data: [{ weekday: undefined, name: undefined, count: undefined }] },
  ],
  BusiestSlotsChart: [
    { heatmap: { weekday_names: ['Monday'], cells: [{ weekday: 1, hour: 8, count: 2 }] } },
    { heatmap: { cells: [] } },
    { heatmap: null },
    { heatmap: undefined },
    { heatmap: { weekday_names: undefined, cells: [{ weekday: undefined, hour: undefined, count: undefined }] } },
  ],
  PaymentDurationChart: [
    { buckets: [{ key: '0_3', label: '0–3 days', count: 1 }] },
    { buckets: [] },
    { buckets: null },
    { buckets: undefined },
    { buckets: [{ key: undefined, label: undefined, count: undefined }] },
  ],
  AgingChart: [
    { buckets: [{ key: '0_7', label: '0–7 days', count: 1, amount: 500 }] },
    { buckets: [] },
    { buckets: null },
    { buckets: undefined },
    { buckets: [{ key: undefined, label: undefined, count: undefined, amount: undefined }] },
  ],
  RepeatDistributionChart: [
    { distribution: [{ label: '2 times', violators: 1 }] },
    { distribution: [] },
    { distribution: null },
    { distribution: undefined },
    { distribution: [{ label: undefined, violators: undefined }] },
  ],
}

describe('AnalyticsCharts render without throwing', () => {
  it('includes every exported chart', () => {
    expect(Object.keys(charts).sort()).toEqual([...EXPECTED].sort())
  })

  for (const name of EXPECTED) {
    for (const [index, props] of cases[name].entries()) {
      it(`${name} case ${index} does not throw`, () => {
        expect(() => render(charts[name](props))).not.toThrow()
      })
    }
  }
})
