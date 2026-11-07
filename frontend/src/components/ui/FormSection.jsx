/**
 * FormSection — groups related fields under a heading inside a modal/page
 * body, with an optional grid. Fixes the flat, ungrouped field layout
 * flagged in long forms (e.g. Add/Edit Enforcer): instead of one big grid
 * of unrelated fields, wrap logical groups (Personal Information,
 * Employment, Contact, etc.) in a FormSection each.
 *
 * props:
 *  title    - section heading, e.g. "Personal Information"
 *  columns  - 1, 2, or 3 (default 2). Pick the column count that matches
 *             how many fields are actually in the section (e.g. 3 fields ->
 *             columns={3}) so nothing sits alone in an otherwise-empty row —
 *             that's what was inflating modal height. Collapses to 1 on mobile via CSS.
 *  children - Field elements
 */
export function FormSection({ title, columns = 2, children, className = '' }) {
  return (
    <div className={`form-section ${className}`}>
      {title && <div className="form-section-title">{title}</div>}
      <div className={`form-section-grid form-section-grid--${columns}`}>
        {children}
      </div>
    </div>
  )
}