// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import RoadSafetyCarousel, { AUTOPLAY_MS } from '../RoadSafetyCarousel'
import { ROAD_SAFETY_SLIDES, MAX_ROAD_SAFETY_SLIDES, buildSlidesFromTypes, formatFine } from '../../../constants/roadSafetySlides'
import { fetchPublicViolationTypes } from '../../../services/publicApi'

vi.mock('../../../services/publicApi', () => ({ fetchPublicViolationTypes: vi.fn() }))

let hidden = false
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const activeTitle = () => document.querySelector('.rsc-slide.is-active .rsc-title').textContent

beforeEach(() => {
  vi.useFakeTimers()
  fetchPublicViolationTypes.mockReset()
  fetchPublicViolationTypes.mockRejectedValue(new Error('offline'))
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

describe('road safety slide data', () => {
  it('has at most 5 slides, each complete, with unique ids', () => {
    expect(MAX_ROAD_SAFETY_SLIDES).toBe(5)
    expect(ROAD_SAFETY_SLIDES.length).toBeGreaterThan(0)
    expect(ROAD_SAFETY_SLIDES.length).toBeLessThanOrEqual(5)
    for (const s of ROAD_SAFETY_SLIDES) {
      for (const k of ['id', 'icon', 'violation', 'title', 'text', 'tip']) expect(s[k], `${s.id}.${k}`).toBeTruthy()
    }
    expect(new Set(ROAD_SAFETY_SLIDES.map((s) => s.id)).size).toBe(ROAD_SAFETY_SLIDES.length)
  })

  it('contains no fine amounts (nothing that can contradict the official penalties)', () => {
    const all = JSON.stringify(ROAD_SAFETY_SLIDES)
    expect(all).not.toMatch(/₱|\bPHP\b|\bpesos?\b|\bfine of\b/i)
  })
})

describe('RoadSafetyCarousel', () => {
  it('renders a labelled carousel region and starts on slide 1', () => {
    render(<RoadSafetyCarousel />)
    expect(screen.getByRole('region', { name: 'Road safety reminders' })).toBeTruthy()
    expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[0].title)
  })

  it('never shows more than 5 slides even if more are supplied', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...ROAD_SAFETY_SLIDES[0], id: `x${i}`, title: `T${i}` }))
    render(<RoadSafetyCarousel slides={many} />)
    expect(document.querySelectorAll('.rsc-slide').length).toBe(5)
    expect(screen.getAllByRole('button', { name: /Go to slide/ }).length).toBe(5)
  })

  it('Next / Previous wrap around', () => {
    render(<RoadSafetyCarousel />)
    const n = ROAD_SAFETY_SLIDES.length
    fireEvent.click(screen.getByRole('button', { name: 'Previous slide' }))
    expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[n - 1].title)
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }))
    expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[0].title)
  })

  it('dots jump to a slide and mark it current', () => {
    render(<RoadSafetyCarousel />)
    fireEvent.click(screen.getByRole('button', { name: `Go to slide 3 of ${ROAD_SAFETY_SLIDES.length}` }))
    expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[2].title)
    expect(screen.getByRole('button', { name: /Go to slide 3/ }).getAttribute('aria-current')).toBe('true')
  })

  it('arrow keys navigate', () => {
    render(<RoadSafetyCarousel />)
    const region = screen.getByRole('region', { name: 'Road safety reminders' })
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[1].title)
    fireEvent.keyDown(region, { key: 'ArrowLeft' })
    expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[0].title)
  })

  it('only the active slide is exposed to assistive tech and keyboard focus', () => {
    render(<RoadSafetyCarousel />)
    const slides = [...document.querySelectorAll('.rsc-slide')]
    slides.forEach((s, i) => {
      expect(s.getAttribute('aria-hidden')).toBe(i === 0 ? null : 'true')
      expect(s.hasAttribute('inert')).toBe(i !== 0)
    })
  })

  it('swipes on touch (left = next, right = previous), ignores small moves and the mouse', () => {
    render(<RoadSafetyCarousel />)
    const stage = document.querySelector('.rsc-stage')
    fireEvent.pointerDown(stage, { pointerType: 'touch', clientX: 200 }); fireEvent.pointerUp(stage, { clientX: 100 })
    expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[1].title)
    fireEvent.pointerDown(stage, { pointerType: 'touch', clientX: 100 }); fireEvent.pointerUp(stage, { clientX: 110 })
    expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[1].title)
    fireEvent.pointerDown(stage, { pointerType: 'touch', clientX: 100 }); fireEvent.pointerUp(stage, { clientX: 220 })
    expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[0].title)
    fireEvent.pointerDown(stage, { pointerType: 'mouse', clientX: 300 }); fireEvent.pointerUp(stage, { clientX: 100 })
    expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[0].title)
  })

  describe('autoplay', () => {
    it('advances once per interval', async () => {
      render(<RoadSafetyCarousel />)
      await advance(AUTOPLAY_MS)
      expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[1].title)
      await advance(AUTOPLAY_MS)
      expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[2].title)
    })

    it('manual navigation restarts the timer (no double jump)', async () => {
      render(<RoadSafetyCarousel />)
      await advance(AUTOPLAY_MS - 500)
      fireEvent.click(screen.getByRole('button', { name: 'Next slide' }))
      await advance(600)
      expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[1].title)
      await advance(AUTOPLAY_MS)
      expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[2].title)
    })

    it('pause button stops it and play resumes it', async () => {
      render(<RoadSafetyCarousel />)
      fireEvent.click(screen.getByRole('button', { name: 'Pause automatic slide change' }))
      await advance(AUTOPLAY_MS * 3)
      expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[0].title)
      fireEvent.click(screen.getByRole('button', { name: 'Start automatic slide change' }))
      await advance(AUTOPLAY_MS)
      expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[1].title)
    })

    it('does NOT pause on mouse hover or after clicking a control (keeps sliding by itself)', async () => {
      render(<RoadSafetyCarousel />)
      const region = screen.getByRole('region', { name: 'Road safety reminders' })
      fireEvent.mouseEnter(region)
      await advance(AUTOPLAY_MS)
      expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[1].title)
      const nextBtn = screen.getByRole('button', { name: 'Next slide' })
      fireEvent.focus(nextBtn) // a mouse click focus is not :focus-visible in a real browser
      await advance(AUTOPLAY_MS)
      expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[2].title)
    })

    it('pauses while a control has KEYBOARD focus and resumes on blur', async () => {
      render(<RoadSafetyCarousel />)
      const nextBtn = screen.getByRole('button', { name: 'Next slide' })
      const spy = vi.spyOn(nextBtn, 'matches').mockImplementation((q) => q === ':focus-visible')
      fireEvent.focus(nextBtn)
      await advance(AUTOPLAY_MS * 2)
      expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[0].title)
      spy.mockRestore()
      fireEvent.blur(nextBtn, { relatedTarget: document.body })
      await advance(AUTOPLAY_MS)
      expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[1].title)
    })

    it('does not advance while the browser tab is hidden', async () => {
      render(<RoadSafetyCarousel />)
      hidden = true; act(() => { document.dispatchEvent(new Event('visibilitychange')) })
      await advance(AUTOPLAY_MS * 3)
      expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[0].title)
      hidden = false; act(() => { document.dispatchEvent(new Event('visibilitychange')) })
      await advance(AUTOPLAY_MS)
      expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[1].title)
    })

    it('still slides automatically when the visitor prefers reduced motion (CSS makes it a plain fade)', async () => {
      window.matchMedia.mockImplementation((q) => ({ matches: /reduce/.test(q), addEventListener() {}, removeEventListener() {} }))
      render(<RoadSafetyCarousel />)
      await advance(AUTOPLAY_MS)
      expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[1].title)
      expect(screen.getByRole('button', { name: 'Pause automatic slide change' })).toBeTruthy()
    })

    it('stops its timer on unmount', async () => {
      const { unmount } = render(<RoadSafetyCarousel />)
      unmount()
      await expect(advance(AUTOPLAY_MS * 3)).resolves.not.toThrow()
    })
  })

  it('a single slide has no autoplay and no pause button', async () => {
    render(<RoadSafetyCarousel slides={[ROAD_SAFETY_SLIDES[0]]} />)
    await advance(AUTOPLAY_MS * 2)
    expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[0].title)
    expect(screen.queryByRole('button', { name: /automatic slide change/ })).toBeNull()
  })

  it('renders nothing for an empty list', () => {
    const { container } = render(<RoadSafetyCarousel slides={[]} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('live violation types', () => {
  const TYPES = [
    { code: 'V-01', name: 'No Helmet', category: 'safety', description: 'Riders must wear a helmet. (from system)', penalty_amount: 1500 },
    { code: 'V-02', name: 'Beating Red Light', category: 'traffic', description: '', penalty_amount: 500 },
    { code: 'V-03', name: 'Reckless Driving', category: 'traffic', description: 'Drive with care.', penalty_amount: 0 },
    { code: 'V-04', name: 'Smoke Belching', category: 'other', description: 'Keep emissions clean.', penalty_amount: 2500.5 },
  ]

  it('formats fines as pesos and hides empty fines', () => {
    expect(formatFine(1500)).toBe('₱1,500')
    expect(formatFine('2500.5')).toBe('₱2,500.50')
    expect(formatFine(0)).toBeNull()
    expect(formatFine(null)).toBeNull()
    expect(formatFine('abc')).toBeNull()
  })

  it('maps types to slides: system description + fine, matching picture, generic fallback by category, max 5', () => {
    const out = buildSlidesFromTypes([...TYPES, ...TYPES, ...TYPES])
    expect(out.length).toBe(5)
    const [helmet, red, reckless, smoke] = out
    expect(helmet).toMatchObject({ icon: 'helmet', violation: 'No Helmet', text: 'Riders must wear a helmet. (from system)', fine: '₱1,500' })
    expect(red.icon).toBe('redLight')
    expect(red.text).toMatch(/signal turns red/) // empty description -> built-in wording
    expect(reckless).toMatchObject({ icon: 'road', title: 'Reckless Driving', kicker: 'Traffic Violation', fine: null })
    expect(smoke).toMatchObject({ icon: 'sign', fine: '₱2,500.50' })
    expect(new Set(out.map((x) => x.id)).size).toBe(5)
  })

  it('does not give the wrong picture to look-alike violations from the official list', () => {
    const pick = (name) => buildSlidesFromTypes([{ code: 'X', name, category: 'traffic', description: '', penalty_amount: 500 }])[0].icon
    expect(pick('Disobeying Traffic Signs / Signals')).toBe('road')
    expect(pick('Obstruction of Traffic')).toBe('road')
    expect(pick('Illegal Loading / Unloading')).toBe('road')
    expect(pick('Illegal Parking')).toBe('parking')
    expect(pick('Beating Red Light')).toBe('redLight')
    expect(pick('No Helmet (Passenger)')).toBe('helmet')
    expect(pick('Use of Mobile Phone While Driving')).toBe('phone')
    expect(pick('Failure to Give Way to Pedestrian')).toBe('pedestrian')
  })

  it('ignores unusable input', () => {
    expect(buildSlidesFromTypes(null)).toEqual([])
    expect(buildSlidesFromTypes([{}, { name: '  ' }, null])).toEqual([])
  })

  it('shows the fallback first, then swaps in the types from the system', async () => {
    fetchPublicViolationTypes.mockResolvedValue(TYPES)
    render(<RoadSafetyCarousel />)
    expect(activeTitle()).toBe(ROAD_SAFETY_SLIDES[0].title)
    await flush()
    expect(document.querySelectorAll('.rsc-slide').length).toBe(4)
    expect(activeTitle()).toBe('Wear your helmet, every ride.')
    expect(document.querySelector('.rsc-slide.is-active .rsc-text').textContent).toBe('Riders must wear a helmet. (from system)')
    expect(document.querySelector('.rsc-slide.is-active .rsc-fine strong').textContent).toBe('₱1,500')
  })

  it('shows the standard fine only when there is one, and never any date', async () => {
    fetchPublicViolationTypes.mockResolvedValue(TYPES)
    render(<RoadSafetyCarousel />)
    await flush()
    expect(document.querySelectorAll('.rsc-fine').length).toBe(3)
    const text = document.querySelector('.rsc').textContent
    expect(text).not.toMatch(/\b(20\d\d|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/)
  })

  it('keeps the fallback slides when the request fails or returns nothing', async () => {
    fetchPublicViolationTypes.mockResolvedValue([])
    render(<RoadSafetyCarousel />)
    await flush()
    expect(document.querySelectorAll('.rsc-slide').length).toBe(ROAD_SAFETY_SLIDES.length)
    cleanup()
    fetchPublicViolationTypes.mockRejectedValue(new Error('500'))
    render(<RoadSafetyCarousel />)
    await flush()
    expect(document.querySelectorAll('.rsc-slide').length).toBe(ROAD_SAFETY_SLIDES.length)
  })

  it('does not call the API when slides are passed in', async () => {
    render(<RoadSafetyCarousel slides={[ROAD_SAFETY_SLIDES[0]]} />)
    await flush()
    expect(fetchPublicViolationTypes).not.toHaveBeenCalled()
  })

  it('keeps autoplay running after the live slides arrive', async () => {
    fetchPublicViolationTypes.mockResolvedValue(TYPES)
    render(<RoadSafetyCarousel />)
    await flush()
    await advance(AUTOPLAY_MS)
    expect(activeTitle()).toBe('Stop on red.')
  })
})