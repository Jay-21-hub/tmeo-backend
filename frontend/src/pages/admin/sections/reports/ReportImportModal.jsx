import { useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Download, FileUp, Upload } from 'lucide-react'
import api from '../../../../services/api'
import Modal from '../../../../components/ui/Modal'
import Button from '../../../../components/ui/Button'
import Alert from '../../../../components/ui/Alert'
import { StatusBadge } from '../../../../components/ui/Badge'
import { fmtMoney } from './reportsConfig'

const MAX_BYTES = 2 * 1024 * 1024
const REQUIRED = ['date_issued', 'plate_number', 'violator_name', 'violation_codes', 'penalty_amount']

/** Axios errors for multipart posts → one readable message (never alert()). */
const explain = (err, fallback) => {
  const d = err?.response?.data
  if (err?.response?.status === 403) return 'Only Administrators can import violations.'
  if (d?.error) return d.error
  return err?.response ? fallback : 'Network error — check your connection and try again.'
}

export default function ImportModal({ onClose, onSuccess }) {
  const [step, setStep] = useState('upload')          // upload | preview | done
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef(null)

  const pick = (f) => {
    setError('')
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.xlsx')) { setFile(null); setError('Only Excel .xlsx files are accepted.'); return }
    if (f.size > MAX_BYTES) { setFile(null); setError('That file is larger than 2 MB. Split it and import in parts.'); return }
    setFile(f)
  }

  const post = (save) => {
    const body = new FormData()
    body.append('file', file)
    return api.post(`/api/violations/import/${save ? '?save=true' : ''}`, body, { headers: { 'Content-Type': 'multipart/form-data' } })
  }

  const runPreview = async () => {
    if (!file) return
    setBusy(true); setError('')
    try { const res = await post(false); setPreview(res.data); setStep('preview') }
    catch (err) { setError(explain(err, 'Could not read the file.')) }
    finally { setBusy(false) }
  }

  const confirm = async () => {
    setBusy(true); setError('')
    try { const res = await post(true); setResult(res.data); setStep('done'); onSuccess?.(res.data.created) }
    catch (err) {
      setError(explain(err, 'Import failed. Nothing was saved.'))
      // server re-validated and found problems → show them instead of a stale preview
      if (err?.response?.data?.errors) setPreview(p => ({ ...p, errors: err.response.data.errors, error_count: err.response.data.errors.length, can_import: false }))
    } finally { setBusy(false) }
  }

  const downloadTemplate = async () => {
    setError('')
    try {
      const res = await api.get('/api/violations/import/template/', { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url; a.download = 'violations_import_template.xlsx'; a.click()
      URL.revokeObjectURL(url)
    } catch (err) { setError(explain(err, 'Could not download the template.')) }
  }

  const blocked = !!preview && (preview.error_count > 0 || !preview.can_import)

  return (
    <Modal open onClose={busy ? undefined : onClose} width={680} title="Import Violations (Excel)"
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{step === 'done' ? 'Close' : 'Cancel'}</Button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step === 'preview' && <Button variant="secondary" disabled={busy} onClick={() => { setStep('upload'); setPreview(null); setError('') }}>Back</Button>}
            {step === 'upload' && <Button icon={FileUp} loading={busy} disabled={!file} onClick={runPreview}>{busy ? 'Checking…' : 'Check file'}</Button>}
            {step === 'preview' && <Button icon={CheckCircle2} loading={busy} disabled={blocked} onClick={confirm}>
              {blocked ? 'Fix errors to import' : `Confirm import (${preview.valid_count} rows)`}</Button>}
          </div>
        </div>
      }>
      {error && <div style={{ marginBottom: 14 }}><Alert tone="danger" title="Something needs attention">{error}</Alert></div>}

      {step === 'upload' && (
        <div>
          <Alert tone="info" title="Admin-only, all-or-nothing import">
            If any row has an error, no row is saved. Paid rows and ambiguous dates are rejected. Imported records have no issuing
            enforcer and store only the ticket-level penalty.
          </Alert>
          {/* a real <button>: focusable, Enter/Space opens the picker */}
          <button type="button" onClick={() => inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); pick(e.dataTransfer.files[0]) }}
            aria-describedby="import-hint"
            style={{ width: '100%', marginTop: 14, padding: '36px 20px', font: 'inherit', cursor: 'pointer', textAlign: 'center',
              border: '2px dashed var(--color-border)', borderRadius: 'var(--radius-lg)',
              background: dragOver ? 'var(--blue-50)' : file ? 'var(--success-50)' : 'var(--slate-50)' }}>
            <input ref={inputRef} type="file" accept=".xlsx" hidden onChange={e => { pick(e.target.files[0]); e.target.value = '' }} />
            {file ? <CheckCircle2 size={28} color="var(--success-500)" aria-hidden="true" /> : <Upload size={26} color="var(--slate-400)" aria-hidden="true" />}
            <span style={{ display: 'block', marginTop: 10, fontWeight: 600 }}>{file ? file.name : 'Choose an Excel file, or drop it here'}</span>
            <span id="import-hint" className="text-caption" style={{ display: 'block' }}>
              {file ? `${(file.size / 1024).toFixed(1)} KB — select again to change` : '.xlsx only · max 2 MB · max 1,000 rows'}
            </span>
          </button>
          <p className="text-caption" style={{ marginTop: 14 }}>
            Required columns: {REQUIRED.map(c => <code key={c} style={{ marginRight: 6 }}>{c}</code>)}<br />
            <code>date_issued</code>: Excel date or text <code>YYYY-MM-DD</code> · <code>status</code>: pending or processing
          </p>
          <button type="button" onClick={downloadTemplate} className="btn btn-ghost btn-sm" style={{ marginTop: 8 }}>
            <Download size={13} aria-hidden="true" /> Download template (headers + current violation codes)
          </button>
        </div>
      )}

      {step === 'preview' && preview && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 14 }} role="group" aria-label="Import summary">
            {[['Total rows', preview.total_rows], ['Valid rows', preview.valid_count], ['Rows with errors', preview.error_count]].map(([l, v]) => (
              <div key={l} className="card card-padded" style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{v}</div><div className="text-caption">{l}</div>
              </div>
            ))}
          </div>

          {preview.ignored_columns?.length > 0 && <div style={{ marginBottom: 12 }}><Alert tone="warning" title="Ignored columns">{preview.ignored_columns.join(', ')} are not part of the import and will be skipped.</Alert></div>}

          {preview.error_count > 0 && (
            <div style={{ marginBottom: 14 }}>
              <Alert tone="danger" title={`${preview.error_count} row(s) must be fixed — nothing will be imported until they are`} />
              <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, maxHeight: 200, overflowY: 'auto', border: '1px solid var(--danger-100)', borderRadius: 'var(--radius-md)' }}>
                {preview.errors.map(e => (
                  <li key={e.row} style={{ padding: '8px 12px', borderTop: '1px solid var(--danger-50)' }}>
                    <strong>Row {e.row}</strong>
                    {e.errors.map((m, i) => <div key={i} className="text-caption" style={{ color: 'var(--danger-600)', display: 'flex', gap: 6 }}><AlertCircle size={12} aria-hidden="true" style={{ flexShrink: 0, marginTop: 3 }} />{m}</div>)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.valid_rows.length > 0 && (
            <>
              <p className="text-caption" style={{ marginBottom: 6 }}>Preview — first {preview.valid_rows.length} of {preview.valid_count} valid rows</p>
              <div className="table-wrap" style={{ maxHeight: 240, overflow: 'auto' }}>
                <table className="table">
                  <thead><tr><th scope="col">Row</th><th scope="col">Date</th><th scope="col">Plate</th><th scope="col">Violator</th><th scope="col">Codes</th><th scope="col" style={{ textAlign: 'right' }}>Ticket penalty</th><th scope="col">Status</th></tr></thead>
                  <tbody>{preview.valid_rows.map(r => (
                    <tr key={r.row}>
                      <td>{r.row}</td><td>{r.date_issued}</td><td className="mono">{r.plate_number}</td><td>{r.violator_name}</td>
                      <td title={r.violation_names.join(', ')}>{r.violation_codes.join(', ')}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{fmtMoney(r.penalty_amount)}</td>
                      <td><StatusBadge status={r.status} /></td>
                    </tr>))}</tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {step === 'done' && result && (
        <div style={{ textAlign: 'center', padding: '28px 0' }} role="status">
          <CheckCircle2 size={36} color="var(--success-500)" aria-hidden="true" />
          <h3 style={{ margin: '10px 0 4px' }}>Import successful</h3>
          <p className="text-caption">{result.message}</p>
        </div>
      )}
    </Modal>
  )
}