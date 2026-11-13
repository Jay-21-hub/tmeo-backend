import { Tag } from 'lucide-react'
import { Modal } from '../../components/ui'

function formatFine(amount) {
  if (amount === null || amount === undefined || amount === '') return null
  return `₱${Number(amount).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

/**
 * One public violation. Shows only the type, category, description, and fine.
 */
export default function ViolationDetailModal({ open, onClose, record }) {
  if (!record) return null

  const fine = formatFine(record.fine)

  return (
    <Modal open={open} onClose={onClose} title="Violation Record" width={560}>
      {!record.name && (
        <div className="pub-vmodal-section">
          <p className="text-subtitle">No violation type details are available for this record.</p>
        </div>
      )}

      {record.name && (
        <div className="pub-vmodal-section">
          <div className="pub-vmodal-type-row">
            <div>
              <div className="pub-vmodal-type-name">
                <Tag size={13} strokeWidth={2.2} aria-hidden="true" style={{ marginRight: 6, verticalAlign: -2 }} />
                {record.name}
              </div>
              {record.category && <span className="pub-vmodal-category">{record.category}</span>}
            </div>
            {fine && <span className="pub-vmodal-fine">{fine}</span>}
          </div>
          {record.description && <p className="pub-vmodal-desc">{record.description}</p>}
        </div>
      )}
    </Modal>
  )
}
