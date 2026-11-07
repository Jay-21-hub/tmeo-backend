import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Eye, Send, ShieldCheck } from 'lucide-react'
import { useToast } from '../../../../context/useToast'
import { useBreakpoint } from '../../../../hooks/useBreakpoint'
import { formatDate } from '../../../../utils/helpers'
import Button from '../../../../components/ui/Button'
import { EmptyState, ErrorState, LoadingRows } from '../../../../components/ui/States'
import { TableWrap, TableEmptyRow } from '../../../../components/ui/Table'
import { Select, TextInput } from '../../../../components/ui/Field'
import { fetchCustodyList, fetchCustodySummary } from '../services/custodyApi'
import { parseCustodyError } from '../utils/custodyErrors'
import {
  DEFAULT_FILTERS, LEGACY_FILTER_OPTIONS, PAGE_SIZE, STATUS, buildListParams,
  getActionAvailability, hasActiveFilters, statusLabel, tabsForRole,
} from '../utils/custodyConfig'
import { CustodyStatusBadge, DocTypeBadge } from './CustodyBadges'
import { ReleaseModal, VerifyDocumentModal } from './CustodyActionModals'
import '../ConfiscatedLicenses.css'

const SEARCH_DEBOUNCE_MS = 350

const EMPTY_COPY = {
  [STATUS.IN_CUSTODY]: 'No licenses are currently in custody.',
  [STATUS.READY]: 'No licenses are ready for release.',
  [STATUS.RELEASED]: 'No licenses have been released yet.',
  all: 'There are no confiscated license records.',
}

/* ── Status tabs ─────────────────────────────────────────────────────── */
function StatusTabs({ tabs, active, counts, onChange, panelId }) {
  const refs = useRef([])
  const onKeyDown = (e, i) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const n = tabs.length
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n
    onChange(tabs[next].key)
    refs.current[next]?.focus()
  }
  return (
    <div className="cl-tabs" role="tablist" aria-label="Filter by custody status">
      {tabs.map((t, i) => {
        const selected = t.key === active
        const count = counts?.[t.countKey]
        return (
          <button
            key={t.key} ref={(el) => { refs.current[i] = el }} type="button"
            role="tab" id={`cl-tab-${t.key}`} aria-selected={selected} aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            className={`cl-tab ${selected ? 'is-active' : ''}`}
            onClick={() => onChange(t.key)} onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
            {typeof count === 'number' && <span className="cl-tab-count" aria-label={`${count} records`}>{count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/* ── Pagination (windowed, same visual pattern as the other list screens) ── */
function Pagination({ page, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const start = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const end = Math.min(page * PAGE_SIZE, total)
  const windowSize = Math.min(5, pages)
  const first = pages <= 5 ? 1 : Math.min(Math.max(page - 2, 1), pages - 4)
  const nums = Array.from({ length: windowSize }, (_, i) => first + i)
  return (
    <nav className="cl-pager" aria-label="Pagination">
      <span className="cl-pager-summary" aria-live="polite">
        Showing <strong>{start}–{end}</strong> of <strong>{total}</strong> records
      </span>
      <div className="pagination">
        <button type="button" className="page-btn" aria-label="First page" onClick={() => onPage(1)} disabled={page <= 1}><ChevronsLeft size={14} aria-hidden="true" /></button>
        <button type="button" className="page-btn" aria-label="Previous page" onClick={() => onPage(page - 1)} disabled={page <= 1}><ChevronLeft size={14} aria-hidden="true" /></button>
        {nums.map((n) => (
          <button key={n} type="button" className={`page-btn ${n === page ? 'is-active' : ''}`} aria-label={`Page ${n}`} aria-current={n === page ? 'page' : undefined} onClick={() => onPage(n)}>{n}</button>
        ))}
        <button type="button" className="page-btn" aria-label="Next page" onClick={() => onPage(page + 1)} disabled={page >= pages}><ChevronRight size={14} aria-hidden="true" /></button>
        <button type="button" className="page-btn" aria-label="Last page" onClick={() => onPage(pages)} disabled={page >= pages}><ChevronsRight size={14} aria-hidden="true" /></button>
      </div>
    </nav>
  )
}

/* ── Row actions (shared by the table and the mobile cards) ──────────────── */
function RowActions({ row, role, onOpen, onQuick }) {
  const a = getActionAvailability(row, role)
  return (
    <div className="cl-row-actions">
      {a.release.enabled && (
        <Button size="sm" icon={Send} onClick={() => onQuick('release', row)} aria-label={`Release license ${row.license_number}`}>Release</Button>
      )}
      {!a.release.enabled && a.verify.enabled && (
        <Button size="sm" variant="secondary" icon={ShieldCheck} onClick={() => onQuick('verify', row)} aria-label={`Verify legacy document for ${row.license_number}`}>Verify</Button>
      )}
      <Button size="sm" variant="secondary" icon={Eye} onClick={() => onOpen(row.key)} aria-label={`View license ${row.license_number}`}>View</Button>
    </div>
  )
}

function StatusCell({ row }) {
  return (
    <div className="cl-status-cell">
      <CustodyStatusBadge status={row.status} />
      <DocTypeBadge docTypeStatus={row.doc_type_status} />
    </div>
  )
}

const showDays = (row) => typeof row.days_held === 'number'

/**
 * Confiscated Licenses — list.
 * `filters` live in the parent so they survive opening a record and coming back.
 */
export default function CustodyList({ role, filters, onFiltersChange, onOpen }) {
  const toast = useToast()
  const { isMobile } = useBreakpoint()
  const isAdmin = role === 'admin'
  const tabs = useMemo(() => tabsForRole(role), [role])

  const [searchInput, setSearchInput] = useState(filters.search)
  const [reloadToken, setReloadToken] = useState(0)
  const [quick, setQuick] = useState(null) // { type: 'release' | 'verify', record }
  const [result, setResult] = useState({ key: null, list: null, summary: null, error: null })

  const listParams = useMemo(() => buildListParams(filters, role), [filters, role])
  // Tab counts must not be narrowed by the active tab, so the summary omits `status`.
  const summaryParams = useMemo(() => buildListParams(filters, role, { includeStatus: false, paged: false }), [filters, role])
  const reqKey = useMemo(() => JSON.stringify([listParams, summaryParams, reloadToken]), [listParams, summaryParams, reloadToken])

  useEffect(() => {
    const ctrl = new AbortController()
    let live = true
    Promise.allSettled([
      fetchCustodyList(listParams, ctrl.signal),
      fetchCustodySummary(summaryParams, ctrl.signal),
    ]).then(([l, s]) => {
      if (!live) return // superseded by a newer request
      if (l.status === 'fulfilled') {
        setResult({ key: reqKey, list: l.value.data, summary: s.status === 'fulfilled' ? s.value.data : null, error: null })
      } else {
        setResult({ key: reqKey, list: null, summary: null, error: parseCustodyError(l.reason) })
      }
    })
    return () => { live = false; ctrl.abort() }
  }, [reqKey, listParams, summaryParams])

  const loading = result.key !== reqKey
  const data = result.list
  const rows = data?.results || []
  const total = data?.count ?? 0

  // If the last row of the last page left this tab (e.g. it was just released),
  // step back to the last page that still exists.
  useEffect(() => {
    if (loading || !data) return
    const pages = Math.max(1, Math.ceil(data.count / PAGE_SIZE))
    if (filters.page > pages) onFiltersChange({ page: pages })
  }, [loading, data, filters.page, onFiltersChange])

  // Debounced search; Enter applies immediately (see onSubmit below).
  useEffect(() => {
    const next = searchInput.trim()
    if (next === filters.search) return undefined
    const t = setTimeout(() => onFiltersChange({ search: next, page: 1 }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput, filters.search, onFiltersChange])

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])
  const closeQuick = useCallback(() => setQuick(null), [])
  const openQuick = useCallback((type, record) => setQuick({ type, record }), [])

  const onQuickSuccess = useCallback((body) => {
    const decision = quick?.type
    setQuick(null)
    if (body?.replayed) toast.success('This action was already recorded. The list has been refreshed.')
    else if (decision === 'release') toast.success('License released.')
    else toast.success(body?.doc_type_status === 'excluded' ? 'Legacy record excluded from custody.' : "Legacy record confirmed as a driver's license.")
    reload()
  }, [quick, toast, reload])

  const onQuickStale = useCallback((err) => {
    setQuick(null)
    toast.warning(err.message)
    reload()
  }, [toast, reload])

  const clearFilters = () => {
    setSearchInput('')
    onFiltersChange({ ...DEFAULT_FILTERS, tab: filters.tab })
  }

  const dateRangeInvalid = !!(filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo)
  const panelId = 'cl-list-panel'
  const filtersActive = hasActiveFilters(filters)
  const cols = isAdmin ? 7 : 6

  return (
    <div className="cl-list">
      <StatusTabs
        tabs={tabs} active={filters.tab} counts={result.summary} panelId={panelId}
        onChange={(tab) => onFiltersChange({ tab, page: 1 })}
      />

      <form
        className="filter-bar cl-filters" role="search" aria-label="Search and filter confiscated licenses"
        onSubmit={(e) => { e.preventDefault(); onFiltersChange({ search: searchInput.trim(), page: 1 }) }}
      >
        <div className="search-input-wrap">
          <Search size={15} className="search-input-icon" aria-hidden="true" />
          <TextInput
            type="search" aria-label="Search by license number, name, or OVR number"
            placeholder="Search license no., name, or OVR no."
            value={searchInput} onChange={(e) => setSearchInput(e.target.value)} autoComplete="off"
          />
          {searchInput && (
            <button type="button" className="search-input-clear" aria-label="Clear search" onClick={() => setSearchInput('')}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <Select
          aria-label="Record type" className="cl-filter-control" value={filters.legacy}
          onChange={(e) => onFiltersChange({ legacy: e.target.value, page: 1 })}
        >
          {LEGACY_FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        <label className="cl-date">
          <span>Confiscated from</span>
          <TextInput type="date" value={filters.dateFrom} max={filters.dateTo || undefined} onChange={(e) => onFiltersChange({ dateFrom: e.target.value, page: 1 })} />
        </label>
        <label className="cl-date">
          <span>to</span>
          <TextInput type="date" value={filters.dateTo} min={filters.dateFrom || undefined} onChange={(e) => onFiltersChange({ dateTo: e.target.value, page: 1 })} />
        </label>
        {isAdmin && (
          <label className="cl-check">
            <input type="checkbox" checked={filters.includeExcluded} onChange={(e) => onFiltersChange({ includeExcluded: e.target.checked, page: 1 })} />
            <span>Include excluded records</span>
          </label>
        )}
        {filtersActive && (
          <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button>
        )}
        {dateRangeInvalid && (
          <p className="cl-filter-warning" role="alert">The “from” date is after the “to” date, so no records can match.</p>
        )}
      </form>

      <div id={panelId} role="tabpanel" aria-labelledby={`cl-tab-${filters.tab}`} aria-busy={loading} className="cl-panel">
        {result.error && !loading ? (
          <ErrorState title="Could not load confiscated licenses" message={result.error.message} onRetry={reload} />
        ) : !data ? (
          <div className="cl-skeleton"><LoadingRows rows={6} height={20} /></div>
        ) : isMobile ? (
          <div className={`cl-cards ${loading ? 'is-refreshing' : ''}`}>
            {rows.length === 0 && (
              <EmptyState
                title={filtersActive ? 'No matching records' : 'Nothing here'}
                message={filtersActive ? 'No records match your search or filters.' : EMPTY_COPY[filters.tab]}
                action={filtersActive ? <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
              />
            )}
            {rows.map((row) => (
              <article key={row.key} className="cl-card" aria-label={`License ${row.license_number}, ${statusLabel(row.status)}`}>
                <header className="cl-card-head">
                  <span className="mono cl-card-license">{row.license_number}</span>
                  <StatusCell row={row} />
                </header>
                <dl className="cl-card-meta">
                  <div><dt>Driver</dt><dd>{row.owner_name}</dd></div>
                  <div><dt>OVR no.</dt><dd>{row.ticket_number || '—'}</dd></div>
                  <div><dt>Confiscated</dt><dd>{formatDate(row.date_confiscated)}</dd></div>
                  {showDays(row) && <div><dt>Days held</dt><dd>{row.days_held}</dd></div>}
                </dl>
                <RowActions row={row} role={role} onOpen={onOpen} onQuick={openQuick} />
              </article>
            ))}
          </div>
        ) : (
          <div className={loading ? 'is-refreshing' : undefined}>
            <TableWrap className="cl-table-wrap">
              <caption className="sr-only">Confiscated driver&rsquo;s licenses</caption>
              <thead>
                <tr>
                  <th scope="col">License Number</th>
                  <th scope="col">Driver Name</th>
                  <th scope="col">OVR No.</th>
                  <th scope="col">Date Confiscated</th>
                  <th scope="col">Status</th>
                  {isAdmin && <th scope="col" title="Informational only — not an overdue indicator">Days Held</th>}
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <TableEmptyRow colSpan={cols} message={filtersActive ? 'No records match your search or filters.' : EMPTY_COPY[filters.tab]} />
                ) : rows.map((row) => (
                  <tr key={row.key}>
                    <td className="mono">{row.license_number}</td>
                    <td>{row.owner_name}</td>
                    <td>{row.ticket_number || '—'}</td>
                    <td>{formatDate(row.date_confiscated)}</td>
                    <td><StatusCell row={row} /></td>
                    {isAdmin && <td>{showDays(row) ? row.days_held : '—'}</td>}
                    <td><RowActions row={row} role={role} onOpen={onOpen} onQuick={openQuick} /></td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            {isAdmin && rows.length > 0 && (
              <p className="cl-footnote">Days held is shown for information only and does not indicate an overdue status.</p>
            )}
          </div>
        )}
        {data && !result.error && total > 0 && (
          <Pagination page={filters.page} total={total} onPage={(page) => onFiltersChange({ page })} />
        )}
      </div>

      {quick?.type === 'release' && (
        <ReleaseModal record={quick.record} onClose={closeQuick} onSuccess={onQuickSuccess} onStale={onQuickStale} />
      )}
      {quick?.type === 'verify' && (
        <VerifyDocumentModal record={quick.record} canExclude={isAdmin} onClose={closeQuick} onSuccess={onQuickSuccess} onStale={onQuickStale} />
      )}
    </div>
  )
}