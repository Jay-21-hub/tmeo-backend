import { useState, useEffect, useCallback, useRef } from 'react'
import { Printer, User, Archive, AlertCircle, ChevronRight } from 'lucide-react'
import api from '../../services/api'
import { API } from '../../constants'
import { useToast } from '../../context/useToast'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Badge, { StatusBadge } from '../ui/Badge'
import { EmptyState } from '../ui/States'
import AssessmentDirectPrint from '../../pages/staff/sections/assessment/AssessmentDirectPrint'
import PrintConfirmModal from '../print/PrintConfirmModal'
import usePrintConfirmation from '../print/usePrintConfirmation'
import { buildReceiptTicket } from '../../pages/staff/sections/assessment/receiptTicket'

const fmtDate = (val) => {
  if (!val) return '—'
  const d = new Date(val)
  if (isNaN(d)) return val
  return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}
const fmtPeso = (n) => (n != null ? `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 })}` : '—')
const getViolationNames = (record) =>
  record.violation_types?.length
    ? record.violation_types.map(t => t.name).filter(Boolean).join(', ')
    : '—'

// Same formatting the Assessment Form / Digital Tickets pass to the official template.
const receiptCurrency = (val) => {
  const n = parseFloat(val)
  if (isNaN(n)) return '—'
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Official Assessment Form reprint is only valid for ACTIVE + PAID records:
 * mark-printed rejects every non-paid record, and archived history rows do not
 * carry the full official-form data (address, amount paid, assessor). Decided
 * from the record itself, so the user never has to click to find out.
 */
function getPrintEligibility(record) {
  if (record.source !== 'active') return { allowed: false, reason: 'Official reprint unavailable for archived record' }
  if (record.status !== 'paid') return { allowed: false, reason: 'Available after payment' }
  return { allowed: true, reason: '' }
}

/**
 * One record rendered as its own standalone card — never merged into a
 * shared table row/box, so each violation keeps its own status, penalty,
 * and Print action regardless of how many other records this violator has.
 */
function ViolationHistoryCard({ record, onPrint, printingId, allowPrint }) {
  const recordKey = `${record.source}-${record.id}`
  const eligibility = getPrintEligibility(record)
  // UI only — this card is never the printed document (see handlePrint).
  return (
    <div className="card card-padded" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--blue-600)', background: 'var(--blue-50)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}>
            #{record.id}
          </span>
          {record.is_archived ? (
            <Badge tone="neutral"><Archive size={10} style={{ marginRight: 3 }} /> Archived {record.violation_year ? `(${record.violation_year})` : ''}</Badge>
          ) : (
            <Badge tone="info">Active</Badge>
          )}
          <StatusBadge status={record.status} />
        </div>
        {allowPrint && (
          <span title={eligibility.allowed ? undefined : eligibility.reason}>
            <Button
              variant="secondary"
              size="sm"
              icon={Printer}
              loading={printingId === recordKey}
              disabled={!eligibility.allowed || (printingId !== null && printingId !== recordKey)}
              aria-label={eligibility.allowed ? `Print Assessment Form for #${record.id}` : `Print unavailable: ${eligibility.reason}`}
              onClick={() => onPrint(record, recordKey)}
            >
              Print
            </Button>
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <p className="text-label" style={{ margin: '0 0 3px' }}>Date Issued</p>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{fmtDate(record.date_issued)}</p>
        </div>
        <div>
          <p className="text-label" style={{ margin: '0 0 3px' }}>Penalty</p>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{fmtPeso(record.penalty_amount)}</p>
        </div>
        <div>
          <p className="text-label" style={{ margin: '0 0 3px' }}>Plate Number</p>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{record.plate_number || '—'}</p>
        </div>
        <div>
          <p className="text-label" style={{ margin: '0 0 3px' }}>Vehicle Type</p>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{record.vehicle_type || '—'}</p>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <p className="text-label" style={{ margin: '0 0 3px' }}>Violation(s)</p>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{getViolationNames(record)}</p>
        </div>
        <div>
          <p className="text-label" style={{ margin: '0 0 3px' }}>Location</p>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{record.location || '—'}</p>
        </div>
        <div>
          <p className="text-label" style={{ margin: '0 0 3px' }}>Enforcer</p>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--slate-950)' }}>{record.enforcer_name || '—'}</p>
        </div>
      </div>
    </div>
  )
}

/**
 * Modal listing every violation on record for one violator, matched by
 * violator_name + license_number across both the active table and anything
 * already archived. Each violation renders as its own card with its own
 * Print button — this view never merges records into a single row/box, it
 * only groups them for browsing.
 *
 * allowPrint: Staff can print/reprint tickets; Admin's Violation Records and
 * Archive Management screens are view-only (MASTER PROMPT Part 16 — Admin
 * must NOT have ticket printing), so they pass allowPrint={false}.
 */
export default function ViolatorHistoryPanel({ open, onClose, violatorName, licenseNumber, allowPrint = true, onPrintRecorded }) {
  const toast = useToast()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState(null)
  const [printingId, setPrintingId] = useState(null)
  // Official Assessment Form print job. Mounted hidden; it opens the NATIVE
  // browser print preview directly (no custom preview layer on screen) and is
  // removed when the print dialog closes. null = no print in progress.
  const [printJob, setPrintJob] = useState(null)

  const onCloseRef = useRef(onClose)
  const printingRef = useRef(false)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  // Stable close handler for the history Modal.
  const handleModalClose = useCallback(() => {
    onCloseRef.current?.()
  }, [])

  const load = useCallback(async () => {
    if (!violatorName || !licenseNumber) return
    setLoading(true)
    setError('')
    try {
      const res = await api.get(API.VIOLATOR_HISTORY_FULL, {
        params: { violator_name: violatorName, license_number: licenseNumber },
      })
      setData(res.data)
    } catch {
      setError('Failed to load violation history. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [violatorName, licenseNumber])

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-open pattern, matches existing codebase convention
      load()
    } else {
      setData(null)
      setError('')
      setPrintJob(null)
    }
  }, [open, load])

  // A print is recorded only after the print dialog closes and Staff answers
  // "Yes, Mark as Printed" (first print -> PRINTED, later -> REPRINTED, decided
  // by the server). No / X / Escape record nothing. History stays open
  // underneath either way.
  const printConfirm = usePrintConfirmation({
    onRecorded: () => { onPrintRecorded?.() },
  })

  // Called when the native print dialog has closed (or the job could not
  // start): drops the hidden print layer and releases the double-click guard.
  const finishPrintJob = useCallback(() => {
    setPrintJob(null)
    printingRef.current = false
    setPrintingId(null)
  }, [])

  // Print = open the SAME official Assessment Form template used by the
  // Assessment Form and the Digital Tickets table. The template owns
  // waitForPrintImages -> fitSheet -> onPrinted (the single mark-printed
  // PATCH) -> the single window.print(). Nothing here prints this modal's DOM
  // or touches mark-printed.
  const handlePrint = async (record, recordKey) => {
    if (printingRef.current || !getPrintEligibility(record).allowed) return
    printingRef.current = true
    setPrintingId(recordKey)
    let started = false
    try {
      // Read-only: returns the full persisted payload (address, payment fields,
      // assessor...) that the history summary row does not carry.
      const res = await api.post(`/api/violations/${record.id}/generate-ticket/`)
      const full = res.data || {}
      if (full.status !== 'paid') {
        toast.warning?.('This record is no longer marked as paid, so the Assessment Form cannot be printed.')
        return
      }
      setPrintJob({ key: Date.now(), ticket: buildReceiptTicket(full) })
      started = true // the guard stays on until the print dialog closes
    } catch {
      // No summary-data fallback here: the history row lacks official-form fields,
      // so printing it would produce an incomplete official document.
      toast.danger?.('Could not load the full ticket details. The Assessment Form was not printed.')
    } finally {
      if (!started) {
        printingRef.current = false
        setPrintingId(null)
      }
    }
  }

  return (
    <>
    <Modal open={open} onClose={handleModalClose} width={620} title={violatorName ? `Violation History — ${violatorName}` : 'Violation History'}>
      {loading && (
        <div style={{ padding: '20px 0' }}>
          {[1, 2].map(i => <div key={i} className="skeleton" style={{ height: 120, marginBottom: 12, borderRadius: 'var(--radius-md)' }} />)}
        </div>
      )}

      {!loading && error && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '16px 0', color: 'var(--danger-600)' }}>
          <AlertCircle size={16} />
          <span className="text-caption" style={{ color: 'var(--danger-600)' }}>{error}</span>
        </div>
      )}

      {!loading && !error && data && (
        <>
          <div style={{ background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', padding: 14, marginBottom: 16, border: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--blue-100)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <User size={18} color="var(--blue-700)" />
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ margin: 0, fontWeight: 700, fontSize: 14, color: 'var(--slate-950)' }}>{data.violator_name}</p>
              <p className="mono text-caption" style={{ margin: 0 }}>{data.license_number}</p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <p style={{ margin: 0, fontWeight: 700, fontSize: 18, color: 'var(--slate-950)' }}>{data.violation_count}</p>
              <p className="text-caption" style={{ margin: 0 }}>total record{data.violation_count !== 1 ? 's' : ''}</p>
            </div>
          </div>

          {data.violation_count === 0 ? (
            <EmptyState icon={User} title="No records found" message="No violations on file for this violator." />
          ) : (
            <>
              <div className="text-caption" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                {data.active_count} active <ChevronRight size={12} /> {data.archived_count} archived
              </div>
              {data.records.map(record => (
                <ViolationHistoryCard
                  key={`${record.source}-${record.id}`}
                  record={record}
                  onPrint={handlePrint}
                  printingId={printingId}
                  allowPrint={allowPrint}
                />
              ))}
            </>
          )}
        </>
      )}

    </Modal>

    {/* Official Assessment Form print — the unchanged shared template, mounted
        hidden by AssessmentDirectPrint so the native browser print preview opens
        directly. No custom preview is ever shown behind the confirmation. */}
    {printJob && (
      <AssessmentDirectPrint
        key={printJob.key}
        ticket={printJob.ticket}
        formatCurrency={receiptCurrency}
        onPrinted={() => printConfirm.arm(printJob.ticket.id)}
        onDone={finishPrintJob}
      />
    )}

    <PrintConfirmModal {...printConfirm.modalProps} />
    </>
  )
}