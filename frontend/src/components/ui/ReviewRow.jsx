/**
 * ReviewSection / ReviewRow — the label/value summary block used on
 * "Review & Submit" screens (Issue OVR step 3, Assessment detail, Check
 * OVR result). One canonical version instead of each screen re-laying out
 * its own two-column dl-style rows.
 *
 * <ReviewSection title="Driver">
 *   <ReviewRow label="Full name" value={form.violator_name} />
 *   <ReviewRow label="License number" value={form.license_number || '—'} />
 * </ReviewSection>
 */
export function ReviewSection({ title, action, children }) {
  return (
    <div className="review-section">
      {(title || action) && (
        <div className="review-section-header">
          {title && <span className="text-label">{title}</span>}
          {action}
        </div>
      )}
      <div className="review-section-body">{children}</div>
    </div>
  )
}

/**
 * props:
 *  label     - left-hand field name
 *  value     - right-hand value (falls back to '—' when empty)
 *  emphasis  - true renders the value larger/bolder (e.g. total penalty)
 */
export function ReviewRow({ label, value, emphasis = false }) {
  const display = value === null || value === undefined || value === '' ? '—' : value
  return (
    <div className="review-row">
      <span className="review-row-label">{label}</span>
      <span className={emphasis ? 'review-row-value review-row-value--emphasis' : 'review-row-value'}>
        {display}
      </span>
    </div>
  )
}