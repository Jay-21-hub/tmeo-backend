import { useState, useEffect, useCallback } from 'react'

/**
 * Arrow-key / Enter / Escape navigation over a flat list of selectable
 * option ids inside a searchable dropdown (VehicleCatalogField and
 * others). Category/group headers aren't part of `flatIds` so
 * they're skipped automatically as the user arrows through the list.
 *
 * Returns the currently active (highlighted-but-not-yet-selected) id and
 * a keydown handler to wire to the field's search input.
 */
export default function useListboxNav({ flatIds, open, onSelect, onClose }) {
  const [activeId, setActiveId] = useState(null)

  // Reset/seed the active option whenever the panel opens or the
  // (filtered) option list changes while open.
  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset/seed active option when the panel opens or the filtered list changes, same convention used elsewhere in this codebase
    setActiveId(prev => (prev != null && flatIds.includes(prev)) ? prev : (flatIds[0] ?? null))
  }, [open, flatIds])

  const move = useCallback((delta) => {
    setActiveId(prev => {
      if (flatIds.length === 0) return null
      const i = prev != null ? flatIds.indexOf(prev) : -1
      const next = (i + delta + flatIds.length) % flatIds.length
      return flatIds[next]
    })
  }, [flatIds])

  const handleKeyDown = useCallback((e) => {
    if (!open) return
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break
      case 'ArrowUp':   e.preventDefault(); move(-1); break
      case 'Enter':
        if (activeId != null) { e.preventDefault(); onSelect(activeId) }
        break
      case 'Escape': e.preventDefault(); onClose(); break
      default: break
    }
  }, [open, move, activeId, onSelect, onClose])

  return { activeId: open ? activeId : null, setActiveId, handleKeyDown }
}