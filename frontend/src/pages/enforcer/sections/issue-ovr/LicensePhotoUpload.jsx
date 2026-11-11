import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, ImagePlus, RotateCcw, Trash2, X } from 'lucide-react'
import { Button } from '../../../../components/ui'
import { resizeImageToJpegBase64, scanLicenseRequest } from '../../../../utils/licenseScan'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_SIZE_BYTES = 5 * 1024 * 1024

/**
 * Upload Photo — Step 1, Driver Information.
 *
 * Pick an image from the device, preview it, and attach it to the OVR.
 * The file lives in the parent form (`form.license_photo`) and is sent
 * later as the multipart `image` field on create. Done also reads the
 * same photo through POST /api/violations/scan-license/ (resized JPEG,
 * same body as the camera scanner) and hands the result to `onScan`.
 * A failed or empty read does not remove the attachment. `onScan` is
 * optional so a caller that only wants the file can omit it.
 */
export default function LicensePhotoUpload({ photo, onChange, onClose, onScan }) {
  const inputRef = useRef(null)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  // Derived straight from `photo`, not stored in state — avoids a
  // setState-in-effect render cascade for what's just a computed URL.
  const previewUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo])
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  const pick = () => inputRef.current?.click()

  const handleFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Only JPEG, PNG, or WEBP images are allowed.')
      return
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError('Image must be smaller than 5MB.')
      return
    }
    setError('')
    onChange(file)
  }

  const finish = async () => {
    if (!photo || typeof onScan !== 'function') {
      onClose()
      return
    }
    setReading(true)
    setError('')
    try {
      const base64 = await resizeImageToJpegBase64(photo)
      onScan(await scanLicenseRequest(base64))
    } catch (err) {
      onScan({
        ok: false,
        status: null,
        parsed: null,
        rawText: '',
        errorDetail: err?.message || 'The photo could not be prepared for reading.',
        errorKind: 'prepare',
      })
    } finally {
      setReading(false)
      onClose()
    }
  }

  return (
    <div className="ovr-scan">
      <div className="ovr-scan-head">
        <span className="ovr-scan-title"><ImagePlus size={16} aria-hidden="true" /> Upload license photo</span>
        <button type="button" className="ovr-icon-btn" onClick={onClose} disabled={reading} aria-label="Close upload"><X size={16} /></button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleFile}
        style={{ display: 'none' }}
      />

      {error && <p className="ovr-inline-error" role="alert">{error}</p>}

      {!photo ? (
        <Button variant="primary" icon={ImagePlus} onClick={pick} fullWidth>Select image</Button>
      ) : (
        <>
          <img src={previewUrl} alt="Selected driver's license" className="ovr-scan-shot" />
          <div className="ovr-scan-actions">
            <Button variant="secondary" icon={RotateCcw} onClick={pick} disabled={reading}>Replace</Button>
            <Button variant="secondary" icon={Trash2} onClick={() => onChange(null)} disabled={reading}>Remove</Button>
            <Button variant="primary" icon={CheckCircle2} onClick={finish} loading={reading} style={{ flex: 1 }}>
              {reading ? 'Reading…' : 'Done'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}