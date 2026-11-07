import { useEffect, useSyncExternalStore } from 'react'
import api from '../services/api'
import { API } from '../constants'
import { formatTime12h } from '../utils/helpers'

/**
 * SHARED SOURCE OF TRUTH for the enforcer's current duty / schedule.
 *
 *   Admin Team Scheduling -> EnforcerSchedule (today, configured local date)
 *     -> GET /api/enforcers/today-status/  (server computes duty from schedule + local time)
 *       -> useTodayDuty()  -> EnforcerShell duty strip + GPSTracking
 *
 * LOGIN IS NOT DUTY. Nothing here reads CustomUser.duty_status, localStorage or
 * auth state to decide whether someone is on duty; only the server's computed
 * answer counts. Likewise the operational area for TODAY is the schedule's
 * assigned_area -- never CustomUser.assigned_area and never an invented label.
 *
 * `phase` is a real state machine, not a boolean:
 *   loading       -> first read in flight
 *   error         -> the read failed: status is UNKNOWN (never shown as Off Duty)
 *   no_schedule   -> API ok, schedule === null
 *   before_shift  -> scheduled, shift has not started   (Off Duty)
 *   on_duty       -> scheduled, within shift            (On Duty)
 *   on_break      -> scheduled, within break window     (On Break)
 *   after_shift   -> scheduled, shift ended             (Off Duty)
 * "schedule exists but area blank" is a separate fact (hasSchedule && area === '').
 *
 * All consumers share one module-level store, so the dashboard strip and GPS
 * can never disagree, and simultaneous refreshes share a single request. The
 * store is cleared when the last consumer unmounts or the signed-in user
 * changes; nothing is persisted client-side.
 */

const REFRESH_MS = 5 * 60 * 1000   // periodic re-read
const FRESH_MS   = 30 * 1000       // a consumer mounting within this window reuses the data

const SERVER_STATES = ['no_schedule', 'before_shift', 'on_duty', 'on_break', 'after_shift']

const DISPLAY = {
  loading:      { label: 'Checking…',          color: 'var(--slate-400)',   bg: 'var(--slate-100)' },
  error:        { label: 'Status unavailable', color: 'var(--danger-600)',  bg: 'var(--danger-50)' },
  no_schedule:  { label: 'Off Duty',           color: 'var(--slate-500)',   bg: 'var(--slate-100)' },
  before_shift: { label: 'Off Duty',           color: 'var(--slate-500)',   bg: 'var(--slate-100)' },
  after_shift:  { label: 'Off Duty',           color: 'var(--slate-500)',   bg: 'var(--slate-100)' },
  on_duty:      { label: 'On Duty',            color: 'var(--success-600)', bg: 'var(--success-50)' },
  on_break:     { label: 'On Break',           color: 'var(--warning-600)', bg: 'var(--warning-50)' },
}

const REASON = {
  loading:      'Loading schedule…',
  error:        'Unable to load status.',
  no_schedule:  'No schedule today.',
  before_shift: 'Shift has not started yet.',
  on_duty:      'Currently on shift.',
  on_break:     'Currently within break time.',
  after_shift:  'Shift has ended.',
}

function build(patch, prev) {
  const next = { ...prev, ...patch }
  const phase = next.error ? 'error' : !next.loaded ? 'loading' : next.state
  const schedule = next.schedule
  const area = typeof schedule?.assigned_area === 'string' ? schedule.assigned_area.trim() : ''

  next.phase = phase
  next.isKnown = phase !== 'loading' && phase !== 'error'
  next.hasSchedule = next.isKnown && !!schedule
  next.area = area
  // Three different "no area" situations, never collapsed into one string.
  next.areaLabel =
      phase === 'loading'     ? 'Loading…'
    : phase === 'error'       ? 'Unable to load status'
    : phase === 'no_schedule' ? 'No schedule today'
    : (area || 'No assigned area')
  next.display = DISPLAY[phase]
  next.reasonText = REASON[phase]
  // One line for the narrow duty strip: area, plus when the shift starts/ended if it is not running.
  next.stripText =
      phase === 'before_shift' && formatTime12h(schedule?.shift_start) ? `${next.areaLabel} · Starts ${formatTime12h(schedule.shift_start)}`
    : phase === 'after_shift'  && formatTime12h(schedule?.shift_end)   ? `${next.areaLabel} · Ended ${formatTime12h(schedule.shift_end)}`
    : next.areaLabel
  // For components that only understand on_duty/on_break/off_duty (e.g. ProfileModal's
  // `dutyStatus` override): 'unknown' while loading/errored, never a guess.
  next.profileStatus = !next.isKnown ? 'unknown' : next.status
  return next
}

const INITIAL = build({
  loaded: false, error: false, loading: false,
  state: null, status: null, serverReason: '', schedule: null, updatedAt: 0,
}, {})

let state = INITIAL
let ownerId = null
let generation = 0          // bumped on reset so late responses from a previous user are ignored
let inflight = null
let timerId = null
const listeners = new Set()

const emit = () => listeners.forEach(l => l())
const setState = (patch) => { state = build(patch, state); emit() }

function reset() {
  generation += 1
  inflight = null
  ownerId = null
  state = INITIAL
  emit()
}

export function refreshTodayDuty() {
  if (inflight) return inflight          // de-duplicate simultaneous requests
  const gen = generation
  setState({ loading: true })
  const request = api.get(API.TODAY_STATUS)
    .then(res => {
      if (gen !== generation) return
      const d = res.data || {}
      // A response without a recognizable `state` is treated as a failed read, not guessed at.
      if (!SERVER_STATES.includes(d.state)) throw new Error('unrecognized today-status response')
      setState({
        loaded: true, loading: false, error: false,
        state: d.state, status: d.status, serverReason: d.reason || '',
        schedule: d.schedule || null,
        updatedAt: Date.now(),
      })
    })
    .catch(() => {
      if (gen !== generation) return
      // API failure => UNKNOWN. Drop any previous schedule/status so nothing stale
      // (and nothing like a profile default) is shown as the current duty.
      setState({ loading: false, error: true, state: null, status: null, schedule: null })
    })
    .finally(() => { if (gen === generation) inflight = null })
  inflight = request
  return request
}

const onVisible = () => { if (document.visibilityState === 'visible') refreshTodayDuty() }
const onOnline  = () => { refreshTodayDuty() }

function subscribe(listener) {
  listeners.add(listener)
  if (listeners.size === 1) {
    timerId = setInterval(refreshTodayDuty, REFRESH_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearInterval(timerId)
      timerId = null
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      reset()
    }
  }
}

const getSnapshot = () => state

/**
 * @param {string|number} userId  signed-in enforcer's id. A different id clears the
 *                                store so one user's schedule never shows for another.
 * @returns {{
 *   phase: 'loading'|'error'|'no_schedule'|'before_shift'|'on_duty'|'on_break'|'after_shift',
 *   isKnown: boolean,
 *   status: 'on_duty'|'on_break'|'off_duty'|null,   // null while loading/error
 *   hasSchedule: boolean,
 *   schedule: null | { shift_start, shift_end, assigned_area, break_start, break_end },
 *   area: string,          // today's schedule area, trimmed; '' when none/unknown
 *   areaLabel: string,     // 'Loading…' | 'Unable to load status' | 'No schedule today' | area | 'No assigned area'
 *   stripText: string,     // areaLabel (+ "Starts 8:00 AM" / "Ended 5:00 PM" outside the shift; display only)
 *   display: { label, color, bg },   // 'Checking…' | 'Status unavailable' | 'Off Duty' | 'On Duty' | 'On Break'
 *   reasonText: string,
 *   profileStatus: string, // status, or 'unknown' while loading/error
 *   loaded: boolean, loading: boolean, error: boolean,
 *   updatedAt: number,
 *   refresh: () => Promise<void>,
 * }}
 */
export default function useTodayDuty(userId) {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    if (ownerId !== (userId ?? null)) {
      if (ownerId !== null) reset()
      ownerId = userId ?? null
    }
    if (!state.loaded || Date.now() - state.updatedAt > FRESH_MS) refreshTodayDuty()
  }, [userId])

  return { ...snap, refresh: refreshTodayDuty }
}