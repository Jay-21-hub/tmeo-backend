import { useEffect, useState } from 'react'
import { prefersReducedMotion, useInViewOnce } from './useReveal'

const easeOutCubic = (t) => 1 - (1 - t) ** 3

/**
 * Presentation-only count-up. Takes the value ALREADY fetched and animates 0 -> value once, when the
 * element first scrolls into view. The last frame is always the exact target. With reduced motion
 * (or no IntersectionObserver) it returns the target immediately. It never fetches anything.
 */
export default function useCountUp(target, duration = 1100) {
  const [ref, inView] = useInViewOnce({ threshold: 0.4 })
  const reduce = prefersReducedMotion()
  const [val, setVal] = useState(0)

  useEffect(() => {
    if (reduce || !inView) return undefined
    let raf = 0
    let t0 = 0
    const tick = (now) => {
      if (!t0) t0 = now
      const p = Math.min(1, (now - t0) / duration)
      setVal(p >= 1 ? target : Math.round(target * easeOutCubic(p)))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [inView, target, duration, reduce])

  return [ref, reduce ? target : val]
}