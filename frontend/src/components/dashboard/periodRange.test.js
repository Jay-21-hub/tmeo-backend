import { describe, it, expect } from 'vitest'
import { customRangeIssue, manilaYmd, periodParams } from './periodRange'

const at = (iso) => new Date(iso)

describe('periodParams', () => {
  it('All time sends range=all and no dates', () => {
    expect(periodParams('all', at('2026-06-15T00:00:00Z'))).toEqual({ range: 'all' })
  })

  it('Today is the Manila calendar day', () => {
    const now = at('2026-11-10T02:00:00Z') // 10:00 Manila
    expect(periodParams('today', now)).toEqual({
      date_from: '2026-11-10',
      date_to: '2026-11-10',
    })
  })

  it('This month runs from the 1st through today', () => {
    expect(periodParams('month', at('2026-11-10T02:00:00Z'))).toEqual({
      date_from: '2026-11-01',
      date_to: '2026-11-10',
    })
  })

  it('This year runs from January 1 through today', () => {
    expect(periodParams('year', at('2026-11-10T02:00:00Z'))).toEqual({
      date_from: '2026-01-01',
      date_to: '2026-11-10',
    })
  })

  it('Last month in January is December of the previous year', () => {
    expect(periodParams('lastMonth', at('2026-01-15T02:00:00Z'))).toEqual({
      date_from: '2025-12-01',
      date_to: '2025-12-31',
    })
  })

  it('Last month in March is February 29 in a leap year (2028)', () => {
    expect(periodParams('lastMonth', at('2028-03-10T02:00:00Z'))).toEqual({
      date_from: '2028-02-01',
      date_to: '2028-02-29',
    })
  })

  it('Last month in March is February 28 in a non-leap year (2027)', () => {
    expect(periodParams('lastMonth', at('2027-03-10T02:00:00Z'))).toEqual({
      date_from: '2027-02-01',
      date_to: '2027-02-28',
    })
  })

  it('Last 7 days on January 3 crosses the month and the year', () => {
    expect(periodParams('last7', at('2026-01-03T07:00:00Z'))).toEqual({
      date_from: '2025-12-28',
      date_to: '2026-01-03',
    })
  })

  it('23:30 Manila (15:30 UTC) is still that Manila date', () => {
    const now = at('2026-01-03T15:30:00Z')
    expect(manilaYmd(now)).toBe('2026-01-03')
    expect(periodParams('today', now)).toEqual({
      date_from: '2026-01-03',
      date_to: '2026-01-03',
    })
    expect(periodParams('last7', now).date_from).toBe('2025-12-28')
  })

  it('00:30 Manila (16:30 UTC the previous day) is the new Manila date, not the UTC date', () => {
    const now = at('2026-01-02T16:30:00Z')
    expect(manilaYmd(now)).toBe('2026-01-03')
    expect(periodParams('today', now)).toEqual({
      date_from: '2026-01-03',
      date_to: '2026-01-03',
    })
    expect(periodParams('last7', now)).toEqual({
      date_from: '2025-12-28',
      date_to: '2026-01-03',
    })
    expect(periodParams('month', now)).toEqual({
      date_from: '2026-01-01',
      date_to: '2026-01-03',
    })
  })

  it('custom passes the two dates through and does not look at now', () => {
    expect(periodParams('custom', at('1999-01-01T00:00:00Z'), {
      date_from: '2024-05-01',
      date_to: '2024-05-04',
    })).toEqual({ date_from: '2024-05-01', date_to: '2024-05-04' })
  })
})

describe('customRangeIssue', () => {
  it('is incomplete until both dates are set, and order when From is after To', () => {
    expect(customRangeIssue('', '2026-05-02')).toBe('incomplete')
    expect(customRangeIssue('2026-05-01', '')).toBe('incomplete')
    expect(customRangeIssue('2026-05-04', '2026-05-01')).toBe('order')
    expect(customRangeIssue('2026-05-01', '2026-05-01')).toBeNull()
  })
})
