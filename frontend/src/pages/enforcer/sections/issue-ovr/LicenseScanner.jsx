import { useEffect, useRef, useState } from 'react'
import { Camera, CheckCircle2, IdCard, RefreshCw, RotateCcw, ScanLine, SwitchCamera, X } from 'lucide-react'
import { Button } from '../../../../components/ui'
import { formatScanFailure, hasReadableLicense, resizeImageToJpegBase64, scanLicenseRequest } from '../../../../utils/licenseScan'

/**
 * Driver's-license scanner (Step 1). Talks to the existing
 * POST /api/violations/scan-license/ endpoint — { image: <base64 jpeg> } in,
 * { raw_text, parsed: { full_name, license_number, address } } out.
 * Capture shrinks the frame to a 1600px JPEG before that request.
 *
 * It never writes to the form itself: "Apply" hands the parsed result to the
 * parent, which merges it without overwriting anything already typed.
 */
export default function LicenseScanner({ onApply, onClose }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [cameraOn, setCameraOn] = useState(false)
  const [facingMode, setFacingMode] = useState('environment')
  const [image, setImage] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  const stopStream = () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }

  // Leaving the step (or closing the scanner) must release the camera —
  // otherwise the phone keeps the camera light on in the background.
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
  }, [])

  const startCamera = async (mode = facingMode) => {
    setError('')
    stopStream()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: mode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCameraOn(true)
    } catch {
      stopStream()
      setCameraOn(false)
      setError('Camera access was blocked. Allow camera permission in your browser and try again.')
    }
  }

  const stopCamera = () => { stopStream(); setCameraOn(false) }

  const flipCamera = () => {
    const next = facingMode === 'environment' ? 'user' : 'environment'
    setFacingMode(next)
    startCamera(next)
  }

  const capture = async () => {
    const video = videoRef.current
    if (!video?.videoWidth || !video?.videoHeight) {
      setError('The photo was not captured. The camera frame was not ready. Try again.')
      return
    }
    setError('')
    try {
      const base64 = await resizeImageToJpegBase64(video)
      setImage(`data:image/jpeg;base64,${base64}`)
      setResult(null)
      stopCamera()
    } catch {
      setError('The photo was not captured. Try again.')
    }
  }

  const retake = () => { setImage(null); setResult(null); setError(''); startCamera() }

  const scan = async () => {
    if (!image) return
    setScanning(true)
    setError('')
    setResult(null)
    try {
      const outcome = await scanLicenseRequest(image)
      if (outcome?.ok) setResult({ parsed: outcome.parsed, raw_text: outcome.rawText })
      else setError(formatScanFailure(outcome))
    } finally {
      setScanning(false)
    }
  }

  const parsed = result?.parsed
  const found = hasReadableLicense(parsed)

  return (
    <div className="ovr-scan">
      <div className="ovr-scan-head">
        <span className="ovr-scan-title"><IdCard size={16} aria-hidden="true" /> Scan driver&apos;s license</span>
        <button type="button" className="ovr-icon-btn" onClick={onClose} aria-label="Close scanner"><X size={16} /></button>
      </div>

      {/* The <video> stays mounted so the ref is always there when the camera starts. */}
      <div className={`ovr-viewfinder ${image ? 'is-hidden' : ''}`}>
        <video ref={videoRef} playsInline muted className={cameraOn ? '' : 'is-hidden'} />
        {!cameraOn && (
          <div className="ovr-viewfinder-empty">
            <IdCard size={28} aria-hidden="true" />
            <span>Fit the license inside the frame</span>
          </div>
        )}
        <span className="ovr-viewfinder-corners" aria-hidden="true" />
      </div>
      {image && <img src={image} alt="Captured driver's license" className="ovr-scan-shot" />}

      {error && <p className="ovr-inline-error" role="alert">{error}</p>}

      {!image ? (
        <div className="ovr-scan-actions">
          {!cameraOn ? (
            <Button variant="primary" icon={Camera} onClick={() => startCamera()} fullWidth>Start camera</Button>
          ) : (
            <>
              <Button variant="primary" icon={ScanLine} onClick={capture} style={{ flex: 1 }}>Capture</Button>
              <Button variant="secondary" icon={SwitchCamera} onClick={flipCamera} aria-label="Switch camera" />
              <Button variant="secondary" onClick={stopCamera}>Stop</Button>
            </>
          )}
        </div>
      ) : (
        <div className="ovr-scan-actions">
          <Button variant="secondary" icon={RotateCcw} onClick={retake} disabled={scanning}>Retake</Button>
          <Button variant="primary" icon={scanning ? RefreshCw : ScanLine} onClick={scan} loading={scanning} style={{ flex: 1 }}>
            {scanning ? 'Reading…' : 'Read license'}
          </Button>
        </div>
      )}

      {result && (
        found ? (
          <div className="ovr-detected">
            <div className="ovr-detected-title">
              <CheckCircle2 size={18} aria-hidden="true" />
              <div>
                <strong>License detected</strong>
                <span>Check the details below, then apply them. You can still edit every field.</span>
              </div>
            </div>
            <dl className="ovr-detected-list">
              {parsed.full_name && <div><dt>Name</dt><dd>{parsed.full_name}</dd></div>}
              {parsed.license_number && <div><dt>License no.</dt><dd className="mono">{parsed.license_number}</dd></div>}
              {parsed.address && <div><dt>Address</dt><dd>{parsed.address}</dd></div>}
            </dl>
            <Button variant="primary" icon={CheckCircle2} onClick={() => onApply(parsed)} fullWidth>
              Apply to driver details
            </Button>
          </div>
        ) : (
          <p className="ovr-inline-note">Nothing readable was found. Retake the photo, or type the details below.</p>
        )
      )}
    </div>
  )
}