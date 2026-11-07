import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, CheckCircle2, ChevronDown, ClipboardCheck, FileCheck2, Mail, MapPin, Search, ShieldCheck, Phone } from 'lucide-react'
import FacebookIcon from './FacebookIcon'
import { fetchPublicViolations } from '../../services/publicApi'
import { EmptyState, ErrorState, LoadingRows } from '../../components/ui'
import PublicViolationCard from './PublicViolationCard'
import ViolationDetailModal from './ViolationDetailModal'
import PublicStats from './PublicStats'
import RoadSafetyCarousel from './RoadSafetyCarousel'
import { prefersReducedMotion } from './useReveal'
import tmeoOffice from '../../assets/tmeo-office.jpg'
import {
  TMEO_ADDRESS_LINES, TMEO_EMAIL, TMEO_GMAIL_URL, TMEO_FACEBOOK_URL, TMEO_MAPS_EMBED_URL, TMEO_MAPS_SEARCH_URL, TMEO_PHONE, TMEO_PHONE_TEL,
  TMEO_MISSION, TMEO_VISION, TMEO_OFFICE_NAME,
} from '../../constants/publicOffice'

const HOME_VIOLATIONS_COUNT = 4

const STEPS = [
  { icon: ShieldCheck, title: 'Violation Recorded', text: 'Traffic violations are documented by TMEO enforcers in the field.' },
  { icon: ClipboardCheck, title: 'Assessment', text: 'Recorded details are reviewed and assessed by authorized TMEO staff.' },
  { icon: CheckCircle2, title: 'Payment', text: 'The assessed fine is settled through the appropriate official channels.' },
  { icon: FileCheck2, title: 'Official Record', text: 'Completed transactions become part of the official traffic record.' },
]

const Eyebrow = ({ children }) => <span className="pub-eyebrow"><span className="pub-eyebrow-rule" aria-hidden="true" />{children}</span>

export default function HomePage() {
  const [state, setState] = useState({ loading: true, error: false, results: [] })
  const [selected, setSelected] = useState(null)
  const heroImg = useRef(null)

  // Existing fetch behaviour, unchanged: one request on mount (and on explicit Retry).
  const load = () => {
    setState((s) => ({ ...s, loading: true, error: false }))
    fetchPublicViolations({ page_size: HOME_VIOLATIONS_COUNT })
      .then((data) => setState({ loading: false, error: false, results: (data.results || []).slice(0, HOME_VIOLATIONS_COUNT) }))
      .catch(() => setState({ loading: false, error: true, results: [] }))
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount pattern used across the codebase
    load()
  }, [])

  // Hero depth: the photo drifts a touch slower than the content. Desktop + fine pointer only (no parallax on
  // phones/tablets/touch), off for reduced motion, transform-only via one CSS variable, one rAF per frame.
  useEffect(() => {
    if (prefersReducedMotion()) return undefined
    const mq = window.matchMedia('(min-width: 900px) and (pointer: fine)')
    let raf = 0
    let last = -1
    const apply = () => {
      raf = 0
      const y = mq.matches && window.scrollY < window.innerHeight ? Math.round(window.scrollY * 0.08) : 0
      if (y !== last) { last = y; heroImg.current?.style.setProperty('--py', `${y}px`) }
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(apply) }
    window.addEventListener('scroll', onScroll, { passive: true })
    mq.addEventListener?.('change', onScroll)
    return () => { window.removeEventListener('scroll', onScroll); mq.removeEventListener?.('change', onScroll); cancelAnimationFrame(raf) }
  }, [])

  const scrollToAbout = () => document.getElementById('about')?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })

  return (
    <>
      {/* 01 — HERO */}
      <section className="pub-hero" aria-labelledby="hero-title">
        {/* Layers: 1 real photo · 2 navy overlay (::before) · 3 ambient light + road-line trace · 4 content · 5 location card / cue */}
        <div className="pub-hero-media">
          <img ref={heroImg} className="pub-hero-img" src={tmeoOffice} alt="TMEO office building in Lucena City" width="680" height="510" fetchPriority="high" />
        </div>
        <div className="pub-hero-glow" aria-hidden="true" />
        <div className="pub-hero-trace" aria-hidden="true" />
        <div className="pub-hero-inner">
          <div className="pub-hero-in">
            <div className="pub-hero-eyebrow hz" style={{ '--hd': '180ms' }}>{TMEO_OFFICE_NAME}</div>
            <h1 id="hero-title" className="pub-hero-title">
              <span className="pub-hero-line hz" style={{ '--hd': '260ms', '--hy': '28px' }}>Safer Roads.</span>{' '}
              <span className="pub-hero-line pub-accent hz" style={{ '--hd': '330ms', '--hy': '28px' }}>A Better Lucena.</span>
            </h1>
            <span className="pub-hero-rule" aria-hidden="true" />
            <p className="pub-hero-desc hz" style={{ '--hd': '420ms' }}>
              A public information portal of the Traffic Management &amp; Enforcement Office of Lucena City.
              Explore traffic violation updates, public-safe records, and official office information in one place.
            </p>
            <div className="pub-hero-actions">
              <Link to="/violation-updates" className="pbtn pbtn--gold hz" style={{ '--hd': '520ms', '--hy': '16px' }}>View Traffic Violations <ArrowRight size={16} aria-hidden="true" /></Link>
              <a href={TMEO_FACEBOOK_URL} target="_blank" rel="noopener noreferrer" className="pbtn pbtn--ghost hz" style={{ '--hd': '600ms', '--hy': '16px' }}>Have a Concern?<span className="pub-sr"> (opens TMEO Facebook page in new tab)</span></a>
            </div>
            <button type="button" className="pub-scroll-cue hz" style={{ '--hd': '760ms' }} onClick={scrollToAbout}>
              <ChevronDown size={16} aria-hidden="true" /> Scroll to explore
            </button>
          </div>
          <a className="pub-hero-loc hz" style={{ '--hd': '680ms' }} href={TMEO_MAPS_SEARCH_URL} target="_blank" rel="noopener noreferrer">
            <MapPin size={20} aria-hidden="true" />
            <div><span>TMEO Office</span><strong>Old City Hall Building</strong><span className="pub-sr"> (opens Google Maps in new tab)</span></div>
          </a>
        </div>
      </section>

      {/* 02 — ABOUT TMEO */}
      <section id="about" className="pub-section pub-about" aria-labelledby="about-title">
        <div className="pub-section-inner pub-about-grid">
          <div className="pub-about-media rv rv--l"><div className="pub-about-photo"><img src={tmeoOffice} alt="Traffic Management and Enforcement Office building" width="680" height="510" loading="lazy" /></div></div>
          <div>
           <div className="rv" style={{ '--d': '100ms' }}>
            <Eyebrow>About TMEO</Eyebrow>
            <h2 id="about-title" className="pub-section-title">Serving Lucena through safer, more orderly roads.</h2>
            <p className="pub-lede">
              The Traffic Management &amp; Enforcement Office helps manage traffic enforcement, process violations,
              and support road safety across Lucena City. This public portal provides a clear and accessible way to
              view information that is appropriate for public release.
            </p>
           </div>
           <div className="rv" style={{ '--d': '280ms', marginTop: 32 }}>
            <Link to="/about" className="pbtn pbtn--ink">Learn more about TMEO <ArrowRight size={16} aria-hidden="true" /></Link>
           </div>
          </div>
        </div>
      </section>

      {/* 02b — ROAD SAFETY REMINDERS (carousel, max 5 slides; content in constants/roadSafetySlides.js) */}
      <section id="road-safety" className="pub-section pub-section--sunken" aria-labelledby="rsc-title">
        <div className="pub-section-inner">
          <div className="pub-head rv">
            <div>
              <Eyebrow>Road Safety Reminders</Eyebrow>
              <h2 id="rsc-title" className="pub-section-title">Know the rules. Drive safe.</h2>
              <p className="pub-lede">Common traffic violations in Lucena and simple ways to avoid them.</p>
            </div>
            <Link to="/violation-updates" className="pub-link">View violation updates <ArrowRight size={15} aria-hidden="true" /></Link>
          </div>
          <div className="rv"><RoadSafetyCarousel /></div>
          <p className="rsc-note">General road-safety reminders based on common TMEO violation categories. For official rules and penalties, please contact the office.</p>
        </div>
      </section>

      {/* 03 — MISSION & VISION (wording comes straight from constants/publicOffice.js) */}
      <section className="pub-mv" aria-labelledby="mv-title">
        <h2 id="mv-title" className="pub-sr">Mission and Vision</h2>
        <div className="pub-mv-panel pub-mv-panel--mission rv rv--ml">
          <div className="pub-mv-panel-in">
            <span className="pub-eyebrow pub-eyebrow--light"><span className="pub-eyebrow-rule" aria-hidden="true" />Our Mission</span>
            <p className="pub-mv-text">{TMEO_MISSION}</p>
          </div>
        </div>
        <div className="pub-mv-panel pub-mv-panel--vision rv rv--mr" style={{ '--d': '140ms' }}>
          <div className="pub-mv-panel-in">
            <Eyebrow>Our Vision</Eyebrow>
            <p className="pub-mv-text">{TMEO_VISION}</p>
            <Link to="/mission-vision" className="pub-link" style={{ marginTop: 28 }}>Mission &amp; Vision <ArrowRight size={15} aria-hidden="true" /></Link>
          </div>
        </div>
      </section>

      {/* 04 — PUBLIC STATISTICS (real API data; see PublicStats.jsx) */}
      <section id="pub-stats" className="pub-section pub-dark" aria-labelledby="insights-title">
        <div className="pub-section-inner">
          <div className="pub-head rv">
            <div>
              <Eyebrow>Traffic Insights</Eyebrow>
              <h2 id="insights-title" className="pub-section-title">Data for a safer Lucena.</h2>
              <p className="pub-lede">Aggregated information only. Personal, vehicle-identifying, and enforcement details are not displayed here.</p>
            </div>
            <Link to="/violation-updates" className="pub-link">Explore records <ArrowRight size={15} aria-hidden="true" /></Link>
          </div>
          <PublicStats />
        </div>
      </section>

      {/* 05 — LATEST VIOLATION UPDATES: static responsive grid, no carousel */}
      <section className="pub-section" aria-labelledby="latest-title">
        <div className="pub-section-inner">
          <div className="pub-head rv">
            <div>
              <Eyebrow>Latest Violation Updates</Eyebrow>
              <h2 id="latest-title" className="pub-section-title">Recent Public Violations</h2>
              <p className="pub-lede">Public-safe records that have been finalized for release.</p>
            </div>
            <Link to="/violation-updates" className="pub-link">View all violations <ArrowRight size={15} aria-hidden="true" /></Link>
          </div>

          {state.loading && (
            <div className="pub-vgrid pub-vgrid--four" aria-busy="true">
              {Array.from({ length: HOME_VIOLATIONS_COUNT }).map((_, i) => <div className="pub-vcard pub-vcard--skeleton" key={i}><LoadingRows rows={3} /></div>)}
            </div>
          )}
          {!state.loading && state.error && <div className="pub-panel"><ErrorState title="Unable to load violation updates" message="Please try again later." onRetry={load} /></div>}
          {!state.loading && !state.error && state.results.length === 0 && (
            <div className="pub-panel"><EmptyState icon={Search} title="No public violation updates are currently available" message="Check back soon as records are finalized for public release." /></div>
          )}
          {!state.loading && !state.error && state.results.length > 0 && (
            <div className="pub-vgrid pub-vgrid--four">
              {state.results.map((r, i) => <PublicViolationCard key={i} record={r} index={i} onSelect={setSelected} />)}
            </div>
          )}
        </div>
      </section>

      {/* 06 — HOW IT WORKS (the four existing steps) */}
      <section className="pub-section pub-section--sunken" aria-labelledby="process-title">
        <div className="pub-section-inner">
          <div className="pub-head rv">
            <div>
              <Eyebrow>Our process</Eyebrow>
              <h2 id="process-title" className="pub-section-title">A simple process. A safer city.</h2>
              <p className="pub-lede">How a traffic violation moves through the official process.</p>
            </div>
          </div>
          <ol className="pub-steps">
            {STEPS.map((s, i) => (
              <li className="pub-step rv" style={{ '--d': `${i * 140}ms` }} key={s.title}>
                <div className="pub-step-ic"><s.icon size={22} strokeWidth={1.7} aria-hidden="true" /></div>
                <div>
                  <div className="pub-step-n" aria-hidden="true">{String(i + 1).padStart(2, '0')}</div>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 07 — CONTACT (real office details only; phone is the client-supplied number) */}
      <section id="contact" className="pub-office pub-office--light" aria-labelledby="office-title">
        <div className="pub-office-map rv rv--curtain">
          <iframe title="TMEO office location map" src={TMEO_MAPS_EMBED_URL} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
          <a className="pub-office-map-link" href={TMEO_MAPS_SEARCH_URL} target="_blank" rel="noopener noreferrer">
            <MapPin size={16} aria-hidden="true" /> Open in Google Maps<span className="pub-sr"> (new tab)</span>
          </a>
        </div>
        <div className="pub-office-copy rv rv--r">
          <Eyebrow>Contact</Eyebrow>
          <h2 id="office-title">We’re here to help.</h2>
          <p className="pub-office-lede">Official office address, email, phone, and Facebook page.</p>
          <address>
            <strong>{TMEO_OFFICE_NAME}</strong>
            {TMEO_ADDRESS_LINES.map((l) => <span key={l} style={{ display: 'block' }}>{l}</span>)}
          </address>
          <div className="pub-office-list">
            <a href={TMEO_GMAIL_URL} target="_blank" rel="noopener noreferrer"><Mail size={18} aria-hidden="true" />{TMEO_EMAIL}<span className="pub-sr"> (opens Gmail in new tab)</span></a>
            {TMEO_PHONE && <a href={`tel:${TMEO_PHONE_TEL}`}><Phone size={18} aria-hidden="true" />{TMEO_PHONE}</a>}
            <a href={TMEO_FACEBOOK_URL} target="_blank" rel="noopener noreferrer"><FacebookIcon size={18} />Official Facebook page<span className="pub-sr"> (new tab)</span></a>
          </div>
          <a href={TMEO_FACEBOOK_URL} target="_blank" rel="noopener noreferrer" className="pbtn pbtn--ink" style={{ alignSelf: 'flex-start' }}>Have a Concern? <ArrowRight size={16} aria-hidden="true" /><span className="pub-sr"> (opens TMEO Facebook page in new tab)</span></a>
        </div>
      </section>

      <ViolationDetailModal open={!!selected} onClose={() => setSelected(null)} record={selected} />
    </>
  )
}