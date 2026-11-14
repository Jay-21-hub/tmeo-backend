import { describe, it, expect } from 'vitest'
import { buildOvrFormData, driverLicenseForSubmit, emptyForm, mergeOcrIntoForm } from './helpers'

describe('license scan does not confiscate', () => {
  it('fills the scanned number and leaves the status Not confiscated', () => {
    const next = mergeOcrIntoForm(emptyForm(), {
      full_name: 'Dela Cruz, Juan',
      license_number: 'N01-23-456789',
      license_status: 'confiscated',
    })
    expect(next.license_status).toBe('not_confiscated')
    expect(next.scanned_license).toBe('N01-23-456789')
    expect(driverLicenseForSubmit(next)).toBe('N01-23-456789')
    expect(buildOvrFormData(next, [1]).get('license_status')).toBe('not_confiscated')
    expect(buildOvrFormData(next, [1]).get('license_number')).toBe('N01-23-456789')
  })

  it('submits a typed confiscation number only while Confiscated stays selected', () => {
    const scanned = mergeOcrIntoForm(emptyForm(), { license_number: 'N01-23-456789' })
    const held = {
      ...scanned,
      license_status: 'confiscated',
      confiscated_license_draft: 'TYPED-999',
    }
    expect(driverLicenseForSubmit(held)).toBe('TYPED-999')
    expect(buildOvrFormData(held, [1]).get('license_status')).toBe('confiscated')

    const released = { ...held, license_status: 'not_confiscated', confiscated_license_draft: '' }
    expect(driverLicenseForSubmit(released)).toBe('N01-23-456789')
    expect(buildOvrFormData(released, [1]).get('license_number')).toBe('N01-23-456789')
    expect(buildOvrFormData(released, [1]).get('license_status')).toBe('not_confiscated')
  })

  it('drops a number typed only inside Confiscated when there was no scan', () => {
    const typed = {
      ...emptyForm(),
      license_status: 'not_confiscated',
      confiscated_license_draft: 'TYPED-999',
    }
    expect(driverLicenseForSubmit(typed)).toBe('')
  })
})
