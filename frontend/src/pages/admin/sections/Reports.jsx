import { useCallback, useRef, useState } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import { FileBarChart, Loader2, Upload } from 'lucide-react'
import api from '../../../services/api'
import { useToast } from '../../../context/useToast'
import Button from '../../../components/ui/Button'

import {
  REPORT_TYPES, VEHICLE_TYPE_OPTIONS, endOfWeek, startOfMonth, startOfWeek, today,
} from './reports/reportsConfig'
import ReportTypeCards from './reports/ReportTypeCards'
import ReportFilters from './reports/ReportFilters'
import ReportResultsPanel from './reports/ReportResultsPanel'
import ImportModal from './reports/ReportImportModal'

const NO_FILTERS = []
const initialFilters = () => ({
  preset: 'month', dateFrom: startOfMonth(), dateTo: today(), status: '', category: '', vehicleType: '',
})

export default function Reports() {
  const toast = useToast()
  const [reportId, setReportId] = useState(null)
  const [filters, setFilters] = useState(initialFilters)
  // INITIAL | LOADING | DATA | ZERO | ERROR are explicit, mutually exclusive.
  const [phase, setPhase] = useState('initial')
  const [payload, setPayload] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [stale, setStale] = useState(false)
  // Last custom range the user APPLIED. Kept separately from `filters` so switching to a
  // preset and back doesn't lose it. Draft (unapplied) dates live inside CustomRangePopover only.
  const [customRange, setCustomRange] = useState(null)
  const [page, setPage] = useState(1)
  const [rowsPerPage, setRowsPerPage] = useState(10)
  const [showImport, setShowImport] = useState(false)
  const requestSeq = useRef(0)
  const resultsRef = useRef(null)

  const report = REPORT_TYPES.find(r => r.id === reportId)
  const supported = report?.filters ?? NO_FILTERS
  const dateInvalid = !!(filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo)

  // Any change to the report or a filter invalidates what is on screen:
  // results are kept (so the page doesn't jump) but flagged stale and cannot be exported.
  const markStale = () => { requestSeq.current += 1; setStale(true); if (phase === 'loading') setPhase(payload ? (payload.rows.length ? 'data' : 'zero') : 'initial') }

  const selectReport = (id) => {
    if (id === reportId) return
    setReportId(id)
    // Filters a newly-selected report does not support must not silently carry over.
    const next = REPORT_TYPES.find(r => r.id === id).filters
    setFilters(f => ({
      ...f,
      status: next.includes('status') ? f.status : '',
      category: next.includes('category') ? f.category : '',
      vehicleType: next.includes('vehicle_type') ? f.vehicleType : '',
    }))
    // A different report's rows must never linger under the new title.
    requestSeq.current += 1
    setPayload(null); setPhase('initial'); setStale(false); setErrorMessage(''); setPage(1)
  }

  const changeFilters = (patch) => {
    setFilters(f => ({ ...f, ...patch }))
    if (payload) markStale()
  }

  // Commits the custom range as the ACTIVE filter. It never requests a report —
  // "Generate report" remains the only action that does. Results are only marked
  // stale when the committed filter actually changes, so open/edit/cancel never do.
  const applyCustomRange = (dateFrom, dateTo) => {
    if (!dateFrom || !dateTo || dateFrom > dateTo) return
    const changed = filters.preset !== 'custom' || filters.dateFrom !== dateFrom || filters.dateTo !== dateTo
    setCustomRange({ dateFrom, dateTo })
    setFilters(f => ({ ...f, preset: 'custom', dateFrom, dateTo }))
    if (payload && changed) markStale()
  }

  const applyPreset = (preset) => {
    let range = {}
    if (preset === 'today') range = { dateFrom: today(), dateTo: today() }
    else if (preset === 'week') range = { dateFrom: startOfWeek(), dateTo: endOfWeek() }
    else if (preset === 'month') range = { dateFrom: startOfMonth(), dateTo: today() }
    setFilters(f => ({ ...f, preset, ...range }))
    if (payload) markStale()
  }

  const generate = useCallback(async () => {
    if (!reportId || dateInvalid) return
    const seq = ++requestSeq.current
    setPhase('loading'); setStale(false); setErrorMessage(''); setPage(1)
    const params = { type: reportId, date_from: filters.dateFrom, date_to: filters.dateTo }
    if (supported.includes('status') && filters.status) params.status = filters.status
    if (supported.includes('category') && filters.category) params.category = filters.category
    if (supported.includes('vehicle_type') && filters.vehicleType) params.vehicle_type = filters.vehicleType
    try {
      const res = await api.get('/api/reports/generate/', { params })
      if (seq !== requestSeq.current) return      // a newer request / filter change superseded this one
      setPayload(res.data)
      setPhase(res.data.rows.length ? 'data' : 'zero')
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
    } catch (err) {
      if (seq !== requestSeq.current) return
      // A failure is an ERROR state — never rendered as "no records".
      setPayload(null)
      setErrorMessage(err?.response?.data?.error || (err?.response ? 'The server could not generate this report.' : 'Network error — check your connection.'))
      setPhase('error')
      toast.danger('Failed to generate report.')
    }
  }, [reportId, dateInvalid, filters, supported, toast])

  const exportPdf = async () => {
    if (!payload || stale) return
    try {
      // Loaded on demand so jsPDF stays out of the initial Reports bundle.
      const { buildReportPdf, reportFileName } = await import('./reports/reportPdf')
      buildReportPdf(payload).save(reportFileName(payload.meta))
      toast.success('PDF exported.')
    } catch {
      toast.danger('Could not create the PDF. Please try again.')
    }
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        action={(
          <>
          <Button variant="secondary" icon={Upload} onClick={() => setShowImport(true)}>Import Excel</Button>
      
          </>
        )}
      />

      <ReportTypeCards selectedId={reportId} onSelect={selectReport} />

      {report && (
        <>
          <ReportFilters filters={filters} supported={supported} onPreset={applyPreset} onChange={changeFilters}
            customRange={customRange} onApplyCustom={applyCustomRange} dateInvalid={dateInvalid} vehicleOptions={VEHICLE_TYPE_OPTIONS} />
          <div style={{ marginBottom: 20 }}>
            <Button icon={phase === 'loading' ? Loader2 : FileBarChart} loading={phase === 'loading'} disabled={dateInvalid} onClick={generate}>
              {phase === 'loading' ? 'Generating…' : 'Generate report'}
            </Button>
          </div>
        </>
      )}

      <div ref={resultsRef}>
        <ReportResultsPanel
          phase={phase} reportId={reportId} payload={payload} stale={stale} errorMessage={errorMessage}
          page={page} rowsPerPage={rowsPerPage} onSetPage={setPage}
          onSetRowsPerPage={(n) => { setRowsPerPage(n); setPage(1) }}
          onRetry={generate} onExportPdf={exportPdf}
        />
      </div>

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onSuccess={(count) => { setShowImport(false); toast.success(`Imported ${count} violation record(s).`); if (payload) markStale() }}
        />
      )}
    </div>
  )
}