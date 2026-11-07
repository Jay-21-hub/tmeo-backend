import { useState, useEffect, useRef, useCallback } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import {
  Ticket, CalendarCheck, Printer, Search, X,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, RefreshCw, History,
  User, FileText, CreditCard,
} from 'lucide-react'
import api from '../../../services/api'
import { useToast } from '../../../context/useToast'
import Badge, { StatusBadge } from '../../../components/ui/Badge'
import { EmptyState } from '../../../components/ui/States'
import ViolatorHistoryPanel from '../../../components/common/ViolatorHistoryPanel'
import AssessmentDirectPrint from './assessment/AssessmentDirectPrint'
import PrintConfirmModal from '../../../components/print/PrintConfirmModal'
import usePrintConfirmation from '../../../components/print/usePrintConfirmation'
import { buildReceiptTicket } from './assessment/receiptTicket'
import { API } from '../../../constants'
import './DigitalTickets.css'

const formatCurrency = (val) => {
  const n = parseFloat(val)
  if (isNaN(n)) return '—'
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const formatDate = (val) => {
  if (!val) return '—'
  const d = new Date(val)
  if (isNaN(d)) return val
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
const formatDateTime = (val) => {
  if (!val) return '—'
  const d = new Date(val)
  if (isNaN(d)) return val
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
const getViolationNames = (ticket) => {
  if (ticket.items?.length) return ticket.items.map(i => i.violation_type?.name).filter(Boolean).join(', ') || '—'
  return ticket.violation_type || '—'
}
const getEnforcerName = (ticket) => {
  // Event-time name from the API (snapshot-first); the nested live account is
  // only a legacy fallback for payloads that don't carry enforcer_historical.
  if (ticket.enforcer_historical !== undefined) return ticket.enforcer_name || '—'
  if (!ticket.enforcer) return '—'
  if (typeof ticket.enforcer === 'object') return ticket.enforcer.full_name || ticket.enforcer.name || '—'
  return ticket.enforcer
}

/* ── Pagination (windowed, matches ViolationRecords pattern) ── */
function Pagination({ currentPage, totalPages, totalItems, pageSize, onPageChange }) {
  const start = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const end = Math.min(currentPage * pageSize, totalItems)
  const pageButtons = Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
    let p = i + 1
    if (totalPages > 5) {
      if (currentPage <= 3) p = i + 1
      else if (currentPage >= totalPages - 2) p = totalPages - 4 + i
      else p = currentPage - 2 + i
    }
    return p
  })
  return (
    <div className="dt-pager">
      <span>Showing <strong>{start}–{end}</strong> of <strong>{totalItems}</strong> tickets</span>
      <div className="pagination">
        <button className="page-btn" aria-label="First page" onClick={() => onPageChange(1)} disabled={currentPage === 1}><ChevronsLeft size={14} /></button>
        <button className="page-btn" aria-label="Previous page" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1}><ChevronLeft size={14} /></button>
        {pageButtons.map(p => <button key={p} className={`page-btn ${p === currentPage ? 'is-active' : ''}`} onClick={() => onPageChange(p)}>{p}</button>)}
        <button className="page-btn" aria-label="Next page" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === totalPages || totalPages === 0}><ChevronRight size={14} /></button>
        <button className="page-btn" aria-label="Last page" onClick={() => onPageChange(totalPages)} disabled={currentPage === totalPages || totalPages === 0}><ChevronsRight size={14} /></button>
      </div>
    </div>
  )
}

/* ── Ticket detail modal (custom, not shared Modal — keeps the #printable-ticket id) ──
   Compact record viewer: header / scrollable body / sticky footer. Presentation only —
   same ticket object, same fields, same onPrint handler.
   Motion is pure CSS (see .dtm-* keyframes). The only JS is a `closing` flag: every
   close path (X, Close, Escape, backdrop) funnels through requestClose, which plays the
   exit animation and then calls the parent's onClose exactly once. */
function Field({ label, children, full = false }) {
  return (
    <div className={`dtm-field${full ? ' dtm-field--full' : ''}`}>
      <p className="dtm-label">{label}</p>
      <div className="dtm-value">{children || '—'}</div>
    </div>
  )
}

function SectionHeading({ icon, tone, children }) {
  const Icon = icon
  return (
    <h3 className={`dtm-heading dtm-heading--${tone}`}>
      <span className="dtm-heading-icon" aria-hidden="true"><Icon size={14} strokeWidth={2} /></span>
      {children}
    </h3>
  )
}

const DTM_EXIT_FALLBACK_MS = 400 // safety net only; the real signal is onAnimationEnd

function TicketDetailModal({ ticket, printing, onClose, onPrint }) {
  const panelRef = useRef(null)
  const closeRef = useRef(null)
  const [closing, setClosing] = useState(false)
  const closedRef = useRef(false)

  const finishClose = useCallback(() => {
    if (closedRef.current) return
    closedRef.current = true
    onClose()
  }, [onClose])

  const requestClose = useCallback(() => {
    setClosing(true)
  }, [])

  // Single place that finishes the exit: animationend normally, one fallback timer otherwise.
  useEffect(() => {
    if (!closing) return undefined
    const t = setTimeout(finishClose, DTM_EXIT_FALLBACK_MS)
    return () => clearTimeout(t)
  }, [closing, finishClose])

  // Escape closes; Tab stays inside the dialog; background scroll is locked;
  // focus moves into the dialog and returns to the opener (the View button) on close.
  useEffect(() => {
    const opener = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') { requestClose(); return }
      if (e.key === 'Tab' && panelRef.current) {
        const f = panelRef.current.querySelectorAll('button:not(:disabled)')
        if (!f.length) return
        const first = f[0], last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      if (opener && typeof opener.focus === 'function') opener.focus()
    }
  }, [requestClose])

  return (
    <div
      className={`dtm-overlay${closing ? ' is-closing' : ''}`}
      onMouseDown={e => { if (e.target === e.currentTarget) requestClose() }}
    >
      <div
        ref={panelRef}
        id="printable-ticket"
        className="dtm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dtm-title"
        onAnimationEnd={e => { if (closing && e.target === e.currentTarget) finishClose() }}
      >
        <div className="dtm-header">
          <div>
            <span className="dtm-badge">TICKET #{ticket.id}</span>
            <h2 id="dtm-title" className="dtm-title">Digital Ticket Details</h2>
            <p className="dtm-meta">Date issued: {formatDateTime(ticket.date_issued || ticket.created_at)}</p>
          </div>
          <button ref={closeRef} className="dtm-x" onClick={requestClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="dtm-body">
          <section className="dtm-section">
            <SectionHeading icon={User} tone="blue">Violator Information</SectionHeading>
            <div className="dtm-grid">
              <Field label="Full Name">{ticket.violator_name}</Field>
              <Field label="Address">{ticket.address}</Field>
              <Field label="License Number">{ticket.license_number}</Field>
              <Field label="License Status">{ticket.license_status}</Field>
              <Field label="Plate Number">{ticket.plate_number}</Field>
              <Field label="Registration No.">{ticket.registration_number}</Field>
              <Field label="OVR Number">{ticket.ovr_number}</Field>
            </div>
          </section>

          <section className="dtm-section">
            <SectionHeading icon={FileText} tone="green">Violation Details</SectionHeading>
            <div className="dtm-grid">
              <Field label="Violations" full>{getViolationNames(ticket)}</Field>
              <Field label="Vehicle Type">{ticket.vehicle_type}</Field>
              <Field label="Enforcer">{getEnforcerName(ticket)}</Field>
              <Field label="Date Issued">{formatDate(ticket.date_issued)}</Field>
              {/* Date Paid lives on the separate Assessment record — distinct from
                  Date Issued (when the Enforcer wrote the OVR). Server-generated. */}
              <Field label="Date Paid">{formatDate(ticket.date_paid)}</Field>
              <Field label="Location" full>{ticket.location}</Field>
            </div>
          </section>

          <section className="dtm-section">
            <SectionHeading icon={CreditCard} tone="gold">Payment Details</SectionHeading>
            <div className="dtm-grid dtm-grid--keep">
              <Field label="Fine Amount"><span className="dtm-fine">{formatCurrency(ticket.penalty_amount)}</span></Field>
              <Field label="Status"><StatusBadge status={ticket.status} /></Field>
            </div>
          </section>
        </div>

        <div className="dtm-footer">
          <button className="dtm-btn" onClick={requestClose}>Close</button>
          <button className="dtm-btn dtm-btn--primary" onClick={onPrint} disabled={printing}>
            <Printer size={14} /> {printing ? 'Printing…' : 'Print Ticket'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════════════════ */
export default function DigitalTickets() {
  const toast = useToast()
  const [tickets, setTickets] = useState([])
  const [stats, setStats] = useState({ total: 0, today: 0, printed: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  // Id of the ticket whose Assessment Form is being prepared (generate-ticket
  // in flight). The ref is the synchronous guard against double-clicks; the
  // state only drives the disabled/busy UI.
  const [printingId, setPrintingId] = useState(null)
  const printingRef = useRef(false)
  const printKeyRef = useRef(0) // fresh key per job so every print remounts the hidden print layer
  const [historyTarget, setHistoryTarget] = useState(null)
  // Print job for the official Assessment Form. It is mounted hidden and opens
  // the NATIVE browser print preview directly (AssessmentDirectPrint) — there is
  // no custom on-screen preview layer — and is removed as soon as the print
  // dialog closes. null = no print in progress.
  const [printJob, setPrintJob] = useState(null)

  const [currentPage, setCurrentPage] = useState(1)
  const [total, setTotal] = useState(0)
  const pageSize = 10

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const params = { status: 'paid', page: currentPage, page_size: pageSize, ordering: '-created_at' }
      if (search.trim()) params.search = search.trim()
      const res = await api.get('/api/violations/', { params })
      const data = res.data
      const results = Array.isArray(data) ? data : data.results || []
      setTickets(results)
      setTotal(data.count ?? results.length)
    } catch {
      setError('Failed to load digital tickets. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Stats (total / today / printed) reflect the whole paid-tickets dataset,
  // not just the current page — fetched separately and lightly (page_size=1
  // for the count-only queries; today/printed still need actual rows since
  // there's no dedicated stats endpoint for this).
  const fetchStats = async () => {
    try {
      // Three count-only requests (page_size=1, reading only `count` from
      // the paginated response) instead of downloading up to 100 rows and
      // counting client-side — stays accurate no matter how many paid
      // tickets exist, not just the first 100.
      const today = new Date().toISOString().slice(0, 10)
      const [totalRes, todayRes, printedRes] = await Promise.all([
        api.get('/api/violations/', { params: { status: 'paid', page_size: 1 } }),
        api.get('/api/violations/', { params: { status: 'paid', page_size: 1, date: today } }),
        api.get('/api/violations/', { params: { status: 'paid', page_size: 1, is_printed: 1 } }),
      ])
      setStats({
        total: totalRes.data.count ?? 0,
        today: todayRes.data.count ?? 0,
        printed: printedRes.data.count ?? 0,
      })
    } catch { /* stats are supplementary, ignore failures */ }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern, matches existing codebase convention
    fetchStats()
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-filter/page-change pattern, matches existing codebase convention
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, currentPage])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset pagination on filter change, matches existing codebase convention
    setCurrentPage(1)
  }, [search])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const paginated = tickets

  // A print is recorded ONLY after the browser print dialog closes and Staff
  // answers "Yes, Mark as Printed" (see usePrintConfirmation). On success BOTH
  // the table and the Tickets Printed KPI refresh. The page underneath (and
  // Digital Ticket Details, if Staff opened it with View) is left as it was.
  const printConfirm = usePrintConfirmation({
    onRecorded: async () => { await Promise.all([fetchData(), fetchStats()]) },
  })

  // Called when the native print dialog has closed (or the job could not start):
  // drops the hidden print layer and releases the double-click guard.
  const finishPrintJob = useCallback(() => {
    setPrintJob(null)
    printingRef.current = false
    setPrintingId(null)
  }, [])

  // Opens the Assessment Form preview from the persisted record. The table
  // row (ViolationListSerializer) lacks address, license status and the
  // Assessment fields, so the full payload comes from generate-ticket — a
  // read-only endpoint that creates or changes nothing. Payment values are
  // the stored ones (no paid -> penalty fallback).
  //
  // FAIL-CLOSED: if the full payload cannot be loaded we stop. The summary row
  // is never used as a fallback, because it would print an incomplete official
  // document.
  const handlePrint = async (ticket) => {
    if (printingRef.current) return
    printingRef.current = true
    setPrintingId(ticket.id)
    let started = false
    try {
      const res = await api.post(`/api/violations/${ticket.id}/generate-ticket/`)
      const full = res.data || {}
      if (full.status !== 'paid') {
        toast.warning('This record is no longer marked as paid, so the Assessment Form cannot be printed.')
        return
      }
      const built = buildReceiptTicket(full)
      printKeyRef.current += 1
      setPrintJob({ key: printKeyRef.current, ticket: { ...built, id: built.id ?? ticket.id } })
      started = true // the guard stays on until the print dialog closes
    } catch {
      toast.danger('Unable to prepare the Assessment Form. Please try again.')
    } finally {
      if (!started) {
        printingRef.current = false
        setPrintingId(null)
      }
    }
  }

  const COLS = ['Ticket ID', 'Violator', 'Vehicle', 'Fine Amount', 'Status', 'Dates', 'Actions']
  const closeSelected = useCallback(() => setSelected(null), [])
  const openHistory = (t) => setHistoryTarget({ name: t.violator_name, license: t.license_number })
  const canShowHistory = (t) => !!(t.violator_name && t.license_number)
  const isRepeat = (t) => t.repeat_status === 'REPEAT VIOLATOR'

  // Same actions + same availability rules as before (View always, Print always,
  // History only when both name and license exist) — presentation only.
  const renderActions = (t) => (
    <div className="dt-actions">
      <button className="dt-btn" onClick={() => setSelected(t)} aria-label={`View ticket ${t.id}`}>View</button>
      <button className="dt-btn" onClick={() => handlePrint(t)} disabled={printingId !== null} aria-busy={printingId === t.id} aria-label={`${t.is_printed ? 'Reprint' : 'Print'} ticket ${t.id}`} title={t.is_printed ? 'Printed — click to reprint' : 'Print'}>
        <Printer size={13} /><span className="dt-btn-label">{t.is_printed ? '✓ Printed' : 'Print'}</span>
      </button>
      {canShowHistory(t) && (
        <button className="dt-btn dt-btn--icon" title="Violation History" aria-label="Violation History" onClick={() => openHistory(t)}>
          <History size={13} />
        </button>
      )}
    </div>
  )

  // Server-computed, active-database-only status — never counts archived years.
  const renderRepeat = (t) => isRepeat(t) && (
    <button type="button" className="dt-repeat" title="This violator has more than one active-year record"
      onClick={e => { e.stopPropagation(); openHistory(t) }}>
      <Badge tone="warning" dot={false}>REPEAT VIOLATOR</Badge>
    </button>
  )

  const renderDates = (t) => (
    <>
      <p className="dt-date dt-date--issued"><span>Issued:</span>{formatDate(t.date_issued || t.created_at)}</p>
      <p className="dt-date dt-date--paid"><span>Paid:</span>{formatDate(t.date_paid)}</p>
    </>
  )

  const vehicleSecondary = (t) => t.vehicle_type || '—'

  const statCards = [
    { label: 'Total Tickets', value: stats.total, sub: 'All paid violations', icon: Ticket, color: 'var(--blue-600)' },
    { label: 'Generated Today', value: stats.today, sub: 'Issued today', icon: CalendarCheck, color: 'var(--success-600)' },
    { label: 'Tickets Printed', value: stats.printed, sub: 'Staff-confirmed prints', icon: Printer, color: '#7c3aed' },
  ]

  return (
    <div className="dt">
      <PageHeader
        title="Digital Tickets"
        action={(
          <button className="btn btn-secondary btn-sm" onClick={fetchData} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
          </button>
        )}
      />

      {error && (
        <div style={{ marginBottom: 14 }}>
          <div className="alert alert-danger">
            <span>⚠ {error}</span>
            <button onClick={fetchData} style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--blue-600)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}>Retry</button>
          </div>
        </div>
      )}

      <div className="dt-stats">
        {statCards.map(c => (
          <div key={c.label} className="dt-stat">
            <span className="dt-stat-icon" aria-hidden="true" style={{ background: `color-mix(in srgb, ${c.color} 12%, white)`, color: c.color }}>
              <c.icon size={18} strokeWidth={2.2} />
            </span>
            <div className="dt-stat-body">
              <p className="dt-stat-label">{c.label}</p>
              {loading ? <div className="skeleton" style={{ height: 24, width: 48, marginTop: 4 }} /> : <p className="dt-stat-value">{c.value ?? 0}</p>}
              <p className="dt-stat-sub">{c.sub}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="dt-search">
        <Search size={15} className="search-input-icon" />
        <input className="input" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by violator name, plate number, license number, or violation..."
          aria-label="Search digital tickets" />
        {search && (
          <button type="button" className="dt-search-clear" onClick={() => setSearch('')} aria-label="Clear search"><X size={14} /></button>
        )}
      </div>

      <div className="dt-card">
        <div className="dt-meta">
          <span>
            <strong>{total}</strong> ticket{total !== 1 ? 's' : ''}
            {search && <span> for "{search}"</span>}
          </span>
          {search && <button onClick={() => setSearch('')} className="dt-link">Clear ✕</button>}
        </div>

        <div className="dt-tablewrap">
          <table className="dt-table">
            <colgroup>
              <col className="dt-col-id" /><col className="dt-col-violator" /><col className="dt-col-vehicle" />
              <col className="dt-col-fine" /><col className="dt-col-status" /><col className="dt-col-dates" /><col className="dt-col-actions" />
            </colgroup>
            <thead><tr>{COLS.map(c => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>{COLS.map((c, j) => <td key={j}><div className="skeleton" style={{ height: 13, width: '70%' }} /></td>)}</tr>
                ))
              ) : paginated.length === 0 ? (
                <tr><td colSpan={COLS.length} style={{ padding: 0 }}>
                  <EmptyState icon={Ticket} title="No tickets found" message={search ? 'Try a different search term' : 'No paid violations yet'} />
                </td></tr>
              ) : paginated.map(t => (
                <tr key={t.id}>
                  <td><span className="dt-id">#{t.id}</span></td>
                  <td>
                    <p className="dt-name">{t.violator_name || '—'}</p>
                    {renderRepeat(t)}
                  </td>
                  <td>
                    <p className="dt-plate">{t.plate_number || '—'}</p>
                    <p className="dt-sub">{vehicleSecondary(t)}</p>
                  </td>
                  <td><span className="dt-fine">{formatCurrency(t.penalty_amount)}</span></td>
                  <td className="dt-status"><StatusBadge status={t.status} /></td>
                  <td>{renderDates(t)}</td>
                  <td>{renderActions(t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile (≤639px): compact ticket cards replace the table */}
        <div className="dt-cards">
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="dt-tcard"><div className="skeleton" style={{ height: 13, width: '60%', marginBottom: 8 }} /><div className="skeleton" style={{ height: 13, width: '40%' }} /></div>
            ))
          ) : paginated.length === 0 ? (
            <EmptyState icon={Ticket} title="No tickets found" message={search ? 'Try a different search term' : 'No paid violations yet'} />
          ) : paginated.map(t => (
            <div key={t.id} className="dt-tcard">
              <div className="dt-tcard-top">
                <span className="dt-id">#{t.id}</span>
                <span className="dt-status"><StatusBadge status={t.status} /></span>
              </div>
              <p className="dt-name">{t.violator_name || '—'}</p>
              {renderRepeat(t)}
              <p className="dt-tcard-line"><strong className="dt-plate" style={{ display: 'inline' }}>{t.plate_number || '—'}</strong> · {vehicleSecondary(t)}</p>
              <p className="dt-tcard-line dt-fine dt-tcard-fine">{formatCurrency(t.penalty_amount)}</p>
              <div className="dt-tcard-dates">{renderDates(t)}</div>
              {renderActions(t)}
            </div>
          ))}
        </div>

        {!loading && total > 0 && (
          <Pagination currentPage={currentPage} totalPages={totalPages} totalItems={total} pageSize={pageSize} onPageChange={setCurrentPage} />
        )}
      </div>

      {selected && (
        <TicketDetailModal ticket={selected} printing={printingId !== null} onClose={closeSelected} onPrint={() => handlePrint(selected)} />
      )}

      <ViolatorHistoryPanel
        open={!!historyTarget}
        onClose={() => setHistoryTarget(null)}
        violatorName={historyTarget?.name}
        licenseNumber={historyTarget?.license}
        onPrintRecorded={() => { fetchData(); fetchStats() }}
      />

      {printJob && (
        <AssessmentDirectPrint
          key={printJob.key}
          ticket={printJob.ticket}
          formatCurrency={formatCurrency}
          onPrinted={() => printConfirm.arm(printJob.ticket.id)}
          onDone={finishPrintJob}
        />
      )}

      <PrintConfirmModal {...printConfirm.modalProps} />
    </div>
  )
}