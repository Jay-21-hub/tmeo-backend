import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../services/api'
import tmeoLogo from '../assets/TMEO_ICON.jpg'
import tmeoBg  from '../assets/TMEO.jpg'
import { Eye, EyeOff } from 'lucide-react'

export default function ResetPassword() {
  const { uid, token } = useParams()
  const navigate = useNavigate()
  const [password, setPassword]   = useState('')
  const [confirm,  setConfirm]    = useState('')
  const [showPw,   setShowPw]     = useState(false)
  const [showCf,   setShowCf]     = useState(false)
  const [msg,      setMsg]        = useState('')
  const [err,      setErr]        = useState('')
  const [loading,  setLoading]    = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr(''); setMsg('')
    if (password !== confirm) { setErr('Passwords do not match.'); return }
    if (password.length < 8)  { setErr('Password must be at least 8 characters.'); return }

    setLoading(true)
    try {
      await api.post('/api/auth/reset-password/', {
        uid,
        token,
        new_password:     password,
        confirm_password: password,
    })
      setMsg('Password reset successful! Redirecting to login...')
      setTimeout(() => navigate('/login'), 2500)
    } catch (e) {
      setErr(e.response?.data?.detail || 'Link may have expired. Please request a new one.')
    } finally {
      setLoading(false)
    }
  }

  const s = {
    page: {
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundImage: `url(${tmeoBg})`, backgroundSize: 'cover', backgroundPosition: 'center',
      fontFamily: 'Inter, sans-serif', position: 'relative',
    },
    overlay: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' },
    card: {
      position: 'relative', zIndex: 1, background: '#fff', borderRadius: 20,
      padding: '2.5rem 2rem', width: '100%', maxWidth: 420,
      boxShadow: '0 12px 48px rgba(0,0,0,0.3)',
    },
    logo: { display: 'block', margin: '0 auto 16px', width: 72, height: 72,
            borderRadius: '50%', objectFit: 'cover', border: '3px solid #1a3c5e' },
    title: { textAlign: 'center', fontWeight: 800, fontSize: 22, color: '#1a3c5e', marginBottom: 4 },
    sub:   { textAlign: 'center', fontSize: 13, color: '#888', marginBottom: 24, lineHeight: 1.5 },
    label: { fontSize: 13, fontWeight: 600, color: '#334', marginBottom: 4, display: 'block' },
    inputWrap: { position: 'relative', marginBottom: 16 },
    input: { width: '100%', padding: '11px 40px 11px 14px', borderRadius: 10,
             border: '1.5px solid #dde', fontSize: 14, boxSizing: 'border-box', outline: 'none' },
    eyeBtn: { position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer', color: '#888', padding: 0 },
    btn: { width: '100%', padding: 12, borderRadius: 10, background: '#1a3c5e',
           color: '#fff', fontWeight: 700, fontSize: 15, border: 'none', cursor: 'pointer', marginTop: 4 },
    err: { background: '#fde8e8', color: '#c0392b', borderRadius: 8,
           padding: '10px 14px', fontSize: 13, marginBottom: 14 },
    ok:  { background: '#e8f5e9', color: '#256029', borderRadius: 8,
           padding: '10px 14px', fontSize: 13, marginBottom: 14 },
  }

  return (
    <div style={s.page}>
      <div style={s.overlay} />
      <div style={s.card}>
        <img src={tmeoLogo} alt="TMEO" style={s.logo} />
        <p style={s.title}>Reset Password</p>
        <p style={s.sub}>Enter and confirm your new password.</p>

        {err && <div style={s.err}>{err}</div>}
        {msg && <div style={s.ok}>{msg}</div>}

        {!msg && (
          <form onSubmit={handleSubmit}>
            <label style={s.label}>New Password</label>
            <div style={s.inputWrap}>
              <input style={s.input} type={showPw ? 'text' : 'password'}
                     placeholder="At least 8 characters"
                     value={password} onChange={e => setPassword(e.target.value)} required />
              <button type="button" style={s.eyeBtn} onClick={() => setShowPw(p => !p)}>
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            <label style={s.label}>Confirm Password</label>
            <div style={s.inputWrap}>
              <input style={s.input} type={showCf ? 'text' : 'password'}
                     placeholder="Re-enter password"
                     value={confirm} onChange={e => setConfirm(e.target.value)} required />
              <button type="button" style={s.eyeBtn} onClick={() => setShowCf(p => !p)}>
                {showCf ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            <button style={s.btn} type="submit" disabled={loading}>
              {loading ? 'Resetting...' : 'Reset Password'}
            </button>
          </form>
        )}

        {msg && (
          <button style={s.btn} onClick={() => navigate('/login')}>
            Go to Login
          </button>
        )}
      </div>
    </div>
  )
}