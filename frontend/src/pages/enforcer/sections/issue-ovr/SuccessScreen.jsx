import { Button } from '../../../../components/ui'
import { formatIssuedDateTime, violationNamesFromResponse } from './helpers'

/**
 * Shown in place of the wizard once the OVR is in. Two variants:
 *  - online  → the server's saved record (data = create response)
 *  - offline → queued on this device; will sync automatically
 * `fallback` carries what the enforcer entered, used when the server
 * response doesn't include a field.
 */
export default function SuccessScreen({ data, fallback, offline, onIssueAnother, onViewDetails, onViewQueue }) {
  const names = violationNamesFromResponse(data?.items)
  const violations = names.length ? names : fallback.violationNames
  const violationLabel = violations.length === 0 ? '—'
    : violations.length === 1 ? violations[0]
    : `${violations[0]} +${violations.length - 1} more`

  const rows = [
    ['Plate number', data?.plate_number || fallback.plate_number],
    ['Violation', violationLabel],
    ['Location', data?.location || fallback.location],
    ['Date and time', formatIssuedDateTime(data?.date_issued || fallback.date_issued)],
  ]

  return (
    <div className="ovr-success">
      <div className={`ovr-success-badge ${offline ? 'is-offline' : ''}`}>
        <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true">
          <path className="ovr-success-check" d="M9 17.5l5.5 5.5L25 11.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <h2>{offline ? 'Violation Saved — Pending Sync' : 'OVR successfully issued'}</h2>
      <p className="ovr-success-sub">
        {offline
          ? 'There’s no internet right now. This OVR is saved on this device and will sync automatically once you’re back online.'
          : 'The violation ticket is recorded and waiting for Staff assessment.'}
      </p>

      <div className="card card-padded ovr-success-card">
        <span className="text-label">OVR number</span>
        <div className="ovr-success-number mono">{data?.ovr_number || fallback.ovr_number || '—'}</div>
        <dl className="ovr-success-rows">
          {rows.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>
          ))}
        </dl>
      </div>

      <div className="ovr-success-actions">
        {offline
          ? onViewQueue && <Button variant="secondary" onClick={onViewQueue} fullWidth>View sync queue</Button>
          : onViewDetails && <Button variant="secondary" onClick={onViewDetails} fullWidth>View OVR details</Button>}
        <Button variant="primary" onClick={onIssueAnother} fullWidth>Issue another OVR</Button>
      </div>
    </div>
  )
}