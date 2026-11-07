import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, ImagePlus, RotateCcw, Trash2, X } from 'lucide-react'
import { Button } from '../../../../components/ui'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_SIZE_BYTES = 5 * 1024 * 1024

/**
 * Upload Photo — Step 1, Driver Information → Scan License.
 *
 * A plain photo-attachment alternative to the OCR camera scanner
 * (LicenseScanner): pick an image from the device, preview it, remove or
 * replace it. This does NOT read or extract anything from the photo — no
 * OCR is performed here, it only attaches a picture to the OVR for the
 * final-defense demo. The file itself lives in the parent form state
 * (`form.license_photo`) and rides along in the existing multipart submit
 * as the `image` field — no new backend endpoint or model.
 */
export default function LicensePhotoUpload({ photo, onChange, onClose }) {
  const inputRef = useRef(null)
  const [error, setError] = useState('')
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

  return (
    <div className="ovr-scan">
      <div className="ovr-scan-head">
        <span className="ovr-scan-title"><ImagePlus size={16} aria-hidden="true" /> Upload license photo</span>
        <button type="button" className="ovr-icon-btn" onClick={onClose} aria-label="Close upload"><X size={16} /></button>
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
            <Button variant="secondary" icon={RotateCcw} onClick={pick}>Replace</Button>
            <Button variant="secondary" icon={Trash2} onClick={() => onChange(null)}>Remove</Button>
            <Button variant="primary" icon={CheckCircle2} onClick={onClose} style={{ flex: 1 }}>Done</Button>
          </div>
        </>
      )}
    </div>
  )
}