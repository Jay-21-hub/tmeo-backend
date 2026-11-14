// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AssessmentStep1 } from './staff/sections/assessment/AssessmentFormSteps'
import { StepDriverVehicle } from './enforcer/sections/issue-ovr/Steps'
import NameSuggestions from '../components/common/NameSuggestions'

vi.mock('../hooks/useVehicleCatalog', () => ({
  default: () => ({ vehicles: [], loading: false, refresh: () => {} }),
}))

vi.mock('../services/api', () => ({ default: { get: vi.fn() } }))

const person = { violator_name: 'REYES, ANA', address: '12 Rizal Street' }

const assessmentForm = {
  full_name: '', address: '', license_number: '', plate_number: '',
  registration_number: '', vehicle_use: '', vehicle_type: '', vehicle_brand: '', vehicle_model: '',
  license_status: 'not_confiscated',
  confiscated_document_type: '', confiscated_document_name: '', confiscated_document_number: '',
  ovr_number: '',
}

const ovrForm = {
  last_name: '', first_name: '', middle_initial: '', address: '',
  license_number: '', license_status: 'not_confiscated', license_photo: null,
  plate_number: '', registration_number: '',
  vehicle_type: '', vehicle_brand: '', vehicle_model: '', vehicle_use: 'private',
}

function renderAssessment(extra = {}) {
  return render(
    <AssessmentStep1
      form={assessmentForm}
      errors={{}}
      onChange={() => {}}
      onPlateLookup={() => {}}
      onNameLookup={() => {}}
      onSelectName={() => {}}
      onUseVehicle={() => {}}
      onNext={() => {}}
      {...extra}
    />,
  )
}

describe('license number stays in confiscation', () => {
  it('is absent from Assessment step 1 until Confiscated is chosen', () => {
    const { rerender } = renderAssessment()
    expect(screen.queryByLabelText(/Driver's License Number/i)).toBeNull()
    expect(screen.queryByText(/matching license/i)).toBeNull()

    rerender(
      <AssessmentStep1
        form={{ ...assessmentForm, license_status: 'confiscated' }}
        errors={{}}
        onChange={() => {}}
        onPlateLookup={() => {}}
        onNameLookup={() => {}}
        onSelectName={() => {}}
        onUseVehicle={() => {}}
        onNext={() => {}}
      />,
    )
    expect(screen.getByLabelText(/Driver's License Number/i)).toBeTruthy()
  })

  it('shows a scanned license without making the status Confiscated', () => {
    render(
      <StepDriverVehicle
        form={{ ...ovrForm, scanned_license: 'N01-23-456789' }}
        setForm={() => {}}
        errors={{}}
        onApplyOcr={() => {}}
      />,
    )
    expect(screen.getByTestId('scanned-license').textContent).toBe('Scanned license: N01-23-456789')
    expect(screen.queryByLabelText(/License no/i)).toBeNull()
    expect(screen.getByRole('radio', { name: 'Not confiscated' }).checked).toBe(true)
    expect(screen.getByRole('radio', { name: 'Confiscated' }).checked).toBe(false)
  })

  it('is absent from Issue OVR until Confiscated is chosen', () => {
    const setForm = vi.fn()
    const { rerender } = render(
      <StepDriverVehicle form={ovrForm} setForm={setForm} errors={{}} onApplyOcr={() => {}} />,
    )
    expect(screen.queryByLabelText(/License no/i)).toBeNull()
    expect(screen.queryByText(/matching license/i)).toBeNull()

    rerender(
      <StepDriverVehicle
        form={{ ...ovrForm, license_status: 'confiscated' }}
        setForm={setForm}
        errors={{}}
        onApplyOcr={() => {}}
      />,
    )
    expect(screen.getByLabelText(/License no/i)).toBeTruthy()
  })
})

function NamePick() {
  const [picked, setPicked] = useState(null)
  return (
    <div>
      <span data-testid="picked-name">{picked?.violator_name || ''}</span>
      <span data-testid="picked-license">{picked?.license_number || ''}</span>
      <NameSuggestions suggestions={[person]} onSelect={setPicked} />
    </div>
  )
}

describe('name suggestions', () => {
  it('fills name and address only after a suggestion is chosen', () => {
    const onSelectName = vi.fn()
    renderAssessment({ nameSuggestions: [person], onSelectName })
    expect(onSelectName).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('option', { name: /REYES, ANA/i }))
    expect(onSelectName).toHaveBeenCalledTimes(1)
    expect(onSelectName).toHaveBeenCalledWith(person)
    expect(person.license_number).toBeUndefined()

    render(<NamePick />)
    expect(screen.getByTestId('picked-name').textContent).toBe('')
    fireEvent.click(screen.getAllByRole('option', { name: /REYES, ANA/i })[1])
    expect(screen.getByTestId('picked-name').textContent).toBe('REYES, ANA')
    expect(screen.getByTestId('picked-license').textContent).toBe('')
  })
})
