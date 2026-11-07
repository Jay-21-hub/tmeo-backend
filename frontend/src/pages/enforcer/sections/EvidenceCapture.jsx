import { useState, useRef, useEffect } from 'react'
import { Camera, X, RotateCcw, CheckCircle, UploadCloud, MapPin } from 'lucide-react'
import api from '../../../services/api'
import { API } from '../../../constants'
import { Button, Popover } from '../../../components/ui'
import { saveOfflineEvidence } from '../../../services/offlineEvidenceDB'

const C = {
  navy: 'var(--navy-700)', orange: 'var(--warning-500)', orangeL: 'var(--warning-50)',
  green: 'var(--success-600)', greenL: 'var(--success-50)', red: 'var(--danger-600)', redL: 'var(--danger-50)',
  border: 'var(--color-border)', muted: 'var(--slate-400)', label: 'var(--slate-600)',
  text: 'var(--slate-950)', bg: 'var(--slate-50)', white: 'var(--white)',
}

/**
 * EvidenceCapture — a camera Popover for field-audit photos, anchored to
 * whichever "Capture" button triggered it.
 *
 * This is deliberately NOT a step inside IssueOVR. It exists so an
 * Enforcer can attach one or more dispute/audit photos to an OVR at any
 * time (right after issuing it, or later from My Reports) without those
 * photos ever appearing on the official OVR printout (business rule
 * #12/#20/#22).
 *
 * Was a full-page dark-overlay modal; converted to an anchored Popover
 * (compact, contextual, no page-wide dimming) since this is a low-stakes,
 * self-contained flow triggered from one specific button each time.
 *
 * Props (violationId/localOvrId/onClose/onSaved are all optional — with
 * none of them, this is a fully standalone capture with no OVR context;
 * the photo can be associated to an OVR later from the Evidence Gallery):
 *  - violationId: server-side Violation pk, if the OVR has already synced
 *  - localOvrId: offline queue id (e.g. "offline_172...") to key evidence
 *    against when the OVR itself hasn't synced yet — mutually exclusive
 *    with violationId
 *  - onClose(): close the popover
 *  - onSaved(): called after a photo is successfully stored (online or
 *    queued offline) so the caller can refresh its evidence count/list
 *  - triggerRef: ref to the button this popover anchors to (required —
 *    see Popover.jsx for why it has to be a wrapping span/div, not the
 *    Button component itself)
 *  - align: 'left' | 'right' | 'center' passed through to Popover;
 *    default 'left'. Pick whichever keeps the panel on screen given
 *    where the trigger button sits.
 */
export default function EvidenceCapture({ violationId, localOvrId, onClose, onSaved, triggerRef, align = 'left' }) {
  const videoRef  = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)

  const [cameraOn, setCameraOn]     = useState(false)
  const [facingMode, setFacingMode] = useState('environment')
  const [captured, setCaptured]     = useState(null) // { blob, preview, capturedAt }
  const [coords, setCoords]         = useState({ latitude: null, longitude: null, accuracy: null })
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')
  const [saved, setSaved]           = useState(false)

  useEffect(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      pos => setCoords({
        latitude: +pos.coords.latitude.toFixed(6),
        longitude: +pos.coords.longitude.toFixed(6),
        accuracy: pos.coords.accuracy != null ? +pos.coords.accuracy.toFixed(1) : null,
      }),
      () => {},
      { enableHighAccuracy: true, timeout: 8000 }
    )
  }, [])

  useEffect(() => () => { streamRef.current?.getTracks().forEach(t => t.stop()) }, [])

  const startCamera = async () => {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      })
      streamRef.current = stream
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      setCameraOn(true)
    } catch {
      setError('Camera access denied. Allow camera permission and try again.')
    }
  }

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    setCameraOn(false)
  }

  const flipCamera = () => {
    stopCamera()
    setFacingMode(f => f === 'environment' ? 'user' : 'environment')
    setTimeout(startCamera, 250)
  }

  const capture = () => {
    if (!videoRef.current || !canvasRef.current) return
    const video = videoRef.current
    const canvas = canvasRef.current
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0)

    const capturedAtLabel = new Date().toLocaleString('en-PH', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    ctx.font = 'bold 18px monospace'
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(8, canvas.height - 36, ctx.measureText(capturedAtLabel).width + 16, 28)
    ctx.fillStyle = '#facc15'
    ctx.fillText(capturedAtLabel, 16, canvas.height - 16)

    canvas.toBlob(blob => {
      setCaptured({ blob, preview: canvas.toDataURL('image/jpeg', 0.92), capturedAt: new Date().toISOString(), capturedAtLabel })
      stopCamera()
    }, 'image/jpeg', 0.92)
  }

  const retake = () => { setCaptured(null); setError(''); startCamera() }

  const handleSave = async () => {
    if (!captured) return
    setSaving(true)
    setError('')
    try {
      // A local (not-yet-synced) OVR has no real server id yet, so it
      // can never upload directly — it always queues offline, keyed to
      // localOvrId, regardless of connectivity.
      if (navigator.onLine && !localOvrId) {
        // Online — uploads standalone by default (violation is optional);
        // only attaches to a Violation when the caller already has a
        // real, synced violationId to pass.
        const fd = new FormData()
        fd.append('image', new File([captured.blob], `evidence_${Date.now()}.jpg`, { type: 'image/jpeg' }))
        fd.append('captured_at', captured.capturedAt)
        if (violationId)               fd.append('violation', violationId)
        if (coords.latitude != null)   fd.append('latitude', coords.latitude)
        if (coords.longitude != null)  fd.append('longitude', coords.longitude)
        if (coords.accuracy != null)   fd.append('gps_accuracy', coords.accuracy)
        await api.post(API.EVIDENCE, fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
      } else {
        // Offline, or the parent OVR itself hasn't synced yet — queue the
        // Blob in IndexedDB, keyed to whichever id we have (or none, for a
        // fully standalone capture). SyncData's flush step uploads these
        // once connectivity (and, if applicable, the OVR's real server id)
        // is available.
        await saveOfflineEvidence(localOvrId || null, captured.blob, {
          capturedAt: captured.capturedAt,
          latitude: coords.latitude,
          longitude: coords.longitude,
          gpsAccuracy: coords.accuracy,
        })
      }
      setSaved(true)
      onSaved && onSaved()
      setTimeout(() => { onClose && onClose() }, 1200)
    } catch {
      setError('Could not save evidence. It will be kept for retry.')
    } finally {
      setSaving(false)
    }
  }

  // Popover takes a fixed pixel width (unlike the old modal, which was
  // width:100%/max-width via CSS), so clamp it to the viewport ourselves
  // for narrow screens.
  const width = typeof window !== 'undefined' ? Math.min(380, window.innerWidth - 32) : 380

  return (
    <Popover open onClose={onClose} triggerRef={triggerRef} width={width} align={align} className="evidence-capture-popover">
      <div style={{ background: C.navy, padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.white, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Camera size={17} color="#facc15" /> Capture Evidence
          </div>
          <div style={{ fontSize: 11, color: '#93c5fd', marginTop: 2 }}>
            Audit photo — not printed on the OVR. Used for disputes/verification only.
          </div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#93c5fd', cursor: 'pointer' }}>
          <X size={18} />
        </button>
      </div>

      <div style={{ padding: 20, flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {saved ? (
            <div style={{ textAlign: 'center', padding: '30px 0' }}>
              <CheckCircle size={40} color={C.green} />
              <div style={{ marginTop: 10, fontWeight: 700, color: C.green }}>Evidence saved</div>
            </div>
          ) : captured ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden' }}>
                <img src={captured.preview} alt="Captured evidence" style={{ width: '100%', display: 'block', maxHeight: 320, objectFit: 'cover' }} />
              </div>
              {coords.latitude != null && (
                <div style={{ fontSize: 12, color: C.label, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <MapPin size={13} /> {coords.latitude}, {coords.longitude}
                  {coords.accuracy != null && <span style={{ color: C.muted }}>(±{coords.accuracy}m)</span>}
                </div>
              )}
              {error && <div style={{ color: C.red, fontSize: 12.5, fontWeight: 600 }}>{error}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="secondary" icon={RotateCcw} onClick={retake} disabled={saving}>Retake</Button>
                <Button variant="primary" icon={UploadCloud} onClick={handleSave} loading={saving} fullWidth style={{ flex: 1 }}>
                  {navigator.onLine ? 'Save Evidence' : 'Save Offline'}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{
                position: 'relative', background: '#0a0f18', borderRadius: 10,
                overflow: 'hidden', marginBottom: 10, aspectRatio: '4/3',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <video ref={videoRef} style={{ width: '100%', height: '100%', objectFit: 'cover', display: cameraOn ? 'block' : 'none' }} playsInline muted />
                {!cameraOn && (
                  <div style={{ textAlign: 'center', color: '#4a5568' }}>
                    <Camera size={32} />
                    <div style={{ fontSize: 13, marginTop: 6, color: '#718096' }}>Camera off</div>
                  </div>
                )}
              </div>
              <canvas ref={canvasRef} style={{ display: 'none' }} />
              {error && <div style={{ color: C.red, fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>{error}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                {!cameraOn ? (
                  <Button variant="primary" icon={Camera} onClick={startCamera} fullWidth style={{ flex: 1 }}>Start Camera</Button>
                ) : (
                  <>
                    <Button variant="primary" onClick={capture} style={{ flex: 1, background: C.green }}>📸 Capture</Button>
                    <Button variant="secondary" onClick={flipCamera}>🔄</Button>
                    <Button variant="secondary" onClick={stopCamera}>Stop</Button>
                  </>
                )}
              </div>
            </div>
          )}
      </div>
    </Popover>
  )
}