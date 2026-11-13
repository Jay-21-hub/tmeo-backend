import Alert from '../ui/Alert'
import Button from '../ui/Button'

/** Shown when a prior violation matches. Nothing is copied until the button is used. */
export default function PreviousRecordPrompt({ visible, onUse }) {
  if (!visible) return null
  return (
    <Alert tone="info" title="Previous record found">
      <p style={{ margin: '0 0 8px' }}>
        Saved details from the most recent matching record can be copied into this form. Every filled field stays editable.
      </p>
      <Button type="button" variant="secondary" size="sm" onClick={onUse}>Use saved details</Button>
    </Alert>
  )
}
