import { useEffect, useRef, useState } from 'react'

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * Scroll reveal for the whole public portal. Call ONCE from PublicLayout.
 * Adds .is-in to every .rv element the first time it enters the viewport, then stops watching it
 * (animate-once). A MutationObserver picks up .rv nodes that mount later (API-driven sections, route
 * changes), so no page needs its own call. Presentation only: it never touches data or fetching.
 */
export default function useReveal() {
  useEffect(() => {
    // The whole public shell (not just #pub-main) so footer groups reveal as well.
    const root = document.getElementById('pub-main')?.closest('.pub')
    if (!root) return undefined
    const instant = prefersReducedMotion() || !('IntersectionObserver' in window)
    const io = instant ? null : new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target) } })
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' })

    const track = (el) => { if (io) io.observe(el); else el.classList.add('is-in') }
    const scan = (node) => {
      if (node.nodeType !== 1) return
      if (node.matches('.rv:not(.is-in)')) track(node)
      node.querySelectorAll('.rv:not(.is-in)').forEach(track)
    }
    scan(root)
    const mo = new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach(scan)))
    mo.observe(root, { childList: true, subtree: true })
    return () => { mo.disconnect(); io?.disconnect() }
  }, [])
}

/** Returns [ref, inView]; inView flips to true once, the first time the element is visible. */
export function useInViewOnce(options = { threshold: 0.25 }) {
  const ref = useRef(null)
  const [inView, setInView] = useState(() => prefersReducedMotion() || (typeof window !== 'undefined' && !('IntersectionObserver' in window)))
  useEffect(() => {
    const el = ref.current
    if (inView || !el) return undefined
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setInView(true); io.disconnect() } }, options)
    io.observe(el)
    return () => io.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView])
  return [ref, inView]
}