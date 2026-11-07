import Badge from '../../../../components/ui/Badge'
import { STATUS_META, DOC_META } from '../utils/custodyConfig'

/** Custody status as a labelled badge (text + colour, never colour alone). */
export function CustodyStatusBadge({ status }) {
  const meta = STATUS_META[status]
  return <Badge tone={meta?.tone || 'neutral'}>{meta?.label || status || 'Unknown'}</Badge>
}

/**
 * Legacy document-verification badge. Renders nothing for `not_required`
 * (a normal, non-legacy record).
 */
export function DocTypeBadge({ docTypeStatus }) {
  const meta = DOC_META[docTypeStatus]
  if (!meta) return null
  return <Badge tone={meta.tone} dot={false}>{meta.label}</Badge>
}