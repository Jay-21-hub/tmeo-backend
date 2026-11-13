import { describe, it, expect } from 'vitest'
import { orNumberDisplay, receivedByDisplay, shown, PENDING_OR } from './ticketDisplay'

describe('digital ticket display', () => {
  it('shows a pending OR until payment, then the real number', () => {
    expect(orNumberDisplay('pending', '')).toBe(PENDING_OR)
    expect(orNumberDisplay('paid', 'OR-44')).toBe('OR-44')
    expect(orNumberDisplay('paid', '')).toBe('— Not provided')
  })

  it('uses an acknowledgment when it exists, otherwise the recorder and time', () => {
    expect(receivedByDisplay({
      acknowledgment: 'Juan Dela Cruz',
      issuerName: 'Enforcer One',
      recordedAtLabel: 'Mar 1, 2026, 9:00 AM',
    })).toBe('Juan Dela Cruz')
    expect(receivedByDisplay({
      acknowledgment: '',
      issuerName: 'Enforcer One',
      recordedAtLabel: 'Mar 1, 2026, 9:00 AM',
    })).toBe('Enforcer One · recorded Mar 1, 2026, 9:00 AM')
  })

  it('does not leave a missing field blank', () => {
    expect(shown('')).toBe('— Not provided')
    expect(shown('Quezon Ave')).toBe('Quezon Ave')
  })
})
