import { useState, useEffect, useCallback } from 'react'
import { Database, Download, CheckCircle2, FileSpreadsheet } from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { useToast } from '../../../context/useToast'
import Button from '../../../components/ui/Button'
import StatCard from '../../../components/ui/StatCard'
import { Card, CardHeader } from '../../../components/ui/Card'
import Alert from '../../../components/ui/Alert'

/**
 * Database Management — Full Database Export (see MASTER PROMPT PART 4-11).
 *
 * Intentionally minimal per the spec: no dashboards, no duplicate
 * search/filter UI (that already exists on Violation Records). The only
 * job here is one-click export of the entire currently-active dataset.
 * Columns shown below are fetched from the backend, which derives them
 * dynamically from the live Violation model — nothing here is hardcoded.
 */
export default function DatabaseManagement() {
  const toast = useToast()
  const [fields, setFields] = useState(null)
  const [loadingFields, setLoadingFields] = useState(true)
  const [exportState, setExportState] = useState('idle') // idle | exporting | success | error
  const [errorMsg, setErrorMsg] = useState('')

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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern, matches existing codebase convention
    loadFields()
  }, [loadFields])

  const handleExport = async () => {
    setExportState('exporting')
    setErrorMsg('')
    try {
      const res = await api.get(API.DB_EXPORT_FULL, { responseType: 'blob' })

      // Filename comes from the backend's Content-Disposition header
      // (TMEO_Full_Database_YYYY-MM-DD_HH-MM.xlsx) — fall back to a
      // generic name only if the header is ever missing.
      const disposition = res.headers['content-disposition'] || ''
      const match = disposition.match(/filename="?([^"]+)"?/)
      const filename = match ? match[1] : `TMEO_Full_Database_${new Date().toISOString()}.xlsx`

      const url = URL.createObjectURL(new Blob([res.data]))
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)

      setExportState('success')
      toast.success('Full database export downloaded.')
      loadFields() // refresh active record count in case it changed
      setTimeout(() => setExportState('idle'), 2500)
    } catch (err) {
      setExportState('error')
      const msg = err.response?.data?.error || 'Export failed. Please try again.'
      setErrorMsg(msg)
      toast.danger(msg)
    }
  }

  return (
    <div>
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
          label="Exportable Fields"
          value={fields ? fields.field_count : '—'}
          icon={FileSpreadsheet}
          accent="var(--success-500)"
          sublabel="Determined dynamically"
          loading={loadingFields}
        />
      </div>

      {/* ── EXPORT CARD ── */}
      <Card>
        <CardHeader
          title="Full Database Export"
          subtitle="Downloads every active record as an Excel file. This is a copy — it never deletes, archives, or modifies active data."
        />

        {exportState === 'error' && (
          <div style={{ marginBottom: 16 }}>
            <Alert tone="danger">{errorMsg}</Alert>
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
            onClick={handleExport}
            loading={exportState === 'exporting'}
            disabled={exportState === 'exporting'}
          >
            {exportState === 'exporting' ? 'Exporting…' : 'Export Full Database'}
          </Button>
          <span className="text-caption">
            {fields ? `Will export ${fields.active_record_count.toLocaleString()} record(s) across ${fields.field_count} fields.` : ''}
          </span>
        </div>
      </Card>
    </div>
  )
}