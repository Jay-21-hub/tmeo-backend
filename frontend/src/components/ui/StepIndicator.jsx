import { Check } from 'lucide-react'

/**
 * StepIndicator — shared wizard progress header for Issue OVR, Assessment,
 * and any other multi-step form. Replaces each page hand-rolling its own
 * step header markup.
 *
 * props:
 *  steps   - array of step labels, e.g. ['Driver & Vehicle', 'Violation', 'Review & Submit']
 *  current - 1-based index of the active step
 *
 * Renders full numbered/labelled steps at >=480px, and collapses to a
 * compact "Step X of N — Label" + progress bar on narrow phones, since a
 * 3-5 circle stepper with labels doesn't fit a 360px enforcer screen.
 */
export default function StepIndicator({ steps, current }) {
  const total = steps.length
  return (
    <div className="step-indicator" role="group" aria-label={`Step ${current} of ${total}`}>
      <div className="step-indicator-compact">
        <span className="text-caption" style={{ fontWeight: 700 }}>
          Step {current} of {total} — {steps[current - 1]}
        </span>
        <div className="step-indicator-bar">
          <div className="step-indicator-bar-fill" style={{ width: `${(current / total) * 100}%` }} />
        </div>
      </div>

      <ol className="step-indicator-full">
        {steps.map((label, i) => {
          const stepNum = i + 1
          const state = stepNum < current ? 'done' : stepNum === current ? 'active' : 'upcoming'
          return (
            <li key={label} className={`step-indicator-item step-indicator-item--${state}`}>
              <span className="step-indicator-dot" aria-hidden="true">
                {state === 'done' ? <Check size={13} strokeWidth={3} /> : stepNum}
              </span>
              <span className="step-indicator-label">{label}</span>
              {stepNum < total && <span className="step-indicator-connector" aria-hidden="true" />}
            </li>
          )
        })}
      </ol>
    </div>
  )
}