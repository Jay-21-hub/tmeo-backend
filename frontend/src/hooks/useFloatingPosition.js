import { useState, useLayoutEffect, useCallback } from 'react'

/**
 * Collision-aware positioning for a floating panel (searchable dropdown /
 * listbox, or a Popover) anchored to a trigger element.
 *
 * Measures the trigger's position against the viewport and decides:
 *  - placement: 'bottom' when there's enough room below (or at least as
 *    much as above), otherwise 'top' — the panel flips upward
 *  - maxHeight: however much space is actually available in that
 *    direction, clamped so the panel never grows absurdly tall on a big
 *    screen or shrinks to nothing on a small one
 *
 * Returns viewport-relative coordinates meant to be used with
 * `position: fixed` (see FloatingPanel) — that's what lets the panel
 * escape `overflow: hidden` ancestors, scroll containers, modals, and
 * drawers instead of being clipped by them.
 *
 * @param {object} [options]
 * @param {number} [options.width] - Fixed panel width in px. Defaults to
 *   the trigger's own width — the original dropdown/listbox behavior,
 *   where the panel should exactly match the field it belongs to and
 *   horizontal clamping is a no-op (it's already on screen). On a
 *   viewport too narrow for the requested width, the panel is shrunk to
 *   fit (viewport width minus the gutter on both sides) rather than
 *   being allowed to overflow the screen edge.
 * @param {'left'|'right'|'center'} [options.align='left'] - Which edge/
 *   point of the panel lines up with the trigger when a custom `width`
 *   is given (a Popover is usually wider than the small button/icon it's
 *   anchored to). Only matters when `width` differs from the trigger's
 *   own width.
 */
const GUTTER = 8        // gap kept between the trigger/panel and the viewport edge
const MIN_BOTTOM = 160  // won't flip to 'top' for just a sliver of extra room below
const MIN_HEIGHT = 120  // panel is never squeezed shorter than this
const MAX_HEIGHT = 320  // panel never grows taller than this even with room to spare

export default function useFloatingPosition(triggerRef, open, options = {}) {
  const { width: fixedWidth, align = 'left' } = options
  const [position, setPosition] = useState(null)

  const measure = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const viewportH = window.innerHeight
    const viewportW = window.innerWidth

    const spaceBelow = viewportH - r.bottom - GUTTER
    const spaceAbove = r.top - GUTTER
    const placement = spaceBelow >= MIN_BOTTOM || spaceBelow >= spaceAbove ? 'bottom' : 'top'
    const available = placement === 'bottom' ? spaceBelow : spaceAbove
    const maxHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, available))

    // Trigger-width panels (dropdowns) are always left-aligned to the
    // trigger and never need horizontal clamping — they're already on
    // screen. A custom-width panel (Popover) can be wider than its
    // trigger, so it aligns per `align` and then gets clamped so it
    // never runs off either edge of the viewport. On very narrow phones
    // a fixed width can exceed the viewport outright, so the width is
    // shrunk to fit first — clamping only `left` would leave a
    // wide-enough panel overflowing off one edge no matter where it sits.
    const maxAvailableWidth = viewportW - GUTTER * 2
    const width = Math.min(fixedWidth ?? r.width, maxAvailableWidth)
    let left = align === 'right' ? r.right - width
      : align === 'center' ? r.left + r.width / 2 - width / 2
      : r.left
    left = Math.min(Math.max(left, GUTTER), viewportW - width - GUTTER)

    setPosition({
      left,
      width,
      top: r.bottom,
      bottom: viewportH - r.top,
      placement,
      maxHeight,
    })
  }, [triggerRef, fixedWidth, align])

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- close/reset position when the panel isn't open, and measure-on-open below, same convention used elsewhere in this codebase
    if (!open) { setPosition(null); return }
    measure()
    // capture:true so this also fires for scroll on nested scroll
    // containers (modals, drawers, scrollable tables), not just window
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, measure])

  return position
}