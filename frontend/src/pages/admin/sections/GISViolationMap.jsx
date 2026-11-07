import { useState, useEffect, useCallback } from 'react'
import PageHeader from '../../../components/ui/PageHeader'
import { MapContainer, TileLayer, useMap, CircleMarker, Tooltip, Marker, Polygon } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  Map, AlertCircle, Flame, ZoomIn, ZoomOut, Locate, Users, Shield
} from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { Spinner } from '../../../components/ui/States'
import './GISViolationMap.css'

/* ─── constants ─────────────────────────────────────────────── */
const LUCENA = [13.9322, 121.6170]

// TMEO operational coverage boundary — based on the sector map (Sectors 1–11)
// Covers the downtown Lucena City grid bounded by:
// Carmelite Road (north), Buenaac River (east), Doña Nena St (south), Malvar St (west)
const TMEO_BOUNDARY = [
  [13.9430, 121.6080], // NW — near Carmelite Road / Malvar area
  [13.9435, 121.6130], // N  — Carmelite Road
  [13.9425, 121.6195], // NE — Sector 11 / Region area
  [13.9395, 121.6245], // E  — Bum Acaa River / Sector 2/4/6
  [13.9330, 121.6260], // SE — Sector 9/10 east edge
  [13.9255, 121.6230], // SE corner — Doña Nena area
  [13.9230, 121.6175], // S  — Sector 8 bottom
  [13.9240, 121.6100], // SW — Leon Guinto / Layos area
  [13.9280, 121.6065], // W  — Malvar / Sector 7
  [13.9355, 121.6055], // NW — Sector 3/5 west edge
  [13.9410, 121.6060], // NW — Sector 1 west
  [13.9430, 121.6080], // close
]

const ENFORCER_STATUS = {
  active:   { label: 'On Duty',  color: '#10b981', ring: '#6ee7b7' },
  on_break: { label: 'On Break', color: '#f59e0b', ring: '#fcd34d' },
  inactive: { label: 'Off Duty', color: '#94a3b8', ring: '#cbd5e1' },
  on_duty:  { label: 'On Duty',  color: '#10b981', ring: '#6ee7b7' },
  off_duty: { label: 'Off Duty', color: '#94a3b8', ring: '#cbd5e1' },
}

/* ─── helpers ───────────────────────────────────────────────── */
const getEnfStatus = s => ENFORCER_STATUS[(s || '').toLowerCase().replace(' ', '_')] || ENFORCER_STATUS.inactive

/* ─── heatmap layer — reference-style gradient ───────────────── */
function ClusteredViolationMarkers({ points }) {
  const clusters = {}
  points.forEach(v => {
    const lat = parseFloat(v.latitude)
    const lng = parseFloat(v.longitude)
    if (isNaN(lat) || isNaN(lng)) return
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`
    if (!clusters[key]) clusters[key] = { lat, lng, count: 0, locations: [] }
    clusters[key].count++
    if (v.location) clusters[key].locations.push(v.location)
  })

  return Object.entries(clusters).map(([key, c]) => {
    const color = c.count >= 15 ? '#dc2626'
                : c.count >= 8  ? '#ea580c'
                : c.count >= 4  ? '#f59e0b'
                :                 '#16a34a'

    const radius = c.count >= 15 ? 22
                 : c.count >= 8  ? 17
                 : c.count >= 4  ? 13
                 :                  9

    const topLoc = c.locations[0] || 'Unknown location'
    const level  = c.count >= 15 ? 'Critical'
                 : c.count >= 8  ? 'High'
                 : c.count >= 4  ? 'Moderate'
                 :                 'Low'

    return (
      <CircleMarker
        key={key}
        center={[c.lat, c.lng]}
        radius={radius}
        pathOptions={{ color: '#fff', weight: 2, fillColor: color, fillOpacity: 0.85 }}
      >
        <Tooltip direction="top" offset={[0, -radius]} opacity={1}>
          <div style={{ fontFamily: 'var(--font-family)', padding: '8px 12px', fontSize: 12, minWidth: 160 }}>
            <div style={{ fontWeight: 700, color: 'var(--slate-950)', marginBottom: 4 }}>{topLoc}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
              <span style={{ fontWeight: 700, color }}>{level} Risk</span>
            </div>
            <div style={{ color: 'var(--slate-600)', fontSize: 11 }}>
              {c.count} violation{c.count !== 1 ? 's' : ''} in this area
            </div>
          </div>
        </Tooltip>
      </CircleMarker>
    )
  })
}

/* ─── TMEO coverage polygon ──────────────────────────────────── */
function TMEOBoundary() {
  return (
    <Polygon
      positions={TMEO_BOUNDARY}
      pathOptions={{
        color: '#2563eb',
        weight: 2.5,
        opacity: 0.8,
        fillColor: '#3b82f6',
        fillOpacity: 0.07,
        dashArray: '6 4',
      }}
    >
      <Tooltip sticky direction="top" opacity={1}>
        <div style={{ fontFamily: 'var(--font-family)', padding: '6px 10px', fontSize: 12 }}>
          <div style={{ fontWeight: 700, color: 'var(--blue-700)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Shield size={12} /> TMEO Operational Coverage
          </div>
          <div style={{ color: 'var(--slate-600)', marginTop: 2, fontSize: 11 }}>Lucena City — Sectors 1–11</div>
        </div>
      </Tooltip>
    </Polygon>
  )
}

/* ─── enforcer icon ──────────────────────────────────────────── */
const makeEnforcerIcon = (e) => {
  const name = e.enforcer_detail?.full_name || e.full_name || e.username || '?'
  const cfg  = getEnfStatus(e.status || e.duty_status)
  const ini  = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  return L.divIcon({
    className: '',
    html: `<div style="
      width:36px;height:36px;border-radius:50%;
      background:${cfg.color};border:3px solid #fff;
      box-shadow:0 0 0 2px ${cfg.color},0 2px 10px rgba(0,0,0,0.25);
      display:flex;align-items:center;justify-content:center;
      font-size:11px;font-weight:700;color:#fff;
      font-family:var(--font-family);
    ">${ini}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -22],
  })
}

/* ─── enforcer live markers ──────────────────────────────────── */
const EnforcerMarkers = ({ enforcers }) => {
  return enforcers.map((e, i) => {
    const lat  = parseFloat(e.latitude || e.lat)
    const lng  = parseFloat(e.longitude || e.lng || e.lon)
    if (isNaN(lat) || isNaN(lng)) return null
    const name       = e.enforcer_detail?.full_name || e.enforcer_name || e.full_name || e.username || '—'
    const badge      = e.enforcer_detail?.badge_number || '—'
    const area       = e.enforcer_detail?.assigned_area || '—'
    const phone      = e.enforcer_detail?.phone_number || '—'
    const employment = e.enforcer_detail?.employment_status_display || '—'
    const cfg        = getEnfStatus(e.status || e.duty_status)
    const lastPing   = e.updated_at
      ? new Date(e.updated_at).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '—'
    return (
      <Marker key={e.id ?? i} position={[lat, lng]} icon={makeEnforcerIcon(e)}>
        <Tooltip direction="top" offset={[0, -20]} opacity={1} permanent={false}>
          <div style={{ fontFamily: 'var(--font-family)', padding: '10px 14px', fontSize: 12, minWidth: 210 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--slate-200)' }}>
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: cfg.color + '22', border: `2px solid ${cfg.color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: cfg.color, flexShrink: 0 }}>
                {name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div style={{ fontWeight: 700, color: 'var(--slate-950)', fontSize: 13 }}>{name}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: cfg.color, display: 'inline-block' }} />
                  <span style={{ color: cfg.color, fontWeight: 600, fontSize: 11 }}>{cfg.label}</span>
                </div>
              </div>
            </div>
            {[
              ['Badge',       badge],
              ['Area',        area],
              ['Phone',       phone],
              ['Status',      employment],
              ['Coordinates', `${lat.toFixed(5)}, ${lng.toFixed(5)}`],
              ['Last ping',   lastPing],
            ].map(([label, val]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, padding: '3px 0' }}>
                <span style={{ color: 'var(--slate-400)', fontSize: 11 }}>{label}</span>
                <span style={{ color: 'var(--slate-950)', fontWeight: 600, fontSize: 11, textAlign: 'right' }}>{val}</span>
              </div>
            ))}
          </div>
        </Tooltip>
      </Marker>
    )
  })
}

/* ─── lock map view — prevent auto-fit on marker load ───────── */
function LockView() {
  const map = useMap()
  useEffect(() => {
    map.setView(LUCENA, 14)
    map.setMaxBounds([[13.88, 121.57], [13.99, 121.67]])
  }, [map])
  return null
}

/* ─── map controls ───────────────────────────────────────────── */
const MapControls = () => {
  const map = useMap()
  return (
    <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 800, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button className="map-ctrl-btn" title="Zoom In" onClick={() => map.zoomIn()}><ZoomIn size={16} /></button>
      <button className="map-ctrl-btn" title="Zoom Out" onClick={() => map.zoomOut()}><ZoomOut size={16} /></button>
      <button className="map-ctrl-btn" title="Reset View" onClick={() => map.setView(LUCENA, 14)}><Locate size={16} /></button>
    </div>
  )
}

/* ─── map overlay info ───────────────────────────────────────── */
const MapOverlay = ({ count, topZone, enforcerCount }) => (
  <div style={{
    position: 'absolute', top: 12, left: 12, zIndex: 800,
    background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(8px)',
    borderRadius: 'var(--radius-lg)', padding: '12px 16px', boxShadow: 'var(--shadow-lg)',
    border: '1px solid var(--color-border)', minWidth: 170
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
      <div className="gis-live-dot" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--danger-500)' }} />
      <span className="text-label">Heatmap</span>
    </div>
    <div className="text-display" style={{ fontSize: 26 }}>{count}</div>
    <div className="text-caption" style={{ marginTop: 2 }}>violation{count !== 1 ? 's' : ''} plotted</div>
    {enforcerCount > 0 && (
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--slate-100)' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--success-600)' }}>{enforcerCount} enforcer{enforcerCount !== 1 ? 's' : ''} on map</div>
      </div>
    )}
    {topZone && (
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--slate-100)' }}>
        <div className="text-label" style={{ fontSize: 10 }}>Top Hotspot</div>
        <div className="u-truncate" style={{ fontSize: 12, fontWeight: 600, color: 'var(--danger-600)', marginTop: 2, maxWidth: 140 }}>{topZone}</div>
      </div>
    )}
  </div>
)

/* ─── heatmap legend — matches new gradient ──────────────────── */
const HeatLegend = () => (
  <div style={{
    position: 'absolute', bottom: 16, left: 12, zIndex: 800,
    background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(8px)',
    borderRadius: 'var(--radius-md)', padding: '10px 14px', boxShadow: 'var(--shadow-md)',
    border: '1px solid var(--color-border)'
  }}>
    <div className="text-label" style={{ marginBottom: 8 }}>Violation Density</div>
    {[
      { color: '#dc2626', label: 'Critical', range: '15+ violations' },
      { color: '#ea580c', label: 'High',     range: '8–14 violations' },
      { color: '#f59e0b', label: 'Moderate', range: '4–7 violations' },
      { color: '#16a34a', label: 'Low',      range: '1–3 violations' },
    ].map(({ color, label, range }) => (
      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
        <div style={{ width: 12, height: 12, borderRadius: '50%', background: color, flexShrink: 0, border: '2px solid #fff', boxShadow: `0 0 0 1px ${color}` }} />
        <div>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--slate-950)' }}>{label}</span>
          <span style={{ fontSize: 10, color: 'var(--slate-400)', marginLeft: 5 }}>{range}</span>
        </div>
      </div>
    ))}
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--slate-100)', display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 20, height: 2, borderRadius: 2, background: 'var(--blue-600)', borderTop: '2px dashed var(--blue-600)' }} />
      <span style={{ fontSize: 9, color: 'var(--blue-600)', fontWeight: 600 }}>TMEO Coverage</span>
    </div>
  </div>
)

/* ─── header info pill ───────────────────────────────────────── */
const HeaderPill = ({ icon, tone = 'info', children, live = false }) => {
  const Icon = icon
  return (
    <div className={`badge badge-${tone}`} style={{ padding: '8px 14px', fontSize: 12 }}>
      {live ? <span className="gis-live-dot" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success-600)' }} /> : <Icon size={12} />}
      {children}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════════════════════════ */
export default function GISViolationMap() {
  const [violations, setViolations] = useState([])
  const [enforcers, setEnforcers]   = useState([])
  const [loading, setLoading]       = useState(true)

  // Only plot points within Lucena City bounds — prevents map from zooming out to wrong coords
  const inBounds = (lat, lng) => lat >= 13.9240 && lat <= 13.9430 && lng >= 121.6065 && lng <= 121.6245
  const gpsViolations   = violations.filter(v => {
    const lat = parseFloat(v.latitude), lng = parseFloat(v.longitude)
    return v.latitude && v.longitude && inBounds(lat, lng)
  })
  const mappedEnforcers = enforcers.filter(e => {
    const lat = parseFloat(e.latitude || e.lat)
    const lng = parseFloat(e.longitude || e.lng || e.lon)
    return !isNaN(lat) && !isNaN(lng) && inBounds(lat, lng)
  })

  const topZone = (() => {
    if (!violations.length) return null
    const freq = {}
    violations.forEach(v => { const z = v.location; if (z) freq[z] = (freq[z] || 0) + 1 })
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]
    return top ? top[0] : null
  })()

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get(`${API.VIOLATIONS}?page_size=1000`).catch(() => ({ data: [] }))
      const mapData = res.data
      setViolations(Array.isArray(mapData) ? mapData : mapData.results ?? [])
    } catch (err) {
      console.error('[GISViolationMap] fetchData failed:', err)
      setViolations([])
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchEnforcers = useCallback(async () => {
    try {
      const res = await api.get('/api/enforcers/live-locations/').catch(() => null)
      if (!res) return
      const d = res.data
      setEnforcers(Array.isArray(d) ? d : d.results ?? [])
    } catch (err) {
      console.error('[GISViolationMap] fetchEnforcers failed:', err)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern, matches existing codebase convention
    fetchData()
  }, [fetchData])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchEnforcers()
  }, [fetchEnforcers])

  useEffect(() => {
    const id = setInterval(fetchEnforcers, 15000)
    return () => clearInterval(id)
  }, [fetchEnforcers])

  useEffect(() => {
    const id = setInterval(fetchData, 30000)
    return () => clearInterval(id)
  }, [fetchData])

  return (
    <div>
      {/* ── PAGE HEADER ── */}
      <PageHeader
        title="GIS Violation Map"
        action={(
          <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <HeaderPill icon={Shield} tone="info">TMEO Coverage Active</HeaderPill>
            <HeaderPill tone="success" live>Live · 15s refresh</HeaderPill>
            <HeaderPill icon={Users} tone="info">{mappedEnforcers.length} enforcer{mappedEnforcers.length !== 1 ? 's' : ''} on duty</HeaderPill>
          </div>
      
          </>
        )}
      />

      {/* ── MAP CARD ── */}
      <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ position: 'relative', height: 520 }}>
          <MapContainer
            center={LUCENA}
            zoom={14}
            minZoom={13}
            maxZoom={17}
            maxBounds={[
              [13.88, 121.57],
              [13.99, 121.67],
            ]}
            maxBoundsViscosity={1.0}
            style={{ height: '100%', width: '100%' }}
            zoomControl={false}
            attributionControl={false}
            scrollWheelZoom={false}
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution=""
            />
            <LockView />
            <MapControls />

            {/* TMEO boundary polygon — always visible */}
            <TMEOBoundary />

            {gpsViolations.length > 0 && (
              <ClusteredViolationMarkers points={gpsViolations} />
            )}

            <EnforcerMarkers enforcers={mappedEnforcers} />
          </MapContainer>

          <MapOverlay
            count={gpsViolations.length}
            topZone={topZone}
            enforcerCount={mappedEnforcers.length}
          />

          <HeatLegend />

          {!loading && gpsViolations.length === 0 && (
            <div style={{
              position: 'absolute', bottom: 16, right: 16, zIndex: 800,
              background: 'rgba(255,255,255,0.96)', borderRadius: 'var(--radius-md)', padding: '10px 14px',
              border: '1px solid var(--warning-100)', boxShadow: 'var(--shadow-sm)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--warning-700)' }}>
                <AlertCircle size={14} color="var(--warning-600)" />
                <span>No GPS-tagged violations yet. Heatmap requires lat/lng data.</span>
              </div>
            </div>
          )}

          {loading && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 900,
              background: 'rgba(248,250,252,0.7)', backdropFilter: 'blur(2px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <div className="card" style={{ padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <Spinner size={16} />
                <span className="text-title">Loading map data…</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── HOTSPOT SUMMARY CARDS ── */}
      {violations.length > 0 && (() => {
        const freq = {}
        violations.forEach(v => { const z = v.location; if (z) freq[z] = (freq[z] || 0) + 1 })
        const top5 = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5)
        const max  = top5[0]?.[1] || 1
        return top5.length > 0 ? (
          <div className="card card-padded">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <Flame size={16} color="var(--danger-500)" />
              <span className="text-title" style={{ fontSize: 15 }}>Top Violation Hotspots</span>
              <span className="text-caption">by location frequency</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
              {top5.map(([area, count], i) => (
                <div key={area} style={{
                  background: i === 0 ? 'var(--danger-50)' : 'var(--slate-50)',
                  border: `1px solid ${i === 0 ? 'var(--danger-100)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-md)', padding: '12px 14px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span className="u-truncate" style={{ fontSize: 12, fontWeight: 700, color: 'var(--slate-950)', maxWidth: 160 }}>
                      {i === 0 && <Flame size={11} color="var(--danger-500)" style={{ marginRight: 4, display: 'inline', verticalAlign: -1 }} />}{area}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: i === 0 ? 'var(--danger-600)' : 'var(--slate-600)' }}>{count}</span>
                  </div>
                  <div style={{ height: 5, background: 'var(--slate-200)', borderRadius: 'var(--radius-full)' }}>
                    <div style={{
                      width: `${(count / max) * 100}%`, height: '100%',
                      background: i === 0 ? 'var(--danger-500)' : 'var(--slate-400)',
                      borderRadius: 'var(--radius-full)'
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null
      })()}
    </div>
  )
}