import { Eye, UserX, ChevronLeft, ChevronRight, Users2 } from 'lucide-react'
import { EmptyState } from '../../../../components/ui/States'
import { EnforcerStatusBadge, dutyStatusLabel } from './enforcerStatus'

const COLS = ['Enforcer ID', 'Full Name', 'Badge No.', 'Contact', 'Status', 'Actions']

export default function EnforcersTable({
  loading, filtered, paginated, page, totalPages, search, onClearSearch,
  onPageChange, onView, onDeact,
}) {
  return (
    <div className="card">
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--slate-100)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="text-title" style={{ fontSize: 13 }}>Showing <strong>{filtered.length}</strong> enforcer(s)</span>
        {search && <button onClick={onClearSearch} className="text-caption" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--slate-500)' }}>Clear ✕</button>}
      </div>

      <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
        <table className="table">
          <thead>
            <tr>{COLS.map(col => <th key={col}>{col}</th>)}</tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 6 }).map((_, j) => (
                  <td key={j}><div className="skeleton" style={{ height: 13, width: '70%' }} /></td>
                ))}</tr>
              ))
            ) : paginated.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: 0 }}>
                <EmptyState icon={Users2} title="No enforcers found" message={search ? 'Try a different search' : 'Add enforcers from User Management'} />
              </td></tr>
            ) : paginated.map(enf => (
              <tr key={enf.id}>
                <td><span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--blue-700)', background: 'var(--blue-50)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}>{enf.enforcer_id || '—'}</span></td>
                <td style={{ fontWeight: 600, color: 'var(--slate-950)' }}>{enf.full_name || `${enf.last_name}, ${enf.first_name}`}</td>
                <td className="text-caption">{enf.badge_number || '—'}</td>
                <td className="text-caption">{enf.contact || '—'}</td>
                <td><EnforcerStatusBadge status={dutyStatusLabel(enf)} /></td>
                <td>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    <button className="row-action-btn" style={{ background: 'var(--blue-50)', opacity: 1 }} title="View" onClick={() => onView(enf)}><Eye size={13} color="var(--blue-600)" /></button>
                    <button className="row-action-btn" style={{ background: 'var(--danger-50)', opacity: 1 }} title="Deactivate" onClick={() => onDeact(enf)}><UserX size={13} color="var(--danger-600)" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--slate-100)', flexWrap: 'wrap', gap: 8 }}>
          <span className="text-caption">Page {page} of {totalPages}</span>
          <div className="pagination">
            <button className="page-btn" disabled={page === 1} onClick={() => onPageChange(Math.max(1, page - 1))}><ChevronLeft size={14} /></button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 1).map((p, idx, arr) => (
              <span key={p} style={{ display: 'flex' }}>
                {idx > 0 && arr[idx - 1] !== p - 1 && <span style={{ padding: '0 4px', color: 'var(--slate-400)' }}>…</span>}
                <button className={`page-btn ${p === page ? 'is-active' : ''}`} onClick={() => onPageChange(p)}>{p}</button>
              </span>
            ))}
            <button className="page-btn" disabled={page === totalPages} onClick={() => onPageChange(Math.min(totalPages, page + 1))}><ChevronRight size={14} /></button>
          </div>
        </div>
      )}
    </div>
  )
}