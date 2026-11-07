import { Tag } from 'lucide-react'
import { Modal } from '../../components/ui'

function formatFine(amount) {
  if (amount === null || amount === undefined) return null
  return `₱${Number(amount).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

/**
 * Public violation detail modal.
 *
 * Renders ONLY fields present on PublicViolationSerializer: violation
 * type(s), category, description, and fine/penalty. The issue date is not
 * part of the public record. No
 * image, vehicle, location, or personal/identifying data exists on this
 * record to begin with — see violations/serializers.py.
 */
export default function ViolationDetailModal({ open, onClose, record }) {
  if (!record) return null

  const types = record.violation_types || []
  const totalFine = types.reduce((sum, t) => sum + (Number(t.fine) || 0), 0)

  return (
    <Modal open={open} onClose={onClose} title="Violation Record" width={560}>
      {types.length === 0 && (
        <div className="pub-vmodal-section">
          <p className="text-subtitle">No violation type details are available for this record.</p>
        </div>
      )}

      {types.map((t, i) => (
        <div className="pub-vmodal-section" key={`${t.name}-${i}`}>
          <div className="pub-vmodal-type-row">
            <div>
              <div className="pub-vmodal-type-name">
                <Tag size={13} strokeWidth={2.2} aria-hidden="true" style={{ marginRight: 6, verticalAlign: -2 }} />
                {t.name}
              </div>
              {t.category && <span className="pub-vmodal-category">{t.category}</span>}
            </div>
            {t.fine !== null && t.fine !== undefined && (
              <span className="pub-vmodal-fine">{formatFine(t.fine)}</span>
            )}
          </div>
          {t.description && <p className="pub-vmodal-desc">{t.description}</p>}
        </div>
      ))}

      {totalFine > 0 && (
        <div className="pub-vmodal-section">
          <div className="pub-vmodal-total-row">
            <span className="pub-vmodal-label">Total fine / penalty</span>
            <span className="pub-vmodal-total-value">{formatFine(totalFine)}</span>
          </div>
        </div>
      )}
    </Modal>
  )
}