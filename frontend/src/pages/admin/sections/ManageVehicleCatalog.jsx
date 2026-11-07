import { useState, useEffect, useCallback } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import {
  Car, Bike, Bus, Truck, Siren, Search, X, ChevronUp, ChevronDown,
  ChevronLeft, ChevronRight, Plus, Edit2, Trash2, List, Layers, CheckCircle2,
} from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { useToast } from '../../../context/useToast'
import Modal from '../../../components/ui/Modal'
import Button from '../../../components/ui/Button'
import StatCard from '../../../components/ui/StatCard'
import Badge from '../../../components/ui/Badge'
import { Field, TextInput } from '../../../components/ui/Field'
import { EmptyState } from '../../../components/ui/States'

/* ── CATEGORY CONFIG — same categories VehicleBrandModel.Category defines on the backend ── */
const CATEGORIES = [
  { value: 'motorcycle', label: 'Motorcycles',              icon: Bike,  tone: 'warning' },
  { value: 'car',        label: 'Cars',                     icon: Car,   tone: 'info' },
  { value: 'puv',        label: 'Public Utility Vehicles',  icon: Bus,   tone: 'success' },
  { value: 'truck',      label: 'Trucks & Heavy Vehicles',  icon: Truck, tone: 'danger' },
  { value: 'special',    label: 'Special / Other',          icon: Siren, tone: 'neutral' },
]
const getCat = (v) => CATEGORIES.find(c => c.value === v) || CATEGORIES[1]

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
        <div className="text-title" style={{ fontSize: 15 }}>Delete Vehicle</div>
        <div className="text-caption">This action cannot be undone</div>
      </div>
    </div>
    <p className="text-body">
      You are about to delete <strong style={{ color: 'var(--slate-950)' }}>{item?.brand} {item?.model}</strong> from the catalog.
      Existing reports that already used it keep their saved text — this only removes it from future pickers.
    </p>
  </Modal>
)

/* ── ADD / EDIT VEHICLE MODAL ─────────────────────────────────
   One form: pick a Category, then Brand + Model. Category is a
   direct field on the brand/model row now — there is no separate
   "Vehicle Type" layer to keep in sync with it anymore. ── */
const VehicleModal = ({ item, existingBrands, onClose, onSave }) => {
  const isEdit = !!item?.id

  const [category, setCategory] = useState(item?.category || 'car')
  const [brand, setBrand] = useState(item?.brand || '')
  const [model, setModel] = useState(item?.model || '')
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const set = (setter) => (v) => { setter(v); setErrors(e => ({ ...e, _all: '' })) }

  const validate = () => {
    const e = {}
    if (!brand.trim()) e.brand = 'Brand is required'
    if (!model.trim()) e.model = 'Model is required'
    return e
  }

  const handleSave = async () => {
    const e = validate()
    if (Object.keys(e).length) { setErrors(e); return }
    setSaving(true)
    try {
      const payload = { brand: brand.trim(), model: model.trim(), category }
      if (isEdit) await api.patch(`${API.VEHICLE_BRANDS}${item.id}/`, payload)
      else await api.post(API.VEHICLE_BRANDS, payload)
      onSave(isEdit ? 'Vehicle updated.' : 'Vehicle added.')
    } catch (err) {
      const msg = err?.response?.data?.non_field_errors?.[0]
        || err?.response?.data?.brand?.[0]
        || 'That vehicle already exists, or something went wrong.'
      onSave(null, msg)
    } finally { setSaving(false) }
  }

  return (
    <Modal
      open onClose={onClose} width={460}
      title={isEdit ? 'Edit Vehicle' : 'Add Vehicle'}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} loading={saving}>{saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Vehicle'}</Button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label className="field-label" style={{ marginBottom: 6, display: 'block' }}>Vehicle Category</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {CATEGORIES.map(c => {
              const active = category === c.value
              const Icon = c.icon
              return (
                <button
                  key={c.value} type="button" onClick={() => set(setCategory)(c.value)}
                  className="btn"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', fontSize: 12, fontWeight: 600,
                    border: active ? `2px solid var(--${c.tone === 'neutral' ? 'slate-500' : c.tone + '-600'})` : '2px solid var(--color-border)',
                    background: active ? `var(--${c.tone === 'neutral' ? 'slate-100' : c.tone + '-50'})` : 'var(--slate-50)',
                    color: active ? `var(--${c.tone === 'neutral' ? 'slate-700' : c.tone + '-700'})` : 'var(--slate-500)',
                    justifyContent: 'flex-start', textAlign: 'left',
                  }}
                >
                  <Icon size={14} /> {c.label}
                </button>
              )
            })}
          </div>
        </div>

        <Field label="Brand" required error={errors.brand} helper="e.g. Honda, Toyota — reuse an existing brand name for consistency">
          {id => (
            <>
              <TextInput id={id} list="brand-suggestions" value={brand} onChange={e => set(setBrand)(e.target.value)} placeholder="e.g. Toyota" error={!!errors.brand} />
              <datalist id="brand-suggestions">
                {existingBrands.map(b => <option key={b} value={b} />)}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Model" required error={errors.model} helper="e.g. Vios, Click 125i">
          {id => <TextInput id={id} value={model} onChange={e => set(setModel)(e.target.value)} placeholder="e.g. Vios" error={!!errors.model} />}
        </Field>
      </div>
    </Modal>
  )
}

/* ── module-level sortable header ── */
const SortTH = ({ label, colKey, sortable, sortKey, sortDir, onSort }) => (
  <th className={sortable ? 'is-sortable' : ''} onClick={sortable ? () => onSort(colKey) : undefined}>
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
export default function ManageVehicleCatalog() {
  const toast = useToast()
  const [vehicles, setVehicles] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('all')
  const [brandFilter, setBrandFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sortKey, setSortKey] = useState('brand')
  const [sortDir, setSortDir] = useState('asc')
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(10)
  const [modal, setModal] = useState(null)
  const [delItem, setDelItem] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get(API.VEHICLE_BRANDS)
      const raw = res.data?.results ?? res.data ?? []
      setVehicles(raw.map(v => ({
        id: v.id,
        brand: v.brand,
        model: v.model,
        category: v.category ?? null,
        categoryLabel: v.category_label ?? null,
        isActive: v.is_active ?? true,
      })))
    } catch { setVehicles([]) } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern, matches existing codebase convention
    load()
  }, [load])

  const uniqueBrands = Array.from(new Set(vehicles.map(v => v.brand))).sort()
  const usedCategories = new Set(vehicles.map(v => v.category).filter(Boolean))
  const stats = {
    total: vehicles.length,
    categories: usedCategories.size,
    brands: uniqueBrands.length,
    active: vehicles.filter(v => v.isActive !== false).length,
  }
  const categoryCounts = CATEGORIES.map(c => ({
    ...c,
    count: vehicles.filter(v => v.category === c.value).length,
  }))

  const filtered = vehicles
    .filter(v => {
      const q = search.toLowerCase()
      const matchQ = !q
        || v.brand.toLowerCase().includes(q)
        || v.model.toLowerCase().includes(q)
        || (v.categoryLabel || '').toLowerCase().includes(q)
      const matchC = catFilter === 'all' || v.category === catFilter
      const matchB = brandFilter === 'all' || v.brand === brandFilter
      const matchS = statusFilter === 'all' || (statusFilter === 'active' ? v.isActive !== false : v.isActive === false)
      return matchQ && matchC && matchB && matchS
    })
    .sort((a, b) => {
      const va = (a[sortKey] || '').toString().toLowerCase()
      const vb = (b[sortKey] || '').toString().toLowerCase()
      return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
    })

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage))
  const paged = filtered.slice((page - 1) * perPage, page * perPage)

  const doSort = (k) => { if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(k); setSortDir('asc') } }
  const clearFilters = () => { setSearch(''); setCatFilter('all'); setBrandFilter('all'); setStatusFilter('all'); setPage(1) }
  const hasFilters = search || catFilter !== 'all' || brandFilter !== 'all' || statusFilter !== 'all'

  const handleDelete = async () => {
    try {
      await api.delete(`${API.VEHICLE_BRANDS}${delItem.id}/`)
      toast.success('Deleted.')
      load()
    } catch { toast.danger('Delete failed. Please try again.') }
    setDelItem(null)
  }

  const handleSave = (msg, errMsg) => {
    setModal(null)
    if (msg) { toast.success(msg); load() }
    else toast.danger(errMsg || 'Failed to save. Please try again.')
  }

  const CARDS = [
    { label: 'Total Vehicles', value: stats.total, icon: List, accent: 'var(--blue-600)', sublabel: 'In the catalog' },
    { label: 'Categories Used', value: stats.categories, icon: Layers, accent: 'var(--warning-600)', sublabel: 'Vehicle categories' },
    { label: 'Unique Brands',  value: stats.brands, icon: Car, accent: 'var(--success-600)', sublabel: 'Registered brands' },
    { label: 'Active', value: stats.active, icon: CheckCircle2, accent: 'var(--blue-600)', sublabel: 'Available for use' },
  ]

  const COLS = [
    { label: 'Vehicle', key: 'model', sortable: true },
    { label: 'Brand', key: 'brand', sortable: true },
    { label: 'Category', key: 'category', sortable: true },
    { label: 'Status', key: 'isActive', sortable: false },
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
      <PageHeader
        title="Vehicle Catalog"
        action={(
          <>
          <Button icon={Plus} onClick={() => setModal('add')}>Add Vehicle</Button>
      
          </>
        )}
      />

      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        {CARDS.map(c => <StatCard key={c.label} {...c} loading={loading} />)}
      </div>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div className="card" style={{ flex: '1 1 640px', minWidth: 0 }}>
        <div className="filter-bar" style={{ borderRadius: 0, borderLeft: 'none', borderRight: 'none', borderTop: 'none' }}>
          <div className="search-input-wrap">
            <Search size={14} className="search-input-icon" />
            <input className="input" value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder="Search by brand, model, or vehicle type…" />
            {search && (
              <button className="search-input-clear" onClick={() => { setSearch(''); setPage(1) }} aria-label="Clear search">
                <X size={12} />
              </button>
            )}
          </div>

          <select className="filter-select" value={catFilter} onChange={e => { setCatFilter(e.target.value); setPage(1) }}>
            <option value="all">All Categories</option>
            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>

          <select className="filter-select" value={brandFilter} onChange={e => { setBrandFilter(e.target.value); setPage(1) }}>
            <option value="all">All Brands</option>
            {uniqueBrands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>

          <select className="filter-select" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1) }}>
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>

          {hasFilters && <Button variant="danger-ghost" size="sm" icon={X} onClick={clearFilters}>Clear</Button>}

          <span className="text-caption" style={{ marginLeft: 'auto' }}>{filtered.length} vehicle{filtered.length !== 1 ? 's' : ''}</span>
        </div>

        <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
          <table className="table">
            <thead>
              <tr>
                {COLS.map(col => <SortTH key={col.key} label={col.label} colKey={col.key} sortable={col.sortable} sortKey={sortKey} sortDir={sortDir} onSort={doSort} />)}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {[110, 100, 90, 60, 70].map((w, j) => (
                      <td key={j}><div className="skeleton" style={{ height: 13, width: w }} /></td>
                    ))}
                  </tr>
                ))
              ) : paged.length === 0 ? (
                <tr>
                  <td colSpan={COLS.length} style={{ padding: 0 }}>
                    <EmptyState
                      icon={Car}
                      title={hasFilters ? 'No vehicles match your filters' : 'No vehicles yet'}
                      message={hasFilters ? 'Try adjusting your search or category filter' : 'Add your first vehicle to get started'}
                      action={!hasFilters && <Button size="sm" icon={Plus} onClick={() => setModal('add')}>Add Vehicle</Button>}
                    />
                  </td>
                </tr>
              ) : paged.map(v => {
                const cat = v.category ? getCat(v.category) : null
                const CatIcon = cat?.icon
                return (
                  <tr key={v.id} onClick={() => setModal(v)} style={{ cursor: 'pointer' }}>
                    <td style={{ fontWeight: 600, color: 'var(--slate-950)' }}>{v.model}</td>
                    <td>{v.brand}</td>
                    <td>
                      {cat
                        ? <Badge tone={cat.tone} dot={false}><CatIcon size={11} style={{ marginRight: 4 }} />{cat.label}</Badge>
                        : <span style={{ color: 'var(--slate-400)' }}>—</span>}
                    </td>
                    <td>
                      <Badge tone={v.isActive !== false ? 'success' : 'neutral'} dot={false}>{v.isActive !== false ? 'Active' : 'Inactive'}</Badge>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button className="row-action-btn" style={{ background: 'var(--blue-50)' }} title="Edit" aria-label={`Edit ${v.brand} ${v.model}`} onClick={ev => { ev.stopPropagation(); setModal(v) }}>
                          <Edit2 size={13} color="var(--blue-600)" />
                        </button>
                        <button className="row-action-btn" style={{ background: 'var(--danger-50)' }} title="Delete" aria-label={`Delete ${v.brand} ${v.model}`} onClick={ev => { ev.stopPropagation(); setDelItem(v) }}>
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

        {!loading && filtered.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--slate-100)', background: 'var(--slate-50)', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="text-caption">Rows per page</span>
                <select className="filter-select" style={{ padding: '5px 8px' }} value={perPage} onChange={e => { setPerPage(Number(e.target.value)); setPage(1) }}>
                  {[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <span className="text-caption">{Math.min((page - 1) * perPage + 1, filtered.length)}–{Math.min(page * perPage, filtered.length)} of {filtered.length}</span>
            </div>
            <div className="pagination">
              <button className="page-btn" disabled={page === 1} onClick={() => setPage(p => p - 1)} aria-label="Previous page"><ChevronLeft size={14} /></button>
              {pageButtons.map(p => (
                <button key={p} className={`page-btn ${page === p ? 'is-active' : ''}`} onClick={() => setPage(p)} aria-current={page === p ? 'page' : undefined}>{p}</button>
              ))}
              <button className="page-btn" disabled={page === totalPages} onClick={() => setPage(p => p + 1)} aria-label="Next page"><ChevronRight size={14} /></button>
            </div>
          </div>
        )}
      </div>

      <div className="card card-padded" style={{ flex: '0 1 280px', minWidth: 240 }}>
        <div className="text-title" style={{ fontSize: 14, marginBottom: 12 }}>Vehicle Categories</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {categoryCounts.map(c => {
            const Icon = c.icon
            const active = catFilter === c.value
            return (
              <button
                key={c.value} type="button"
                onClick={() => { setCatFilter(active ? 'all' : c.value); setPage(1) }}
                className="btn"
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px',
                  border: 'none', borderRadius: 'var(--radius-md)',
                  background: active ? 'var(--slate-100)' : 'transparent',
                  justifyContent: 'flex-start', textAlign: 'left', width: '100%',
                }}
              >
                <span
                  style={{
                    width: 26, height: 26, borderRadius: 'var(--radius-sm)', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: `var(--${c.tone === 'neutral' ? 'slate-100' : c.tone + '-50'})`,
                    color: `var(--${c.tone === 'neutral' ? 'slate-500' : c.tone + '-600'})`,
                  }}
                >
                  <Icon size={13} />
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-700)', flex: 1 }}>{c.label}</span>
                <span className="text-caption">{c.count}</span>
                <ChevronRight size={13} color="var(--slate-400)" />
              </button>
            )
          })}
        </div>
      </div>
      </div>

      {modal && <VehicleModal item={modal === 'add' ? null : modal} existingBrands={uniqueBrands} onClose={() => setModal(null)} onSave={handleSave} />}
      <DeleteModal item={delItem} onConfirm={handleDelete} onCancel={() => setDelItem(null)} />
    </div>
  )
}