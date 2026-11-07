import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const ZOOM_STEP = 0.5

/**
 * Full-viewport image lightbox for inspecting a single image at a larger,
 * dynamic size (evidence photos, etc). A dedicated variant rather than the
 * shared Modal component: Modal's header/body/footer chrome and capped
 * `width` are built for form content, not for a full-bleed, zoomable image
 * — but it mirrors Modal's conventions (Escape to close, backdrop click to
 * close, focus handling, scroll lock) so the interaction feels consistent
 * with the rest of the app.
 *
 * Portalled to document.body like FloatingPanel, so it always sits above
 * whatever page/modal/drawer it was opened from.
 */
export default function ImageLightbox({ open, onClose, src, alt = 'Evidence photo' }) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragState = useRef(null)
  const stageRef = useRef(null)
  const closeBtnRef = useRef(null)
  const lastFocused = useRef(null)

  const reset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [])

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset zoom/pan whenever the lightbox opens, same convention used elsewhere in this codebase
    reset()
    lastFocused.current = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeBtnRef.current?.focus()

    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose?.()
      else if (e.key === '+' || e.key === '=') setZoom(z => Math.min(MAX_ZOOM, z + ZOOM_STEP))
      else if (e.key === '-') setZoom(z => Math.max(MIN_ZOOM, z - ZOOM_STEP))
      else if (e.key === '0') reset()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
      lastFocused.current?.focus?.()
    }
  }, [open, onClose, reset])

  if (!open) return null

  const zoomIn = () => setZoom(z => Math.min(MAX_ZOOM, z + ZOOM_STEP))
  const zoomOut = () => setZoom(z => {
    const next = Math.max(MIN_ZOOM, z - ZOOM_STEP)
    if (next === MIN_ZOOM) setPan({ x: 0, y: 0 })
    return next
  })

  // Simple drag-to-pan once zoomed in — pointer events cover mouse + touch.
  const onPointerDown = (e) => {
    if (zoom === MIN_ZOOM) return
    dragState.current = { startX: e.clientX - pan.x, startY: e.clientY - pan.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e) => {
    if (!dragState.current) return
    setPan({ x: e.clientX - dragState.current.startX, y: e.clientY - dragState.current.startY })
  }
  const onPointerUp = () => { dragState.current = null }

  return createPortal(
    <div className="lightbox-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }} role="dialog" aria-modal="true" aria-label={alt}>
      <div className="lightbox-toolbar">
        <span />
        <div className="lightbox-toolbar-group">
          <button className="lightbox-btn" onClick={zoomOut} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out"><ZoomOut size={18} /></button>
          <span className="lightbox-zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="lightbox-btn" onClick={zoomIn} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in"><ZoomIn size={18} /></button>
          <button className="lightbox-btn" onClick={reset} disabled={zoom === MIN_ZOOM && pan.x === 0 && pan.y === 0} aria-label="Reset zoom"><Maximize2 size={16} /></button>
          <button className="lightbox-btn" onClick={onClose} aria-label="Close" ref={closeBtnRef}><X size={20} /></button>
        </div>
      </div>
      <div
        ref={stageRef}
        className={`lightbox-stage ${zoom > MIN_ZOOM ? 'is-zoomed' : ''}`}
        onDoubleClick={() => (zoom > MIN_ZOOM ? reset() : setZoom(2))}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <img src={src} alt={alt} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} draggable={false} />
      </div>
    </div>,
    document.body
  )
}