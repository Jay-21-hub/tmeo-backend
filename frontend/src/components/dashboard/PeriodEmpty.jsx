import './PeriodFilter.css'

/** Shown when the selected period has no rows. `onShowThisYear` switches the filter. */
export default function PeriodEmpty({ onShowThisYear }) {
  return (
    <div className="period-empty" role="status">
      <p>Walang data sa napiling panahon. Try a wider range.</p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onShowThisYear}>
        This year
      </button>
    </div>
  )
}
