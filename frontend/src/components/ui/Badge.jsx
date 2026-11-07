const TONE_CLASS = {
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
  info: 'badge-info',
  neutral: 'badge-neutral',
}

/** tone: success | warning | danger | info | neutral */
export default function Badge({ tone = 'neutral', dot = true, children, className = '' }) {
  return (
    <span className={`badge ${TONE_CLASS[tone] || TONE_CLASS.neutral} ${className}`}>
      {dot && <span className="badge-dot" aria-hidden="true" />}
      {children}
    </span>
  )
}

// Maps the app's violation/schedule status strings to a tone consistently,
// so every screen renders the same status the same color.
const STATUS_TONE = {
  pending: 'warning',
  processing: 'info',
  paid: 'success',
  overdue: 'danger',
  rejected: 'danger',
  on_duty: 'success',
  off_duty: 'neutral',
  on_break: 'warning',
  active: 'success',
  inactive: 'neutral',
}

export function StatusBadge({ status, label }) {
  const tone = STATUS_TONE[status] || 'neutral'
  const text = label || (status ? status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Unknown')
  return <Badge tone={tone}>{text}</Badge>
}