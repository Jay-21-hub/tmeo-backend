// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import PublicViolationCard from '../PublicViolationCard'
import ViolationDetailModal from '../ViolationDetailModal'

afterEach(cleanup)

const helmet = {
  name: 'No Helmet', category: 'Minor', description: 'Riding without a helmet', fine: 500,
}
const license = {
  name: 'No License', category: 'Major', description: 'Driving without a license', fine: 1500,
}

describe('public violation record (one violation per entry)', () => {
  it('card shows that violation and its own fine, not a merged total', () => {
    const { container } = render(<PublicViolationCard record={helmet} />)
    expect(screen.getByText('No Helmet')).toBeTruthy()
    expect(screen.queryByText(/\+1 more/)).toBeNull()
    expect(screen.getByText('₱500')).toBeTruthy()
    expect(screen.queryByText('₱2,000')).toBeNull()
    expect(container.querySelector('.pub-vcard-date')).toBeNull()
  })

  it('a second violation is its own card', () => {
    render(<PublicViolationCard record={license} />)
    expect(screen.getByText('No License')).toBeTruthy()
    expect(screen.getByText('₱1,500')).toBeTruthy()
  })

  it('detail modal shows that violation and its fine, and no issue date', () => {
    render(<ViolationDetailModal open onClose={() => {}} record={license} />)
    expect(screen.getByText('No License')).toBeTruthy()
    expect(screen.getByText('₱1,500')).toBeTruthy()
    expect(screen.queryByText(/total fine/i)).toBeNull()
    expect(screen.queryByText(/date issued/i)).toBeNull()
    expect(document.body.textContent).not.toMatch(/2026|March/)
  })
})
