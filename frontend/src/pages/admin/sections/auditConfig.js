import {
  ClipboardList, User, AlertTriangle, CheckCircle, Activity, Shield,
  Users, Wallet, Car, Tags, Database, Archive,
} from 'lucide-react'

export const ACTION_COLORS = {
  LOGIN: { bg: '#eff6ff', text: '#2563eb', border: '#bfdbfe', dot: '#3b82f6' },
  LOGOUT: { bg: '#f8fafc', text: '#475569', border: '#e2e8f0', dot: '#94a3b8' },
  CREATE: { bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0', dot: '#22c55e' },
  UPDATE: { bg: '#fffbeb', text: '#d97706', border: '#fde68a', dot: '#f59e0b' },
  DELETE: { bg: '#fef2f2', text: '#dc2626', border: '#fecaca', dot: '#ef4444' },
  DEPLOY: { bg: '#faf5ff', text: '#7c3aed', border: '#e9d5ff', dot: '#8b5cf6' },
  EXPORT: { bg: '#ecfeff', text: '#0e7490', border: '#a5f3fc', dot: '#06b6d4' },
  ARCHIVE: { bg: '#fdf4ff', text: '#a21caf', border: '#f5d0fe', dot: '#c026d3' },
  DEFAULT: { bg: '#f8fafc', text: '#475569', border: '#e2e8f0', dot: '#94a3b8' },
}

export const MODULE_ICONS = {
  'Accounts': Shield,
  'User Management': User,
  'Violations': AlertTriangle,
  'Assessment': CheckCircle,
  'Tickets': ClipboardList,
  'Payment': Wallet,
  'Enforcers': Users,
  'Violation Types': Tags,
  'Vehicle Types': Car,
  'Vehicle Brands & Models': Car,
  'Database Management': Database,
  'DEFAULT': Activity,
}

export { Archive as ArchiveIcon }

/* Dropdown options for the Audit Trail filter bar. Kept in sync with
   AuditLog.ACTION_CHOICES / STATUS_CHOICES on the backend — the
   filter-options endpoint (/api/audit/filter-options/) is the source of
   truth at runtime, these are just the fallback while it's loading. */
export const ACTION_FILTER_OPTIONS = [
  { value: 'CREATE', label: 'Created' },
  { value: 'UPDATE', label: 'Updated' },
  { value: 'DELETE', label: 'Deleted' },
  { value: 'LOGIN', label: 'Logged In' },
  { value: 'LOGOUT', label: 'Logged Out' },
  { value: 'DEPLOY', label: 'Enforcer Deployed' },
  { value: 'EXPORT', label: 'Full Database Export' },
  { value: 'ARCHIVE', label: 'Database Archived' },
]

export const STATUS_FILTER_OPTIONS = [
  { value: 'SUCCESS', label: 'Success' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'WARNING', label: 'Warning' },
  { value: 'INFO', label: 'Info' },
]

/* Human-readable labels for keys that show up inside a log's `changes`
   before/after diff — falls back to a title-cased version of the raw key
   when a field isn't listed here. */
export const FIELD_LABELS = {
  status: 'Status',
  violator_name: 'Violator',
  plate_number: 'Plate Number',
  location: 'Location',
  penalty_amount: 'Penalty',
  remarks: 'Remarks',
  full_name: 'Full Name',
  email: 'Email',
  phone_number: 'Phone Number',
  role: 'Role',
  employment_status: 'Employment Status',
  duty_status: 'Duty Status',
  badge_number: 'Badge No.',
  name: 'Name',
  code: 'Code',
  category: 'Category',
  is_active: 'Active',
  brand: 'Brand',
  model: 'Model',
  shift_start: 'Shift Start',
  shift_end: 'Shift End',
  break_start: 'Break Start',
  break_end: 'Break End',
  assigned_area: 'Assigned Area',
  notes: 'Notes',
}

export function fieldLabel(key) {
  return FIELD_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}