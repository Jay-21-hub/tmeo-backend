import { Link } from 'react-router-dom'
import { ArrowRight, Mail, MapPin, Phone, MessageCircleQuestion } from 'lucide-react'
import FacebookIcon from './FacebookIcon'
import {
  TMEO_OFFICE_NAME, TMEO_ADDRESS_LINES, TMEO_EMAIL, TMEO_GMAIL_URL,
  TMEO_FACEBOOK_NAME, TMEO_FACEBOOK_URL, TMEO_PHONE, TMEO_PHONE_TEL, TMEO_MAPS_SEARCH_URL, TMEO_MAPS_EMBED_URL,
} from '../../constants/publicOffice'
import tmeoBg from '../../assets/tmeo-office.jpg'

const ext = { target: '_blank', rel: 'noopener noreferrer' }

export default function ContactPage() {
  return (
    <div className="pub-page">
      <section className="pub-page-hero">
        <div className="pub-hero-bg" aria-hidden="true" style={{ '--pub-photo-bg': `url(${tmeoBg})` }} />
        <div className="pub-hero-scrim" aria-hidden="true" />
        <div className="pub-page-hero-inner">
          <span className="pub-eyebrow pub-eyebrow--light"><span className="pub-eyebrow-rule" aria-hidden="true" />Contact</span>
          <h1 className="pub-page-title">Get in touch with TMEO</h1>
          <p className="pub-page-lede">Official office address, email, phone, and Facebook page.</p>
        </div>
      </section>

      <section className="pub-dark">
        <div className="pub-office">
          <div className="pub-office-map">
            <iframe title="TMEO office location map" src={TMEO_MAPS_EMBED_URL} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
            <a className="pub-office-map-link" href={TMEO_MAPS_SEARCH_URL} {...ext}>
              <MapPin size={16} aria-hidden="true" /> Open in Google Maps<span className="pub-sr"> (new tab)</span>
            </a>
          </div>
          <div className="pub-office-copy rv">
            <span className="pub-eyebrow"><span className="pub-eyebrow-rule" aria-hidden="true" />Visit our office</span>
            <h2>We’re here to help.</h2>
            <address>
              <strong style={{ color: '#fff' }}>{TMEO_OFFICE_NAME}</strong>
              {TMEO_ADDRESS_LINES.map((l) => <span key={l} style={{ display: 'block' }}>{l}</span>)}
            </address>
            <div className="pub-office-list">
              <a href={TMEO_MAPS_SEARCH_URL} {...ext}><MapPin size={18} aria-hidden="true" />Get directions<span className="pub-sr"> (new tab)</span></a>
              <a href={TMEO_GMAIL_URL} {...ext}><Mail size={18} aria-hidden="true" />{TMEO_EMAIL}<span className="pub-sr"> (opens Gmail in new tab)</span></a>
              {TMEO_PHONE && <a href={`tel:${TMEO_PHONE_TEL}`}><Phone size={18} aria-hidden="true" />{TMEO_PHONE}</a>}
              <a href={TMEO_FACEBOOK_URL} {...ext}><FacebookIcon size={18} />{TMEO_FACEBOOK_NAME}<span className="pub-sr"> (new tab)</span></a>
            </div>
          </div>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-section-inner pub-head rv" style={{ marginBottom: 0, alignItems: 'center' }}>
          <div>
            <span className="pub-eyebrow"><span className="pub-eyebrow-rule" aria-hidden="true" />Have a concern?</span>
            <h2 className="pub-section-title">Send it through our official Facebook page.</h2>
          </div>
          <a href={TMEO_FACEBOOK_URL} {...ext} className="pbtn pbtn--ink">
            <MessageCircleQuestion size={16} aria-hidden="true" /> Message us on Facebook <ArrowRight size={16} aria-hidden="true" /><span className="pub-sr"> (new tab)</span>
          </a>
        </div>
      </section>
    </div>
  )
}