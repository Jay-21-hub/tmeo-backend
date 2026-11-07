import { useEffect, useSyncExternalStore } from 'react'
import api from '../services/api'
import { API } from '../constants'
import useTodayDuty, { refreshTodayDuty } from './useTodayDuty'

/**
 * SHARED ENFORCER LOCATION TRACKER  (the only owner of foreground GPS tracking)
 *
 *   today's schedule + local time  ->  server-computed duty  (useTodayDuty)
 *   duty                           ->  SHOULD FOREGROUND TRACKING RUN?   (this file)
 *   recent successful sync         ->  GPS presence / "LIVE"             (this file's state)
 *   authentication                 ->  application access                (useAuth)
 *
 * Ownership: <EnforcerDashboard> calls useEnforcerTracker(user.id) once. That
 * component stays mounted for the whole authenticated Enforcer session on every
 * device class (phone EnforcerShell AND tablet/desktop AppShell), so navigating
 * Home -> GPS -> Issue OVR -> Evidence -> Reports -> Home never touches the
 * tracker. GPSTracking.jsx is only a VIEW: it reads useTrackerState() and may
 * call syncNow(). Mounting/unmounting it neither starts nor stops anything.
 *
 * Start / stop rule (duty phase from useTodayDuty):
 *   on_duty, on_break                     -> tracking ON  (~15 s cadence)
 *   no_schedule, before_shift, after_shift-> tracking OFF (one-time sign-off if
 *                                            this session had been reporting)
 *   loading, error                        -> UNKNOWN. Never treated as off duty:
 *                                            a tracker that is already running
 *                                            keeps running; one that is not
 *                                            running is not started.
 *   logout                                -> haltTrackerForLogout() (the logout
 *                                            flow in useAuth sends the sign-off)
 *
 * Duty health (useTodayDuty: phase 'error') and GPS sync health (syncError here)
 * are separate and can coexist: On Duty + "Location sync unavailable" is valid.
 *
 * The server stays authoritative: every update-location response carries the
 * computed `state` and `tracking_allowed`. If the server says tracking is not
 * allowed the tracker pauses itself even if the duty read has not caught up.
 *
 * LIMITATION: this is foreground browser/PWA tracking. No Wake Lock, no
 * background geolocation: a locked phone or an OS-suspended tab may stop
 * timers and geolocation. Admin treats any fix older than 2 minutes as not live.
 */

const SYNC_MS = 15000                 // target sync cadence
const BEFORE_SHIFT_POLL_MS = 60000    // notice a shift starting without waiting for the 5-min duty refresh
const DUTY_ERROR_RETRY_MS = 30000     // retry a failed duty read
const DUTY_REFRESH_GAP_MS = 60000     // min gap for sync-triggered duty refreshes
const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
const LOG_LIMIT = 10

const TRACK_PHASES = new Set(['on_duty', 'on_break'])
const PAUSE_PHASES = new Set(['no_schedule', 'before_shift', 'after_shift'])

/* ───────────────────────── store ───────────────────────── */

const INITIAL = {
  running: false,          // timers + watch are active
  pausedReason: null,      // 'no_schedule' | 'before_shift' | 'after_shift' | null
  permission: 'unknown',   // 'unknown' | 'granted' | 'denied' | 'unsupported'
  position: null,          // [lat, lng] latest fix (display only)
  accuracy: null,
  positionAt: 0,
  fixError: null,          // transient "cannot get a fix" (not permission)
  syncing: false,
  lastSyncAt: 0,           // ms; last SUCCESSFUL server sync of this run
  syncError: null,         // string when the last sync attempt failed
  serverState: null,       // `state` from the last successful sync response
  log: [],                 // last LOG_LIMIT successful syncs (see GPSTracking)
}

let store = INITIAL
const listeners = new Set()
const emit = () => listeners.forEach(l => l())
const setStore = (patch) => { store = { ...store, ...patch }; emit() }

// Non-reactive controller state
let ownerId = null
let running = false
let watchId = null
let intervalId = null
let inflight = null                 // promise of the sync attempt in progress
let signOffPending = false          // server may hold a live row from THIS run
let lastPhase = 'loading'
let lastDutyRefreshAt = 0
let logSeq = 0
let permStatus = null

/* ───────────────────────── internals ───────────────────────── */

function stopTimers() {
  if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId)
  if (intervalId !== null) clearInterval(intervalId)
  watchId = null
  intervalId = null
  running = false
}

function detachPermissionWatch() {
  if (permStatus) permStatus.onchange = null
  permStatus = null
}

function handlePermissionDenied() {
  // Not retried automatically (no aggressive retry). The Permissions API change
  // listener, or the user pressing "Check again", restarts it.
  stopTimers()
  setStore({ running: false, permission: 'denied', fixError: null, syncing: false })
}

function onFix(pos) {
  if (!running) return
  const { latitude, longitude, accuracy } = pos.coords
  setStore({
    position: [latitude, longitude], accuracy, positionAt: Date.now(),
    permission: 'granted', fixError: null,
  })
}

function onFixError(err) {
  if (!running) return
  if (err && err.code === 1) { handlePermissionDenied(); return }
  setStore({ fixError: 'Unable to get location. Please check GPS settings.' })
}

function maybeRefreshDuty() {
  const now = Date.now()
  if (now - lastDutyRefreshAt < DUTY_REFRESH_GAP_MS) return
  lastDutyRefreshAt = now
  refreshTodayDuty()
}

async function signOff() {
  // One-time, idempotent: only when this run may have left a live row behind.
  if (!signOffPending) return
  signOffPending = false
  try {
    // Not a GPS fix: the server marks the location inactive, stores no (0, 0),
    // runs no geofence logic and closes any open geofence episode.
    await api.post(API.LOCATION, { sign_off: true, latitude: 0, longitude: 0 })
  } catch {
    // Offline: the server's 2-minute freshness cutoff takes the row off the live map.
  }
}

async function settleInflight() {
  if (inflight) { try { await inflight } catch { /* never rejects */ } }
}

async function syncToServer(lat, lng, acc) {
  setStore({ syncing: true })
  try {
    // Location only. Duty is computed by the server, never sent by the client.
    const res = await api.post(API.LOCATION, { latitude: lat, longitude: lng, accuracy: acc })
    const d = res.data || {}

    if (d.tracking_allowed === false) {
      // Server says duty no longer allows tracking (shift ended, etc). It has
      // already stored this fix as inactive, so no separate sign-off is needed.
      stopTimers()
      signOffPending = false
      setStore({
        running: false, syncing: false, syncError: null, position: null, accuracy: null,
        pausedReason: PAUSE_PHASES.has(d.state) ? d.state : null, serverState: d.state || null,
      })
      lastDutyRefreshAt = Date.now()
      refreshTodayDuty()
      return
    }

    signOffPending = true
    const entry = {
      id: ++logSeq, time: new Date(), lat: lat.toFixed(6), lng: lng.toFixed(6),
      accuracy: Math.round(acc), status: d.duty_status,
      // Address is filled in by GPSTracking (display only); coordinates stay the source of truth.
      geoState: 'loading', geoRequested: false, address: null, qualifier: null, fullAddress: null,
    }
    setStore({
      syncing: false, lastSyncAt: Date.now(), syncError: null,
      serverState: d.state || null,
      log: [entry, ...store.log].slice(0, LOG_LIMIT),
    })
    // Duty changed (e.g. on_duty -> on_break) before the 5-minute read noticed.
    if (d.state && d.state !== lastPhase) maybeRefreshDuty()
  } catch (err) {
    console.error('[tracker] sync failed:', err)
    setStore({ syncing: false, syncError: 'Location sync unavailable' })
  }
}

function tick() {
  if (!running || !navigator.geolocation) return Promise.resolve()
  if (inflight) return inflight          // never overlap interval + Sync Now
  const p = new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!running) { resolve(); return }
        onFix(pos)
        const { latitude, longitude, accuracy } = pos.coords
        resolve(syncToServer(latitude, longitude, accuracy))
      },
      (err) => { onFixError(err); resolve() },
      GEO_OPTIONS,
    )
  })
  inflight = p
  p.finally(() => { if (inflight === p) inflight = null })
  return p
}

function watchPermission() {
  if (permStatus || !navigator.permissions?.query) return
  navigator.permissions.query({ name: 'geolocation' }).then((status) => {
    if (permStatus || ownerId === null) return
    permStatus = status
    status.onchange = () => {
      if (status.state === 'denied') { if (running) handlePermissionDenied(); else setStore({ permission: 'denied' }) }
      else if (store.permission === 'denied') { setStore({ permission: 'unknown' }); reconcile(lastPhase) }
    }
    if (status.state === 'denied' && !running) setStore({ permission: 'denied' })
  }).catch(() => { /* Permissions API unavailable: rely on geolocation error codes */ })
}

function startTracking() {
  if (running) return
  if (!navigator.geolocation) {
    setStore({ permission: 'unsupported', fixError: 'Geolocation is not supported by this browser.' })
    return
  }
  if (store.permission === 'denied') return          // no aggressive retry
  watchPermission()
  running = true
  setStore({
    running: true, pausedReason: null, fixError: null, syncError: null,
    lastSyncAt: 0, serverState: null,
  })
  // Local display only; the 15 s interval below is what talks to the server.
  watchId = navigator.geolocation.watchPosition(onFix, onFixError, GEO_OPTIONS)
  intervalId = setInterval(tick, SYNC_MS)
  tick()
}

async function stopForDuty(reason) {
  const wasRunning = running
  if (wasRunning) stopTimers()
  if (wasRunning || store.pausedReason !== reason) {
    setStore({ running: false, pausedReason: reason, position: null, accuracy: null, syncing: false })
  }
  // Transition off an actively tracked state: sign off once. Repeated duty
  // refreshes while already paused find nothing pending and do nothing.
  if (wasRunning || signOffPending) {
    await settleInflight()
    await signOff()
  }
}

function reconcile(phase) {
  lastPhase = phase
  if (ownerId === null) return
  if (TRACK_PHASES.has(phase)) startTracking()
  else if (PAUSE_PHASES.has(phase)) stopForDuty(phase)
  // 'loading' / 'error': duty is UNKNOWN, not off duty. Keep the current lifecycle.
}

function teardown() {
  stopTimers()
  detachPermissionWatch()
  inflight = null
  signOffPending = false
  lastPhase = 'loading'
  store = INITIAL
  emit()
}

/* ───────────────────────── public API ───────────────────────── */

/**
 * Manual sync. Allowed only while tracking is legitimately running (on duty /
 * on break). While paused it does nothing: it can never restart continuous
 * tracking or put an enforcer who is off duty on the map.
 */
export function syncNow() {
  if (!running) return Promise.resolve()
  return tick()
}

/** User-initiated "check again" after a denied permission (not automatic). */
export function retryLocationPermission() {
  if (store.permission !== 'denied') return
  setStore({ permission: 'unknown' })
  reconcile(lastPhase)
}

/** Persist reverse-geocoded display text on a log entry (survives page changes). */
export function annotateLogEntry(id, patch) {
  setStore({ log: store.log.map(l => (l.id === id ? { ...l, ...patch } : l)) })
}

/**
 * Call before logout. Stops the timers, lets an in-flight sync finish (so it
 * cannot land AFTER the sign-off and revive the row), and leaves the sign-off
 * itself to the logout flow in useAuth (one sign-off, not two).
 */
export async function haltTrackerForLogout() {
  stopTimers()
  signOffPending = false
  await settleInflight()
  setStore({ running: false, position: null, accuracy: null, syncing: false })
}

const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
const getSnapshot = () => store

/**
 * VIEW hook for screens (GPSTracking). Read-only state of the shared tracker.
 * @returns {{
 *   running: boolean, pausedReason: string|null,
 *   permission: 'unknown'|'granted'|'denied'|'unsupported',
 *   position: [number, number]|null, accuracy: number|null, positionAt: number,
 *   fixError: string|null, syncing: boolean,
 *   lastSyncAt: number, syncError: string|null, serverState: string|null,
 *   log: Array,
 * }}
 */
export function useTrackerState() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * HOST hook: call ONCE, from the component that lives for the whole
 * authenticated Enforcer session (EnforcerDashboard).
 */
export default function useEnforcerTracker(userId) {
  const { phase } = useTodayDuty(userId)

  // Session ownership: a different (or missing) user tears the tracker down.
  useEffect(() => {
    if (!userId) return undefined
    if (ownerId !== null && ownerId !== userId) teardown()
    ownerId = userId
    return () => { teardown(); ownerId = null }
  }, [userId])

  // Duty drives tracking.
  useEffect(() => {
    if (userId) reconcile(phase)
  }, [userId, phase])

  // Notice a shift starting (before_shift) and recover from a failed duty read
  // (error) without waiting for the 5-minute refresh.
  useEffect(() => {
    const ms = phase === 'before_shift' ? BEFORE_SHIFT_POLL_MS : phase === 'error' ? DUTY_ERROR_RETRY_MS : 0
    if (!userId || !ms) return undefined
    const id = setInterval(refreshTodayDuty, ms)
    return () => clearInterval(id)
  }, [userId, phase])

  // Browsers throttle timers in hidden tabs. Catch up as soon as the app is
  // visible / online again. (Only while tracking is already running.)
  useEffect(() => {
    if (!userId) return undefined
    const onVisible = () => { if (document.visibilityState === 'visible') tick() }
    const onOnline = () => { tick() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [userId])
}