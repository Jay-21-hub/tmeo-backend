import { TMEO_MAPS_SEARCH_URL } from '../../constants/publicOffice'

/**
 * Red location pin fixed at the centre of the embedded map (Google centres the embed on the
 * office address). A full-cover link makes the map open Google Maps, so the pin can never
 * drift away from the location the way it would if visitors could pan the embed.
 */
export default function MapPinOverlay() {
  return (
    <>
      <a className="pub-office-map-hit" href={TMEO_MAPS_SEARCH_URL} target="_blank" rel="noopener noreferrer"
        aria-label="TMEO office location — open in Google Maps (new tab)" />
      <div className="pub-pin" aria-hidden="true">
        <svg viewBox="0 0 24 32" width="38" height="50">
          <path d="M12 1C5.9 1 1 5.9 1 12c0 8.4 11 19 11 19s11-10.6 11-19C23 5.9 18.1 1 12 1z" fill="#e5252a" stroke="#fff" strokeWidth="1.6" />
          <circle cx="12" cy="12" r="4.3" fill="#fff" />
        </svg>
        <span className="pub-pin-label">TMEO Office</span>
      </div>
    </>
  )
}