import { Phone, ChevronLeft, ChevronRight } from 'lucide-react'
import { EnforcerStatusBadge } from './enforcerStatus'

const CardSkeleton = () => (
  <div className="card card-padded" style={{ marginBottom: 12 }}>
    <div className="skeleton" style={{ height: 16, width: '50%', marginBottom: 8 }} />
    <div className="skeleton" style={{ height: 12, width: '30%' }} />
  </div>
)

const Card = ({ enf, onView, onDeact }) => (
  <div className="card card-padded card-interactive" style={{ marginBottom: 12, cursor: 'pointer' }} onClick={() => onView(enf)}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
      <div>
        <p style={{ fontWeight: 700, fontSize: 14, color: 'var(--slate-950)', margin: 0 }}>{enf.full_name || `${enf.last_name}, ${enf.first_name}`}</p>
        <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue-700)', background: 'var(--blue-50)', padding: '2px 7px', borderRadius: 'var(--radius-sm)', marginTop: 4, display: 'inline-block' }}>{enf.enforcer_id}</span>
      </div>
      <EnforcerStatusBadge status={enf.status} />
    </div>
    <p className="text-caption" style={{ margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 4 }}>
      <Phone size={11} /> {enf.contact || '—'} &nbsp;•&nbsp; Badge: {enf.badge_number || '—'}
    </p>
    <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
      <button className="btn btn-secondary btn-sm" style={{ flex: 1 }} onClick={() => onView(enf)}>View</button>
      <button className="btn btn-danger-ghost btn-sm" style={{ flex: 1, border: '1px solid var(--danger-100)' }} onClick={() => onDeact(enf)}>Deactivate</button>
    </div>
  </div>
)

export default function EnforcerMobileList({
  loading, filtered, paginated, page, totalPages, onPageChange, onView, onDeact,
}) {
  return (
    <div>
      <p className="text-title" style={{ fontSize: 13, marginBottom: 12 }}>{filtered.length} enforcer(s) found</p>

      {loading ? (
        Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)
      ) : paginated.map(enf => (
        <Card key={enf.id} enf={enf} onView={onView} onDeact={onDeact} />
      ))}

      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
          <button className="btn btn-secondary btn-sm" disabled={page === 1} onClick={() => onPageChange(page - 1)}><ChevronLeft size={14} /> Prev</button>
          <span style={{ padding: '8px 12px', fontSize: 13, color: 'var(--slate-600)', fontWeight: 600 }}>{page}/{totalPages}</span>
          <button className="btn btn-secondary btn-sm" disabled={page === totalPages} onClick={() => onPageChange(page + 1)}>Next <ChevronRight size={14} /></button>
        </div>
      )}
    </div>
  )
}