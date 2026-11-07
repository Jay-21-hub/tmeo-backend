import { Link } from 'react-router-dom'
import { ShieldCheck, ClipboardList, Radio, MapPin, ArrowRight } from 'lucide-react'
import { TMEO_ADDRESS_LINES, TMEO_MAPS_SEARCH_URL } from '../../constants/publicOffice'
import tmeoBg from '../../assets/tmeo-office.jpg'

const PILLARS = [
  { icon: ShieldCheck, title: 'Traffic Enforcement', text: 'Enforcers record violations in the field, capturing the details needed to process each case fairly.' },
  { icon: ClipboardList, title: 'Assessment & Processing', text: 'Every recorded violation is reviewed and assessed by TMEO staff before it becomes an official record.' },
  { icon: Radio, title: 'Public Transparency', text: 'Once a violation clears assessment, a public-safe summary is shared here — without exposing anyone\u2019s personal information.' },
]

export default function AboutPage() {
  return (
    <div className="pub-page">
      <section className="pub-page-hero">
        <div className="pub-hero-bg" aria-hidden="true" style={{ '--pub-photo-bg': `url(${tmeoBg})` }} />
        <div className="pub-hero-scrim" aria-hidden="true" />
        <div className="pub-page-hero-inner">
          <span className="pub-eyebrow pub-eyebrow--light"><span className="pub-eyebrow-rule" aria-hidden="true" />About</span>
          <h1 className="pub-page-title">Traffic Management &amp; Enforcement Office</h1>
          <p className="pub-page-lede">
            TMEO is Lucena City's traffic management and enforcement system — built to record, process, and track
            traffic violations through a digital workflow used by enforcers, assessment staff, and administrators across the city.
          </p>
        </div>
      </section>

      <section className="pub-section pub-about">
        <div className="pub-section-inner pub-about-grid">
          <div className="pub-about-photo rv"><img src={tmeoBg} alt="Traffic Management and Enforcement Office building" width="680" height="510" loading="lazy" /></div>
          <div className="rv" style={{ '--d': '100ms' }}>
            <span className="pub-eyebrow"><span className="pub-eyebrow-rule" aria-hidden="true" />How we work</span>
            <h2 className="pub-section-title">From the roadside to the public record.</h2>
            <ol className="pub-steps" style={{ display: 'block', marginTop: 32 }}>
              {PILLARS.map((p, i) => (
                <li className="pub-step pub-step--stack rv" key={p.title} style={{ '--d': `${i * 120}ms`, paddingBottom: i === PILLARS.length - 1 ? 0 : 32 }}>
                  <div className="pub-step-ic"><p.icon size={22} strokeWidth={1.7} aria-hidden="true" /></div>
                  <div><h3>{p.title}</h3><p style={{ maxWidth: '46ch' }}>{p.text}</p></div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section className="pub-section pub-dark">
        <div className="pub-section-inner pub-head" style={{ marginBottom: 0, alignItems: 'center' }}>
          <div className="rv">
            <span className="pub-eyebrow"><span className="pub-eyebrow-rule" aria-hidden="true" />Visit our office</span>
            <h2 className="pub-section-title">{TMEO_ADDRESS_LINES.join(' ')}</h2>
          </div>
          <div className="pub-cta-actions rv">
            <a href={TMEO_MAPS_SEARCH_URL} target="_blank" rel="noopener noreferrer" className="pbtn pbtn--gold">
              <MapPin size={16} aria-hidden="true" /> Open in Google Maps<span className="pub-sr"> (new tab)</span>
            </a>
            <Link to="/contact" className="pub-link">Full contact details <ArrowRight size={15} aria-hidden="true" /></Link>
          </div>
        </div>
      </section>
    </div>
  )
}