import { ArrowUpRight } from 'lucide-react'

const fmtFine = (n) => `₱${Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 })}`

/**
 * Public-safe record card. The public API exposes no image, location or date, so none is shown
 * (violation type(s) and fine only).
 * The reveal (.rv) lives on a wrapper so the card's own hover transition is never delayed;
 * `index` staggers cards in groups of four (0 / 70 / 140 / 210ms) when they enter the viewport.
 */
export default function PublicViolationCard({ record, index = 0, onSelect }) {
  const types = record.violation_types || []
  const primary = types[0]
  const extra = types.length - 1
  const total = types.reduce((s, t) => s + (Number(t.fine) || 0), 0)
  return (
    <div className="pub-vcell rv" style={{ '--d': `${(index % 4) * 70}ms` }}>
      <button type="button" className="pub-vcard" onClick={() => onSelect?.(record)} aria-haspopup="dialog">
        <span className="pub-vcard-type">
          {primary ? primary.name : 'Traffic Violation'}
          {extra > 0 && <span className="pub-vcard-more">+{extra} more</span>}
        </span>
        {primary?.description && <p className="pub-vcard-desc">{primary.description}</p>}
        <span className="pub-vcard-foot">
          <span>{total > 0 ? fmtFine(total) : 'View details'}</span>
          <ArrowUpRight size={18} aria-hidden="true" />
        </span>
      </button>
    </div>
  )
}