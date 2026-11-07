import { useState, useEffect } from 'react'
import { breakpoints } from '../styles/theme'

function getBreakpoint(width) {
  if (width <= breakpoints.mobile) return 'mobile'
  if (width <= breakpoints.tablet) return 'tablet'
  return 'desktop'
}

/**
 * Single source of truth for responsive breakpoints.
 * Returns { breakpoint, isMobile, isTablet, isDesktop, width }
 * Debounced on resize (rAF) to avoid layout-thrash re-renders.
 */
export function useBreakpoint() {
  const [width, setWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1280)

  useEffect(() => {
    let raf = null
    const onResize = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setWidth(window.innerWidth))
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  const breakpoint = getBreakpoint(width)
  return {
    width,
    breakpoint,
    isMobile: breakpoint === 'mobile',
    isTablet: breakpoint === 'tablet',
    isDesktop: breakpoint === 'desktop',
  }
}