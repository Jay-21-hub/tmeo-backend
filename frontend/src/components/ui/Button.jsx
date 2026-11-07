/**
 * Canonical button. variant: primary | secondary | ghost | danger | danger-ghost
 * size: sm | md | lg
 */
export default function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  loading = false,
  disabled = false,
  fullWidth = false,
  children,
  className = '',
  ...rest
}) {
  const sizeClass = size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : ''
  return (
    <button
      className={`btn btn-${variant} ${sizeClass} ${className}`}
      disabled={disabled || loading}
      style={fullWidth ? { width: '100%' } : undefined}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
      ) : Icon ? (
        <Icon size={15} strokeWidth={2.2} aria-hidden="true" />
      ) : null}
      {children && <span>{children}</span>}
      {!loading && IconRight && <IconRight size={15} strokeWidth={2.2} aria-hidden="true" />}
    </button>
  )
}