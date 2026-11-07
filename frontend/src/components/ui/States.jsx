import { Inbox } from 'lucide-react'

export function EmptyState({ icon, title = 'Nothing here yet', message, action }) {
  const Icon = icon || Inbox
  return (
    <div className="empty-state">
      <div className="empty-state-icon"><Icon size={24} strokeWidth={1.6} aria-hidden="true" /></div>
      <div className="text-title" style={{ color: 'var(--slate-800)', marginBottom: 4 }}>{title}</div>
      {message && <div className="text-caption" style={{ maxWidth: 320 }}>{message}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  )
}

export function Spinner({ size = 22 }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />
}

export function LoadingRows({ rows = 5, height = 16 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} role="status" aria-label="Loading content">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height, width: `${88 - i * 6}%` }} />
      ))}
    </div>
  )
}

export function ErrorState({ title = 'Something went wrong', message = 'Please try again, or contact support if the issue persists.', onRetry }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon" style={{ background: 'var(--danger-50)', color: 'var(--danger-600)' }}>!</div>
      <div className="text-title" style={{ color: 'var(--slate-800)', marginBottom: 4 }}>{title}</div>
      <div className="text-caption" style={{ maxWidth: 320 }}>{message}</div>
      {onRetry && (
        <button className="btn btn-secondary btn-sm" style={{ marginTop: 16 }} onClick={onRetry}>Retry</button>
      )}
    </div>
  )
}