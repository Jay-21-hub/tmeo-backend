import Badge from './Badge'

/**
 * PageHeader — the in-screen page title row used by every Admin / Staff /
 * Enforcer page: title on the left, the page's primary action(s) on the right.
 * Title only by design (no description line).
 *
 * props:
 *  icon   - lucide icon component (optional)
 *  title  - page title (required)
 *  count  - optional number/string shown as a badge next to the title
 *  action - element rendered at the right (usually a Button)
 */
export default function PageHeader({ icon: Icon, title, count, action }) {
  return (
    <div
      className="page-header"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 12 }}
    >
      <div className="page-header-title" style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        {Icon && <Icon size={22} color="var(--blue-600)" strokeWidth={2} aria-hidden="true" />}
        <h1 style={{ margin: 0, fontFamily: 'Helvetica, Arial, sans-serif', fontSize: 24, lineHeight: 1.2, fontWeight: 700, color: 'var(--navy-900)' }}>{title}</h1>
        {(count || count === 0) && <Badge tone="info" dot={false}>{Number(count).toLocaleString()}</Badge>}
      </div>
      {action}
    </div>
  )
}