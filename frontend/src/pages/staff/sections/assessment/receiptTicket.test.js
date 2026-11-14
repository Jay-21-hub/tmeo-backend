import { describe, it, expect } from 'vitest'
import { buildReceiptTicket } from './receiptTicket'

// Role Evolution Phase 3: the printed "Assessed by" is the persisted event-time
// assessor only. It must never fall back to the live / FK account.
describe('buildReceiptTicket — assessor identity', () => {
  it('uses the persisted assessment assessor name', () => {
    const t = buildReceiptTicket({
      status: 'paid',
      assessed_by: { full_name: 'Live Name Now' },
      assessment: { assessed_by_name: 'Name At The Time' },
    })
    expect(t.assessed_by).toBe('Name At The Time')
  })

  it('prints blank when the legacy assessor cannot be proven (no live fallback)', () => {
    const t = buildReceiptTicket({
      status: 'paid',
      assessed_by: { full_name: 'Live Payment Confirmer' },
      assessment: { assessed_by_name: null },
    })
    expect(t.assessed_by).toBe('')
  })

  it('does not use a string assessed_by either', () => {
    expect(buildReceiptTicket({ assessed_by: 'Someone', assessment: {} }).assessed_by).toBe('')
  })

  it('still leaves payment fields alone', () => {
    const t = buildReceiptTicket({ violator_name: 'JUAN', assessment: { or_number: 'OR-1', amount_paid: 500 } })
    expect([t.full_name, t.or_number, t.amount_paid, t.received_by]).toEqual(['JUAN', 'OR-1', 500, ''])
  })
})

// Received by = the Treasury Personnel recorded at Confirm Payment (event-time
// name). It is never taken from the assessor, the live account or free text.
describe('buildReceiptTicket — received by', () => {
  it('prints the recorded Treasury Personnel name', () => {
    const t = buildReceiptTicket({ assessment: { received_by: 'Maria Cruz', assessed_by_name: 'Staff Person' } })
    expect(t.received_by).toBe('Maria Cruz')
  })

  it('stays blank when nobody was chosen (never falls back to assessor/staff)', () => {
    const t = buildReceiptTicket({
      assessed_by: { full_name: 'Live Staff' },
      assessment: { received_by: '', assessed_by_name: 'Staff Person' },
    })
    expect(t.received_by).toBe('')
    expect(buildReceiptTicket({}).received_by).toBe('')
  })
})