/**
 * Circled "f" icon for the official Facebook page links (Contact + footer).
 * Same drawing language as the lucide icons next to it: 24px grid, 2px
 * outlined circle, currentColor (so it takes the gold/footer link colour).
 * Decorative only - the link text carries the accessible name.
 */
export default function FacebookIcon({ size = 18, className = '' }) {
  return (
    <svg
      className={`pub-fb-icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <path
        fill="currentColor"
        d="M13.2 19v-6.2h2.1l.35-2.5H13.2V8.75c0-.72.2-1.2 1.2-1.2h1.3V5.3c-.22-.03-1-.1-1.9-.1-1.85 0-3.1 1.13-3.1 3.2v1.9H8.6v2.5h2.15V19z"
      />
    </svg>
  )
}