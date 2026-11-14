/** A short list of previous violators. Nothing is copied until one is chosen. */
export default function NameSuggestions({ suggestions, onSelect }) {
  if (!suggestions?.length) return null
  return (
    <ul className="name-suggestions" role="listbox" aria-label="Previous violators" style={{
      listStyle: 'none', margin: '8px 0 0', padding: 0,
      border: '1px solid var(--slate-200)', borderRadius: 8, background: '#fff',
    }}>
      {suggestions.slice(0, 5).map((person) => (
        <li key={`${person.violator_name}|${person.address}`}>
          <button
            type="button"
            role="option"
            onClick={() => onSelect(person)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '8px 10px', background: 'transparent', border: 0, cursor: 'pointer',
            }}
          >
            <span style={{ display: 'block', fontWeight: 600, color: 'var(--navy, #0B1F3A)' }}>{person.violator_name}</span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--slate-500)' }}>{person.address || '—'}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
