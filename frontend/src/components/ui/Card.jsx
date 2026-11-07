export function Card({ padded = true, interactive = false, className = '', style, children, ...rest }) {
  return (
    <div
      className={`card ${padded ? 'card-padded' : ''} ${interactive ? 'card-interactive' : ''} ${className}`}
      style={style}
      {...rest}
    >
      {children}
    </div>
  )
}

export function CardHeader({ title, subtitle, action }) {
  return (
    <div className="card-header">
      <div>
        <div className="text-h3">{title}</div>
        {subtitle && <div className="text-caption" style={{ marginTop: 2 }}>{subtitle}</div>}
      </div>
      {action}
    </div>
  )
}