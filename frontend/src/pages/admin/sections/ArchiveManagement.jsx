import { useState, useEffect, useCallback, useRef } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import {
  Archive, AlertTriangle, Search, X, ChevronLeft, ChevronRight,
  Clock, History, FolderOpen, Eye, Trash2, ChevronRight as ChevronRightIcon,
  Database, Download, CheckCircle2, FileText,
} from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { useToast } from '../../../context/useToast'
import Button from '../../../components/ui/Button'
import StatCard from '../../../components/ui/StatCard'
import { Card, CardHeader } from '../../../components/ui/Card'
import Badge from '../../../components/ui/Badge'
import Alert from '../../../components/ui/Alert'
import Modal from '../../../components/ui/Modal'
import ConfirmDialog from '../../../components/ui/ConfirmDialog'
import { EmptyState } from '../../../components/ui/States'
import {
  buildArchiveExportPdf, archiveExportFileName, downloadPdf, LARGE_EXPORT_RECORDS,
} from '../../../utils/archiveExportPdf'

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function DetailRow({ label, value }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--slate-100)', gap: 12 }}>
      <span style={{ fontSize: 12, color: 'var(--slate-400)', fontWeight: 500, minWidth: 120, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--slate-950)', fontWeight: 500, textAlign: 'right', wordBreak: 'break-word' }}>{value}</span>
    </div>
  )
}

const fmtDate = (str) => (str ? new Date(str).toLocaleDateString('en-PH', { month: 'long', day: '2-digit', year: 'numeric' }) : '—')
const vehicleLabel = (r) => {
  const d = r?.data || {}
  const desc = [d.vehicle_brand, d.vehicle_model].filter(Boolean).join(' ') || d.vehicle_type || ''
  const plate = r?.plate_number || ''
  if (desc && plate) return `${desc} (${plate})`
  return desc || plate || '—'
}
const violationTypeLabel = (r) => (r?.data?.items || []).map(i => i.name).filter(Boolean).join(', ') || '—'
const fmtDateTime = (str) => (str ? new Date(str).toLocaleString('en-PH', { month: 'long', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : '—')

/**
 * Archive Management (MASTER PROMPT PART 12-25).
 *
 * "Archive Current Active Data" moves active violations whose staff
 * processing is finished into persistent archive storage (never Excel —
 * see backend archive_utils.py) after a transactional record-count
 * reconciliation. Records still pending, in progress, or locked for an
 * active Resume session are never archived or deleted — they stay active
 * until a staff member finishes them (PART 8/17/18).
 *
 * The browse experience below follows the required hierarchy:
 * Archive Management → Archive Year → Month → Archived Violation Records
 * → View / optional Delete. Years and months are always derived from what
 * actually exists in the archive (grouped by the ORIGINAL violation date,
 * never the archive timestamp) — nothing here is a hardcoded year or
 * month list, and empty months are never shown. Archive is a read-only
 * historical repository: no repeat-offender recalculation, no editing,
 * no printing, no history cross-linking here.
 *
 * "Export" tab — folded in from the former standalone Database Management
 * page (which was a near-duplicate sidebar destination for a closely
 * related job — exporting data). Two exports live here: the Full Database
 * Export (every active record, unchanged from the old page) and the
 * Archived Records Export (every archived record, or one archive year,
 * reading only from ArchivedViolation snapshots — never the active
 * table). Both are read-only copies; neither deletes or modifies data.
 */
export default function ArchiveManagement() {
  const toast = useToast()
  const [tab, setTab] = useState('archive') // 'archive' | 'export'

  // Archive-operation state
  const [overview, setOverview] = useState(null)
  const [loadingOverview, setLoadingOverview] = useState(true)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [lastResult, setLastResult] = useState(null)
  const [refreshingOverview, setRefreshingOverview] = useState(false)
  const [exportConfirm, setExportConfirm] = useState(null) // null | 'full' | 'archived'

  // Year / month drilldown state
  const [years, setYears] = useState([])
  const [loadingYears, setLoadingYears] = useState(true)
  const [activeYear, setActiveYear] = useState(null)
  const [months, setMonths] = useState([])
  const [loadingMonths, setLoadingMonths] = useState(false)
  const [view, setView] = useState('months') // 'months' | 'records'
  const [selectedMonth, setSelectedMonth] = useState(null)

  // Monthly record browsing state
  const [settlement, setSettlement] = useState('all')
  const [search, setSearch] = useState('')
  const [records, setRecords] = useState([])
  const [recordCount, setRecordCount] = useState(0)
  const [page, setPage] = useState(1)
  const [loadingRecords, setLoadingRecords] = useState(false)
  const pageSize = 20

  // View / delete modal state
  const [detailRecord, setDetailRecord] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)

  // ── Export tab state (Full Database Export — folded from the former
  // standalone Database Management page) ──
  const [fields, setFields] = useState(null)
  const [loadingFields, setLoadingFields] = useState(true)
  const [exportState, setExportState] = useState('idle') // idle | exporting | success | error
  const [exportErrorMsg, setExportErrorMsg] = useState('')

  // ── Export tab state (Archived Records Export — new) ──
  const [archiveExportYear, setArchiveExportYear] = useState('') // '' = all years
  const [archivedFields, setArchivedFields] = useState(null)
  const [loadingArchivedFields, setLoadingArchivedFields] = useState(true)
  const [archivedExportState, setArchivedExportState] = useState('idle')
  const [archivedExportErrorMsg, setArchivedExportErrorMsg] = useState('')
  // Synchronous guard: state updates are async, so two quick clicks (or a
  // click while the other export runs) could both start. The ref blocks that
  // instantly; the *ExportState values only drive the UI.
  const exportBusyRef = useRef(false)

  const loadOverview = useCallback(async () => {
    setLoadingOverview(true)
    try {
      const res = await api.get(API.ARCHIVE_OVERVIEW)
      setOverview(res.data)
    } catch {
      setOverview(null)
    } finally {
      setLoadingOverview(false)
    }
  }, [])

  // Re-reads the archive counts when the Archive confirmation opens so the
  // dialog never shows numbers older than the moment the Admin clicked. Quiet:
  // it does not toggle the page's skeleton state. On failure the page-load
  // counts are kept; the server re-evaluates eligibility on confirm anyway.
  const refreshOverviewQuietly = useCallback(async () => {
    setRefreshingOverview(true)
    try {
      const res = await api.get(API.ARCHIVE_OVERVIEW)
      setOverview(res.data)
    } catch {
      /* keep the existing counts */
    } finally {
      setRefreshingOverview(false)
    }
  }, [])

  const openArchiveConfirm = () => {
    setArchiveError('')
    setConfirmOpen(true)
    refreshOverviewQuietly()
  }

  const loadYears = useCallback(async () => {
    setLoadingYears(true)
    try {
      const res = await api.get(API.ARCHIVE_YEARS)
      const y = res.data.years || []
      setYears(y)
      setActiveYear(prev => (prev && y.includes(prev) ? prev : (y[0] ?? null)))
    } catch {
      setYears([])
      setActiveYear(null)
    } finally {
      setLoadingYears(false)
    }
  }, [])

  const loadMonths = useCallback(async (year) => {
    if (!year) { setMonths([]); return }
    setLoadingMonths(true)
    try {
      const res = await api.get(`${API.ARCHIVE_MONTHS}?year=${year}`)
      setMonths(res.data.months || [])
    } catch {
      setMonths([])
    } finally {
      setLoadingMonths(false)
    }
  }, [])

  const loadRecords = useCallback(async () => {
    if (!activeYear || !selectedMonth) return
    setLoadingRecords(true)
    try {
      const params = new URLSearchParams()
      params.append('year', activeYear)
      params.append('month', selectedMonth)
      if (settlement !== 'all') params.append('settlement_status', settlement)
      if (search) params.append('search', search)
      params.append('page', page)
      params.append('page_size', pageSize)
      const res = await api.get(`${API.ARCHIVE_RECORDS}?${params.toString()}`)
      setRecords(res.data.results || [])
      setRecordCount(res.data.count || 0)
    } catch {
      setRecords([])
      setRecordCount(0)
    } finally {
      setLoadingRecords(false)
    }
  }, [activeYear, selectedMonth, settlement, search, page])

  const loadFields = useCallback(async () => {
    setLoadingFields(true)
    try {
      const res = await api.get(API.DB_EXPORT_FIELDS)
      setFields(res.data)
    } catch {
      setFields(null)
    } finally {
      setLoadingFields(false)
    }
  }, [])

  const loadArchivedFields = useCallback(async (year) => {
    setLoadingArchivedFields(true)
    try {
      const res = await api.get(API.ARCHIVE_EXPORT_FIELDS, { params: year ? { year } : {} })
      setArchivedFields(res.data)
    } catch {
      setArchivedFields(null)
    } finally {
      setLoadingArchivedFields(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern, matches existing codebase convention
    loadOverview()
    loadYears()
  }, [loadOverview, loadYears])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- year changed, refresh its months
    if (view === 'months') loadMonths(activeYear)
  }, [activeYear, view, loadMonths])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern, matches existing codebase convention
    if (view === 'records') loadRecords()
  }, [view, loadRecords])

  useEffect(() => {
    if (tab !== 'export') return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Export tab opened, load both exports' field summaries
    loadFields()
    loadArchivedFields(archiveExportYear || null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- archiveExportYear changes handled by the dedicated effect below
  }, [tab, loadFields])

  useEffect(() => {
    if (tab !== 'export') return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- archive export year filter changed
    loadArchivedFields(archiveExportYear || null)
  }, [archiveExportYear, tab, loadArchivedFields])

  // One shared PDF pipeline for both exports: fetch the read-only data,
  // draw the PDF in the browser, download it. Runs only after the Admin has
  // confirmed in the modal, and never twice at once.
  const runPdfExport = async ({ scope, setState, setErrorMsg, endpoint, params, doneMessage, refresh }) => {
    if (exportBusyRef.current) return
    exportBusyRef.current = true
    setState('exporting')
    setErrorMsg('')
    try {
      const res = await api.get(endpoint, { params })
      const { doc, warnings } = await buildArchiveExportPdf(res.data, { scope })
      downloadPdf(doc, archiveExportFileName({
        scope, year: res.data.meta?.year, generatedAt: res.data.meta?.generated_at,
      }))
      setState('success')
      toast.success(doneMessage)
      warnings.forEach(w => toast.warning(w))
      refresh()
      setTimeout(() => setState('idle'), 2500)
    } catch (err) {
      setState('error')
      const msg = err.response?.data?.error || 'Export failed. Please try again.'
      setErrorMsg(msg)
      toast.danger(msg)
    } finally {
      exportBusyRef.current = false
    }
  }

  const handleExport = () => runPdfExport({
    scope: 'full',
    setState: setExportState,
    setErrorMsg: setExportErrorMsg,
    endpoint: API.DB_EXPORT_FULL_PDF_DATA,
    params: {},
    doneMessage: 'Full database export (PDF) downloaded.',
    refresh: loadFields, // refresh active record count in case it changed
  })

  const handleArchivedExport = () => runPdfExport({
    scope: 'archived',
    setState: setArchivedExportState,
    setErrorMsg: setArchivedExportErrorMsg,
    endpoint: API.ARCHIVE_EXPORT_PDF_DATA,
    params: archiveExportYear ? { year: archiveExportYear } : {},
    doneMessage: 'Archived records export (PDF) downloaded.',
    refresh: () => loadArchivedFields(archiveExportYear || null),
  })

  const handleArchive = async () => {
    setArchiving(true)
    setArchiveError('')
    try {
      const res = await api.post(API.ARCHIVE_EXECUTE)
      setLastResult(res.data)
      setConfirmOpen(false)
      toast.success(`Archived ${res.data.archived_count.toLocaleString()} record(s) successfully.`)
      loadOverview()
      loadYears()
      if (view === 'months') loadMonths(activeYear)
    } catch (err) {
      // 409 BUSY: another archive run holds the server-side lock. Nothing was
      // changed; the Admin simply tries again once it finishes.
      const msg = err.response?.status === 409
        ? 'Another archive operation is already running. No data was changed — please wait a moment and try again.'
        : (err.response?.data?.error || 'Archive operation failed. No data was changed.')
      setArchiveError(msg)
      toast.danger(msg)
      loadOverview()
    } finally {
      setArchiving(false)
    }
  }

  const openMonth = (monthNum) => {
    setSelectedMonth(monthNum)
    setSettlement('all')
    setSearch('')
    setPage(1)
    setView('records')
  }

  const backToMonths = () => {
    setView('records' === view ? 'months' : view)
    setSelectedMonth(null)
    setRecords([])
    setRecordCount(0)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.delete(`${API.ARCHIVE_RECORDS}${deleteTarget.id}/`)
      toast.success(`Archived record #${deleteTarget.original_violation_id} deleted.`)
      setDeleteTarget(null)
      loadRecords()
      loadMonths(activeYear)
      loadOverview()
    } catch (err) {
      toast.danger(err.response?.data?.error || 'Delete failed. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(recordCount / pageSize))
  const from = recordCount === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, recordCount)
  const deleteEnabled = !!overview?.delete_enabled
  const alreadyArchivedActive = overview?.already_archived_active_count || 0
  const conflictCount = overview?.archive_conflict_count || 0
  const blockedCount = alreadyArchivedActive + conflictCount
  const eligibleByYear = (overview?.year_breakdown || [])
    .map(y => ({
      year: y.year,
      eligible: y.total - y.in_progress - (y.already_archived || 0) - (y.conflict || 0),
    }))
    .filter(y => y.eligible > 0)
    .sort((a, b) => b.year - a.year)

  const exportBusy = exportState === 'exporting' || archivedExportState === 'exporting'
  const fullCount = fields?.active_record_count ?? null
  const archivedCount = archivedFields?.archived_record_count ?? null
  const largeNote = (count, hint) => (
    count !== null && count >= LARGE_EXPORT_RECORDS
      ? `This is a large export (${count.toLocaleString()} records). The PDF can run to hundreds of pages and take a while to generate; keep this page open until it finishes. ${hint}`
      : undefined
  )

  const exportCfg = exportConfirm === 'archived'
    ? {
        title: 'Export Archived Records',
        subtitle: 'This will generate a PDF file containing the archived violation records.',
        rows: [
          ['File Type', 'PDF (A4 landscape)'],
          ['Content', 'Archived violation records'],
          ['Year', archiveExportYear ? `Selected year: ${archiveExportYear}` : 'All years'],
          ['Records', archivedCount !== null ? archivedCount.toLocaleString() : '—'],
        ],
        warning: largeNote(
          archivedCount,
          archiveExportYear
            ? 'You can cancel and export a smaller set instead.'
            : 'To keep it smaller, cancel and select a specific archive year first.',
        ),
        onConfirm: () => { setExportConfirm(null); handleArchivedExport() },
      }
    : {
        title: 'Export Full Database (Active Records)',
        subtitle: 'This will generate a PDF file containing all active violation records.',
        rows: [
          ['File Type', 'PDF (A4 landscape)'],
          ['Content', 'All active violation records (current database)'],
          ['Records', fullCount !== null ? fullCount.toLocaleString() : '—'],
        ],
        warning: largeNote(fullCount, 'You can cancel now if you would rather export later.'),
        onConfirm: () => { setExportConfirm(null); handleExport() },
      }

  return (
    <div>
      <PageHeader title="Archive Management" />

      {/* ── TAB BAR ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <Button variant={tab === 'archive' ? 'primary' : 'secondary'} size="sm" icon={Archive} onClick={() => setTab('archive')}>
          Archive
        </Button>
        <Button variant={tab === 'export' ? 'primary' : 'secondary'} size="sm" icon={Download} onClick={() => setTab('export')}>
          Export
        </Button>
      </div>

      {tab === 'archive' && (
      <>
      {/* ── STAT CARDS ── */}
      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        <StatCard
          label="Eligible to Archive"
          value={overview ? overview.eligible_count.toLocaleString() : '—'}
          icon={Clock}
          accent="var(--warning-500)"
          sublabel="Processing finished, not yet archived"
          loading={loadingOverview}
        />
        <StatCard
          label="In Progress"
          value={overview ? overview.in_progress_count.toLocaleString() : '—'}
          icon={AlertTriangle}
          accent="var(--danger-600)"
          sublabel="Staff still working — stays active"
          loading={loadingOverview}
        />
        <StatCard
          label="Archived Records"
          value={overview ? overview.already_archived_count.toLocaleString() : '—'}
          icon={Archive}
          accent="var(--blue-600)"
          loading={loadingOverview}
        />
        {blockedCount > 0 && (
          <StatCard
            label="Archive Conflicts"
            value={blockedCount.toLocaleString()}
            icon={AlertTriangle}
            accent="var(--danger-600)"
            sublabel="Already archived or clashing id — left untouched"
            loading={loadingOverview}
          />
        )}
        <StatCard
          label="Archive Years"
          value={years.length}
          icon={History}
          accent="var(--success-500)"
          sublabel={years.length ? years.join(', ') : 'None yet'}
        />
      </div>

      {/* ── ARCHIVE OPERATION CARD ── */}
      <Card style={{ marginBottom: 20 }}>
        <CardHeader
          title="Archive Current Active Data"
          subtitle="Moves records whose staff processing is finished into permanent archive storage after verifying nothing is lost. Records a staff member is still processing (pending, in progress, or currently locked for Resume) are never touched — they stay active until finished, however long that takes."
        />

        {blockedCount > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Alert tone="warning">
              {blockedCount.toLocaleString()} active record(s) will be skipped because the archive already holds
              {conflictCount > 0 ? ' the same record or a record with a clashing id' : ' a snapshot of the same record'}.
              They are left untouched and are not counted twice in any statistic. Ask the developer to run
              <code> inspect_archive_duplicates</code> to review them.
            </Alert>
          </div>
        )}

        {lastResult && !confirmOpen && (
          <div style={{ marginBottom: 16 }}>
            <Alert tone={lastResult.archive_conflict_count > 0 ? 'warning' : 'success'}>
              Last archive: {lastResult.archived_count.toLocaleString()} record(s) moved successfully.
              {lastResult.skipped_in_progress_count > 0 && (
                <> {lastResult.skipped_in_progress_count.toLocaleString()} in-progress record(s) were left active.</>
              )}
              {lastResult.skipped_already_archived_count > 0 && (
                <> {lastResult.skipped_already_archived_count.toLocaleString()} already-archived record(s) were left untouched.</>
              )}
              {lastResult.archive_conflict_count > 0 && (
                <> {lastResult.archive_conflict_count.toLocaleString()} record(s) with a conflicting archive id were left untouched.</>
              )}
            </Alert>
          </div>
        )}

        <Button
          variant="danger"
          icon={Archive}
          onClick={openArchiveConfirm}
          disabled={loadingOverview || !overview?.eligible_count}
        >
          Archive Current Database
        </Button>
        {!loadingOverview && !overview?.eligible_count && (
          <p className="text-caption" style={{ marginTop: 8 }}>
            {overview?.in_progress_count
              ? `No records are eligible right now — all ${overview.in_progress_count.toLocaleString()} active record(s) are still being processed.`
              : 'No active records to archive right now.'}
          </p>
        )}
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => { if (!archiving) { setConfirmOpen(false); setArchiveError('') } }}
        width={540}
        icon={Database}
        title="Archive Current Database"
        subtitle="This will move all eligible active violation records to the archive and remove them from active records."
        tone="danger"
        reminder={[
          'Only finished records (staff processing is completed) will be archived.',
          'Records that are pending, processing, or locked for a Resume session will not be archived and will remain in active records.',
          'The archived records will be removed from active records and stored in the archive as a snapshot.',
          'There is no restore or unarchive function in the system.',
          'Please verify the record counts below before continuing.',
        ]}
        warning={archiveError || undefined}
        confirmLabel="Archive Records"
        confirmIcon={Database}
        confirmDisabled={refreshingOverview || !overview?.eligible_count}
        onConfirm={handleArchive}
        loading={archiving}
      >
        <div className="confirm-section-title">Records to Archive</div>
        <div className="confirm-stats" aria-busy={refreshingOverview || undefined}>
          <div className="confirm-stat">
            <span className="confirm-stat-value">{overview ? overview.eligible_count.toLocaleString() : '—'}</span>
            <span className="confirm-stat-label">Eligible Records (finished)</span>
          </div>
          <div className="confirm-stat">
            <span className="confirm-stat-value">{overview ? overview.in_progress_count.toLocaleString() : '—'}</span>
            <span className="confirm-stat-label">Will Not Be Archived (pending/processing/locked)</span>
          </div>
          {blockedCount > 0 && (
            <div className="confirm-stat">
              <span className="confirm-stat-value">{blockedCount.toLocaleString()}</span>
              <span className="confirm-stat-label">Skipped (already archived / conflicting id)</span>
            </div>
          )}
          <div className="confirm-stat">
            <span className="confirm-stat-value">
              {overview ? (overview.active_count ?? overview.eligible_count + overview.in_progress_count).toLocaleString() : '—'}
            </span>
            <span className="confirm-stat-label">Total Active Records</span>
          </div>
        </div>

        {eligibleByYear.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="confirm-section-title">Breakdown of Eligible Records (by Year)</div>
            <table className="confirm-table">
              <thead>
                <tr><th scope="col">Year</th><th scope="col">Records</th></tr>
              </thead>
              <tbody>
                {eligibleByYear.map(y => (
                  <tr key={y.year}><td>{y.year || 'No date'}</td><td>{y.eligible.toLocaleString()}</td></tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td>Total</td><td>{overview.eligible_count.toLocaleString()}</td></tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="text-caption" style={{ marginTop: 10 }}>
          Counts are as of when this dialog opened. The final result is shown after archiving.
        </p>
      </ConfirmDialog>

      {/* ── HISTORICAL ARCHIVE BROWSER ── */}
      <Card padded={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <div className="text-h3">Historical Archived Violation Records</div>
          {view === 'records' && (
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 10, paddingLeft: 0 }}
              onClick={backToMonths}
            >
              <ChevronLeft size={14} /> Back to {activeYear} Archive
            </button>
          )}
        </div>

        {loadingYears ? (
          <div style={{ padding: 24 }}><div className="skeleton" style={{ height: 120 }} /></div>
        ) : years.length === 0 ? (
          <div style={{ padding: '8px 0 24px' }}>
            <EmptyState icon={Archive} title="No archived years yet" message="Once you archive the active database, years will appear here automatically." />
          </div>
        ) : view === 'months' ? (
          <>
            {/* Archive Year selector — dynamic, no hardcoded years */}
            <div style={{ padding: '14px 18px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="text-caption" style={{ fontWeight: 600 }}>Archive Year:</span>
              <select
                className="filter-select"
                value={activeYear ?? ''}
                onChange={e => setActiveYear(Number(e.target.value))}
              >
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>

            <div style={{ padding: 18 }}>
              {loadingMonths ? (
                <div className="skeleton" style={{ height: 160 }} />
              ) : months.length === 0 ? (
                <EmptyState icon={FolderOpen} title="No archived records for this year" />
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
                  {months.map(m => (
                    <div key={m.month} className="card card-padded card-interactive" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <FolderOpen size={16} color="var(--blue-600)" />
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{MONTH_NAMES[m.month]} {activeYear}</span>
                      </div>
                      <span className="text-caption">{m.total} record{m.total !== 1 ? 's' : ''}</span>
                      <span className="text-caption">Settled: {m.settled} · Pending: {m.unsettled}</span>
                      <Button variant="secondary" size="sm" onClick={() => openMonth(m.month)}>
                        View <ChevronRightIcon size={13} />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: '4px 18px 0' }}>
              <span className="text-h3" style={{ fontSize: 15 }}>{MONTH_NAMES[selectedMonth]} {activeYear}</span>
              <span className="text-caption" style={{ marginLeft: 8 }}>{recordCount.toLocaleString()} Archived Record{recordCount !== 1 ? 's' : ''}</span>
            </div>

            {/* Filter bar */}
            <div className="filter-bar" style={{ borderRadius: 0, borderLeft: 'none', borderRight: 'none', marginTop: 14 }}>
              <div className="search-input-wrap">
                <Search size={14} className="search-input-icon" />
                <input
                  className="input" value={search}
                  onChange={e => { setSearch(e.target.value); setPage(1) }}
                  placeholder="Search violator, license, plate, violation ID…"
                />
                {search && (
                  <button className="search-input-clear" onClick={() => { setSearch(''); setPage(1) }} aria-label="Clear search">
                    <X size={12} />
                  </button>
                )}
              </div>

              <select className="filter-select" value={settlement} onChange={e => { setSettlement(e.target.value); setPage(1) }}>
                <option value="all">All Statuses</option>
                <option value="settled">Settled</option>
                <option value="unsettled">Pending</option>
              </select>
            </div>

            {/* Table */}
            <div style={{ overflowX: 'auto' }}>
              {loadingRecords ? (
                <div style={{ padding: 24 }}><div className="skeleton" style={{ height: 200 }} /></div>
              ) : records.length === 0 ? (
                <EmptyState icon={Archive} title="No archived records found" message="Try adjusting your search or status filter." />
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Violator</th>
                      <th>License</th>
                      <th>Plate</th>
                      <th>Violation</th>
                      <th>Date</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map(r => (
                      <tr key={r.id}>
                        <td>#{r.original_violation_id}</td>
                        <td>{r.violator_name}</td>
                        <td>{r.license_number || '—'}</td>
                        <td>{r.plate_number || '—'}</td>
                        <td>{(r.data?.items || []).map(i => i.name).filter(Boolean).join(', ') || '—'}</td>
                        <td>{fmtDate(r.date_issued)}</td>
                        <td>
                          <Badge tone={r.settlement_status === 'settled' ? 'success' : 'warning'}>
                            {r.settlement_status === 'settled' ? 'Settled' : 'Pending'}
                          </Badge>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn btn-secondary btn-sm" title="View" onClick={() => setDetailRecord(r)}>
                              <Eye size={13} /> View
                            </button>
                            {deleteEnabled && (
                              <button className="btn btn-danger-ghost btn-sm" title="Delete" onClick={() => setDeleteTarget(r)}>
                                <Trash2 size={13} /> Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Pagination */}
            {recordCount > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--slate-100)', background: 'var(--slate-50)', flexWrap: 'wrap', gap: 10 }}>
                <span className="text-caption">{`${from}–${to} of ${recordCount.toLocaleString()} records`}</span>
                <div className="pagination">
                  <button className="page-btn" disabled={page === 1} onClick={() => setPage(p => p - 1)} aria-label="Previous page">
                    <ChevronLeft size={14} />
                  </button>
                  <span className="text-caption" style={{ padding: '0 8px' }}>Page {page} of {totalPages}</span>
                  <button className="page-btn" disabled={page === totalPages} onClick={() => setPage(p => p + 1)} aria-label="Next page">
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <AlertTriangle size={14} style={{ color: 'var(--slate-400)', marginTop: 2, flexShrink: 0 }} />
        <p className="text-caption">
          Archive records are grouped by the original violation date, never the archive or settlement date — a
          violation issued in June stays under June even if it was archived months later. Archive is a read-only
          historical repository; it does not recalculate repeat-offender status.
        </p>
      </div>
      </>
      )}

      {tab === 'export' && (
      <>
      {/* ── STAT CARDS ── */}
      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        <StatCard
          label="Active Records"
          value={fields ? fields.active_record_count.toLocaleString() : '—'}
          icon={Database}
          accent="var(--blue-600)"
          loading={loadingFields}
        />
        <StatCard
          label="Archived Records"
          value={archivedFields ? archivedFields.archived_record_count.toLocaleString() : '—'}
          icon={Archive}
          accent="var(--success-500)"
          sublabel={archiveExportYear ? `Year ${archiveExportYear} only` : 'All years'}
          loading={loadingArchivedFields}
        />
      </div>

      {/* ── FULL DATABASE EXPORT CARD ── */}
      <Card style={{ marginBottom: 20 }}>
        <CardHeader
          title="Full Database Export"
          subtitle="Downloads every active record as a PDF file. This is a copy — it never deletes, archives, or modifies active data."
        />

        {exportState === 'error' && (
          <div style={{ marginBottom: 16 }}>
            <Alert tone="danger">{exportErrorMsg}</Alert>
          </div>
        )}
        {exportState === 'success' && (
          <div style={{ marginBottom: 16 }}>
            <Alert tone="success">Export completed successfully.</Alert>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <Button
            icon={exportState === 'success' ? CheckCircle2 : Download}
            onClick={() => setExportConfirm('full')}
            loading={exportState === 'exporting'}
            disabled={exportBusy}
          >
            {exportState === 'exporting' ? 'Exporting…' : 'Export Full Database'}
          </Button>
          <span className="text-caption">
            {fields ? `Will export ${fields.active_record_count.toLocaleString()} record(s) across ${fields.field_count} fields.` : ''}
          </span>
        </div>
      </Card>

      {/* ── ARCHIVED RECORDS EXPORT CARD ── */}
      <Card>
        <CardHeader
          title="Archived Records Export"
          subtitle="Downloads archived records as a PDF file, including preserved payment info (OR Number, Amount Paid, Date Paid, Received By). Reads only from the archive — never the active database."
        />

        {archivedExportState === 'error' && (
          <div style={{ marginBottom: 16 }}>
            <Alert tone="danger">{archivedExportErrorMsg}</Alert>
          </div>
        )}
        {archivedExportState === 'success' && (
          <div style={{ marginBottom: 16 }}>
            <Alert tone="success">Export completed successfully.</Alert>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <span className="text-caption" style={{ fontWeight: 600 }}>Archive Year:</span>
          <select
            className="filter-select"
            value={archiveExportYear}
            onChange={e => setArchiveExportYear(e.target.value)}
          >
            <option value="">All Years</option>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <Button
            icon={archivedExportState === 'success' ? CheckCircle2 : FileText}
            onClick={() => setExportConfirm('archived')}
            loading={archivedExportState === 'exporting'}
            disabled={exportBusy || !archivedFields?.archived_record_count}
          >
            {archivedExportState === 'exporting' ? 'Exporting…' : 'Export Archived Records'}
          </Button>
          <span className="text-caption">
            {archivedFields
              ? `Will export ${archivedFields.archived_record_count.toLocaleString()} record(s) across ${archivedFields.field_count} fields.`
              : ''}
          </span>
        </div>
      </Card>
      </>
      )}

      {/* ── READ-ONLY DETAIL MODAL ── */}
      {detailRecord && (
        <Modal open onClose={() => setDetailRecord(null)} width={520} title="Violation Details">
          <DetailRow label="Violation ID" value={`#${detailRecord.original_violation_id}`} />
          <DetailRow label="Violator" value={detailRecord.violator_name} />
          <DetailRow label="License No." value={detailRecord.license_number} />
          <DetailRow label="Plate No." value={detailRecord.plate_number} />
          <DetailRow
            label="Violation Type"
            value={(detailRecord.data?.items || []).map(i => i.name).filter(Boolean).join(', ')}
          />
          <DetailRow label="Violation Date" value={fmtDate(detailRecord.date_issued)}></DetailRow>
          <DetailRow label="Location" value={detailRecord.data?.location} />
          <DetailRow
            label="Enforcer"
            value={(['event', 'derived'].includes(detailRecord.data?.enforcer_snapshot_source)
              && detailRecord.data?.enforcer_name_snapshot)
              || detailRecord.data?.enforcer_name}
          />
          <DetailRow
            label="Status"
            value={<Badge tone={detailRecord.settlement_status === 'settled' ? 'success' : 'warning'}>
              {detailRecord.settlement_status === 'settled' ? 'Settled' : 'Pending'}
            </Badge>}
          />
          <DetailRow label="Violation Year" value={detailRecord.violation_year} />
          <DetailRow label="Archived At" value={fmtDateTime(detailRecord.archived_at)} />
        </Modal>
      )}

      {/* ── EXPORT REMINDER (informational, read-only action) ── */}
      <ConfirmDialog
        open={!!exportConfirm}
        onClose={() => setExportConfirm(null)}
        width={520}
        icon={FileText}
        title={exportCfg.title}
        subtitle={exportCfg.subtitle}
        warning={exportCfg.warning}
        reminder={[
          'This action will only download a file. Nothing in the system will be modified.',
          'The exported file contains TMEO data, including personal information (e.g., violator details, vehicle details, violation records, assessments).',
          'Make sure to store and handle the file securely.',
        ]}
        rows={exportCfg.rows}
        confirmLabel="Download Export"
        confirmIcon={Download}
        onConfirm={exportCfg.onConfirm}
      />

      {/* ── DELETE CONFIRMATION ── */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => { if (!deleting) setDeleteTarget(null) }}
        width={500}
        icon={Trash2}
        title="Delete Archived Record"
        subtitle="This will permanently delete the selected archived record."
        tone="danger"
        reminder={[
          'This action cannot be undone.',
          'The record will be permanently removed from the archive.',
          'Once deleted, this record will no longer appear in Archive Management, Reports, Analytics, or violator history.',
          'Only this archived record is deleted. Active records, payments, and evidence are not touched.',
          'Please verify the record details below before continuing.',
        ]}
        rowsTitle="Record Details"
        rows={deleteTarget ? [
          ['Violation No.', `#${deleteTarget.original_violation_id}`],
          ['Violator Name', deleteTarget.violator_name || '—'],
          ['Vehicle', vehicleLabel(deleteTarget)],
          ['Violation Type', violationTypeLabel(deleteTarget)],
          ['Date', fmtDate(deleteTarget.date_issued)],
          ['Location', deleteTarget.data?.location || '—'],
          ['Status (at time of archive)', deleteTarget.settlement_status === 'settled' ? 'Settled' : 'Pending'],
        ] : []}
        confirmLabel="Delete Archived Record"
        confirmIcon={Trash2}
        onConfirm={handleDelete}
        loading={deleting}
      />
    </div>
  )
}