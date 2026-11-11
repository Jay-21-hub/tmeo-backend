import { X, Printer } from 'lucide-react'
import { OVR_CHECKLIST_LEFT, OVR_CHECKLIST_RIGHT, getCheckedOvrItems } from '../../constants/ovrChecklist'

/**
 * OVRPrintTemplate
 *
 * Renders a print-accurate reproduction of the physical "Ordinance
 * Violation Receipt (OVR)" booklet page (Section 5, City Ordinance No.
 * 2510, Series of 2014), populated from a Violation record.
 *
 * Data-shape notes (please confirm these decisions, Jay):
 *  - The paper form has separate LAST NAME / FIRST NAME / MIDDLE NAME
 *    boxes, but `Violation.violator_name` is a single free-text field with
 *    no split. Rather than guessing a split (risky — many names don't
 *    follow "First Middle Last"), this renders one full-width "Name" row
 *    instead of three boxes. Flag if you'd rather add first/middle/last
 *    fields to the model later.
 *  - No official City of Lucena seal image exists in the project
 *    (checked src/assets, public/, and both zips) — the seal area is a
 *    plain bordered placeholder box, not a drawn/fabricated seal. Drop a
 *    real seal PNG/SVG into src/assets and wire it in here when you have one.
 *  - "Apprehending Officer" comes from `violation.enforcer.full_name` (the
 *    enforcer who filed the record). "Violator's Signature" is left blank
 *    — it's a physical wet-ink signature line, not app data.
 *
 * Props:
 *  - violation: full Violation object (ViolationDetailSerializer shape —
 *    needs violator_name, address, license_number, license_status,
 *    location, date_issued, vehicle_use, vehicle_type, plate_number,
 *    registration_number, ovr_number, enforcer, items[])
 *  - onClose: fn — closes the modal
 */

// Moved out of OVRPrintTemplate: these were being declared inside the
// component body, which recreates them (and resets their state) on every
// render. They don't depend on anything but their own props, so they're
// plain module-level components now.
function Box({ checked: isChecked }) {
  return (
    <span style={{
      display: 'inline-block', width: 12, height: 12, border: '1px solid #000',
      marginRight: 6, textAlign: 'center', lineHeight: '10px', fontSize: 10, fontWeight: 700,
    }}>
      {isChecked ? 'X' : ''}
    </span>
  )
}

function Field({ label, value, style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', borderBottom: '1px solid #000', padding: '3px 4px', ...style }}>
      <span style={{ fontSize: 11, fontWeight: 700, marginRight: 6, whiteSpace: 'nowrap' }}>{label}:</span>
      <span style={{ fontSize: 12, flex: 1 }}>{value || '\u00A0'}</span>
    </div>
  )
}

// Depended on `checked`/`othersList` via closure before — now takes them
// as props so it can live outside the component too.
function ChecklistColumn({ items, checked, othersList }) {
  return (
    <div style={{ flex: 1 }}>
      {items.map(label => (
        <div key={label} style={{ display: 'flex', alignItems: 'baseline', marginBottom: 4 }}>
          <Box checked={checked.has(label)} />
          <span style={{ fontSize: 12 }}>
            {label}
            {label === 'Others' && othersList.length > 0 && (
              <span>: {othersList.join(', ')}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function OVRPrintTemplate({ violation, onClose }) {
  const { checked, othersList } = getCheckedOvrItems(violation?.items)

  const issuedAt = violation?.date_issued ? new Date(violation.date_issued) : null
  const dateStr = issuedAt ? issuedAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''
  const timeStr = issuedAt ? issuedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : ''

  const isPrivate = violation?.vehicle_use === 'private'
  const isPublic  = violation?.vehicle_use === 'public'
  const isConfiscated    = violation?.license_status === 'confiscated'
  const isNotConfiscated = violation?.license_status === 'not_confiscated' || violation?.license_status === 'other_documents'

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.() }}>
      <div style={{ background: 'var(--white)', borderRadius: 'var(--radius-xl)', width: '100%', maxWidth: 720, maxHeight: '90vh', overflowY: 'auto', boxShadow: 'var(--shadow-xl)' }}>

        {/* On-screen chrome — hidden on print via #printable-ovr rule below */}
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--slate-100)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--slate-950)' }}>OVR Print Preview</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--slate-400)', cursor: 'pointer', padding: 4 }} aria-label="Close"><X size={20} /></button>
        </div>

        {/* Printable form — plain black-on-white to mirror the physical booklet page */}
        <div id="printable-ovr" style={{ background: '#fff', color: '#000', fontFamily: "'Times New Roman', Times, serif", padding: '24px 28px', margin: '16px' }}>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}>
            {/* Seal placeholder — no official City of Lucena seal asset exists in the project.
                Do not replace this with a drawn/invented seal; swap for a real image asset when available. */}
            <div style={{
              width: 64, height: 64, borderRadius: '50%', border: '1px dashed #666',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <span style={{ fontSize: 8, color: '#888', textAlign: 'center', lineHeight: 1.2 }}>City Seal</span>
            </div>

            <div style={{ flex: 1, textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: 13 }}>Republic of the Philippines</p>
              <p style={{ margin: 0, fontSize: 13 }}>City of Lucena</p>
              <p style={{ margin: '4px 0 0', fontSize: 15, fontWeight: 700 }}>OFFICE OF THE CITY MAYOR</p>
            </div>

            {/* Second seal on the physical form (Traffic Enforcement Section) — same placeholder rule applies */}
            <div style={{
              width: 64, height: 64, borderRadius: '50%', border: '1px dashed #666',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <span style={{ fontSize: 8, color: '#888', textAlign: 'center', lineHeight: 1.2 }}>TES Seal</span>
            </div>
          </div>

          <div style={{ textAlign: 'center', marginBottom: 4 }}>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 700, border: '1px solid #000', display: 'inline-block', padding: '2px 12px' }}>
              ORDINANCE VIOLATION RECEIPT (OVR)
            </p>
          </div>
          <p style={{ textAlign: 'center', fontSize: 11, margin: '0 0 14px' }}>
            (As per Section 5, City Ordinance No. 2510, Series of 2014)
          </p>

          <div style={{ border: '1px solid #000', marginBottom: 8 }}>
            <Field label="Name" value={violation?.violator_name} />
            <Field label="Address" value={violation?.address} style={{ borderBottom: '1px solid #000' }} />
            <div style={{ display: 'flex', borderBottom: '1px solid #000' }}>
              <Field label="License Number" value={violation?.license_number} style={{ flex: 1, borderBottom: 'none', borderRight: '1px solid #000' }} />
              <div style={{ display: 'flex', alignItems: 'center', padding: '3px 8px', gap: 12 }}>
                <span style={{ fontSize: 11 }}><Box checked={isConfiscated} />Confiscated</span>
                <span style={{ fontSize: 11 }}><Box checked={isNotConfiscated} />Not Confiscated</span>
              </div>
            </div>
            <Field label="Place" value={violation?.location} />
          </div>

          <div style={{ display: 'flex', border: '1px solid #000', borderTop: 'none', marginTop: -8, marginBottom: 8 }}>
            <Field label="Date" value={dateStr} style={{ flex: 1, borderBottom: 'none', borderRight: '1px solid #000' }} />
            <Field label="Time" value={timeStr} style={{ flex: 1, borderBottom: 'none', borderRight: '1px solid #000' }} />
            <div style={{ display: 'flex', alignItems: 'center', padding: '3px 8px', gap: 12 }}>
              <span style={{ fontSize: 11 }}><Box checked={isPrivate} />Private</span>
              <span style={{ fontSize: 11 }}><Box checked={isPublic} />Public</span>
            </div>
          </div>

          <div style={{ display: 'flex', border: '1px solid #000', marginTop: -8, marginBottom: 14 }}>
            <Field label="Vehicle Type" value={violation?.vehicle_type} style={{ flex: 1, borderBottom: 'none', borderRight: '1px solid #000' }} />
            <Field label="Plate No./Body No." value={violation?.plate_number} style={{ flex: 1, borderBottom: 'none', borderRight: '1px solid #000' }} />
            <Field label="Registration No." value={violation?.registration_number} style={{ flex: 1, borderBottom: 'none' }} />
          </div>

          <p style={{ fontSize: 12, margin: '0 0 10px' }}>
            You are hereby charged for committing the Traffic / Administrative violation(s) indicated hereunder:
          </p>

          <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
            <ChecklistColumn items={OVR_CHECKLIST_LEFT} checked={checked} othersList={othersList} />
            <ChecklistColumn items={OVR_CHECKLIST_RIGHT} checked={checked} othersList={othersList} />
          </div>

          <p style={{ fontSize: 11, margin: '0 0 18px', lineHeight: 1.5 }}>
            You are directed to appear at the Traffic Enforcement Section within Five (5) day from date hereof, for
            appropriate disposition of his violation. Failure to appear as required shall constrain the proper
            authorities to forward this case to the Office of the City Prosecutor for the filing of appropriate charge(s).
          </p>

          <div style={{ border: '1px solid #000', marginBottom: 14 }}>
            <Field label="Apprehending Officer" value={violation?.enforcer?.full_name} />
            <Field label="Violator's Signature" value="" />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 10 }}>
            <div>
              <p style={{ margin: 0 }}>ORIGINAL (White) — VIOLATOR</p>
              <p style={{ margin: 0 }}>DUPLICATE (Yellow) — Office of the City Mayor</p>
              <p style={{ margin: 0 }}>TRIPLICATE (Pink) — Apprehending Officer</p>
            </div>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#c00', fontFamily: 'monospace' }}>
              {violation?.ovr_number || '\u00A0'}
            </p>
          </div>
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--slate-100)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={() => window.print()}><Printer size={14} /> Print OVR</button>
        </div>
      </div>

      <style>{`
        @media print {
          body > *:not(#printable-ovr) { display: none !important; }
          #printable-ovr { position: fixed; inset: 0; margin: 0; max-height: none; overflow: visible; }
        }
      `}</style>
    </div>
  )
}