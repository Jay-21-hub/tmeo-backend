/* eslint-disable react-refresh/only-export-components -- intentionally mixes shared constants + one small badge component to keep the ManageEnforcers split at 7 files total */
import Badge from '../../../../components/ui/Badge'

export const ALL_STATUSES = ['Active', 'On Duty', 'Off Duty', 'On Leave', 'Suspended', 'Resigned', 'Retired']

const STATUS_TONE = {
  'Active':    'success',
  'On Duty':   'info',
  'Off Duty':  'neutral',
  'On Leave':  'warning',
  'Suspended': 'danger',
  'Resigned':  'neutral',
  'Retired':   'neutral',
}

export function EnforcerStatusBadge({ status }) {
  return <Badge tone={STATUS_TONE[status] || 'neutral'}>{status || '—'}</Badge>
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export const getYear = () => new Date().getFullYear()

export const genPassword = () => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$'
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

export const formatEnforcerID = (num, year) => `EN-${String(num).padStart(4, '0')}-${year}`