import { useState, useEffect, useCallback, useRef } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import { MapContainer, TileLayer, useMap, Marker, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  Navigation2, Users, ShieldCheck, Coffee, UserX,
  ZoomIn, ZoomOut, Locate, RefreshCw, Clock, Radio,
} from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { colors } from '../../../styles/theme'
import Button from '../../../components/ui/Button'
import StatCard from '../../../components/ui/StatCard'
import Badge, { StatusBadge } from '../../../components/ui/Badge'
import { EmptyState } from '../../../components/ui/States'
import './GPSEnforcerTracking.css'

/* ─── status config ─────────────────────────────────────────── */
const STATUS_COLOR = {
  on_duty:  colors.success[600],
  on_break: colors.warning[600],
  off_duty: colors.slate[500],
}
const normalizeStatus = s => (s || '').toLowerCase().replace(' ', '_')
const getColor = s => STATUS_COLOR[normalizeStatus(s)] || STATUS_COLOR.off_duty

/* ─── helpers ───────────────────────────────────────────────── */
const initials = n => n ? n.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase() : '?'
const fmtTime = ts => {
  if (!ts) return '—'
  const d = new Date(ts)
  if (isNaN(d)) return ts
  return d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })
}

/* ─── custom divIcon per enforcer ───────────────────────────── */
const makeIcon = (enforcer) => {
  const color = getColor(enforcer.status)
  const label = initials(enforcer.name || enforcer.full_name || enforcer.username)
  return L.divIcon({
    className: '',
    html: `
      <div style="
        width:38px;height:38px;border-radius:50%;
        background:${color};color:#fff;
        display:flex;align-items:center;justify-content:center;
        font-family:var(--font-family);font-size:13px;font-weight:700;
        border:3px solid #fff;
        box-shadow:0 2px 10px rgba(0,0,0,0.18),0 0 0 3px ${color}55;
        cursor:pointer;
      ">${label}</div>
    `,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
  })
}

/* ─── map fly-to helper ─────────────────────────────────────── */
const LUCENA = [13.9322, 121.6170]
const FlyTo = ({ target }) => {
  const map = useMap()
  useEffect(() => {
    if (target) map.flyTo(target, 16, { duration: 1.2 })
  }, [target, map])
  return null
}

/* ─── custom map controls ────────────────────────────────────── */
const MapControls = ({ onReset }) => {
  const map = useMap()
  return (
    <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 800, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button className="map-ctrl-btn" title="Zoom In" onClick={() => map.zoomIn()}><ZoomIn size={16} /></button>
      <button className="map-ctrl-btn" title="Zoom Out" onClick={() => map.zoomOut()}><ZoomOut size={16} /></button>
      <button className="map-ctrl-btn" title="Reset View" onClick={() => { map.setView(LUCENA, 14); onReset?.() }}><Locate size={16} /></button>
    </div>
  )
}

/* ─── enforcer markers layer ─────────────────────────────────── */
const EnforcerMarkers = ({ enforcers, onSelect }) => {
  return enforcers.map((e, i) => {
    const lat = parseFloat(e.latitude || e.lat)
    const lng = parseFloat(e.longitude || e.lng || e.lon)
    if (isNaN(lat) || isNaN(lng)) return null
    const name = e.name || e.full_name || e.username || '—'
    return (
      <Marker key={e.id ?? i} position={[lat, lng]} icon={makeIcon(e)}
        eventHandlers={{ click: () => onSelect(e) }}>
        <Tooltip direction="top" offset={[0, -22]} opacity={1} className="gps-tooltip">
          <div style={{ fontFamily: 'var(--font-family)', padding: '8px 12px', minWidth: 140 }}>
            <div style={{ fontWeight: 700, color: 'var(--slate-950)', fontSize: 13 }}>{name}</div>
            <div style={{ marginTop: 5 }}><StatusBadge status={normalizeStatus(e.status)} /></div>
            {e.last_seen && <div style={{ fontSize: 11, color: 'var(--slate-400)', marginTop: 5 }}>Last seen {fmtTime(e.last_seen)}</div>}
          </div>
        </Tooltip>
      </Marker>
    )
  })
}

/* ══════════════════════════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════════════════════════ */
export default function GPSEnforcerTracking() {
  const [enforcers, setEnforcers]   = useState([])
  const [loading, setLoading]       = useState(true)
  const [activeTab, setActiveTab]   = useState('all')
  const [flyTarget, setFlyTarget]   = useState(null)
  const [selectedEnf, setSelectedEnf] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(new Date())
  const [countdown, setCountdown]   = useState(15)
  const timerRef = useRef(null)

  const fetchEnforcers = useCallback(async () => {
    setLoading(true)
    try {
      // Enforcer profiles (id, name, badge, duty_status, ...) and real-time
      // GPS coordinates live in two different records — EnforcerLocation is
      // only created once an enforcer has actually sent a location update
      // (see UpdateLocationView / GPSTracking.jsx). Fetch both and merge by
      // enforcer id so the panel keeps listing every enforcer (duty-status
      // counts/tabs stay correct) while the map only gets a marker for
      // enforcers who have real coordinates on file.
      const [profileRes, locationRes] = await Promise.all([
        api.get(`${API.ENFORCERS || '/api/enforcers/'}?page_size=200`),
        api.get('/api/enforcers/live-locations/').catch(() => null),
      ])
      const d = profileRes.data
      const profiles = Array.isArray(d) ? d : d.results ?? []

      const locationByEnforcerId = {}
      if (Array.isArray(locationRes?.data)) {
        locationRes.data.forEach(loc => { locationByEnforcerId[loc.enforcer] = loc })
      }

      const merged = profiles.map(p => {
        const loc = locationByEnforcerId[p.id]
        return {
          ...p,
          // UserSerializer calls this field "duty_status"; the status
          // coloring/tabs/counts below were written for on_duty/on_break/
          // off_duty, so alias it to the "status" key they read.
          status: p.duty_status,
          latitude: loc?.latitude,
          longitude: loc?.longitude,
          last_seen: loc?.updated_at,
        }
      })

      setEnforcers(merged)
      setLastRefresh(new Date())
      setCountdown(15)
    } catch {
      setEnforcers([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern, matches existing codebase convention
    fetchEnforcers()
  }, [fetchEnforcers])

  /* auto-refresh every 15s */
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { fetchEnforcers(); return 15 }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(timerRef.current)
  }, [fetchEnforcers])

  /* counts */
  const counts = {
    all:      enforcers.length,
    on_duty:  enforcers.filter(e => normalizeStatus(e.status) === 'on_duty').length,
    on_break: enforcers.filter(e => normalizeStatus(e.status) === 'on_break').length,
    off_duty: enforcers.filter(e => normalizeStatus(e.status) === 'off_duty').length,
  }

  const filtered = activeTab === 'all' ? enforcers : enforcers.filter(e => normalizeStatus(e.status) === activeTab)

  const handleEnforcerClick = (enf) => {
    const lat = parseFloat(enf.latitude || enf.lat)
    const lng = parseFloat(enf.longitude || enf.lng || enf.lon)
    if (!isNaN(lat) && !isNaN(lng)) setFlyTarget([lat, lng])
    setSelectedEnf(enf)
  }

  const TABS = [
    { key: 'all',      label: 'All',      color: colors.blue[600] },
    { key: 'on_duty',  label: 'On Duty',  color: colors.success[600] },
    { key: 'on_break', label: 'On Break', color: colors.warning[600] },
    { key: 'off_duty', label: 'Off Duty', color: colors.slate[500] },
  ]

  return (
    <div>
      {/* ── PAGE HEADER ── */}
      <PageHeader
        title="GPS Enforcer Tracking"
        action={(
          <>
          <Button variant="secondary" icon={RefreshCw} loading={loading} onClick={fetchEnforcers}>Refresh</Button>
      
          </>
        )}
      />

      {/* ── STAT CARDS ── */}
      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        <StatCard label="Total Enforcers" value={counts.all} accent="var(--blue-600)" icon={Users} />
        <StatCard label="On Duty" value={counts.on_duty} accent="var(--success-600)" icon={ShieldCheck} />
        <StatCard label="On Break" value={counts.on_break} accent="var(--warning-600)" icon={Coffee} />
        <StatCard label="Off Duty" value={counts.off_duty} accent="var(--slate-500)" icon={UserX} />
      </div>

      {/* ── MAIN CONTENT: MAP + PANEL ── */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* ── MAP CARD ── */}
        <div className="card" style={{ flex: '1 1 560px', overflow: 'hidden' }}>

          {/* tab bar above map */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--slate-100)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {TABS.map(tab => {
              const isActive = activeTab === tab.key
              return (
                <button
                  key={tab.key} onClick={() => setActiveTab(tab.key)} className="gps-tab"
                  style={isActive ? { background: tab.color, color: '#fff' } : undefined}
                >
                  {tab.label}
                  <span className="gps-tab-count" style={isActive ? { background: 'rgba(255,255,255,0.25)', color: '#fff' } : undefined}>{counts[tab.key]}</span>
                </button>
              )
            })}
          </div>

          {/* map */}
          <div style={{ position: 'relative', height: 480 }}>
            <MapContainer center={LUCENA} zoom={14} minZoom={12} maxZoom={17} maxBounds={[[13.9240, 121.6065], [13.9430, 121.6245]]} maxBoundsViscosity={1.0} style={{ height: '100%', width: '100%' }} zoomControl={false} attributionControl={false} scrollWheelZoom={false}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
              <MapControls onReset={() => setFlyTarget(null)} />
              <FlyTo target={flyTarget} />
              <EnforcerMarkers enforcers={filtered} onSelect={handleEnforcerClick} />
            </MapContainer>

            {/* live indicator */}
            <div style={{
              position: 'absolute', bottom: 12, left: 12, zIndex: 800,
              background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(8px)',
              borderRadius: 'var(--radius-full)', padding: '6px 14px', display: 'flex', alignItems: 'center',
              gap: 7, boxShadow: 'var(--shadow-md)', border: '1px solid var(--color-border)',
            }}>
              <span className="gps-live-dot" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success-500)', display: 'inline-block' }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--slate-700)' }}>Live</span>
              <span className="text-caption">· refreshes in {countdown}s</span>
            </div>

            {/* loading overlay */}
            {loading && (
              <div style={{ position: 'absolute', inset: 0, zIndex: 900, background: 'rgba(248,250,252,0.75)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="card" style={{ padding: '14px 22px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="spinner" style={{ width: 15, height: 15 }} />
                  <span className="text-title">Loading enforcers…</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── ENFORCER LIST PANEL ── */}
        <div className="card" style={{ flex: '1 1 320px', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: 546 }}>

          {/* panel header */}
          <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--slate-100)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <Radio size={16} color="var(--blue-600)" />
              <h2 className="text-title" style={{ fontSize: 14 }}>Enforcer Status</h2>
              <Badge tone="info" dot={false}>{filtered.length}</Badge>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span className="gps-live-dot" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success-500)', display: 'inline-block' }} />
              <span className="text-caption">Live</span>
            </div>
          </div>

          {/* enforcer list */}
          <div style={{ overflowY: 'auto', flex: 1, padding: 6 }}>
            {loading ? (
              Array(5).fill(0).map((_, i) => (
                <div key={i} style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div className="skeleton" style={{ width: 40, height: 40, borderRadius: '50%', flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div className="skeleton" style={{ height: 12, width: '60%', marginBottom: 8 }} />
                    <div className="skeleton" style={{ height: 10, width: '40%' }} />
                  </div>
                </div>
              ))
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={Users} title="No enforcers found"
                message={activeTab === 'all' ? 'Enforcers will appear here once active.' : `No enforcers currently ${activeTab.replace('_', ' ')}.`}
              />
            ) : (
              filtered.map((enf, idx) => {
                const color = getColor(enf.status)
                const name = enf.name || enf.full_name || enf.username || '—'
                const isSel = selectedEnf?.id === enf.id
                return (
                  <div
                    key={enf.id ?? idx}
                    onClick={() => handleEnforcerClick(enf)}
                    className={`list-row ${isSel ? 'list-row--highlight' : ''}`}
                    style={{ cursor: 'pointer' }}
                  >
                    {/* avatar */}
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <div style={{
                        width: 40, height: 40, borderRadius: '50%',
                        background: color, color: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 14, fontWeight: 700,
                        boxShadow: `0 0 0 3px ${color}55`,
                      }}>{initials(name)}</div>
                      <span style={{
                        position: 'absolute', bottom: 1, right: 1,
                        width: 10, height: 10, borderRadius: '50%',
                        background: color, border: '2px solid #fff', display: 'block',
                      }} />
                    </div>

                    {/* info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="u-truncate" style={{ fontWeight: 700, color: isSel ? 'var(--blue-700)' : 'var(--slate-950)', fontSize: 13 }}>{name}</div>
                      <div style={{ fontSize: 11, color: 'var(--slate-400)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                        {enf.last_seen ? <><Clock size={10} />{fmtTime(enf.last_seen)}</> : <span>No location data</span>}
                      </div>
                    </div>

                    <StatusBadge status={normalizeStatus(enf.status)} />
                  </div>
                )
              })
            )}
          </div>

          {/* panel footer */}
          <div style={{ padding: '10px 18px', borderTop: '1px solid var(--slate-100)', flexShrink: 0, background: 'var(--slate-50)' }}>
            <p className="text-caption" style={{ textAlign: 'center', margin: 0 }}>
              Last updated: {lastRefresh.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}