import { TMEO_MISSION, TMEO_VISION } from '../../constants/publicOffice'
import tmeoBg from '../../assets/tmeo-office.jpg'

export default function MissionVisionPage() {
  return (
    <div className="pub-page">
      <section className="pub-page-hero">
        <div className="pub-hero-bg" aria-hidden="true" style={{ '--pub-photo-bg': `url(${tmeoBg})` }} />
        <div className="pub-hero-scrim" aria-hidden="true" />
        <div className="pub-page-hero-inner">
          <span className="pub-eyebrow pub-eyebrow--light"><span className="pub-eyebrow-rule" aria-hidden="true" />Mission &amp; Vision</span>
          <h1 className="pub-page-title">What guides TMEO</h1>
          <p className="pub-page-lede">Our official Mission and Vision statements.</p>
        </div>
      </section>
      <section className="pub-section">
        <div className="pub-section-inner">
          {[['01', 'Mission', TMEO_MISSION], ['02', 'Vision', TMEO_VISION]].map(([n, label, text], i) => (
            <div className="pub-mv-row rv" key={label} style={{ '--d': `${i * 140}ms` }}>
              <div><div className="pub-mv-num" aria-hidden="true">{n}</div><h2 className="pub-eyebrow" style={{ margin: 0 }}>{label}</h2></div>
              <p className="pub-mv-statement">{text}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}