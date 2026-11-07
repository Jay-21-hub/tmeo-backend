import { useState, useEffect } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import { MapContainer, TileLayer, Marker, Popup, Circle } from 'react-leaflet'
import L from 'leaflet'
import { RefreshCw, MapPin, Navigation2, Target, Coffee, ChevronDown } from 'lucide-react'
import { reverseGeocode } from '../../../utils/geocode'
import { formatTime12h } from '../../../utils/helpers'
import useTodayDuty from '../../../hooks/useTodayDuty'
import { useTrackerState, syncNow, retryLocationPermission, annotateLogEntry } from '../../../hooks/useEnforcerTracker'

const LUCENA_CENTER = [13.9373, 121.6144]
// The only geographic condition checked: distance from the Lucena City centre.
// (Mirrors CITY_RADIUS_METERS in backend UpdateLocationView.) Not a scheduled-area boundary.
const ZONE_RADIUS_M = 5000
const ZONE_RADIUS_KM = ZONE_RADIUS_M / 1000
// A sync counts as "live" for the badge only while it is this recent (3 x the
// 15 s cadence). Mirrors the idea of the server's 2-minute live-map cutoff
// without being it: the badge is about THIS device's recent sync health.
const LIVE_BADGE_FRESH_MS = 45 * 1000

function getDistanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Truthful GPS badge: derived from the shared tracker + duty phase, never from
// the fact that this page rendered. GPS presence is separate from duty status.
function gpsBadge(phase, tracker, now) {
  if (tracker.permission === 'denied') return { tone: 'danger', text: 'Location permission required' }
  if (tracker.permission === 'unsupported') return { tone: 'danger', text: 'Location not supported' }
  if (tracker.running) {
    if (tracker.syncError) return { tone: 'warning', text: tracker.syncError }
    const fresh = tracker.lastSyncAt && now - tracker.lastSyncAt <= LIVE_BADGE_FRESH_MS
    if (fresh) {
      const onBreak = phase === 'on_break' || (phase !== 'on_duty' && tracker.serverState === 'on_break')
      return { tone: 'live', text: onBreak ? 'LIVE · On Break' : 'LIVE · every 15s' }
    }
    if (tracker.fixError) return { tone: 'warning', text: 'Location unavailable' }
    if (!tracker.lastSyncAt) return { tone: 'neutral', text: 'Acquiring location…' }
    return { tone: 'warning', text: 'Waiting for location sync' }
  }
  if (phase === 'no_schedule') return { tone: 'neutral', text: 'Tracking paused' }
  if (phase === 'before_shift') return { tone: 'neutral', text: 'Tracking starts with shift' }
  if (phase === 'after_shift') return { tone: 'neutral', text: 'Tracking ended' }
  if (phase === 'error') return { tone: 'warning', text: 'Status unavailable' }
  if (phase === 'loading') return { tone: 'neutral', text: 'Checking duty status…' }
  return { tone: 'neutral', text: 'Starting tracking…' }   // on_duty / on_break, tracker about to start
}

function makeIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 0 0 2px ${color},0 2px 8px rgba(0,0,0,0.4);"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -12],
  })
}

// Used only for the sync-log rows, whose status is the server-computed duty
// returned by update-location. The live duty display comes from useTodayDuty().
const DUTY_COLORS = {
  on_duty: { label: 'On Duty', color: 'var(--success-600)', bg: 'var(--success-50)' },
  on_break: { label: 'On Break', color: 'var(--warning-600)', bg: 'var(--warning-50)' },
  off_duty: { label: 'Off Duty', color: 'var(--slate-500)', bg: 'var(--slate-100)' },
}

export default function GPSTracking({ user }) {
  // This page is a VIEW. Continuous tracking is owned by the shared tracker
  // started in EnforcerDashboard (useEnforcerTracker), so mounting/unmounting
  // this component never starts or stops location reporting.
  const tracker = useTrackerState()
  // Shared current-duty source (today's EnforcerSchedule via /today-status/) --
  // identical to what the dashboard duty strip shows.
  const {
    display: currentDuty, reasonText: dutyReason, schedule: scheduleInfo,
    areaLabel, loading: dutyLoading, refresh: refreshDuty, phase,
  } = useTodayDuty(user?.id)
  const [expandedLogId, setExpandedLogId] = useState(null)
  // Re-evaluates badge freshness between syncs.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])

  const { position, accuracy, running: tracking, syncing, log: locationLog, permission, fixError } = tracker
  const lastSync = tracker.lastSyncAt ? new Date(tracker.lastSyncAt) : null
  const inZone = position
    ? getDistanceM(position[0], position[1], LUCENA_CENTER[0], LUCENA_CENTER[1]) <= ZONE_RADIUS_M
    : null
  const badge = gpsBadge(phase, tracker, now)
  const dutyUnavailable = phase === 'error'

  // Reverse-geocode new history rows once; the result is stored on the shared
  // tracker entry so it survives navigating away and back.
  useEffect(() => {
    locationLog.forEach((entry) => {
      if (entry.geoRequested) return
      annotateLogEntry(entry.id, { geoRequested: true })
      reverseGeocode(parseFloat(entry.lat), parseFloat(entry.lng), entry.accuracy).then(({ address, qualifier, fullAddress }) => {
        annotateLogEntry(entry.id, { geoState: address ? 'ready' : 'error', address, qualifier, fullAddress })
      })
    })
  }, [locationLog])

  const fmt = (t) => formatTime12h(t) || '—'

  const statusChips = [
    { label: 'Duty', value: currentDuty.label, color: currentDuty.color, bg: currentDuty.bg, icon: currentDuty.label === 'On Break' ? Coffee : Navigation2 },
    { label: 'Lucena center', value: inZone === null ? (tracking ? 'Locating…' : 'Paused') : inZone ? `Within ${ZONE_RADIUS_KM} km` : `Beyond ${ZONE_RADIUS_KM} km`, color: inZone === null ? 'var(--slate-500)' : inZone ? 'var(--success-600)' : 'var(--danger-600)', bg: inZone === null ? 'var(--slate-100)' : inZone ? 'var(--success-50)' : 'var(--danger-50)', icon: MapPin },
    { label: 'Accuracy', value: accuracy ? `±${Math.round(accuracy)}m` : (tracking ? 'Acquiring…' : '—'), color: accuracy && accuracy < 20 ? 'var(--success-600)' : 'var(--warning-600)', bg: 'var(--slate-50)', icon: Target },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PageHeader title="GPS Tracking" />
      {permission === 'denied' && (
        <div className="alert alert-danger" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span>⚠ Location permission required. Allow location access for this site in your browser or device settings to resume tracking.</span>
          <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={retryLocationPermission}>Check again</button>
        </div>
      )}
      {permission !== 'denied' && fixError && <div className="alert alert-danger">⚠ {fixError}</div>}
      {dutyUnavailable && (
        <div className="alert alert-warning">
          Duty status unavailable.{' '}
          {tracking
            ? 'Location tracking continues from the last known duty status until it can be confirmed.'
            : 'Tracking is not running until duty status can be confirmed.'}
        </div>
      )}

      {/* GPS badge row: reflects the shared tracker's real state, not "this page is open" */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div className={`badge ${badge.tone === 'live' ? 'badge-success' : badge.tone === 'danger' ? 'badge-danger' : badge.tone === 'warning' ? 'badge-warning' : 'badge-neutral'}`} style={{ padding: '6px 12px' }}>
          {badge.tone === 'live' && (
            <span className="gps-live-dot-local" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success-600)' }} />
          )}
          {badge.text}
        </div>
        {lastSync && tracking && (
          <span className="text-caption">
            {syncing ? 'Syncing…' : `Synced ${lastSync.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })}`}
          </span>
        )}
      </div>

      {/* Map — full width, top of page */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <MapContainer center={position || LUCENA_CENTER} zoom={15} style={{ height: 260, width: '100%' }} key={position ? 'located' : 'default'} scrollWheelZoom={false} dragging={false}>
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
          {position && (
            <>
              <Marker position={position} icon={makeIcon(currentDuty.color)}>
                <Popup>
                  <div style={{ fontFamily: 'var(--font-family)', minWidth: 160 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{user?.full_name || 'You'}</div>
                    <div style={{ fontSize: 11, color: 'var(--slate-600)', marginBottom: 6 }}>{areaLabel}</div>
                    <span style={{ padding: '2px 8px', borderRadius: 10, background: currentDuty.bg, color: currentDuty.color, fontSize: 11, fontWeight: 700 }}>{currentDuty.label}</span>
                    {lastSync && <div style={{ fontSize: 10, color: 'var(--slate-400)', marginTop: 6 }}>Last sync: {lastSync.toLocaleTimeString('en-PH')}</div>}
                  </div>
                </Popup>
              </Marker>
              {accuracy && <Circle center={position} radius={accuracy} pathOptions={{ color: currentDuty.color, fillOpacity: 0.1, weight: 1 }} />}
            </>
          )}
        </MapContainer>
        <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--slate-100)' }}>
          <p className="text-caption" style={{ margin: 0 }}>
            {position
              ? `${position[0].toFixed(5)}, ${position[1].toFixed(5)}`
              : tracking ? 'Acquiring GPS signal…'
              : permission === 'denied' ? 'Location permission required'
              : 'Tracking paused'}
          </p>
          <button
            className="btn btn-secondary btn-sm"
            onClick={syncNow}
            disabled={!tracking || syncing}
            title={tracking ? 'Send your location now' : 'Available only while on duty or on break'}
          >
            <RefreshCw size={12} /> Sync Now
          </button>
        </div>
        {!tracking && (
          <p className="text-caption" style={{ margin: 0, padding: '0 14px 10px' }}>
            Sync Now is available only while you are on duty or on break.
          </p>
        )}
      </div>

      {/* Status chips — horizontal scroll on narrow screens */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {statusChips.map(s => {
          const Icon = s.icon
          return (
            <div key={s.label} className="card" style={{ padding: '10px 8px', textAlign: 'center' }}>
              <Icon size={14} color={s.color} style={{ marginBottom: 5 }} />
              <div style={{ fontSize: 11, fontWeight: 700, color: s.color, lineHeight: 1.2 }}>{s.value}</div>
              <div style={{ fontSize: 9, color: 'var(--slate-500)', fontWeight: 600, textTransform: 'uppercase', marginTop: 2 }}>{s.label}</div>
            </div>
          )
        })}
      </div>

      {/* Today's duty status */}
      <div className="card card-padded">
        <p className="text-title" style={{ fontSize: 13, marginBottom: 12 }}>Today's Duty Status</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 'var(--radius-md)', background: currentDuty.bg, border: `1.5px solid ${currentDuty.color}33`, marginBottom: 10 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: currentDuty.color, flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: currentDuty.color }}>{currentDuty.label}</div>
            <div className="text-caption" style={{ marginTop: 2 }}>{dutyReason}</div>
          </div>
        </div>

        {scheduleInfo && (
          <div style={{ padding: '10px 12px', background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', fontSize: 12 }}>
            <div style={{ fontWeight: 700, color: 'var(--slate-700)', marginBottom: 6 }}>Today's Schedule</div>
            <div style={{ color: 'var(--slate-600)', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span>🕐 Shift: {fmt(scheduleInfo.shift_start)} – {fmt(scheduleInfo.shift_end)}</span>
              {scheduleInfo.break_start && <span>☕ Break: {fmt(scheduleInfo.break_start)} – {fmt(scheduleInfo.break_end)}</span>}
              <span>📍 Area: {areaLabel}</span>
            </div>
          </div>
        )}

        <button className="btn btn-secondary btn-sm" style={{ width: '100%', marginTop: 10 }} onClick={refreshDuty} disabled={dutyLoading}>
          <RefreshCw size={12} /> Refresh Status
        </button>
      </div>

      {/* Assigned area */}
      <div className="card card-padded">
        <p className="text-title" style={{ fontSize: 13, marginBottom: 10 }}>My Assigned Area</p>
        <div style={{ padding: '10px 14px', background: 'var(--slate-50)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--navy-700)' }}>📍 {areaLabel}</div>
          <div className="text-caption" style={{ marginTop: 4 }}>Lucena City, Quezon Province</div>
        </div>
        <div style={{ marginTop: 10, padding: '8px 12px', background: inZone === false ? 'var(--danger-50)' : inZone ? 'var(--success-50)' : 'var(--slate-50)', borderRadius: 'var(--radius-md)', fontSize: 12, fontWeight: 700, color: inZone === false ? 'var(--danger-600)' : inZone ? 'var(--success-700)' : 'var(--slate-600)' }}>
          {inZone === null && (tracking ? '📡 Acquiring GPS…' : 'Location check is paused while tracking is off.')}
          {inZone === true && `✓ Within ${ZONE_RADIUS_KM} km of Lucena City center`}
          {inZone === false && `⚠ More than ${ZONE_RADIUS_KM} km from Lucena City center`}
        </div>
        <div className="text-caption" style={{ marginTop: 6 }}>
          Location check is distance from Lucena City center only. It does not verify your scheduled area.
        </div>
      </div>

      {/* Location history */}
      <div className="card card-padded">
        <p className="text-title" style={{ fontSize: 13, marginBottom: 10 }}>Location History</p>
        {locationLog.length === 0 ? (
          <p className="text-caption" style={{ textAlign: 'center', padding: '16px 0' }}>Waiting for first sync…</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {locationLog.map((log) => {
              const isExpanded = expandedLogId === log.id
              // Primary display line: the human-readable place, never the
              // raw coordinates. Falls back gracefully while resolving or
              // if geocoding fails.
              const primaryText =
                log.geoState === 'ready' && log.address
                  ? log.address
                  : log.geoState === 'error'
                  ? `${log.lat}, ${log.lng}` // fallback — geocoding unavailable
                  : null // loading — shown as a skeleton below
              const qualifierText = log.geoState === 'ready' && log.address ? log.qualifier : (log.geoState === 'error' ? 'Coordinates only' : null)

              return (
                <div key={log.id} style={{ borderRadius: 'var(--radius-md)', border: '1px solid var(--slate-100)', overflow: 'hidden' }}>
                  <button
                    onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                    style={{ width: '100%', textAlign: 'left', padding: '8px 10px', background: 'var(--slate-50)', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3 }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--slate-950)' }}>
                        {log.time.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="text-caption">±{log.accuracy}m</span>
                        <ChevronDown size={13} color="var(--slate-400)" style={{ transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                      </div>
                    </div>

                    {primaryText ? (
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--navy-700)' }}>
                        📍 {qualifierText && <span style={{ fontWeight: 500, color: 'var(--slate-500)' }}>{qualifierText}: </span>}
                        {primaryText}
                      </div>
                    ) : (
                      <div className="skeleton" style={{ height: 13, width: '70%', borderRadius: 4 }} />
                    )}

                    <div className="mono" style={{ fontSize: 9, color: 'var(--slate-400)' }}>
                      GPS: {log.lat}, {log.lng} · Accuracy: ±{log.accuracy}m
                    </div>
                  </button>

                  {isExpanded && (
                    <div style={{ padding: '10px 12px', borderTop: '1px solid var(--slate-100)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div>
                        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--slate-500)', textTransform: 'uppercase', marginBottom: 2 }}>
                          {log.geoState === 'ready' ? (log.qualifier || 'Detected Location') : 'Detected Location'}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--slate-800)' }}>
                          {log.geoState === 'loading' && 'Resolving address…'}
                          {log.geoState === 'error' && 'Address unavailable — showing coordinates only.'}
                          {log.geoState === 'ready' && (log.fullAddress || log.address || '—')}
                        </div>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11 }}>
                        <div>
                          <div style={{ color: 'var(--slate-500)', fontWeight: 700, fontSize: 9, textTransform: 'uppercase' }}>Coordinates</div>
                          <div className="mono" style={{ color: 'var(--slate-800)' }}>{log.lat}, {log.lng}</div>
                        </div>
                        <div>
                          <div style={{ color: 'var(--slate-500)', fontWeight: 700, fontSize: 9, textTransform: 'uppercase' }}>Accuracy</div>
                          <div style={{ color: 'var(--slate-800)' }}>±{log.accuracy}m</div>
                        </div>
                        <div>
                          <div style={{ color: 'var(--slate-500)', fontWeight: 700, fontSize: 9, textTransform: 'uppercase' }}>Timestamp</div>
                          <div style={{ color: 'var(--slate-800)' }}>{log.time.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'medium' })}</div>
                        </div>
                        <div>
                          <div style={{ color: 'var(--slate-500)', fontWeight: 700, fontSize: 9, textTransform: 'uppercase' }}>Duty Status</div>
                          <div style={{ color: 'var(--slate-800)' }}>{DUTY_COLORS[log.status]?.label || log.status}</div>
                        </div>
                      </div>

                      <div style={{ borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid var(--slate-100)' }}>
                        <MapContainer
                          center={[parseFloat(log.lat), parseFloat(log.lng)]}
                          zoom={16}
                          style={{ height: 140, width: '100%' }}
                          scrollWheelZoom={false}
                          dragging={false}
                          zoomControl={false}
                          attributionControl={false}
                        >
                          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                          <Marker position={[parseFloat(log.lat), parseFloat(log.lng)]} icon={makeIcon(DUTY_COLORS[log.status]?.color || 'var(--slate-500)')} />
                          <Circle center={[parseFloat(log.lat), parseFloat(log.lng)]} radius={log.accuracy} pathOptions={{ color: 'var(--slate-500)', fillOpacity: 0.08, weight: 1 }} />
                        </MapContainer>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <style>{`
        .gps-live-dot-local { animation: gps-pulse-local 2s infinite; }
        @keyframes gps-pulse-local { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </div>
  )
}