import { useState } from 'react'
import { Expand, ImageOff } from 'lucide-react'
import ImageLightbox from './ImageLightbox'

/**
 * Responsive evidence-photo preview for the Assessment Form. Click/tap
 * opens a dynamic, zoomable ImageLightbox so staff can inspect detail that
 * doesn't show at thumbnail size. Handles the loading and broken-URL
 * states itself; the caller is still responsible for not rendering this
 * at all when there's no image (`violationData?.image` stays the guard —
 * see AssessmentFormSteps.jsx), same as before.
 */
export default function EvidencePhoto({ src, alt = 'Evidence photo' }) {
  const [loaded, setLoaded] = useState(false)
  const [broken, setBroken] = useState(false)
  const [open, setOpen] = useState(false)

  if (broken) {
    return (
      <div className="lightbox-trigger" style={{ cursor: 'default' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '28px 16px', color: 'var(--slate-400)' }}>
          <ImageOff size={22} strokeWidth={1.6} aria-hidden="true" />
          <span className="text-caption">Evidence photo couldn't be loaded</span>
        </div>
      </div>
    )
  }

  return (
    <>
      <button
        type="button"
        className="lightbox-trigger"
        onClick={() => setOpen(true)}
        aria-label="Open evidence photo, full size"
      >
        {!loaded && <div className="skeleton" style={{ width: '100%', height: 180 }} aria-hidden="true" />}
        <img
          src={src}
          alt={alt}
          style={{ display: loaded ? 'block' : 'none' }}
          onLoad={() => setLoaded(true)}
          onError={() => setBroken(true)}
        />
        {loaded && (
          <span className="lightbox-trigger-hint">
            <Expand size={12} /> View full size
          </span>
        )}
      </button>

      <ImageLightbox open={open} onClose={() => setOpen(false)} src={src} alt={alt} />
    </>
  )
}