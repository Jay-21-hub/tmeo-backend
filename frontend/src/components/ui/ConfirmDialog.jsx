import { useId } from 'react'
import { AlertCircle, Info } from 'lucide-react'
import Modal from './Modal'
import Button from './Button'
import Alert from './Alert'

/**
 * ConfirmDialog — the single shared shape for every "review before you
 * commit" and destructive-confirmation modal in the app (confirm-before-save,
 * delete, deactivate, logout, etc.), replacing the ad-hoc <Modal> + manual
 * footer markup previously duplicated in each feature's own modal file.
 *
 * props:
 *  open, onClose
 *  title             - dialog title
 *  tone              - 'primary' (default, e.g. confirm-and-save) | 'danger' (destructive)
 *  message           - optional plain-text/JSX body copy above the summary rows
 *  rows              - optional [[label, value], ...] summary rows (e.g. review-before-save)
 *  confirmLabel      - defaults to 'Confirm'
 *  cancelLabel       - defaults to 'Cancel'
 *  onConfirm         - handler for the confirm button
 *  loading           - shows a loading state on the confirm button; also blocks
 *                      Escape / overlay click / header X / Cancel while true
 *  warning           - optional short warning string shown as an Alert (tone matches `tone`)
 *
 * Optional, additive props (every existing consumer renders exactly as before
 * when these are omitted):
 *  subtitle          - one-line description under the title (shown in the header)
 *  icon              - lucide icon component shown beside the title
 *  reminder          - string | string[] — renders an "Important Reminder" block
 *  reminderTitle     - defaults to 'Important Reminder'
 *  reminderTone      - 'danger' | 'info' (defaults to 'danger' when tone='danger', else 'info')
 *  rowsTitle         - small heading above `rows`
 *  children          - extra content (stat cells, tables) rendered after the reminder
 *  confirmIcon       - lucide icon component for the confirm button
 *  confirmDisabled   - disables the confirm button (e.g. while counts refresh)
 *  width             - panel max width (default 440)
 *
 * Danger dialogs focus Cancel first (not the header X) so a stray Enter/Space
 * never confirms a destructive action.
 */
export default function ConfirmDialog({
  open, onClose, title, tone = 'primary', message, rows, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  onConfirm, loading = false, warning,
  subtitle, icon: Icon, reminder, reminderTitle = 'Important Reminder', reminderTone, rowsTitle,
  children, confirmIcon, confirmDisabled = false, width = 440,
}) {
  const uid = useId()
  const titleId = `${uid}-title`
  const descId = `${uid}-desc`
  const rTone = reminderTone || (tone === 'danger' ? 'danger' : 'info')
  const reminderItems = reminder ? (Array.isArray(reminder) ? reminder : [reminder]) : null
  const RIcon = rTone === 'danger' ? AlertCircle : Info
  const hasRichHeader = !!(Icon || subtitle)
  const hasRich = hasRichHeader || !!reminderItems || !!children

  const heading = hasRichHeader ? (
    <span className="confirm-heading">
      {Icon && (
        <span className={`confirm-heading-icon confirm-heading-icon--${tone === 'danger' ? 'danger' : 'primary'}`} aria-hidden="true">
          <Icon size={20} strokeWidth={2} />
        </span>
      )}
      <span className="confirm-heading-text">
        <span className="confirm-heading-title">{title}</span>
        {subtitle && <span className="confirm-heading-sub">{subtitle}</span>}
      </span>
    </span>
  ) : title

  return (
    <Modal
      open={open} onClose={onClose} width={width} title={heading} mobileFullScreen={false}
      className={hasRich ? 'confirm-dialog-panel--rich' : ''}
      titleId={titleId} describedBy={descId}
      dismissible={!loading}
      initialFocus={tone === 'danger' ? '[data-confirm-cancel]' : undefined}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={loading} data-confirm-cancel>{cancelLabel}</Button>
        <Button variant={tone === 'danger' ? 'danger' : 'primary'} icon={confirmIcon} onClick={onConfirm} loading={loading} disabled={confirmDisabled}>
          {confirmLabel}
        </Button>
      </>}
    >
      <div id={descId}>
        {warning && (
          <div style={{ marginBottom: reminderItems || rows || message || children ? 14 : 0 }}>
            <Alert tone={tone === 'danger' ? 'danger' : 'warning'}>{warning}</Alert>
          </div>
        )}
        {reminderItems && (
          <div className={`confirm-reminder confirm-reminder--${rTone}`} style={{ marginBottom: rows || message || children ? 14 : 0 }}>
            <RIcon size={18} strokeWidth={2.2} className="confirm-reminder-icon" aria-hidden="true" />
            <div>
              <div className="confirm-reminder-title">{reminderTitle}</div>
              <ul className="confirm-reminder-list">
                {reminderItems.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            </div>
          </div>
        )}
        {message && <div className="text-body" style={{ color: 'var(--slate-700)', marginBottom: rows || children ? 14 : 0 }}>{message}</div>}
        {children && <div style={{ marginBottom: rows ? 14 : 0 }}>{children}</div>}
        {rows && (
          <>
            {rowsTitle && <div className="confirm-section-title">{rowsTitle}</div>}
            <div className="confirm-rows">
              {rows.map(([label, value]) => (
                <div key={label} className="confirm-row">
                  <span className="text-caption" style={{ fontWeight: 500 }}>{label}</span>
                  <span className="confirm-row-value">{value}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}