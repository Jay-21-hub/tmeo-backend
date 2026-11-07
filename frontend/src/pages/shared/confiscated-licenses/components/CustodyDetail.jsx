import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CheckCircle2, Send, ShieldCheck, Pencil } from 'lucide-react'
import { useToast } from '../../../../context/useToast'
import { useBreakpoint } from '../../../../hooks/useBreakpoint'
import { formatDateTime } from '../../../../utils/helpers'
import Button from '../../../../components/ui/Button'
import Badge from '../../../../components/ui/Badge'
import Alert from '../../../../components/ui/Alert'
import { Card, CardHeader } from '../../../../components/ui/Card'
import { EmptyState, ErrorState, LoadingRows } from '../../../../components/ui/States'
import { TableWrap, TableEmptyRow } from '../../../../components/ui/Table'
import { fetchCustodyDetail, fetchCustodyTimeline } from '../services/custodyApi'
import { parseCustodyError } from '../utils/custodyErrors'
import {
  DOC, claimantIdTypeLabel, describeEventDetails, eventLabel,
  getActionAvailability, statusLabel,
} from '../utils/custodyConfig'
import { CustodyStatusBadge, DocTypeBadge } from './CustodyBadges'
import {
  MarkReadyModal, ReleaseModal, VerifyDocumentModal, CorrectLicenseModal,
} from './CustodyActionModals'
import '../ConfiscatedLicenses.css'

const ROLE_LABELS = { admin: 'Administrator', staff: 'Assessment Staff' }

const SUCCESS_COPY = {
  ready: 'License marked ready for release.',
  release: 'License released.',
  correct: 'License number corrected.',
}

function DetailList({ rows }) {
  return (
    <dl className="cl-dl">
      {rows.filter(Boolean).map(([label, value]) => (
        <div key={label} className="cl-dl-row">
          <dt>{label}</dt>
          <dd>{value || value === 0 ? value : '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

function ActionButton({ action, icon, variant = 'secondary', onClick, busy, children }) {
  const disabled = !action.enabled || busy
  const reasonId = `cl-action-${String(children).replace(/\W+/g, '-').toLowerCase()}`
  return (
    <div className="cl-action">
      <Button variant={variant} icon={icon} fullWidth disabled={disabled} onClick={onClick} aria-describedby={action.reason ? reasonId : undefined}>
        {children}
      </Button>
      {action.reason && <p id={reasonId} className="cl-action-note">{action.reason}</p>}
    </div>
  )
}

function HistorySection({ events, error, loading, isAdmin, isMobile, onRetry }) {
  let body
  if (error) {
    body = <ErrorState title="Could not load custody history" message={error.message} onRetry={onRetry} />
  } else if (!events) {
    body = <LoadingRows rows={3} height={18} />
  } else if (isMobile) {
    body = events.length === 0 ? (
      <p className="cl-muted">No custody actions have been recorded yet.</p>
    ) : (
      <ol className="cl-events">
        {events.map((e) => (
          <li key={e.id} className="cl-event">
            <div className="cl-event-title">{eventLabel(e.event_type)}</div>
            <div className="cl-muted">{formatDateTime(e.created_at)} · {e.actor_name || '—'}{isAdmin && e.actor_role ? ` (${ROLE_LABELS[e.actor_role] || e.actor_role})` : ''}</div>
            {e.from_status !== e.to_status && e.to_status && (
              <div className="cl-muted">{statusLabel(e.from_status)} → {statusLabel(e.to_status)}</div>
            )}
            {isAdmin && describeEventDetails(e).map(([k, v]) => <div key={k} className="cl-event-detail"><strong>{k}:</strong> {v}</div>)}
          </li>
        ))}
      </ol>
    )
  } else {
    body = (
      <TableWrap className="cl-table-wrap">
        <caption className="sr-only">Custody history</caption>
        <thead>
          <tr>
            <th scope="col">Date and Time</th>
            <th scope="col">Action</th>
            <th scope="col">Performed By</th>
            <th scope="col">Status Change</th>
            {isAdmin && <th scope="col">Details</th>}
          </tr>
        </thead>
        <tbody>
          {events.length === 0 ? (
            <TableEmptyRow colSpan={isAdmin ? 5 : 4} message="No custody actions have been recorded yet." />
          ) : events.map((e) => (
            <tr key={e.id}>
              <td>{formatDateTime(e.created_at)}</td>
              <td>{eventLabel(e.event_type)}</td>
              <td>
                {e.actor_name || '—'}
                {isAdmin && e.actor_role && <div className="cl-muted">{ROLE_LABELS[e.actor_role] || e.actor_role}</div>}
              </td>
              <td>{e.from_status !== e.to_status && e.to_status ? `${statusLabel(e.from_status)} → ${statusLabel(e.to_status)}` : '—'}</td>
              {isAdmin && (
                <td>
                  {describeEventDetails(e).length === 0 ? '—' : describeEventDetails(e).map(([k, v]) => (
                    <div key={k} className="cl-event-detail"><strong>{k}:</strong> {v}</div>
                  ))}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </TableWrap>
    )
  }
  return (
    <Card padded={false} className="cl-section" aria-busy={loading}>
      <CardHeader title="Custody History" subtitle="Every custody action, in the order it happened." />
      <div className="cl-section-body">{body}</div>
    </Card>
  )
}

/**
 * Confiscated Licenses — record detail with custody history and the actions
 * the current role and record state allow.
 */
export default function CustodyDetail({ role, recordKey, onBack }) {
  const toast = useToast()
  const { isMobile } = useBreakpoint()
  const isAdmin = role === 'admin'

  const [reloadToken, setReloadToken] = useState(0)
  const [modal, setModal] = useState(null) // 'ready' | 'release' | 'verify' | 'correct'
  const [result, setResult] = useState({ key: null, detail: null, events: null, eventsError: null, error: null })

  const reqKey = `${recordKey}:${reloadToken}`

  useEffect(() => {
    const ctrl = new AbortController()
    let live = true
    Promise.allSettled([
      fetchCustodyDetail(recordKey, ctrl.signal),
      fetchCustodyTimeline(recordKey, ctrl.signal),
    ]).then(([d, t]) => {
      if (!live) return
      if (d.status !== 'fulfilled') {
        setResult({ key: reqKey, detail: null, events: null, eventsError: null, error: parseCustodyError(d.reason) })
        return
      }
      setResult({
        key: reqKey,
        detail: d.value.data,
        events: t.status === 'fulfilled' ? (t.value.data?.results || []) : null,
        eventsError: t.status === 'fulfilled' ? null : parseCustodyError(t.reason),
        error: null,
      })
    })
    return () => { live = false; ctrl.abort() }
  }, [recordKey, reqKey])

  const loading = result.key !== reqKey
  const { detail, events } = result

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])
  const closeModal = useCallback(() => setModal(null), [])

  const onModalSuccess = useCallback((body) => {
    const kind = modal
    setModal(null)
    if (body?.replayed) {
      toast.success('This action was already recorded. Showing the current record.')
    } else if (kind === 'verify') {
      toast.success(body?.doc_type_status === DOC.EXCLUDED ? 'Legacy record excluded from custody.' : "Legacy record confirmed as a driver's license.")
    } else {
      toast.success(SUCCESS_COPY[kind])
    }
    reload()
  }, [modal, toast, reload])

  const onModalStale = useCallback((err) => {
    setModal(null)
    toast.warning(err.message)
    if (err.code === 'not_found') onBack()
    else reload()
  }, [toast, reload, onBack])

  const actions = useMemo(() => getActionAvailability(detail, role), [detail, role])

  const back = (
    <div className="cl-back">
      <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>Back to Confiscated Licenses</Button>
    </div>
  )

  if (result.error && !loading) {
    const gone = result.error.code === 'not_found'
    return (
      <div className="cl-detail">
        {back}
        {gone
          ? <EmptyState title="Record not found" message={result.error.message} />
          : <ErrorState title="Could not load this record" message={result.error.message} onRetry={reload} />}
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="cl-detail">
        {back}
        <Card className="cl-section"><LoadingRows rows={6} height={20} /></Card>
      </div>
    )
  }

  const release = detail.release
  const violations = Array.isArray(detail.violations) ? detail.violations.filter(Boolean) : []

  return (
    <div className="cl-detail" aria-busy={loading}>
      {back}

      <div className="cl-detail-grid">
        <Card className="cl-section">
          <div className="cl-identity">
            <div className="cl-identity-main">
              <h2 className="cl-identity-name">{detail.owner_name}</h2>
              <span className="cl-identity-ovr">{detail.ticket_number ? `OVR ${detail.ticket_number}` : 'No OVR number'}</span>
            </div>
            <div className="cl-identity-badges">
              <CustodyStatusBadge status={detail.status} />
              <DocTypeBadge docTypeStatus={detail.doc_type_status} />
              {detail.record_kind === 'archived' && <Badge tone="neutral" dot={false}>Archived record</Badge>}
            </div>
          </div>

          {detail.doc_type_status === DOC.PENDING && (
            <Alert tone="warning" title="Legacy record needs verification" className="cl-modal-alert">
              This record&rsquo;s document type was not recorded. Verify it before it can be marked ready or released.
            </Alert>
          )}
          {detail.doc_type_status === DOC.EXCLUDED && (
            <Alert tone="info" title="Excluded from custody" className="cl-modal-alert">
              This record was excluded as not a driver&rsquo;s license. No custody actions are available.
            </Alert>
          )}

          <DetailList rows={[
            ['License number', <span key="l" className="mono">{detail.license_number}</span>],
            ['Driver name', detail.owner_name],
            ['OVR / ticket no.', detail.ticket_number],
            ['Date confiscated', formatDateTime(detail.date_confiscated)],
            ['Violation(s)', violations.length ? violations.join(', ') : '—'],
            detail.notes && ['Notes', detail.notes],
            detail.ready_marked_at && ['Marked ready', `${formatDateTime(detail.ready_marked_at)}${detail.ready_marked_by ? ` by ${detail.ready_marked_by}` : ''}`],
          ]} />
        </Card>

        <Card padded={false} className="cl-section cl-actions-card">
          <CardHeader title={`Available Actions (${isAdmin ? 'Admin' : 'Staff'})`} />
          <div className="cl-section-body cl-actions">
            <ActionButton action={actions.markReady} icon={CheckCircle2} busy={loading} onClick={() => setModal('ready')}>Mark Ready for Release</ActionButton>
            <ActionButton action={actions.release} icon={Send} variant="primary" busy={loading} onClick={() => setModal('release')}>Release License</ActionButton>
            <ActionButton action={actions.verify} icon={ShieldCheck} busy={loading} onClick={() => setModal('verify')}>Verify Legacy Document</ActionButton>
            {actions.correct.visible && (
              <ActionButton action={actions.correct} icon={Pencil} busy={loading} onClick={() => setModal('correct')}>Correct License Number</ActionButton>
            )}
          </div>
        </Card>
      </div>

      {release && (
        <Card padded={false} className="cl-section">
          <CardHeader title="Release Details" />
          <div className="cl-section-body"><DetailList rows={[
            ['Released on', formatDateTime(release.released_at)],
            ['Released by', release.released_by],
            ['Released to', release.released_to_name],
            ['Claimant ID type', claimantIdTypeLabel(release.claimant_id_type)],
            ['Claimant ID', release.claimant_id && <span key="c" className="mono">{release.claimant_id}</span>],
            ['Authorization reference', release.authorization_reference],
            release.remarks && ['Remarks', release.remarks],
          ]} /></div>
        </Card>
      )}

      <HistorySection
        events={events} error={result.eventsError} loading={loading}
        isAdmin={isAdmin} isMobile={isMobile} onRetry={reload}
      />

      {modal === 'ready' && <MarkReadyModal record={detail} onClose={closeModal} onSuccess={onModalSuccess} onStale={onModalStale} />}
      {modal === 'release' && <ReleaseModal record={detail} onClose={closeModal} onSuccess={onModalSuccess} onStale={onModalStale} />}
      {modal === 'verify' && <VerifyDocumentModal record={detail} canExclude={actions.canExclude} onClose={closeModal} onSuccess={onModalSuccess} onStale={onModalStale} />}
      {modal === 'correct' && actions.correct.enabled && <CorrectLicenseModal record={detail} onClose={closeModal} onSuccess={onModalSuccess} onStale={onModalStale} />}
    </div>
  )
}