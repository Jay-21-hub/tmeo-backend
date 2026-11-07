import { useCallback, useRef, useState } from 'react'
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react'
import { ToastContext } from './toastContextObject'

const ICON = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle, info: Info }
const COLOR = { success: 'var(--success-600)', warning: 'var(--warning-600)', danger: 'var(--danger-600)', info: 'var(--blue-600)' }

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const idRef = useRef(0)

  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  const push = useCallback((tone, message, opts = {}) => {
    const id = ++idRef.current
    setToasts((t) => [...t, { id, tone, message, title: opts.title }])
    setTimeout(() => dismiss(id), opts.duration ?? 4500)
  }, [dismiss])

  const api = {
    success: (msg, opts) => push('success', msg, opts),
    warning: (msg, opts) => push('warning', msg, opts),
    danger: (msg, opts) => push('danger', msg, opts),
    info: (msg, opts) => push('info', msg, opts),
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite" aria-atomic="true">
        {toasts.map((t) => {
          const Icon = ICON[t.tone] || Info
          return (
            <div className="toast" key={t.id} role={t.tone === 'danger' ? 'alert' : 'status'}>
              <Icon size={18} strokeWidth={2} color={COLOR[t.tone]} style={{ flexShrink: 0 }} aria-hidden="true" />
              <div style={{ flex: 1 }}>
                {t.title && <div className="text-title" style={{ marginBottom: 2 }}>{t.title}</div>}
                <div className="text-caption" style={{ color: 'var(--slate-700)' }}>{t.message}</div>
              </div>
              <button className="btn btn-ghost btn-icon" style={{ padding: 4 }} onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
                <X size={14} />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}