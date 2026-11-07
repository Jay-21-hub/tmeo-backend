import { useState, useEffect, useCallback, useRef } from 'react'
import { Camera, Link2, X, MapPin, Clock, ImageOff } from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { Button } from '../../../components/ui'
import { TextInput } from '../../../components/ui/Field'
import Badge from '../../../components/ui/Badge'
import { EmptyState, LoadingRows, ErrorState } from '../../../components/ui/States'
import EvidencePhoto from '../../../components/ui/EvidencePhoto'
import EvidenceCapture from './EvidenceCapture'
import { getAllOfflineEvidence } from '../../../services/offlineEvidenceDB'

/**
 * EvidenceGallery — the Enforcer's own camera-capture evidence, whether
 * already linked to an OVR or still standalone.
 *
 * Camera Evidence is deliberately its own destination (not a step inside
 * Issue OVR) — see EvidenceCapture.jsx's docstring. This is where an
 * Enforcer:
 *   1. Captures a new photo at any time (no OVR needs to exist yet), and
 *   2. Associates an already-captured, still-unassociated photo with the
 *      OVR it belongs to, once that OVR exists/has synced.
 */
export default function EvidenceGallery() {
  const [items, setItems]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [offlineCount, setOfflineCount] = useState(0)
  const [captureOpen, setCaptureOpen]   = useState(false)
  const [associating, setAssociating]   = useState(null) // evidence object being associated
  const captureTriggerRef = useRef(null) // Button doesn't forward refs — wrap it and ref the wrapper

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.get(API.EVIDENCE)
      setItems(Array.isArray(res.data) ? res.data : res.data?.results || [])
    } catch {
      setError('Could not load evidence photos.')
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshOfflineCount = useCallback(async () => {
    try {
      const all = await getAllOfflineEvidence()
      setOfflineCount(all.length)
    } catch { /* IndexedDB unavailable */ }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load on mount, matches existing codebase convention
    load()
    refreshOfflineCount()
  }, [load, refreshOfflineCount])

  const handleSaved = () => { load(); refreshOfflineCount() }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div>
          <div className="text-title" style={{ margin: 0 }}>Camera Evidence</div>
          <div className="text-caption">Audit photos — not printed on the OVR.</div>
        </div>
        <span ref={captureTriggerRef} style={{ display: 'inline-flex' }}>
          <Button variant="primary" icon={Camera} onClick={() => setCaptureOpen(true)}>Capture</Button>
        </span>
      </div>

      {offlineCount > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
          background: 'var(--warning-50)', borderRadius: 'var(--radius-md)',
          color: 'var(--warning-700, #b45309)', fontSize: 12.5, fontWeight: 600,
        }}>
          <Clock size={14} /> {offlineCount} photo{offlineCount !== 1 ? 's' : ''} queued offline — will upload once you're back online.
        </div>
      )}

      {loading ? (
        <LoadingRows rows={4} height={72} />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Camera}
          title="No evidence photos yet"
          message="Photos you capture will show up here, whether or not they're linked to an OVR yet."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map(ev => (
            <div key={ev.id} style={{
              display: 'flex', gap: 12, padding: 10, border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)', background: 'var(--white)',
            }}>
              <div style={{ width: 84, height: 84, flexShrink: 0, borderRadius: 8, overflow: 'hidden' }}>
                {ev.image ? (
                  <EvidencePhoto src={ev.image} alt={`Evidence #${ev.id}`} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--slate-100)' }}>
                    <ImageOff size={18} color="var(--slate-400)" />
                  </div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {ev.violation ? (
                    <Badge tone="success">OVR #{ev.ovr_number || ev.violation}</Badge>
                  ) : (
                    <Badge tone="warning">Unassociated</Badge>
                  )}
                </div>
                <div className="text-caption" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Clock size={11} /> {ev.captured_at ? new Date(ev.captured_at).toLocaleString('en-PH') : '—'}
                </div>
                {(ev.latitude != null && ev.longitude != null) && (
                  <div className="text-caption" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <MapPin size={11} /> {ev.latitude.toFixed(5)}, {ev.longitude.toFixed(5)}
                    {ev.gps_accuracy != null && <span>(±{ev.gps_accuracy}m)</span>}
                  </div>
                )}
                {!ev.violation && (
                  <Button
                    variant="secondary"
                    icon={Link2}
                    onClick={() => setAssociating(ev)}
                    style={{ marginTop: 4, alignSelf: 'flex-start' }}
                  >
                    Associate with OVR
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {captureOpen && (
        <EvidenceCapture
          triggerRef={captureTriggerRef}
          align="right"
          onClose={() => setCaptureOpen(false)}
          onSaved={handleSaved}
        />
      )}

      {associating && (
        <AssociatePicker
          evidence={associating}
          onClose={() => setAssociating(null)}
          onAssociated={() => { setAssociating(null); load() }}
        />
      )}
    </div>
  )
}

/**
 * Small search-and-pick sheet for the "Associate with OVR" action.
 * Searches the Enforcer's own violations (role-scoped server-side by
 * ViolationListView) by violator name / plate / license number and PATCHes
 * the chosen violation id onto the evidence record.
 */
function AssociatePicker({ evidence, onClose, onAssociated }) {
  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing stale results when the query shrinks below the search threshold
      setResults([])
      return
    }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await api.get(API.VIOLATIONS, { params: { search: q } })
        const list = Array.isArray(res.data) ? res.data : res.data?.results || []
        setResults(list.slice(0, 15))
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 350)
    return () => clearTimeout(t)
  }, [query])

  const handlePick = async (violation) => {
    setSaving(true)
    setError('')
    try {
      await api.patch(API.EVIDENCE_ASSOCIATE(evidence.id), { violation: violation.id })
      onAssociated()
    } catch {
      setError('Could not associate this photo. Try again.')
      setSaving(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(10,18,30,0.75)', backdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: 'var(--white)', borderRadius: 16, width: '100%', maxWidth: 440,
        boxShadow: '0 24px 64px rgba(0,0,0,0.3)', overflow: 'hidden', maxHeight: '80vh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Associate with OVR</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--slate-500)' }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
          <TextInput
            placeholder="Search by violator name, plate, or license #"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
          />
          {error && <div style={{ color: 'var(--danger-600)', fontSize: 12.5, fontWeight: 600 }}>{error}</div>}
          {searching && <LoadingRows rows={3} height={40} />}
          {!searching && query.trim().length >= 2 && results.length === 0 && (
            <div className="text-caption">No matching OVRs found.</div>
          )}
          {results.map(v => (
            <button
              key={v.id}
              onClick={() => handlePick(v)}
              disabled={saving}
              style={{
                textAlign: 'left', padding: '10px 12px', borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border)', background: 'var(--slate-50)',
                cursor: saving ? 'default' : 'pointer', display: 'flex', flexDirection: 'column', gap: 2,
              }}
            >
              <span style={{ fontWeight: 600, fontSize: 13 }}>{v.violator_name || 'Unnamed violator'}</span>
              <span className="text-caption">
                {v.plate_number ? `Plate: ${v.plate_number} · ` : ''}
                {v.date_issued ? new Date(v.date_issued).toLocaleDateString('en-PH') : ''}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}