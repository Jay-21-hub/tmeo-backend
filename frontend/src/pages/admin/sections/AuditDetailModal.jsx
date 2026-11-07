import { User, Clock, MapPin, Monitor, ArrowRight } from 'lucide-react'
import Modal from '../../../components/ui/Modal'
import { ACTION_COLORS, MODULE_ICONS, fieldLabel } from './auditConfig'

function SectionLabel({ children }) {
  return (
    <p className="text-caption" style={{ margin: '0 0 8px', fontWeight: 700, letterSpacing: '.02em', textTransform: 'uppercase', color: 'var(--slate-400)', fontSize: 11 }}>
      {children}
    </p>
  )
}

function DetailRow({ label, value, highlight }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--slate-100)', gap: 12 }}>
      <span style={{ fontSize: 12, color: 'var(--slate-400)', fontWeight: 500, minWidth: 120, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: highlight ? 'var(--slate-950)' : 'var(--slate-600)', fontWeight: highlight ? 600 : 400, textAlign: 'right', wordBreak: 'break-word' }}>{value}</span>
    </div>
  )
}

/* Renders a before → after row for one changed field inside `changes`. */
function ChangeRow({ field, before, after }) {
  return (
    <div style={{ padding: '8px 0', borderBottom: '1px solid var(--slate-100)' }}>
      <p style={{ margin: '0 0 4px', fontSize: 12, color: 'var(--slate-400)', fontWeight: 500 }}>{fieldLabel(field)}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <span style={{ color: 'var(--danger-600)', textDecoration: 'line-through', wordBreak: 'break-word' }}>
          {before === '' || before === null || before === undefined ? '—' : String(before)}
        </span>
        <ArrowRight size={12} color="var(--slate-400)" style={{ flexShrink: 0 }} />
        <span style={{ color: 'var(--success-600)', fontWeight: 600, wordBreak: 'break-word' }}>
          {after === '' || after === null || after === undefined ? '—' : String(after)}
        </span>
      </div>
    </div>
  )
}

/* Generic fallback: renders whatever's in `details` as label/value rows,
   without any per-module/per-action branching. Keys are turned into
   readable labels via fieldLabel(); arrays are joined, objects are
   skipped (they'd need their own renderer, not a generic one). */
function renderDetailsGeneric(details) {
  if (!details || typeof details !== 'object') return []
  return Object.entries(details)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object')
    .map(([key, value]) => (
      <DetailRow key={key} label={fieldLabel(key)} value={String(value)} />
    ))
}

const formatDate = (str) => {
  if (!str) return '—'
  return new Date(str).toLocaleString('en-PH', { month: 'long', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
}

export default function AuditDetailModal({ log, onClose }) {
  if (!log) return null
  const actionStyle = ACTION_COLORS[log.action] || ACTION_COLORS.DEFAULT
  const ModuleIcon = MODULE_ICONS[log.module] || MODULE_ICONS.DEFAULT
  const statusLower = (log.status || '').toLowerCase()
  const statusTone = statusLower === 'success' ? 'success' : statusLower === 'failed' ? 'danger' : statusLower === 'warning' ? 'warning' : 'info'

  const changeEntries = log.changes && typeof log.changes === 'object' ? Object.entries(log.changes) : []
  const detailRows = renderDetailsGeneric(log.details)

  return (
    <Modal open onClose={onClose} width={520} title="Activity Details">
      <div style={{ margin: '-24px -24px 0', padding: '4px 24px 16px' }}>
        <p className="text-caption" style={{ margin: '0 0 12px' }}>{log.module}</p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <span className="badge" style={{ background: actionStyle.bg, color: actionStyle.text, border: `1px solid ${actionStyle.border}` }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: actionStyle.dot }} />{log.action}
          </span>
          <span className={`badge badge-${statusTone}`}>{log.status}</span>
        </div>

        {/* ── ACTOR ── */}
        <SectionLabel>Actor</SectionLabel>
        <div style={{ background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', padding: '12px 14px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: actionStyle.bg, border: `1px solid ${actionStyle.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <User size={16} color={actionStyle.text} />
          </div>
          <div>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{log.user_name || '—'}</p>
            <p className="text-caption" style={{ margin: 0 }}>{[log.user_email, log.user_role].filter(Boolean).join(' · ')}</p>
          </div>
        </div>

        {/* ── TARGET ── */}
        {(log.target_label || log.target_type) && (
          <>
            <SectionLabel>Target</SectionLabel>
            <div style={{ background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', padding: '12px 14px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: actionStyle.bg, border: `1px solid ${actionStyle.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <ModuleIcon size={16} color={actionStyle.text} />
              </div>
              <div style={{ minWidth: 0 }}>
                <p className="u-truncate" style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{log.target_label || `${log.target_type} #${log.target_id}`}</p>
                <p className="text-caption" style={{ margin: 0 }}>{log.module}</p>
              </div>
            </div>
          </>
        )}

        {/* ── CHANGES (before → after) ── */}
        {changeEntries.length > 0 && (
          <>
            <SectionLabel>Changes</SectionLabel>
            <div style={{ marginBottom: 18 }}>
              {changeEntries.map(([field, diff]) => (
                <ChangeRow key={field} field={field} before={diff?.before} after={diff?.after} />
              ))}
            </div>
          </>
        )}

        {/* ── DETAILS (generic fallback) ── */}
        {detailRows.length > 0 && (
          <>
            <SectionLabel>Details</SectionLabel>
            <div style={{ marginBottom: 8 }}>{detailRows}</div>
          </>
        )}

        {changeEntries.length === 0 && detailRows.length === 0 && (
          <div style={{ marginBottom: 8 }}>
            <DetailRow label="Description" value={log.description} highlight />
          </div>
        )}

        {/* ── CLIENT INFO ── */}
        <SectionLabel>Client Info</SectionLabel>
        <div style={{ marginTop: 4, padding: '2px 0 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Clock size={12} color="var(--slate-400)" />
            <span style={{ fontSize: 12, color: 'var(--slate-600)' }}>{formatDate(log.timestamp)}</span>
          </div>
          {log.ip_address && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <MapPin size={12} color="var(--slate-400)" />
              <span className="mono" style={{ fontSize: 12, color: 'var(--slate-600)' }}>{log.ip_address}</span>
            </div>
          )}
          {log.client_summary && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Monitor size={12} color="var(--slate-400)" />
              <span style={{ fontSize: 12, color: 'var(--slate-600)' }}>{log.client_summary}</span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}