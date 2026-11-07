// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import PublicViolationCard from '../PublicViolationCard'
import ViolationDetailModal from '../ViolationDetailModal'

afterEach(cleanup)

// The public API returns only violation_types. A stray date_issued (e.g. from an older
// backend) must never be rendered: the public records show the violation and fine only.
const record = {
  date_issued: '2026-03-14T09:30:00+08:00',
  violation_types: [
    { name: 'No Helmet', category: 'Minor', description: 'Riding without a helmet', fine: 500 },
    { name: 'No License', category: 'Major', description: 'Driving without a license', fine: 1500 },
  ],
}

describe('public violation record (fines only, no dates)', () => {
  it('card shows the violation, the extra-count and the total fine, but no date', () => {
    const { container } = render(<PublicViolationCard record={record} />)
    expect(screen.getByText('No Helmet')).toBeTruthy()
    expect(screen.getByText('+1 more')).toBeTruthy()
    expect(screen.getByText('₱2,000')).toBeTruthy()
    expect(container.querySelector('.pub-vcard-date')).toBeNull()
    expect(container.textContent).not.toMatch(/2026|Mar/)
  })

  it('detail modal lists each type with its fine and the total, but no issue date', () => {
    render(<ViolationDetailModal open onClose={() => {}} record={record} />)
    expect(screen.getByText('No License')).toBeTruthy()
    expect(screen.getByText('₱1,500')).toBeTruthy()
    expect(screen.getByText('₱2,000')).toBeTruthy()
    expect(screen.queryByText(/date issued/i)).toBeNull()
    expect(document.body.textContent).not.toMatch(/2026|March/)
  })
})