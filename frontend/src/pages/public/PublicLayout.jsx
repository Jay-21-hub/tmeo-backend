import { useEffect, useRef, useState } from 'react'
import { NavLink, Link, Outlet, useLocation } from 'react-router-dom'
import { ArrowRight, Mail, Menu, Phone, X } from 'lucide-react'
import FacebookIcon from './FacebookIcon'
import tmeoLogo from '../../assets/TMEO_ICON.jpg'
import { TMEO_EMAIL, TMEO_GMAIL_URL, TMEO_FACEBOOK_URL, TMEO_OFFICE_NAME, TMEO_PHONE, TMEO_PHONE_TEL } from '../../constants/publicOffice'
import useReveal from './useReveal'
import './public.css'

const NAV_LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/about', label: 'About' },
  { to: '/mission-vision', label: 'Mission & Vision' },
  { to: '/violation-updates', label: 'Violation Updates' },
  { to: '/contact', label: 'Contact' },
]

function Brand({ onClick }) {
  return (
    <NavLink to="/" className="pub-brand" aria-label="TMEO — Home" onClick={onClick}>
      <img src={tmeoLogo} alt="" className="pub-brand-logo" />
      <span className="pub-brand-text">
        <span className="pub-brand-name">TMEO</span>
        <span className="pub-brand-sub">Lucena City</span>
      </span>
    </NavLink>
  )
}

export default function PublicLayout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const { pathname } = useLocation()
  const toggleRef = useRef(null)
  const drawerRef = useRef(null)
  const closeRef = useRef(null)

  useReveal() // one scroll-reveal observer for every public page

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- close the drawer and reset scroll on route change
    setMenuOpen(false)
    window.scrollTo(0, 0)
  }, [pathname])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!menuOpen) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') { setMenuOpen(false); toggleRef.current?.focus() }
      if (e.key === 'Tab' && drawerRef.current) {
        const f = drawerRef.current.querySelectorAll('a[href], button')
        const first = f[0], last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [menuOpen])

  return (
    <div className="pub">
      <a href="#pub-main" className="pub-skip-link">Skip to main content</a>

      <header className={`pub-header${scrolled ? ' pub-header--solid' : ''}`}>
        <div className="pub-header-inner">
          <Brand />
          <nav className="pub-nav-desktop" aria-label="Primary">
            {NAV_LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end}
                className={({ isActive }) => `pub-nav-link${isActive ? ' pub-nav-link--active' : ''}`}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="pub-header-actions">
            <Link to="/login" className="pbtn pbtn--gold pub-cta-nav">Staff / Admin Login</Link>
            <button ref={toggleRef} type="button" className="pub-menu-toggle" aria-label="Open menu"
              aria-expanded={menuOpen} aria-controls="pub-drawer" onClick={() => setMenuOpen(true)}>
              <Menu size={22} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <div id="pub-drawer" ref={drawerRef} className={`pub-drawer${menuOpen ? ' pub-drawer--open' : ''}`}
        role="dialog" aria-modal="true" aria-label="Site menu" aria-hidden={!menuOpen}>
        <div className="pub-drawer-top">
          <Brand onClick={() => setMenuOpen(false)} />
          <button ref={closeRef} type="button" className="pub-menu-toggle" aria-label="Close menu" onClick={() => { setMenuOpen(false); toggleRef.current?.focus() }}>
            <X size={22} aria-hidden="true" />
          </button>
        </div>
        <nav aria-label="Mobile">
          {NAV_LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} onClick={() => setMenuOpen(false)}
              className={({ isActive }) => (isActive ? 'pub-nav-link--active' : '')}>
              {l.label} <ArrowRight size={18} aria-hidden="true" />
            </NavLink>
          ))}
        </nav>
        <Link to="/login" className="pbtn pbtn--gold" onClick={() => setMenuOpen(false)}>Staff / Admin Login</Link>
      </div>

      <main id="pub-main" className="pub-main"><Outlet /></main>

      <footer className="pub-footer">
        {/* One centered column on every viewport: description, contact row, then the copyright row (brand already lives in the header). */}
        <div className="pub-footer-inner">
          <p className="pub-footer-desc rv" style={{ '--d': '0ms' }}>{TMEO_OFFICE_NAME}. A public information portal for traffic violation updates and official office information.</p>
          <div className="pub-footer-links rv" style={{ '--d': '140ms' }}>
            <a href={TMEO_GMAIL_URL} target="_blank" rel="noopener noreferrer" className="pub-footer-link"><Mail size={15} aria-hidden="true" /> {TMEO_EMAIL}<span className="pub-sr"> (opens Gmail in new tab)</span></a>
            {TMEO_PHONE && <a href={`tel:${TMEO_PHONE_TEL}`} className="pub-footer-link"><Phone size={15} aria-hidden="true" /> {TMEO_PHONE}</a>}
            <a href={TMEO_FACEBOOK_URL} target="_blank" rel="noopener noreferrer" className="pub-footer-link"><FacebookIcon size={15} /> Facebook<span className="pub-sr"> (opens in new tab)</span></a>
          </div>
        </div>
        <div className="pub-footer-bottom">© {new Date().getFullYear()} {TMEO_OFFICE_NAME}, Lucena City. All rights reserved.</div>
      </footer>
    </div>
  )
}