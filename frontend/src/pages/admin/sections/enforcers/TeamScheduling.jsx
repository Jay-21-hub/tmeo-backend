import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Search, X, Users2, CalendarDays, ChevronLeft, ChevronRight,
  UserRoundCheck, ClipboardList,
} from 'lucide-react'
import api from '../../../../services/api'
import { useToast } from '../../../../context/useToast'
import Avatar from '../../../../components/common/Avatar'
import Button from '../../../../components/ui/Button'
import ConfirmDialog from '../../../../components/ui/ConfirmDialog'
import { EmptyState } from '../../../../components/ui/States'
import { MONTH_NAMES } from './enforcerStatus'
import './TeamScheduling.css'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const toDateStr = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const toTimeStr = t => (t ? (t.length === 5 ? `${t}:00` : t) : null)

// Fixed government shift — enforcer shifts are set policy, not adjustable
// per assignment, so these are constants rather than form fields.
const FIXED_SHIFT_START = '08:00'
const FIXED_SHIFT_END = '17:00'
const FIXED_BREAK_START = '12:00'
const FIXED_BREAK_END = '13:00'
const SHIFT_HOURS = (() => {
  const [sh, sm] = FIXED_SHIFT_START.split(':').map(Number)
  const [eh, em] = FIXED_SHIFT_END.split(':').map(Number)
  return ((eh * 60 + em) - (sh * 60 + sm)) / 60
})()

const formatTime12 = (t) => {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}
const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x }
const dateStrOf = (d) => toDateStr(d.getFullYear(), d.getMonth(), d.getDate())
const monthKeyOf = (d) => `${d.getFullYear()}-${d.getMonth()}`

const emptyForm = () => ({ assigned_area: '', notes: '' })

/* ── Selected-date helpers ──
   Dates travel as 'YYYY-MM-DD' strings end to end. They are NEVER parsed with
   `new Date('YYYY-MM-DD')` (that is UTC midnight and can render as the previous
   day in local time). Display uses the local (y, m, d) constructor; day
   arithmetic uses Date.UTC on the parts, so neither can shift the calendar day. */
const parseDateStr = (str) => { const [y, m, d] = str.split('-').map(Number); return { y, m, d } }
const localDateOf = (str) => { const { y, m, d } = parseDateStr(str); return new Date(y, m - 1, d) }
const dayIndexOf = (str) => { const { y, m, d } = parseDateStr(str); return Date.UTC(y, m - 1, d) / 86400000 }
const fmtLong  = (str) => localDateOf(str).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const fmtShort = (str) => localDateOf(str).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })
const fmtFull  = (str) => localDateOf(str).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Describe a set of 'YYYY-MM-DD' strings without ever implying dates that are not selected. */
function summarizeDates(dateSet) {
  const sorted = Array.from(dateSet).sort()
  const count = sorted.length
  if (count === 0) return { sorted, count, consecutive: false, label: '' }
  if (count === 1) return { sorted, count, consecutive: true, label: fmtLong(sorted[0]) }
  const consecutive = sorted.every((d, i) => i === 0 || dayIndexOf(d) - dayIndexOf(sorted[i - 1]) === 1)
  if (consecutive) {
    const a = parseDateStr(sorted[0]), b = parseDateStr(sorted[count - 1])
    // Same year: "Oct 3 – Oct 7, 2026" / "Oct 30 – Nov 1, 2026". Across years the year appears on both ends.
    const label = a.y === b.y
      ? `${fmtShort(sorted[0])} \u2013 ${fmtFull(sorted[count - 1])}`
      : `${fmtFull(sorted[0])} \u2013 ${fmtFull(sorted[count - 1])}`
    return { sorted, count, consecutive, label }
  }
  return { sorted, count, consecutive, label: `${count} days selected` }
}

/**
 * Team Scheduling: a monthly enforcer duty calendar with a
 * searchable/filterable roster on the side and a "Scheduled Shift Details"
 * panel below for assigning or reviewing a day's shifts.
 * Props: enforcers (active roster from ManageEnforcers), loading
 */
export default function TeamScheduling({ enforcers, loading: enforcersLoading }) {
  const toast = useToast()

  const [anchorDate, setAnchorDate] = useState(() => new Date())
  const [activeDate, setActiveDate] = useState(() => dateStrOf(new Date()))
  const [selectedDates, setSelectedDates] = useState(() => new Set([dateStrOf(new Date())]))

  const [schedCache, setSchedCache] = useState({}) // { 'YYYY-M': EnforcerSchedule[] }
  const [schedLoading, setSchedLoading] = useState(false)

  const [rosterSearch, setRosterSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState(() => new Set())

  const [form, setForm] = useState(emptyForm())
  const [formErr, setFormErr] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [conflictState, setConflictState] = useState(null)
  const [removingId, setRemovingId] = useState(null)

  /* ── Which (year, month) page does the current view need? ── */
  const neededMonthKeys = useMemo(() => [monthKeyOf(anchorDate)], [anchorDate])

  const ensureMonthsLoaded = useCallback(async (keys) => {
    const missing = keys.filter(k => !(k in schedCache))
    if (!missing.length) return
    setSchedLoading(true)
    try {
      const results = await Promise.all(missing.map(async (k) => {
        const [y, m] = k.split('-').map(Number)
        try {
          const res = await api.get(`/api/enforcers/schedules/?month=${m + 1}&year=${y}`)
          return { k, data: res.data || [] }
        } catch { return { k, data: [] } }
      }))
      setSchedCache(prev => {
        const next = { ...prev }
        results.forEach(({ k, data }) => { next[k] = data })
        return next
      })
    } finally { setSchedLoading(false) }
  }, [schedCache])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-view/date-change pattern, matches existing codebase convention
    ensureMonthsLoaded(neededMonthKeys)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ensureMonthsLoaded intentionally omitted; it closes over schedCache and would refetch every render otherwise
  }, [neededMonthKeys])

  // Re-read the given months from the server and replace them in the cache.
  // (Deleting the keys instead would leave the calendar empty: the fetch effect
  // only re-runs when the visible month changes.) Returns false if any month
  // could not be refreshed, in which case its previous data is left in place.
  const reloadMonths = useCallback(async (keys) => {
    let ok = true
    const results = await Promise.all(keys.map(async (k) => {
      const [y, m] = k.split('-').map(Number)
      try {
        const res = await api.get(`/api/enforcers/schedules/?month=${m + 1}&year=${y}`)
        return { k, data: res.data || [] }
      } catch { ok = false; return null }
    }))
    setSchedCache(prev => {
      const next = { ...prev }
      results.forEach(r => { if (r) next[r.k] = r.data })
      return next
    })
    return ok
  }, [])

  const scheduleMap = useMemo(() => {
    const map = {}
    Object.values(schedCache).flat().forEach(s => { (map[s.date] ||= []).push(s) })
    return map
  }, [schedCache])

  /* ── Navigation ── */
  const goToday = () => {
    const t = new Date()
    setAnchorDate(t)
    setActiveDate(dateStrOf(t))
  }
  const step = (dir) => setAnchorDate(prev => addMonths(prev, dir))

  const handleDayClick = (dateStr) => {
    // Past days are locked out entirely — allowing them to be picked would
    // let someone backdate an enforcer's schedule after the fact, which is
    // exactly the kind of record-tampering ("daya") this screen must not permit.
    if (dateStr < dateStrOf(new Date())) return
    setActiveDate(dateStr)
    setSelectedDates(prev => {
      const next = new Set(prev)
      if (next.has(dateStr)) next.delete(dateStr); else next.add(dateStr)
      return next
    })
  }

  const removeSelectedDate = (dateStr) => {
    setSelectedDates(prev => {
      const next = new Set(prev)
      next.delete(dateStr)
      return next
    })
  }

  const toggleEnforcer = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  /* ── Roster filtering ── */
  const filteredEnforcers = (enforcers || []).filter(e => {
    const q = rosterSearch.toLowerCase()
    const matchSearch = !q ||
      (e.full_name || '').toLowerCase().includes(q) ||
      (e.id_number || '').toLowerCase().includes(q) ||
      (e.badge_number || '').toLowerCase().includes(q)
    return matchSearch
  })

  /* ── Assignment ── */
  const validateForm = () => {
    if (!form.assigned_area.trim()) return 'Assigned area is required.'
    return ''
  }
  const canAssign = selectedIds.size > 0 && selectedDates.size > 0 && form.assigned_area.trim() && !assigning

  const buildPayload = (overwrite) => ({
    enforcer_ids: Array.from(selectedIds),
    dates: Array.from(selectedDates),
    shift_start: toTimeStr(FIXED_SHIFT_START),
    shift_end: toTimeStr(FIXED_SHIFT_END),
    break_start: toTimeStr(FIXED_BREAK_START),
    break_end: toTimeStr(FIXED_BREAK_END),
    assigned_area: form.assigned_area,
    notes: form.notes,
    overwrite,
  })

  const submitAssign = async (overwrite = false) => {
    if (!overwrite) {
      const err = validateForm()
      if (err) { setFormErr(err); return }
      setFormErr('')
    }
    setAssigning(true)
    try {
      // Snapshot what was actually sent, so the confirmation describes exactly that.
      const payload = buildPayload(overwrite)
      const sent = summarizeDates(selectedDates)
      await api.post('/api/enforcers/schedules/bulk-assign/', payload)
      const what = sent.count === 1 || sent.consecutive
        ? sent.label
        : sent.count <= 4 ? sent.sorted.map(fmtShort).join(', ') : `${sent.count} selected dates`
      toast.success(`Assigned ${plural(payload.enforcer_ids.length, 'enforcer')} to ${plural(sent.count, 'date')} (${what}).`)
      setConflictState(null)
      // Persisted: drop the "selected for assignment" state and reset the form,
      // then re-read every affected month so those days show their real
      // "Has schedule" state from the server.
      const touched = new Set([monthKeyOf(anchorDate)])
      payload.dates.forEach(d => { const { y, m } = parseDateStr(d); touched.add(`${y}-${m - 1}`) })
      setSelectedDates(new Set())
      setSelectedIds(new Set())
      setForm(emptyForm())
      const refreshed = await reloadMonths(Array.from(touched))
      if (!refreshed) toast.warning('Schedules were saved, but the calendar could not be refreshed. Reload to see them.')
    } catch (e) {
      if (e.response?.status === 409) {
        setConflictState({ conflicts: e.response.data.conflicts || [] })
      } else {
        const msg = e.response?.data?.error || e.response?.data?.non_field_errors?.[0] || 'Failed to assign schedule.'
        toast.danger(msg)
      }
    } finally { setAssigning(false) }
  }

  const handleRemoveEntry = async (scheduleId) => {
    setRemovingId(scheduleId)
    try {
      await api.delete(`/api/enforcers/schedules/${scheduleId}/`)
      setSchedCache(prev => {
        const next = {}
        Object.entries(prev).forEach(([k, list]) => { next[k] = list.filter(s => s.id !== scheduleId) })
        return next
      })
      toast.success('Removed from schedule.')
    } catch { toast.danger('Failed to remove.') }
    finally { setRemovingId(null) }
  }

  const today = new Date()
  const todayStr = dateStrOf(today)
  const dayEntries = activeDate ? (scheduleMap[activeDate] || []) : []
  const dateSummary = useMemo(() => summarizeDates(selectedDates), [selectedDates])
  const multiDate = dateSummary.count > 1

  /* ── Title for the toolbar ── */
  const title = `${MONTH_NAMES[anchorDate.getMonth()]} ${anchorDate.getFullYear()}`

  /* ── Monthly grid data ── */
  const calYear = anchorDate.getFullYear(), calMonth = anchorDate.getMonth()
  const firstDayOfWeek = new Date(calYear, calMonth, 1).getDay()
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate()

  return (
    <>
      {/* Toolbar: month navigation */}
      <div className="tsched-toolbar">
        <div className="tsched-toolbar-nav">
          <button className="btn btn-secondary btn-sm" onClick={() => step(-1)} aria-label="Previous"><ChevronLeft size={14} /></button>
          <span className="tsched-toolbar-title">{title}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => step(1)} aria-label="Next"><ChevronRight size={14} /></button>
          <button className="btn btn-ghost btn-sm" onClick={goToday}>Today</button>
        </div>
      </div>

      <div className="team-sched">
        {/* Calendar */}
        <div className="card card-padded team-sched-main">
          {schedLoading ? (
            <div className="skeleton" style={{ height: 320 }} />
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4, marginBottom: 4 }}>
                {DAY_LABELS.map(d => <div key={d} className="text-label" style={{ textAlign: 'center', padding: '4px 0' }}>{d}</div>)}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
                {Array.from({ length: firstDayOfWeek }).map((_, i) => <div key={`e${i}`} />)}
                {Array.from({ length: daysInMonth }, (_, i) => {
                  const dayNum = i + 1
                  const dateStr = toDateStr(calYear, calMonth, dayNum)
                  const entries = scheduleMap[dateStr] || []
                  const isToday = dateStr === todayStr
                  const isSelected = selectedDates.has(dateStr)
                  const isActive = dateStr === activeDate
                  const isPast = dateStr < todayStr

                  let bg = 'var(--slate-50)', color = 'var(--slate-700)', border = '1px solid var(--slate-100)', fontWeight = 400
                  if (entries.length) { bg = 'var(--success-50)'; color = 'var(--success-700)'; border = '1px solid var(--success-100)'; fontWeight = 600 }
                  if (isToday) { border = '1px solid var(--navy-800)' }
                  if (isSelected) { bg = 'var(--blue-600)'; color = '#fff'; border = '1px solid var(--blue-600)'; fontWeight = 700 }
                  // Past days: locked — can't be selected for (re)assignment, so
                  // they're visually muted and read only. slate-500 keeps the
                  // number legible (unlike slate-300/400, which wash out against
                  // the slate-50 cell background) while still reading as disabled.
                  if (isPast) { bg = 'var(--slate-50)'; color = 'var(--slate-500)'; border = '1px solid var(--slate-100)'; fontWeight = 400 }

                  return (
                    <div
                      key={dayNum}
                      onClick={() => handleDayClick(dateStr)}
                      aria-disabled={isPast}
                      title={isPast ? 'Past dates can no longer be scheduled' : undefined}
                      style={{
                        borderRadius: 'var(--radius-md)', textAlign: 'center', padding: '6px 2px', fontSize: 12, fontWeight,
                        background: bg, color, border, cursor: isPast ? 'not-allowed' : 'pointer', minHeight: 50, display: 'flex',
                        flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
                        boxShadow: isActive ? '0 0 0 2px var(--navy-800)' : 'none',
                        transition: 'box-shadow var(--transition-fast)',
                      }}
                    >
                      <span>{dayNum}</span>
                      {entries.length > 0 && (
                        <span style={{ fontSize: 9, fontWeight: 600, color: isSelected ? 'rgba(255,255,255,0.85)' : 'var(--success-600)', lineHeight: 1 }}>
                          {entries.length} enf.
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}

          <div style={{ display: 'flex', gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
            {[
              { bg: 'var(--success-50)', border: 'var(--success-100)', label: 'Has schedule' },
              { bg: 'var(--blue-600)', border: 'var(--blue-600)', label: 'Selected for assignment' },
            ].map(({ bg, border, label }) => (
              <span key={label} className="text-caption" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 14, height: 14, borderRadius: 4, background: bg, border: `1px solid ${border}`, display: 'inline-block' }} />
                {label}
              </span>
            ))}
          </div>

          {selectedDates.size > 0 && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="text-caption">{plural(selectedDates.size, 'date')} selected for assignment</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedDates(new Set(activeDate ? [activeDate] : []))}>Clear extra dates</button>
            </div>
          )}
        </div>

        {/* Enforcers directory */}
        <div className="card card-padded team-sched-roster">
          <div style={{ marginBottom: 12 }}>
            <span className="text-title" style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
              <UserRoundCheck size={15} color="var(--slate-500)" /> Enforcers
            </span>
          </div>

          <div className="search-input-wrap" style={{ marginBottom: 10 }}>
            <Search size={14} className="search-input-icon" />
            <input className="input" placeholder="Search enforcers by name, ID, or area..." value={rosterSearch} onChange={e => setRosterSearch(e.target.value)} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 420, overflowY: 'auto' }}>
            {enforcersLoading ? (
              Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 52 }} />)
            ) : filteredEnforcers.length === 0 ? (
              <EmptyState icon={Users2} title="No enforcers" message="Try a different search" />
            ) : filteredEnforcers.map(e => {
              const isSelected = selectedIds.has(e.id)
              return (
                <div
                  key={e.id}
                  className={`tsched-roster-row ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => toggleEnforcer(e.id)}
                  role="button" tabIndex={0}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleEnforcer(e.id)}
                    onClick={ev => ev.stopPropagation()}
                    aria-label={`Select ${e.full_name}`}
                    style={{ flexShrink: 0, width: 16, height: 16, cursor: 'pointer' }}
                  />
                  <Avatar user={e} size={34} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: 13, color: 'var(--slate-950)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.full_name || `${e.last_name}, ${e.first_name}`}
                    </p>
                    <p className="text-caption" style={{ margin: 0 }}>
                      {e.role_display || 'Enforcer'}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>

          <p className="text-caption" style={{ marginTop: 10, marginBottom: 0 }}>
            Showing {filteredEnforcers.length} of {(enforcers || []).length} enforcers
            {selectedIds.size > 0 && ` \u00b7 ${selectedIds.size} selected`}
          </p>
          {selectedIds.size > 0 && (
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => setSelectedIds(new Set())}>Clear selection</button>
          )}
        </div>
      </div>

      {/* Scheduled Shift Details */}
      <div className="card card-padded tsched-details-card">
        <div className="tsched-details-header">
          <ClipboardList size={15} color="var(--slate-500)" />
          <span className="text-title" style={{ fontSize: 14 }}>Scheduled Shift Details</span>
        </div>
        {multiDate && (
          <p className="text-caption tsched-apply-note tsched-fade">
            Shift time, assigned area, assigned enforcers and notes apply to all {dateSummary.count} selected dates.
          </p>
        )}

        <div className="tsched-details-grid">
          <div className={`tsched-details-field ${multiDate && !dateSummary.consecutive ? 'tsched-details-dates--list' : ''}`}>
            <span className="field-label">{multiDate ? 'Selected Dates' : 'Selected Date'}</span>
            <div className="tsched-date-pill">
              <CalendarDays size={14} />
              <span key={dateSummary.label} className="tsched-fade">{dateSummary.count ? dateSummary.label : 'Select a date'}</span>
            </div>
            {multiDate && dateSummary.consecutive && (
              <span key={dateSummary.count} className="text-caption tsched-fade">{dateSummary.count} days selected</span>
            )}
            {multiDate && !dateSummary.consecutive && (
              <div className="tsched-chip-row tsched-date-chips">
                {dateSummary.sorted.map(d => (
                  <span key={d} className="tsched-chip tsched-chip--date tsched-fade">
                    {fmtFull(d)}
                    <button type="button" onClick={() => removeSelectedDate(d)} aria-label={`Remove ${fmtFull(d)}`}><X size={11} /></button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="tsched-details-field">
            <span className="field-label">Shift Time</span>
            <div className="tsched-fixed-shift-value">
              {formatTime12(FIXED_SHIFT_START)} – {formatTime12(FIXED_SHIFT_END)}
              <span className="tsched-fixed-shift-sub">({SHIFT_HOURS} hours)</span>
            </div>
          </div>

          <div className="tsched-details-field">
            <label htmlFor="team-sched-area" className="field-label">
              Assigned Area<span className="field-required" aria-hidden="true"> *</span>
            </label>
            <input
              id="team-sched-area" className="input"
              value={form.assigned_area} onChange={e => setForm(f => ({ ...f, assigned_area: e.target.value }))}
              placeholder="e.g. Riverside Quarter"
            />
          </div>

          <div className="tsched-details-field">
            <span className="field-label">Assigned Enforcers</span>
            {selectedIds.size === 0 ? (
              <p className="text-caption" style={{ margin: '9px 0 0' }}>Pick enforcers from the panel above.</p>
            ) : (
              <div className="tsched-chip-row">
                {Array.from(selectedIds).map(id => {
                  const e = (enforcers || []).find(en => en.id === id)
                  if (!e) return null
                  return (
                    <span key={id} className="tsched-chip">
                      <Avatar user={e} size={20} />
                      {e.full_name}
                      <button onClick={() => toggleEnforcer(id)} aria-label={`Remove ${e.full_name}`}><X size={11} /></button>
                    </span>
                  )
                })}
              </div>
            )}
          </div>

          <div className="tsched-details-field tsched-details-notes">
            <label htmlFor="team-sched-notes" className="field-label">Notes</label>
            <textarea
              id="team-sched-notes" className="input" rows={2}
              value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Add notes for this schedule (optional)..."
            />
          </div>
        </div>

        {formErr && <p className="field-error-text" style={{ marginTop: 8 }} role="alert">{formErr}</p>}

        <div className="tsched-details-footer">
          <div style={{ flex: 1, minWidth: 0 }}>
            {dayEntries.length > 0 && (
              <div className="tsched-existing-entries">
                <span className="text-caption" style={{ fontWeight: 600 }}>Already scheduled on {fmtShort(activeDate)}:</span>
                {dayEntries.map(entry => (
                  <div key={entry.id} className="tsched-existing-entry">
                    <span>
                      <strong>{entry.enforcer_name}</strong> &middot; {formatTime12(entry.shift_start)}–{formatTime12(entry.shift_end)} &middot; {entry.assigned_area}
                    </span>
                    <button className="row-action-btn" style={{ background: 'var(--danger-50)', opacity: 1 }} title="Remove" onClick={() => handleRemoveEntry(entry.id)} disabled={removingId === entry.id}>
                      <X size={13} color="var(--danger-600)" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <Button onClick={() => submitAssign(false)} disabled={!canAssign} loading={assigning}>
            Assign {plural(selectedIds.size, 'enforcer')} to {plural(selectedDates.size, 'date')}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={!!conflictState}
        onClose={() => setConflictState(null)}
        title="Existing schedules will be overwritten"
        tone="danger"
        message={conflictState ? `${conflictState.conflicts.length} of the selected enforcer/date pairs already have a schedule. Overwrite them?` : ''}
        rows={conflictState?.conflicts?.slice(0, 8).map(c => [`${c.enforcer_name} \u2014 ${c.date}`, `${c.current_shift} \u00b7 ${c.current_area}`]) || []}
        confirmLabel="Overwrite"
        onConfirm={() => submitAssign(true)}
        loading={assigning}
      />
    </>
  )
}