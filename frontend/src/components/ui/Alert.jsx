import { CheckCircle2, AlertTriangle, XCircle, Info } from 'lucide-react'

const ICON = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle, info: Info }

/** tone: success | warning | danger | info */
export default function Alert({ tone = 'info', title, children, className = '' }) {
  const Icon = ICON[tone] || Info
  return (
    <div className={`alert alert-${tone} ${className}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon size={18} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
      <div>
        {title && <div className="alert-title">{title}</div>}
        {children && <div>{children}</div>}
      </div>
    </div>
  )
}