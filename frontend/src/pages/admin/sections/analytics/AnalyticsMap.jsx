import { useMemo } from 'react'
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { Map as MapIcon } from 'lucide-react'
import { EmptyChart } from './AnalyticsPrimitives'

/* ─── constants ─────────────────────────────────────────────── */
const LUCENA = [13.9322, 121.6170]

const RISK_LEVELS = [
  { key: 'high',   label: 'High',   color: '#dc2626', min: 8 },
  { key: 'medium', label: 'Medium', color: '#f59e0b', min: 3 },
  { key: 'low',    label: 'Low',    color: '#16a34a', min: 0 },
]

const getRisk = (count) => RISK_LEVELS.find(r => count >= r.min) || RISK_LEVELS[RISK_LEVELS.length - 1]

/* ─── cluster raw points by rounded coordinate ─────────────── */
function clusterPoints(points) {
  const clusters = {}
  points.forEach(p => {
    const lat = parseFloat(p.latitude)
    const lng = parseFloat(p.longitude)
    if (isNaN(lat) || isNaN(lng)) return
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`
    if (!clusters[key]) clusters[key] = { lat, lng, count: 0, location: p.location || 'Unknown location' }
    clusters[key].count++
  })
  return Object.values(clusters)
}

/* ─── lock initial view — don't auto-fit / fight the parent scroll ── */
function LockView() {
  const map = useMap()
  map.setView(LUCENA, 13)
  return null
}

/* ─── legend ─────────────────────────────────────────────────── */
function MapLegend() {
  return (
    <div style={{
      position: 'absolute', bottom: 10, left: 10, zIndex: 800,
      background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(6px)',
      borderRadius: 'var(--radius-md)', padding: '8px 12px', boxShadow: 'var(--shadow-md)',
      border: '1px solid var(--color-border)',
    }}>
      {RISK_LEVELS.map(r => (
        <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: r.color, display: 'inline-block', border: '2px solid #fff', boxShadow: `0 0 0 1px ${r.color}` }} />
          <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--slate-950)' }}>{r.label}</span>
        </div>
      ))}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════
   AnalyticsMap — lightweight violation-hotspot mini map for the
   Analytics dashboard. Read-only, no live polling: it just plots
   whatever `points` (backend `map_points`) is passed in for the
   currently selected period/filters.
══════════════════════════════════════════════════════════════ */
export default function AnalyticsMap({ points = [] }) {
  const clusters = useMemo(() => clusterPoints(points), [points])

  if (clusters.length === 0) {
    return <EmptyChart icon={MapIcon} message="No GPS-tagged violations for this period" />
  }

  return (
    <div style={{ position: 'relative', height: 300, borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
      <MapContainer
        center={LUCENA}
        zoom={13}
        minZoom={12}
        maxZoom={16}
        style={{ height: '100%', width: '100%' }}
        zoomControl={true}
        attributionControl={false}
        scrollWheelZoom={false}
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="" />
        <LockView />
        {clusters.map((c, i) => {
          const risk = getRisk(c.count)
          const radius = 6 + Math.min(c.count, 15)
          return (
            <CircleMarker
              key={i}
              center={[c.lat, c.lng]}
              radius={radius}
              pathOptions={{ color: '#fff', weight: 2, fillColor: risk.color, fillOpacity: 0.85 }}
            >
              <Tooltip direction="top" offset={[0, -radius]} opacity={1}>
                <div style={{ fontFamily: 'var(--font-family)', padding: '6px 10px', fontSize: 12, minWidth: 140 }}>
                  <div style={{ fontWeight: 700, color: 'var(--slate-950)', marginBottom: 3 }}>{c.location}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: risk.color, display: 'inline-block' }} />
                    <span style={{ fontWeight: 700, color: risk.color }}>{risk.label} Risk</span>
                  </div>
                  <div style={{ color: 'var(--slate-600)', fontSize: 11 }}>
                    {c.count} violation{c.count !== 1 ? 's' : ''} here
                  </div>
                </div>
              </Tooltip>
            </CircleMarker>
          )
        })}
      </MapContainer>
      <MapLegend />
    </div>
  )
}