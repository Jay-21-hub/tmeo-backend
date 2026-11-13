import { ArrowUpRight } from 'lucide-react'

const fmtFine = (n) => `₱${Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 })}`

/**
 * One public-safe violation. The feed returns one row per violation type,
 * so a ticket with several violations is several cards, each with its own fine.
 */
export default function PublicViolationCard({ record, index = 0, onSelect }) {
  const fine = Number(record?.fine) || 0
  return (
    <div className="pub-vcell rv" style={{ '--d': `${(index % 4) * 70}ms` }}>
      <button type="button" className="pub-vcard" onClick={() => onSelect?.(record)} aria-haspopup="dialog">
        <span className="pub-vcard-type">{record?.name || 'Traffic Violation'}</span>
        {record?.description ? <p className="pub-vcard-desc">{record.description}</p> : null}
        <span className="pub-vcard-foot">
          <span>{fine > 0 ? fmtFine(fine) : 'View details'}</span>
          <ArrowUpRight size={18} aria-hidden="true" />
        </span>
      </button>
    </div>
  )
}
