import { ArrowUpDown, ChevronUp, ChevronDown } from 'lucide-react'

/**
 * TableWrap — the scrollable/bordered container every data table sits in.
 * Wraps the existing .table-wrap/.table CSS classes so pages don't repeat
 * the className string.
 */
export function TableWrap({ children, className = '' }) {
  return (
    <div className={`table-wrap ${className}`}>
      <table className="table">{children}</table>
    </div>
  )
}

/**
 * SortableTh — a <th> that toggles sort on click and shows the current
 * sort direction. Pass no `field` for a plain, non-sortable header cell.
 * Extracted from ViolationRecords.jsx so Reports/Analytics/Audit tables
 * (Phase 6+) don't redefine the same sort-icon logic.
 *
 * props: label, field, width, sortField, sortDir, onSort
 */
export function SortableTh({ label, field, width, sortField, sortDir, onSort }) {
  const isActive = field && sortField === field
  const Icon = isActive ? (sortDir === 'asc' ? ChevronUp : ChevronDown) : ArrowUpDown
  return (
    <th
      className={field ? 'is-sortable' : ''}
      onClick={() => field && onSort && onSort(field)}
      style={{ width, minWidth: width }}
    >
      <span style={{ display: 'flex', alignItems: 'center' }}>
        {label}
        {field && (
          <Icon
            size={12}
            style={{ marginLeft: 4, opacity: isActive ? 1 : 0.35, color: isActive ? 'var(--blue-600)' : undefined }}
            aria-hidden="true"
          />
        )}
      </span>
    </th>
  )
}

/** TableEmptyRow — one full-width row for the "no results" state. */
export function TableEmptyRow({ colSpan, message = 'No records found.' }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ textAlign: 'center', padding: 'var(--space-10) var(--space-4)', color: 'var(--slate-500)' }}>
        {message}
      </td>
    </tr>
  )
}