import { useState, useEffect, useCallback } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import {
  List, AlertTriangle, Car, Banknote, Search, X, ChevronUp, ChevronDown,
  ChevronLeft, ChevronRight, Plus, Trash2, FileText,
} from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { useToast } from '../../../context/useToast'
import Modal from '../../../components/ui/Modal'
import Button from '../../../components/ui/Button'
import StatCard from '../../../components/ui/StatCard'
import Badge from '../../../components/ui/Badge'
import { Field, TextInput, Textarea } from '../../../components/ui/Field'
import { EmptyState } from '../../../components/ui/States'

/* ── CATEGORY CONFIG ───────────────────────────────────────── */
const CAT_CFG = {
  safety:  { label: 'Safety',  tone: 'danger' },
  traffic: { label: 'Traffic', tone: 'warning' },
  other:   { label: 'Others',  tone: 'neutral' },
}
const getCat = (c = '') => CAT_CFG[c?.toLowerCase()] || CAT_CFG.other

const fmt = (n) => n != null ? `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 })}` : '—'
const avg = (arr) => arr.length ? arr.reduce((s, v) => s + Number(v.penalty_amount || 0), 0) / arr.length : 0

/* ── DELETE CONFIRM ────────────────────────────────────────── */
const DeleteModal = ({ item, onConfirm, onCancel }) => (
  <Modal
    open={!!item} onClose={onCancel} width={380}
    footer={<>
      <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      <Button variant="danger" icon={Trash2} onClick={onConfirm}>Delete</Button>
    </>}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      <div style={{ width: 42, height: 42, borderRadius: 'var(--radius-md)', background: 'var(--danger-50)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Trash2 size={20} color="var(--danger-600)" />
      </div>
      <div>
        <div className="text-title" style={{ fontSize: 15 }}>Delete Violation Type</div>
        <div className="text-caption">This action cannot be undone</div>
      </div>
    </div>
    <p className="text-body">
      You are about to delete <strong style={{ color: 'var(--slate-950)' }}>{item?.violation_name || item?.name}</strong>
      {item?.code && <> (<span className="mono" style={{ color: 'var(--blue-600)' }}>{item.code}</span>)</>}.
      Any violations linked to this type may be affected.
    </p>
  </Modal>
)

/* ── ADD / EDIT MODAL ──────────────────────────────────────── */
const ViolationTypeModal = ({ item, onClose, onSave }) => {
  const isEdit = !!item?.id
  const [form, setForm] = useState({
    code: item?.code || '',
    violation_name: item?.violation_name || item?.name || '',
    description: item?.description || '',
    category: item?.category || 'traffic',
    penalty_amount: item?.penalty_amount || '',
  })
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setErrors(e => ({ ...e, [k]: '' })) }

  const validate = () => {
    const e = {}
    if (!form.code.trim()) e.code = 'Code is required'
    if (!form.violation_name.trim()) e.violation_name = 'Violation name is required'
    if (!form.penalty_amount || isNaN(Number(form.penalty_amount))) e.penalty_amount = 'Valid penalty amount is required'
    return e
  }

  const handleReview = () => {
    const e = validate()
    if (Object.keys(e).length) { setErrors(e); return }
    setShowConfirm(true)
  }

  const handleSave = async () => {
    setShowConfirm(false)
    setSaving(true)
    try {
      // Backend model/serializer field is `name`, not `violation_name` — the
      // modal's internal form state keeps `violation_name` (used throughout
      // this component for validation/display), only the outgoing payload
      // is remapped to match the actual API contract.
      const payload = {
        code: form.code,
        name: form.violation_name,
        description: form.description,
        category: form.category,
        penalty_amount: form.penalty_amount,
      }
      if (isEdit) await api.patch(`${API.VIOLATION_TYPES}${item.id}/`, payload)
      else await api.post(API.VIOLATION_TYPES, payload)
      onSave(isEdit ? 'Violation type updated.' : 'Violation type added.')
    } catch { onSave(null) } finally { setSaving(false) }
  }

  return (
    <>
      <Modal
        open onClose={onClose} width={480}
        title={isEdit ? 'Edit Violation Type' : 'Add Violation Type'}
        footer={<>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleReview} loading={saving}>
            {saving ? 'Saving…' : 'Review & Save'}
          </Button>
        </>}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Violation Code" required error={errors.code}>
            {id => <TextInput id={id} value={form.code} onChange={e => set('code', e.target.value)} placeholder="e.g. VT-001" error={!!errors.code} />}
          </Field>
          <Field label="Penalty Amount (₱)" required error={errors.penalty_amount}>
            {id => <TextInput id={id} type="number" value={form.penalty_amount} onChange={e => set('penalty_amount', e.target.value)} placeholder="e.g. 500" error={!!errors.penalty_amount} />}
          </Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <Field label="Violation Name" required error={errors.violation_name}>
            {id => <TextInput id={id} value={form.violation_name} onChange={e => set('violation_name', e.target.value)} placeholder="e.g. Illegal Parking" error={!!errors.violation_name} />}
          </Field>
        </div>

        <div style={{ marginTop: 12 }}>
          <label className="field-label" style={{ marginBottom: 5, display: 'block' }}>Category</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {Object.entries(CAT_CFG).map(([k, cfg]) => {
              const active = form.category === k
              return (
                <button
                  key={k} type="button" onClick={() => set('category', k)}
                  className="btn"
                  style={{
                    flex: 1, padding: '8px 4px', fontSize: 12, fontWeight: 600,
                    border: active ? `2px solid var(--${cfg.tone === 'neutral' ? 'slate-500' : cfg.tone + '-600'})` : '2px solid var(--color-border)',
                    background: active ? `var(--${cfg.tone === 'neutral' ? 'slate-100' : cfg.tone + '-50'})` : 'var(--slate-50)',
                    color: active ? `var(--${cfg.tone === 'neutral' ? 'slate-700' : cfg.tone + '-700'})` : 'var(--slate-500)',
                  }}
                >{cfg.label}</button>
              )
            })}
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <Field label="Description" helper="Brief description of this violation type…">
            {id => <Textarea id={id} rows={3} value={form.description} onChange={e => set('description', e.target.value)} placeholder="Brief description of this violation type…" />}
          </Field>
        </div>
      </Modal>

      {/* Confirmation step */}
      {showConfirm && (
        <Modal
          open onClose={() => setShowConfirm(false)} width={420}
          title={isEdit ? 'Confirm Update' : 'Confirm New Violation Type'}
          footer={<>
            <Button variant="secondary" onClick={() => setShowConfirm(false)}>Cancel</Button>
            <Button onClick={handleSave} loading={saving}>{isEdit ? 'Confirm Update' : 'Confirm & Add'}</Button>
          </>}
        >
          <div style={{ display: 'grid', gap: 10 }}>
            {[
              ['Code', form.code],
              ['Violation Name', form.violation_name],
              ['Category', CAT_CFG[form.category]?.label || form.category],
              ['Penalty Amount', `₱${Number(form.penalty_amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`],
              ['Description', form.description || '—'],
            ].map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
                <span className="text-caption" style={{ fontWeight: 500 }}>{label}</span>
                <span style={{ fontSize: 13, color: 'var(--slate-950)', fontWeight: 600, maxWidth: 240, textAlign: 'right' }}>{value}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  )
}

/* ── VIEW (READ-ONLY) MODAL ────────────────────────────────── */
const ViolationTypeViewModal = ({ item, onClose }) => {
  if (!item) return null
  const cat = getCat(item.category)
  const name = item.violation_name || item.name || '—'
  // Same label/value row pattern as the Add-flow's own "Confirm New
  // Violation Type" step above — reusing it here instead of introducing a
  // new layout, since this modal exists purely to display, never edit.
  const rows = [
    ['Violation Code', item.code || '—'],
    ['Violation Name', name],
    ['Category', cat.label],
    ['Penalty Amount', fmt(item.penalty_amount)],
    ['Description', item.description || '—'],
  ]
  return (
    <Modal
      open onClose={onClose} width={480}
      title="Violation Type Details"
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '10px 14px', background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
            <span className="text-caption" style={{ fontWeight: 500, flexShrink: 0 }}>{label}</span>
            <span style={{ fontSize: 13, color: 'var(--slate-950)', fontWeight: 600, maxWidth: 260, textAlign: 'right' }}>{value}</span>
          </div>
        ))}
      </div>
    </Modal>
  )
}

/* ── module-level sortable header (must not be redefined per render) ── */
const SortTH = ({ label, colKey, sortable, align, sortKey, sortDir, onSort }) => (
  <th
    className={sortable ? 'is-sortable' : ''}
    onClick={sortable ? () => onSort(colKey) : undefined}
    style={{ textAlign: align || 'left' }}
  >
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {label}
      {sortable && (sortKey === colKey
        ? (sortDir === 'asc' ? <ChevronUp size={11} color="var(--blue-600)" /> : <ChevronDown size={11} color="var(--blue-600)" />)
        : <span style={{ display: 'inline-block', width: 11 }} />)}
    </span>
  </th>
)

/* ══════════════════════════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════════════════════════ */
export default function ManageViolationTypes() {
  const toast = useToast()
  const [types, setTypes]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [search, setSearch]       = useState('')
  const [catFilter, setCat]       = useState('all')
  const [sortKey, setSortKey]     = useState('violation_name')
  const [sortDir, setSortDir]     = useState('asc')
  const [page, setPage]           = useState(1)
  const [perPage, setPerPage]     = useState(10)
  const [modal, setModal]         = useState(null)   // null | 'add' — creation only, see ViolationTypeViewModal for viewing existing rows
  const [viewItem, setViewItem]   = useState(null)   // existing row selected for the read-only details view
  const [delItem, setDelItem]     = useState(null)

  /* ── fetch ── */
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get(API.VIOLATION_TYPES)
      setTypes(res.data?.results ?? res.data ?? [])
    } catch { setTypes([]) } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern, matches existing codebase convention
    load()
  }, [load])

  /* ── stats ── */
  const stats = {
    total:   types.length,
    safety:  types.filter(t => t.category?.toLowerCase() === 'safety').length,
    traffic: types.filter(t => t.category?.toLowerCase() === 'traffic').length,
    avgPenalty: avg(types),
  }

  /* ── filter + sort ── */
  const filtered = types
    .filter(t => {
      const q = search.toLowerCase()
      const matchQ = !q ||
        (t.code || '').toLowerCase().includes(q) ||
        (t.violation_name || t.name || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q)
      const matchC = catFilter === 'all' || (t.category || '').toLowerCase() === catFilter
      return matchQ && matchC
    })
    .sort((a, b) => {
      let va = '', vb = ''
      if (sortKey === 'penalty_amount') {
        va = Number(a.penalty_amount || 0); vb = Number(b.penalty_amount || 0)
        return sortDir === 'asc' ? va - vb : vb - va
      }
      va = (a[sortKey] || a.name || '').toString().toLowerCase()
      vb = (b[sortKey] || b.name || '').toString().toLowerCase()
      return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
    })

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage))
  const paged = filtered.slice((page - 1) * perPage, page * perPage)

  const doSort = (k) => { if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(k); setSortDir('asc') } }

  const clearFilters = () => { setSearch(''); setCat('all'); setPage(1) }
  const hasFilters = search || catFilter !== 'all'

  /* ── delete ── */
  const handleDelete = async () => {
    try {
      await api.delete(`${API.VIOLATION_TYPES}${delItem.id}/`)
      toast.success('Violation type deleted.')
      load()
    } catch { toast.danger('Delete failed. Please try again.') }
    setDelItem(null)
  }

  const handleSave = (msg) => {
    setModal(null)
    if (msg) { toast.success(msg); load() }
    else toast.danger('Failed to save. Please try again.')
  }

  const CARDS = [
    { label: 'Total Types', value: stats.total, icon: List, accent: 'var(--blue-600)' },
    { label: 'Safety Violations', value: stats.safety, icon: AlertTriangle, accent: 'var(--danger-600)' },
    { label: 'Traffic Violations', value: stats.traffic, icon: Car, accent: 'var(--warning-600)' },
    { label: 'Average Penalty', value: `₱${avg(types).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`, icon: Banknote, accent: 'var(--success-600)' },
  ]

  const COLS = [
    { label: 'Code', key: 'code', sortable: true },
    { label: 'Violation Name', key: 'violation_name', sortable: true },
    { label: 'Description', key: 'description', sortable: false },
    { label: 'Category', key: 'category', sortable: true },
    { label: 'Penalty (₱)', key: 'penalty_amount', sortable: true, align: 'right' },
    { label: '', key: 'actions', sortable: false },
  ]

  const pageButtons = Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
    let p = i + 1
    if (totalPages > 5) {
      if (page <= 3) p = i + 1
      else if (page >= totalPages - 2) p = totalPages - 4 + i
      else p = page - 2 + i
    }
    return p
  })

  return (
    <div>
      {/* ── PAGE HEADER ── */}
      <PageHeader
        title="Violation Types"
        action={(
          <>
          <Button icon={Plus} onClick={() => setModal('add')}>Add Violation Type</Button>
      
          </>
        )}
      />

      {/* ── STAT CARDS ── */}
      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        {CARDS.map(c => <StatCard key={c.label} {...c} loading={loading} />)}
      </div>

      {/* ── MAIN CARD ── */}
      <div className="card">

        {/* Filter Bar */}
        <div className="filter-bar" style={{ borderRadius: 0, borderLeft: 'none', borderRight: 'none', borderTop: 'none' }}>
          <div className="search-input-wrap">
            <Search size={14} className="search-input-icon" />
            <input
              className="input" value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
              placeholder="Search by name, code, or description…"
            />
            {search && (
              <button className="search-input-clear" onClick={() => { setSearch(''); setPage(1) }} aria-label="Clear search">
                <X size={12} />
              </button>
            )}
          </div>

          <select className="filter-select" value={catFilter} onChange={e => { setCat(e.target.value); setPage(1) }}>
            <option value="all">All Categories</option>
            <option value="safety">Safety</option>
            <option value="traffic">Traffic</option>
            <option value="other">Others</option>
          </select>

          {hasFilters && <Button variant="danger-ghost" size="sm" icon={X} onClick={clearFilters}>Clear</Button>}

          <span className="text-caption" style={{ marginLeft: 'auto' }}>
            {filtered.length} type{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Table */}
        <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
          <table className="table">
            <thead>
              <tr>
                {COLS.map(col => (
                  <SortTH key={col.key} label={col.label} colKey={col.key} sortable={col.sortable} align={col.align} sortKey={sortKey} sortDir={sortDir} onSort={doSort} />
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {[70, 140, 200, 90, 90, 70].map((w, j) => (
                      <td key={j}><div className="skeleton" style={{ height: 13, width: w }} /></td>
                    ))}
                  </tr>
                ))
              ) : paged.length === 0 ? (
                <tr>
                  <td colSpan={COLS.length} style={{ padding: 0 }}>
                    <EmptyState
                      icon={FileText}
                      title={hasFilters ? 'No violation types match your filters' : 'No violation types yet'}
                      message={hasFilters ? 'Try adjusting your search or category filter' : 'Add your first violation type to get started'}
                      action={!hasFilters && <Button size="sm" icon={Plus} onClick={() => setModal('add')}>Add Violation Type</Button>}
                    />
                  </td>
                </tr>
              ) : paged.map(t => {
                const cat = getCat(t.category)
                const name = t.violation_name || t.name || '—'
                return (
                  <tr key={t.id} onClick={() => setViewItem(t)} style={{ cursor: 'pointer' }}>
                    <td><span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--blue-700)', background: 'var(--blue-50)', padding: '3px 9px', borderRadius: 'var(--radius-sm)' }}>{t.code || '—'}</span></td>
                    <td style={{ fontWeight: 600, color: 'var(--slate-950)' }}>{name}</td>
                    <td style={{ maxWidth: 260 }}><span className="u-truncate" style={{ display: 'block', color: 'var(--slate-600)', fontSize: 12 }}>{t.description || '—'}</span></td>
                    <td><Badge tone={cat.tone} dot={false}>{cat.label}</Badge></td>
                    <td style={{ textAlign: 'right' }}><span className="mono" style={{ fontWeight: 700, color: 'var(--slate-950)' }}>{fmt(t.penalty_amount)}</span></td>
                    <td>
                      <div className="row-actions">
                        <button className="row-action-btn" style={{ background: 'var(--danger-50)' }} title="Delete" aria-label={`Delete ${name}`} onClick={ev => { ev.stopPropagation(); setDelItem(t) }}>
                          <Trash2 size={13} color="var(--danger-600)" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!loading && filtered.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--slate-100)', background: 'var(--slate-50)', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="text-caption">Rows per page</span>
                <select className="filter-select" style={{ padding: '5px 8px' }} value={perPage} onChange={e => { setPerPage(Number(e.target.value)); setPage(1) }}>
                  {[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <span className="text-caption">
                {Math.min((page - 1) * perPage + 1, filtered.length)}–{Math.min(page * perPage, filtered.length)} of {filtered.length}
              </span>
            </div>
            <div className="pagination">
              <button className="page-btn" disabled={page === 1} onClick={() => setPage(p => p - 1)} aria-label="Previous page">
                <ChevronLeft size={14} />
              </button>
              {pageButtons.map(p => (
                <button key={p} className={`page-btn ${page === p ? 'is-active' : ''}`} onClick={() => setPage(p)} aria-current={page === p ? 'page' : undefined}>{p}</button>
              ))}
              <button className="page-btn" disabled={page === totalPages} onClick={() => setPage(p => p + 1)} aria-label="Next page">
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Overlays */}
      {modal === 'add' && <ViolationTypeModal item={null} onClose={() => setModal(null)} onSave={handleSave} />}
      <ViolationTypeViewModal item={viewItem} onClose={() => setViewItem(null)} />
      <DeleteModal item={delItem} onConfirm={handleDelete} onCancel={() => setDelItem(null)} />
    </div>
  )
}