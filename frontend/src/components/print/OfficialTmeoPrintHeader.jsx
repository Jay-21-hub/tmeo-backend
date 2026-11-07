import clientLucenaSeal from '../../assets/print/client-header-lucena-seal.png'
import clientTmeoSeal from '../../assets/print/client-header-tmeo-seal.png'
import clientPhoneIcon from '../../assets/print/client-header-phone-icon.png'
import clientEmailIcon from '../../assets/print/client-header-email-icon.png'

/**
 * OfficialTmeoPrintHeader — THE standard official TMEO print header.
 *
 * Source of truth: the header supplied by the TMEO client (Header.docx). It
 * REPLACES the old "Republic of the Philippines / TRAFFIC ENFORCEMENT
 * SECTION" header, which the client declared incorrect. Do not re-create
 * this markup in any other print template — import this component (and
 * OFFICIAL_TMEO_HEADER_CSS) so every official TMEO form shares one header.
 *
 *   [ LUCENA SEAL ]   City Government of Lucena   [ TMEO SEAL ]
 *                     OFFICE OF THE CITY MAYOR
 *              Traffic Management and Enforcement Office
 *                         address / phone / email
 *
 * Only the institutional identity lives here. The document body (fields,
 * title, layout) stays owned by each document's own template.
 *
 * Seals are real <img> elements (never CSS backgrounds), so they print even
 * with Chrome's "Background graphics" option off. Direct-print callers must
 * await waitForPrintImages() (./waitForPrintImages.js) on the print DOM before
 * window.print() so the seals are loaded when Print Preview opens.
 *
 * Sizing comes from the host sheet's CSS variables (with fallbacks so the
 * header also works standalone):
 *   --or-seal  seal box size      --or-hg  header column gap
 *   --or-k     spacing multiplier (fit tiers)
 * and font sizes are em-relative to the host's font-size.
 */
export default function OfficialTmeoPrintHeader() {
  return (
    <div className="otph">
      <div className="otph-seal"><img src={clientLucenaSeal} alt="City of Lucena Official Seal" loading="eager" decoding="sync" /></div>
      <div className="otph-text">
        <p className="otph-l1">City Government of Lucena</p>
        <p className="otph-l2">OFFICE OF THE CITY MAYOR</p>
        <p className="otph-l3">Traffic Management and Enforcement Office</p>
        <p className="otph-l4">2nd Floor, Old City Hall Building, ML Tagarao Street, Barangay 5, Lucena City</p>
        <p className="otph-l5">
          <span><img src={clientPhoneIcon} alt="" loading="eager" decoding="sync" />0936-956-8050</span>
          <span><img src={clientEmailIcon} alt="" loading="eager" decoding="sync" />tmeslucena@gmail.com</span>
        </p>
      </div>
      <div className="otph-seal"><img src={clientTmeoSeal} alt="TMEO Seal" loading="eager" decoding="sync" /></div>
    </div>
  )
}

// Stylesheet for the header — interpolated into the host template's <style>.
export const OFFICIAL_TMEO_HEADER_CSS = `
  .otph { display: grid; grid-template-columns: var(--or-seal, 16mm) minmax(0, 1fr) var(--or-seal, 16mm); align-items: center; column-gap: calc(var(--or-hg, 3mm) * var(--or-k, 1)); }
  .otph p { margin: 0; overflow-wrap: anywhere; }
  /* Explicit seal box + explicit img size (never the PNG's intrinsic size);
     object-fit: contain = never stretched. */
  .otph-seal { width: var(--or-seal, 16mm); height: var(--or-seal, 16mm); min-width: var(--or-seal, 16mm); display: flex; align-items: center; justify-content: center; }
  .otph-seal img { display: block !important; visibility: visible !important; opacity: 1 !important; width: var(--or-seal, 16mm) !important; height: var(--or-seal, 16mm) !important; max-width: none !important; max-height: none !important; object-fit: contain; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .otph-text { min-width: 0; text-align: center; line-height: 1.1; }
  .otph-l1 { font-family: 'Times New Roman', Times, 'Liberation Serif', serif; font-style: italic; font-size: 0.83em; }
  .otph-l2 { font-family: 'Times New Roman', Times, 'Liberation Serif', serif; font-weight: 700; font-size: 0.95em; }
  .otph-l3 { font-family: 'Times New Roman', Times, 'Liberation Serif', serif; font-size: 0.92em; }
  .otph-l4, .otph-l5 { font-family: Arial, Helvetica, 'Liberation Sans', sans-serif; font-size: 0.64em; line-height: 1.2; }
  .otph-l5 { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; column-gap: 2.2em; }
  .otph-l5 span { display: inline-flex; align-items: center; gap: 0.4em; }
  .otph-l5 img { width: 1.15em; height: 1.15em; object-fit: contain; display: block; }
`