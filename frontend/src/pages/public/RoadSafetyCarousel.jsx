import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { MAX_ROAD_SAFETY_SLIDES, ROAD_SAFETY_SLIDES, buildSlidesFromTypes } from '../../constants/roadSafetySlides'
import { fetchPublicViolationTypes } from '../../services/publicApi'
import './roadSafetyCarousel.css'

export const AUTOPLAY_MS = 6500
const SWIPE_PX = 45

// Original pictograms (no third-party artwork). Decorative: the slide text carries the meaning.
const ICONS = {
  redLight: (
    <svg viewBox="0 0 240 240" aria-hidden="true" focusable="false">
      <rect x="112" y="176" width="16" height="48" rx="3" fill="#2a4474" />
      <rect x="78" y="22" width="84" height="158" rx="16" fill="#15305a" stroke="#3a5a90" strokeWidth="3" />
      <circle cx="120" cy="66" r="21" fill="#e5484d" />
      <circle cx="120" cy="66" r="32" fill="#e5484d" opacity=".18" />
      <circle cx="120" cy="101" r="21" fill="#3a4a63" />
      <circle cx="120" cy="136" r="21" fill="#2f4a46" />
    </svg>
  ),
  helmet: (
    <svg viewBox="0 0 240 240" aria-hidden="true" focusable="false">
      <path d="M38 158C38 96 76 52 128 52s86 40 86 106z" fill="#e2a93b" />
      <path d="M128 98h86v44c0 6-4 10-10 10h-92c-6 0-8-6-6-10z" fill="#0d2140" />
      <path d="M38 158h176v12c0 6-4 10-10 10H48c-6 0-10-4-10-10z" fill="#c98f22" />
      <path d="M84 70c-14 10-24 24-28 42" fill="none" stroke="#f6d58f" strokeWidth="7" strokeLinecap="round" opacity=".7" />
      <path d="M70 184c16 22 96 22 120-8" fill="none" stroke="#aab6c8" strokeWidth="6" strokeLinecap="round" />
    </svg>
  ),
  parking: (
    <svg viewBox="0 0 240 240" aria-hidden="true" focusable="false">
      <circle cx="120" cy="120" r="84" fill="#0d2140" stroke="#e5484d" strokeWidth="14" />
      <path d="M96 164V78h30a24 24 0 010 48H96" fill="none" stroke="#f4f1ea" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M62 178L178 62" stroke="#e5484d" strokeWidth="14" strokeLinecap="round" />
    </svg>
  ),
  pedestrian: (
    <svg viewBox="0 0 240 240" aria-hidden="true" focusable="false">
      <g fill="#f4f1ea" opacity=".92">
        <rect x="30" y="176" width="34" height="14" rx="2" />
        <rect x="76" y="176" width="34" height="14" rx="2" />
        <rect x="122" y="176" width="34" height="14" rx="2" />
        <rect x="168" y="176" width="34" height="14" rx="2" />
      </g>
      <circle cx="120" cy="50" r="17" fill="#e2a93b" />
      <path d="M120 74v54m0 0l-24 44m24-44l22 44M120 90l-30 22m30-22l32 18" fill="none" stroke="#e2a93b" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  phone: (
    <svg viewBox="0 0 240 240" aria-hidden="true" focusable="false">
      <rect x="82" y="36" width="76" height="140" rx="14" fill="#0d2140" stroke="#f4f1ea" strokeWidth="9" />
      <rect x="96" y="56" width="48" height="84" rx="4" fill="#15305a" />
      <circle cx="120" cy="156" r="6" fill="#f4f1ea" />
      <circle cx="120" cy="120" r="94" fill="none" stroke="#e5484d" strokeWidth="14" />
      <path d="M54 186L186 54" stroke="#e5484d" strokeWidth="14" strokeLinecap="round" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 240 240" aria-hidden="true" focusable="false">
      <path d="M120 30l78 28v56c0 48-32 78-78 96-46-18-78-48-78-96V58z" fill="#15305a" stroke="#3fb8af" strokeWidth="9" strokeLinejoin="round" />
      <path d="M84 120l26 26 48-54" fill="none" stroke="#3fb8af" strokeWidth="15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  road: (
    <svg viewBox="0 0 240 240" aria-hidden="true" focusable="false">
      <path d="M92 34h56l54 172H38z" fill="#15305a" stroke="#3a5a90" strokeWidth="6" strokeLinejoin="round" />
      <path d="M120 44v30m0 24v36m0 28v38" fill="none" stroke="#f4f1ea" strokeWidth="9" strokeLinecap="round" />
      <path d="M96 38L48 204m96-166l48 166" fill="none" stroke="#e2a93b" strokeWidth="6" strokeLinecap="round" />
    </svg>
  ),
  sign: (
    <svg viewBox="0 0 240 240" aria-hidden="true" focusable="false">
      <path d="M120 24l96 96-96 96-96-96z" fill="#e2a93b" stroke="#c98f22" strokeWidth="6" strokeLinejoin="round" />
      <path d="M120 74v66" fill="none" stroke="#0d2140" strokeWidth="15" strokeLinecap="round" />
      <circle cx="120" cy="166" r="9" fill="#0d2140" />
    </svg>
  ),
}

/** Keyboard focus (not a mouse click) is what pauses autoplay, so clicking an arrow never stops the show. */
function isKeyboardFocus(el) {
  try { return !!el?.matches?.(':focus-visible') } catch { return false }
}

/**
 * Presentational carousel (glass design).
 *  - Slides change automatically every 6.5 s. Hovering does NOT pause it.
 *  - It pauses only when: the pause button is pressed, a control has keyboard focus, or the browser tab is hidden.
 *  - Autoplay is on for everyone (reduced-motion visitors get a plain cross-fade, no movement).
 *  - Previous/Next buttons, progress dots, Left/Right arrow keys, swipe on touch.
 *  - Only the active slide is exposed to assistive tech and keyboard focus.
 */
export function RoadSafetyCarouselView({ slides = ROAD_SAFETY_SLIDES }) {
  const items = slides.slice(0, MAX_ROAD_SAFETY_SLIDES)
  const count = items.length
  const [rawIndex, setIndex] = useState(0)
  const index = rawIndex < count ? rawIndex : 0
  const [playing, setPlaying] = useState(true)
  const [focused, setFocused] = useState(false)
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  const startX = useRef(null)

  const go = useCallback((n) => { if (count > 0) setIndex(((n % count) + count) % count) }, [count])
  const next = useCallback(() => setIndex((i) => (count ? ((i < count ? i : 0) + 1) % count : 0)), [count])
  const prev = useCallback(() => setIndex((i) => (count ? ((i < count ? i : 0) - 1 + count) % count : 0)), [count])

  useEffect(() => {
    const onVis = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // One timer per slide; restarts whenever the slide changes, so manual navigation never causes a double jump.
  useEffect(() => {
    if (count < 2 || !playing || focused || hidden) return undefined
    const t = setTimeout(next, AUTOPLAY_MS)
    return () => clearTimeout(t)
  }, [index, count, playing, focused, hidden, next])

  if (count === 0) return null
  const paused = !playing || focused || hidden || count < 2

  const onKeyDown = (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); next() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev() }
  }
  const onPointerDown = (e) => { if (e.pointerType !== 'mouse') startX.current = e.clientX }
  const onPointerUp = (e) => {
    if (startX.current == null) return
    const dx = e.clientX - startX.current
    startX.current = null
    if (Math.abs(dx) >= SWIPE_PX) (dx < 0 ? next : prev)()
  }

  return (
    <div
      className="rsc"
      data-paused={paused ? 'true' : 'false'}
      style={{ '--rsc-ms': `${AUTOPLAY_MS}ms` }}
      role="region"
      aria-roledescription="carousel"
      aria-label="Road safety reminders"
      onKeyDown={onKeyDown}
      onFocus={(e) => { if (isKeyboardFocus(e.target)) setFocused(true) }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false) }}
    >
      <div className="rsc-stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { startX.current = null }}>
        <div className="rsc-slides" aria-live={playing ? 'off' : 'polite'}>
          {items.map((s, i) => (
            <article
              key={s.id}
              className={`rsc-slide${i === index ? ' is-active' : ''}`}
              style={s.accent ? { '--accent': s.accent } : undefined}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${count}: ${s.violation}`}
              aria-hidden={i === index ? undefined : 'true'}
              inert={i === index ? undefined : true}
            >
              <div className="rsc-bg" aria-hidden="true">
                {s.image && <img className="rsc-photo" src={s.image} alt="" loading="lazy" decoding="async" />}
                <i className="rsc-orb rsc-orb--a" />
                <i className="rsc-orb rsc-orb--b" />
                <i className="rsc-orb rsc-orb--c" />
              </div>
              <div className="rsc-glass">
                <span className="rsc-ghost" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                <div className="rsc-copy">
                  <span className="rsc-chip"><i className="rsc-chip-dot" aria-hidden="true" />{s.kicker || `Violation · ${s.violation}`}</span>
                  <h3 className="rsc-title">{s.title}</h3>
                  <p className="rsc-text">{s.text}</p>
                  <div className="rsc-meta">
                    <p className="rsc-tip"><strong>Tip</strong>{s.tip}</p>
                    {s.fine && <p className="rsc-fine"><span>Standard fine</span><strong>{s.fine}</strong></p>}
                  </div>
                </div>
                <div className="rsc-art" aria-hidden="true"><div className="rsc-medal">{ICONS[s.icon] || ICONS.sign}</div></div>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="rsc-controls">
        <div className="rsc-count" aria-hidden="true">{String(index + 1).padStart(2, '0')} / {String(count).padStart(2, '0')}</div>
        <div className="rsc-dots">
          {items.map((s, i) => (
            <button
              type="button"
              key={s.id}
              className={`rsc-dot${i === index ? ' is-active' : ''}`}
              aria-label={`Go to slide ${i + 1} of ${count}`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => go(i)}
            >
              {i === index && <span key={paused ? 'p' : 'r'} className={`rsc-fill${paused ? '' : ' is-running'}`} />}
            </button>
          ))}
        </div>
        <div className="rsc-btns">
          {count > 1 && (
            <button type="button" className="rsc-btn" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause automatic slide change' : 'Start automatic slide change'}>
              {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
            </button>
          )}
          <button type="button" className="rsc-btn" onClick={prev} aria-label="Previous slide"><ChevronLeft size={18} aria-hidden="true" /></button>
          <button type="button" className="rsc-btn" onClick={next} aria-label="Next slide"><ChevronRight size={18} aria-hidden="true" /></button>
        </div>
      </div>
    </div>
  )
}

/**
 * Landing-page carousel. With no `slides` prop it shows the built-in fallback slides immediately, then swaps in
 * the live violation types from the system when they arrive (and keeps the fallback if the request fails or is empty).
 */
export default function RoadSafetyCarousel({ slides }) {
  const [live, setLive] = useState(null)
  useEffect(() => {
    if (slides) return undefined
    let alive = true
    fetchPublicViolationTypes()
      .then((rows) => { if (alive) { const built = buildSlidesFromTypes(rows); if (built.length) setLive(built) } })
      .catch(() => {})
    return () => { alive = false }
  }, [slides])
  return <RoadSafetyCarouselView slides={slides || live || ROAD_SAFETY_SLIDES} />
}