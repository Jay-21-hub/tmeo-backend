import { useId } from 'react'

/**
 * Field — label + control + helper/error, with proper htmlFor/id linking
 * (fixes the accessibility gap flagged in the inspection report: 0 htmlFor
 * usage across the whole app).
 */
export function Field({ label, required, error, helper, children, id: idProp, style }) {
  const autoId = useId()
  const id = idProp || autoId

  return (
    <div className="field" style={style}>
      {label && (
        <label htmlFor={id} className="field-label">
          {label}{required && <span className="field-required" aria-hidden="true"> *</span>}
        </label>
      )}
      {/* children is a render-prop: (id) => <TextInput id={id} ... /> — keeps label/input linked for a11y */}
      {typeof children === 'function' ? children(id) : children}
      {error ? (
        <span className="field-error-text" role="alert">{error}</span>
      ) : helper ? (
        <span className="field-helper">{helper}</span>
      ) : null}
    </div>
  )
}

export function TextInput({ id, error, className = '', ...rest }) {
  return <input id={id} className={`input ${error ? 'input-error' : ''} ${className}`} {...rest} />
}

export function Select({ id, error, className = '', children, ...rest }) {
  return (
    <select id={id} className={`select ${error ? 'input-error' : ''} ${className}`} {...rest}>
      {children}
    </select>
  )
}

export function Textarea({ id, error, className = '', ...rest }) {
  return <textarea id={id} className={`textarea ${error ? 'input-error' : ''} ${className}`} {...rest} />
}