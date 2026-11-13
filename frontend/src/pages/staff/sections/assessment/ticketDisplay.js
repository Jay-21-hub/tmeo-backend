/** On-screen ticket text. Never invents a stored value. */

export const PENDING_OR = 'Pending – to be assigned upon payment'

export function withReason(reason) {
  return reason ? `— ${reason}` : '—'
}

export function shown(value, reason = 'Not provided') {
  if (value === null || value === undefined) return withReason(reason)
  const text = String(value).trim()
  if (!text || text === '—') return withReason(reason)
  return text
}

export function orNumberDisplay(status, orNumber) {
  const or = String(orNumber || '').trim()
  if (or) return or
  if (String(status || '').toLowerCase() !== 'paid') return PENDING_OR
  return withReason('Not provided')
}

/**
 * Violator acknowledgment wins when it was actually recorded.
 * Otherwise show who recorded the ticket and when.
 */
export function receivedByDisplay({ acknowledgment, issuerName, recordedAtLabel }) {
  const ack = String(acknowledgment || '').trim()
  if (ack) return ack
  const name = String(issuerName || '').trim()
  const when = String(recordedAtLabel || '').trim()
  const hasWhen = when && when !== '—'
  if (name && name !== '—' && hasWhen) return `${name} · recorded ${when}`
  if (name && name !== '—') return name
  if (hasWhen) return `Recorded ${when}`
  return withReason('Not recorded')
}
