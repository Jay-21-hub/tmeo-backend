import { AlertTriangle, ChevronLeft, ChevronRight, Download, FileBarChart, FileText, RefreshCw } from 'lucide-react'
import { EmptyState, ErrorState } from '../../../../components/ui/States'
import { StatusBadge } from '../../../../components/ui/Badge'
import Alert from '../../../../components/ui/Alert'
import {
  REPORT_TYPES, SUMMARY_DEFS, UNAVAILABLE, appliedFilterPairs, cellText, fmtDateTime, pageWindow, summaryText,
} from './reportsConfig'

function Cell({ col, row }) {
  const text = cellText(col, row)
  const style = col.align === 'right' ? { textAlign: 'right' } : undefined
  if (col.type === 'status') return <td><StatusBadge status={row[col.key]} label={row.status_label} /></td>
  if (col.type === 'money_coverage') {
    const v = row[col.key]
    if (v == null) return <td style={style} className="mono"><span title="No item-level penalty on record for imported items" style={{ color: 'var(--slate-500)', fontStyle: 'italic' }}>{UNAVAILABLE}</span></td>
    return <td style={style} className="mono" title={row.fines_coverage === 'partial' ? `Partial: ${row.fines_unknown_items} imported item(s) without an item-level penalty are excluded.` : undefined}>{text}</td>
  }
  if (col.type === 'money') return <td style={style} className="mono">{text}</td>
  return <td style={style} className={col.type === 'int' || col.type === 'percent' ? 'mono' : undefined}>{text}</td>
}

/**
 * phase: 'initial' | 'loading' | 'error' | 'data' | 'zero'
 * 'zero' = the request succeeded and matched nothing (a real empty result),
 * 'error' = the request failed — these are never conflated.
 */
export default function ReportResultsPanel({
  phase, reportId, payload, stale, errorMessage, page, rowsPerPage,
  onSetPage, onSetRowsPerPage, onRetry, onExportPdf,
}) {
  const report = REPORT_TYPES.find(r => r.id === reportId)

  if (phase === 'initial') {
    return <EmptyState icon={FileBarChart} title="No report generated yet"
      message={report ? `Choose your filters, then press “Generate report” for ${report.title}.` : 'Select a report type, set your filters, then press “Generate report”.'} />
  }
  if (phase === 'loading') {
    return (
      <div className="card" role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only" style={{ position: 'absolute', left: -9999 }}>Generating report…</span>
        <div style={{ padding: 20 }}>
          {[...Array(6)].map((_, i) => (
            <div key={i} style={{ display: 'flex', gap: 16, padding: '14px 0' }}>
              <div className="skeleton" style={{ height: 14, flex: 1 }} /><div className="skeleton" style={{ height: 14, flex: 1 }} /><div className="skeleton" style={{ height: 14, width: 80 }} />
            </div>
          ))}
        </div>
      </div>
    )
  }
  if (phase === 'error') {
    return <div className="card"><ErrorState title="Couldn’t generate the report" message={errorMessage || 'Please try again.'} onRetry={onRetry} /></div>
  }
  if (!payload) return null

  const { meta, summary, rows } = payload
  const Icon = report?.icon || FileText
  const defs = SUMMARY_DEFS[meta.report] || []
  const pairs = appliedFilterPairs(meta.filters_applied)
  const totalRows = rows.length
  const totalPages = Math.max(1, Math.ceil(totalRows / rowsPerPage))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * rowsPerPage
  const visible = rows.slice(start, start + rowsPerPage)
  const partial = summary?.fines_coverage === 'partial'

  return (
    <section className="card" aria-label={`${meta.title} results`}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--slate-100)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ padding: 8, borderRadius: 'var(--radius-md)', background: report?.iconBg, display: 'flex' }}><Icon size={16} color={report?.accent} aria-hidden="true" /></div>
          <div>
            <h2 className="text-title" style={{ fontSize: 14 }}>{meta.title}</h2>
            <p className="text-caption">{pairs.length ? pairs.map(([k, v]) => `${k}: ${v}`).join(' · ') : 'All records'}</p>
            <p className="text-caption">Generated {fmtDateTime(meta.generated_at)} by {meta.generated_by || '—'}</p>
          </div>
          <span className="badge badge-info" style={{ padding: '3px 10px' }}>{totalRows} {totalRows === 1 ? 'record' : 'records'}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}><RefreshCw size={13} aria-hidden="true" /> Refresh</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onExportPdf} disabled={phase === 'zero' || stale}><Download size={13} aria-hidden="true" /> Export PDF</button>
        </div>
      </div>

      {stale && (
        <div style={{ padding: '10px 20px' }}>
          <Alert tone="warning" title="Filters changed">These results no longer match the selected filters. Press “Generate report” to update.</Alert>
        </div>
      )}

      {defs.length > 0 && (
        <dl style={{ margin: 0, padding: '12px 20px', background: 'var(--slate-50)', borderBottom: '1px solid var(--slate-100)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {defs.map((d) => (
            <div key={d[1]} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'var(--white)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
              <dt className="text-caption">{d[0]}:</dt>
              <dd style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{summaryText(d, summary)}</dd>
            </div>
          ))}
        </dl>
      )}

      {meta.report === 'outstanding' && summary.aging?.length > 0 && (
        <div style={{ padding: '10px 20px', display: 'flex', gap: 10, flexWrap: 'wrap', borderBottom: '1px solid var(--slate-100)' }}>
          {summary.aging.map(a => (
            <span key={a.key} className="badge badge-neutral" style={{ padding: '4px 10px' }}>{a.label}: {a.tickets} · {summaryText(['', 'a', 'money'], { a: a.amount })}</span>
          ))}
        </div>
      )}

      {phase === 'zero' ? (
        <EmptyState icon={FileText} title="No records found" message="The report ran successfully, but nothing matches the selected filters." />
      ) : (
        <>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table className="table">
              <caption className="sr-only" style={{ position: 'absolute', left: -9999 }}>{meta.title}</caption>
              <thead><tr>{meta.columns.map(c => <th key={c.key} scope="col" style={c.align === 'right' ? { textAlign: 'right' } : undefined}>{c.label}</th>)}</tr></thead>
              <tbody>{visible.map((row, i) => <tr key={start + i}>{meta.columns.map(c => <Cell key={c.key} col={c} row={row} />)}</tr>)}</tbody>
            </table>
          </div>

          <nav aria-label="Report pagination" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--slate-100)', background: 'var(--slate-50)', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label className="text-caption" htmlFor="rpt-rows">Rows per page:</label>
              <select id="rpt-rows" className="filter-select" style={{ padding: '5px 8px' }} value={rowsPerPage} onChange={e => onSetRowsPerPage(Number(e.target.value))}>
                {[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="text-caption" aria-live="polite">{start + 1}–{Math.min(start + rowsPerPage, totalRows)} of {totalRows}</span>
            </div>
            <div className="pagination">
              <button type="button" className="page-btn" aria-label="Previous page" disabled={safePage === 1} onClick={() => onSetPage(safePage - 1)}><ChevronLeft size={14} aria-hidden="true" /></button>
              {pageWindow(safePage, totalPages).map((p, i) => p === '…'
                ? <span key={`e${i}`} aria-hidden="true" style={{ padding: '0 4px', color: 'var(--slate-400)' }}>…</span>
                : <button key={p} type="button" className={`page-btn ${safePage === p ? 'is-active' : ''}`} aria-label={`Page ${p}`} aria-current={safePage === p ? 'page' : undefined} onClick={() => onSetPage(p)}>{p}</button>)}
              <button type="button" className="page-btn" aria-label="Next page" disabled={safePage === totalPages} onClick={() => onSetPage(safePage + 1)}><ChevronRight size={14} aria-hidden="true" /></button>
            </div>
          </nav>
        </>
      )}

      {(meta.notes?.length > 0 || partial) && (
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--slate-100)' }}>
          {partial && <p className="text-caption" style={{ display: 'flex', gap: 6, marginBottom: 6 }}><AlertTriangle size={13} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />* Partial total — some imported items have no item-level penalty and are excluded.</p>}
          {meta.notes.map((n, i) => <p key={i} className="text-caption" style={{ marginBottom: 4 }}>{n}</p>)}
          <p className="text-caption" style={{ marginTop: 4 }}>Scope: {meta.scope}</p>
        </div>
      )}
    </section>
  )
}