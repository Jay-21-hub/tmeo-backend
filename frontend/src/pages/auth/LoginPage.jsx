import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, Link } from 'react-router-dom'
import api from '../../services/api'
import { API, ROLES } from '../../constants'
import { isInstalledPwa } from '../../utils/pwaDisplay'
import tmeoSeal from '../../assets/tmeo-seal.png'
import tmeoBg from '../../assets/tmeo-office.jpg'
import { Eye, EyeOff, User, Lock, ArrowRight, ArrowLeft, Loader2, AlertCircle, X, Send, CheckCircle2 } from 'lucide-react'
import './LoginPage.css'

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * Forgot Password dialog.
 *
 * Defined at MODULE level and owning its own transient state (ID, loading,
 * error, success) so that typing never re-renders LoginPage, and so closing
 * it (which unmounts it) naturally resets everything for the next open.
 *
 * Why not the shared <Modal>? Its focus effect depends on `onClose`; any
 * parent that passes an inline handler re-runs that effect on every keystroke,
 * which re-focuses the first button (the X). All listeners here are attached
 * once (empty deps) and read the latest callbacks through refs.
 */
function ForgotPasswordDialog({ onClosed }) {
  const [username, setUsername] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [phase, setPhase] = useState('form')      // 'form' | 'leaving' | 'done'
  const [closing, setClosing] = useState(false)

  const inputRef = useRef(null)
  const doneRef = useRef(null)
  const panelRef = useRef(null)
  const pendingRef = useRef(false)
  const aliveRef = useRef(true)
  const timersRef = useRef([])
  const onClosedRef = useRef(onClosed)
  useEffect(() => { onClosedRef.current = onClosed })

  const closingRef = useRef(false)
  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    if (prefersReducedMotion()) onClosedRef.current?.()
    else timersRef.current.push(setTimeout(() => onClosedRef.current?.(), 170))
  }, [])
  const requestCloseRef = useRef(requestClose)

  // Mount-only: initial focus, scroll lock, Escape + Tab wrap. Never re-runs on typing.
  useEffect(() => {
    aliveRef.current = true
    const timers = timersRef.current
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    inputRef.current?.focus()

    const onKeyDown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); requestCloseRef.current(); return }
      if (e.key !== 'Tab' || !panelRef.current) return
      const items = [...panelRef.current.querySelectorAll('button:not([disabled]), input:not([disabled])')]
      if (!items.length) return
      const first = items[0], last = items[items.length - 1]
      const active = document.activeElement
      if (!panelRef.current.contains(active)) { e.preventDefault(); first.focus() }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      aliveRef.current = false
      timers.forEach(clearTimeout)
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [])

  // Move focus to Done once the success view has replaced the form.
  useEffect(() => { if (phase === 'done') doneRef.current?.focus() }, [phase])

  const handleSubmit = async (e) => {
    e.preventDefault()
    e.stopPropagation() // never let this submit reach any ancestor form handler
    if (pendingRef.current) return
    if (!username.trim()) { setError('Please enter your ID Number.'); inputRef.current?.focus(); return }
    pendingRef.current = true
    setError(''); setLoading(true)
    try {
      // Request contract unchanged: POST /api/auth/forgot-password/ { username }
      await api.post('/api/auth/forgot-password/', { username })
      if (!aliveRef.current) return
      if (prefersReducedMotion()) setPhase('done')
      else {
        setPhase('leaving')
        timersRef.current.push(setTimeout(() => aliveRef.current && setPhase('done'), 200))
      }
    } catch (err) {
      if (!aliveRef.current) return
      const detail = err.response?.data?.detail
      if (!err.response) setError('Unable to reach the server. Please check your connection and try again.')
      else if (err.response.status === 400 && typeof detail === 'string') setError(detail)
      else setError('Something went wrong while sending the reset link. Please try again.')
    } finally {
      pendingRef.current = false
      if (aliveRef.current) setLoading(false)
    }
  }

  const done = phase === 'done'

  return createPortal(
    <div
      className={`lg-fp-overlay ${closing ? 'is-closing' : ''}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose() }}
    >
      <div
        ref={panelRef}
        className="lg-fp-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lg-fp-title"
        aria-describedby={done ? 'lg-fp-done-desc' : 'lg-fp-desc'}
      >
        <h2 id="lg-fp-title" className="lg-fp-title">Forgot Password</h2>
        <span className="lg-fp-rule" aria-hidden="true" />

        {!done ? (
          <form className={`lg-fp-body ${phase === 'leaving' ? 'is-leaving' : ''}`} onSubmit={handleSubmit} noValidate aria-busy={loading}>
            <p id="lg-fp-desc" className="lg-fp-desc">
              Enter your ID Number and we'll send a password reset link to the Gmail linked to your account.
            </p>

            <label htmlFor="fp-id" className="lg-label">ID Number</label>
            <div className="lg-field">
              <User className="lg-ico" size={18} strokeWidth={1.6} aria-hidden="true" />
              <input
                id="fp-id" ref={inputRef} type="text" className="lg-input"
                placeholder="e.g. ADMIN-2024-001" autoComplete="username"
                value={username} onChange={e => setUsername(e.target.value)}
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={error ? 'lg-fp-error' : undefined}
              />
            </div>

            {error && (
              <div id="lg-fp-error" className="lg-error" role="alert">
                <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <div className="lg-fp-actions">
              <button type="button" className="lg-fp-cancel" onClick={requestClose}>Cancel</button>
              <button type="submit" className="lg-submit lg-fp-send" disabled={loading}>
                {loading ? (
                  <><Loader2 size={18} className="lg-spin" aria-hidden="true" /><span>Sending...</span></>
                ) : (
                  <><span>Send Reset Link</span><Send size={17} strokeWidth={2} aria-hidden="true" /></>
                )}
              </button>
            </div>
          </form>
        ) : (
          <div className="lg-fp-body lg-fp-success">
            <span className="lg-fp-check" aria-hidden="true"><CheckCircle2 size={44} strokeWidth={1.6} /></span>
            <h3 className="lg-fp-success-title">Reset Link Sent</h3>
            <p id="lg-fp-done-desc" className="lg-fp-success-text">
              If that ID Number matches an account, a password reset link has been sent to the Gmail linked to it.
            </p>
            <p className="lg-fp-success-sub">Check your inbox (and spam folder) and follow the link to create a new password.</p>
            <button ref={doneRef} type="button" className="lg-submit lg-fp-done" onClick={requestClose}>
              <span>Done</span><ArrowRight size={18} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Last in DOM so Tab order is: ID → Cancel → Send → Close; positioned top-right by CSS. */}
        <button type="button" className="lg-fp-close" onClick={requestClose} aria-label="Close dialog">
          <X size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body
  )
}

export default function LoginPage() {
  const [form, setForm] = useState({ id_number: '', password: '' })
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const [fpOpen, setFpOpen] = useState(false)
  const fpTriggerRef = useRef(null)
  const closeFp = useCallback(() => {
    setFpOpen(false)
    fpTriggerRef.current?.focus()   // restore focus to the "Forgot password?" trigger
  }, [])

  // Authentication logic is unchanged from the previous implementation.
  const handleLogin = async () => {
    if (loading) return
    if (!form.id_number || !form.password) { setError('ID number and password are required.'); return }
    setLoading(true); setError('')
    try {
      const res = await api.post(API.LOGIN, form)
      const { user, access, refresh } = res.data
      localStorage.setItem('access_token', access)
      localStorage.setItem('refresh_token', refresh)
      localStorage.setItem('user', JSON.stringify(user))
      if (user.role === ROLES.ADMIN) navigate('/admin')
      else if (user.role === ROLES.STAFF) navigate('/staff')
      else navigate('/enforcer')
    } catch {
      setError('Invalid credentials. Please verify your ID and password.')
    } finally { setLoading(false) }
  }

  const handleSubmit = (e) => { e.preventDefault(); handleLogin() }

  return (
    <div className="lg-shell">
      <div className="lg-bg" style={{ backgroundImage: `url(${tmeoBg})` }} aria-hidden="true" />
      <div className="lg-overlay" aria-hidden="true" />

      <main className="lg-stack">
        <header className="lg-brand">
          <img className="lg-seal" src={tmeoSeal} alt="TMEO seal" width="84" height="84" />
          <div className="lg-wordmark">TMEO</div>
          <div className="lg-city">Lucena City</div>
          <span className="lg-gold-rule" aria-hidden="true" />
          <div className="lg-office">Traffic Management &amp; Enforcement Office</div>
        </header>

        <section className="lg-card" aria-labelledby="lg-title">
          <h1 id="lg-title" className="lg-title lg-in" style={{ '--i': 0 }}>Welcome Back</h1>
          <p className="lg-sub lg-in" style={{ '--i': 1 }}>Sign in to access the TMEO management system.</p>

          <form className="lg-form" onSubmit={handleSubmit} noValidate>
            <div className="lg-group lg-in" style={{ '--i': 2 }}>
              <label htmlFor="id_number" className="lg-label">ID Number</label>
              <div className="lg-field">
                <User className="lg-ico" size={18} strokeWidth={1.6} aria-hidden="true" />
                <input
                  id="id_number" name="id_number" type="text" className="lg-input"
                  placeholder="Enter your ID number" autoComplete="username"
                  value={form.id_number}
                  onChange={e => setForm(f => ({ ...f, id_number: e.target.value }))}
                  aria-invalid={error ? 'true' : undefined}
                  aria-describedby={error ? 'lg-error' : undefined}
                />
              </div>
            </div>

            <div className="lg-group lg-in" style={{ '--i': 3 }}>
              <label htmlFor="password" className="lg-label">Password</label>
              <div className="lg-field">
                <Lock className="lg-ico" size={18} strokeWidth={1.6} aria-hidden="true" />
                <input
                  id="password" name="password" type={showPass ? 'text' : 'password'} className="lg-input lg-input--eye"
                  placeholder="Enter your password" autoComplete="current-password"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  aria-invalid={error ? 'true' : undefined}
                  aria-describedby={error ? 'lg-error' : undefined}
                />
                <button type="button" className="lg-eye" onClick={() => setShowPass(s => !s)}
                  aria-label={showPass ? 'Hide password' : 'Show password'}>
                  {showPass ? <EyeOff size={18} strokeWidth={1.6} aria-hidden="true" /> : <Eye size={18} strokeWidth={1.6} aria-hidden="true" />}
                </button>
              </div>
              <div className="lg-forgot-row">
                <button type="button" ref={fpTriggerRef} className="lg-forgot" onClick={() => setFpOpen(true)}>Forgot password?</button>
              </div>
            </div>

            {error && (
              <div id="lg-error" className="lg-error" role="alert">
                <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <button type="submit" className="lg-submit lg-in" style={{ '--i': 4 }} disabled={loading} aria-busy={loading}>
              {loading ? (
                <><Loader2 size={18} className="lg-spin" aria-hidden="true" /><span>Authenticating...</span></>
              ) : (
                <><span>Sign In</span><ArrowRight size={18} strokeWidth={2.2} aria-hidden="true" /></>
              )}
            </button>
          </form>

          {!isInstalledPwa() && (
            <>
              <hr className="lg-rule lg-in" style={{ '--i': 5 }} />
              <Link to="/" className="lg-back lg-in" style={{ '--i': 6 }}>
                <ArrowLeft size={18} strokeWidth={1.8} aria-hidden="true" />
                <span>Back to Public Website</span>
              </Link>
            </>
          )}
        </section>
      </main>

      {/* ── FORGOT PASSWORD DIALOG (portal; outside the login <form>) ── */}
      {fpOpen && <ForgotPasswordDialog onClosed={closeFp} />}
    </div>
  )
}