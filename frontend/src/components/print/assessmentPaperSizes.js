/**
 * Paper-size configuration for the Assessment Form print.
 *
 * RULE: DIFFERENT PAPER SIZE = ADAPTED LAYOUT, NOT MISSING CONTENT.
 * Every size prints TWO complete copies (every official field in both) on
 * ONE physical sheet. Nothing is hidden, truncated or clipped per size. The
 * form is not an A4 layout scaled down: each size carries its own page
 * dimensions, margins, column widths, label widths, gaps, seal size and
 * copy spacing (all in millimetres).
 *
 * PHYSICAL DIMENSIONS (width x height, portrait) — use these to verify the
 * printer / driver paper configuration:
 *   A4            210.0 x 297.0 mm   (8.27 x 11.69 in)
 *   Letter/Short  215.9 x 279.4 mm   (8.5  x 11    in)
 *   Legal         215.9 x 355.6 mm   (8.5  x 14    in)
 *   Long          215.9 x 330.2 mm   (8.5  x 13    in)  — PH "long bond"
 * Legal (14 in) and Long (13 in) are DIFFERENT sizes and are configured
 * separately.
 *
 * Layout keys (all mm):
 *   margin       sheet margin (inside the hardware non-printable area)
 *   cutGap       total height of the cut-line band between the two copies
 *   copyPadTop / copyPadBottom / copyPadX   padding inside one copy
 *   seal         seal diameter
 *   headerGap    gap between seals and header text
 *   titleGap     space above/below "ASSESSMENT FORM"
 *   rowGap       vertical gap between field rows
 *   blockGap     gap between the upper block and the lower block
 *   colGap       gap between main column and Date/Time/Place column
 *   mainPct      width of the main (left) column, percent of copy width
 *   labelW       label width, main column (NAME, ADDRESS, ...)
 *   sideLabelW   label width, side column (Date, Time, Place)
 */

export const PAPER_SIZES = {
  a4: {
    id: 'a4',
    label: 'A4',
    detail: '210 × 297 mm',
    widthMm: 210,
    heightMm: 297,
    layout: {
      margin: { top: 8, right: 10, bottom: 8, left: 10 },
      cutGap: 6, copyPadTop: 3, copyPadBottom: 2, copyPadX: 5,
      seal: 16, headerGap: 3, titleGap: 3.5, rowGap: 2.4, blockGap: 2.5,
      colGap: 8, mainPct: 62, labelW: 33, sideLabelW: 12,
    },
  },
  letter: {
    id: 'letter',
    label: 'Letter / Short',
    detail: '215.9 × 279.4 mm (8.5 × 11 in)',
    widthMm: 215.9,
    heightMm: 279.4,
    layout: {
      margin: { top: 7, right: 9, bottom: 7, left: 9 },
      cutGap: 5, copyPadTop: 2.5, copyPadBottom: 1.5, copyPadX: 5,
      seal: 14, headerGap: 2.5, titleGap: 3, rowGap: 2, blockGap: 2,
      colGap: 7, mainPct: 62, labelW: 32, sideLabelW: 12,
    },
  },
  legal: {
    id: 'legal',
    label: 'Legal',
    detail: '215.9 × 355.6 mm (8.5 × 14 in)',
    widthMm: 215.9,
    heightMm: 355.6,
    layout: {
      margin: { top: 10, right: 12, bottom: 10, left: 12 },
      cutGap: 8, copyPadTop: 5, copyPadBottom: 3, copyPadX: 7,
      seal: 19, headerGap: 4, titleGap: 5, rowGap: 3.6, blockGap: 4,
      colGap: 10, mainPct: 61, labelW: 35, sideLabelW: 13,
    },
  },
  long: {
    id: 'long',
    label: 'Long',
    detail: '215.9 × 330.2 mm (8.5 × 13 in)',
    widthMm: 215.9,
    heightMm: 330.2,
    layout: {
      margin: { top: 10, right: 11, bottom: 10, left: 11 },
      cutGap: 7, copyPadTop: 4, copyPadBottom: 2.5, copyPadX: 6,
      seal: 17, headerGap: 3.5, titleGap: 4.5, rowGap: 3, blockGap: 3.4,
      colGap: 9, mainPct: 61, labelW: 34, sideLabelW: 12.5,
    },
  },
}

export const PAPER_SIZE_ORDER = ['a4', 'letter', 'legal', 'long']
export const DEFAULT_PAPER_SIZE = 'a4'

// Height of the page is reduced by this much on the sheet box only (never
// on @page) so rounding can never spill a blank second page.
export const SHEET_HEIGHT_SAFETY_MM = 1

// Fit tiers, tried in order until both copies fit their half of the sheet.
// Whitespace shrinks first (k = spacing multiplier). Text drops to 11 pt
// only after spacing is tight. If that still is not enough (very long
// values), the Date/Time/Place and Assessed-by blocks stack under the main
// fields (stack: true) so long text gets the full line width — every field
// stays present. Text never goes below 9 pt.
export const FIT_TIERS = [
  { fs: 12, k: 1 },
  { fs: 12, k: 0.8 },
  { fs: 12, k: 0.6 },
  { fs: 12, k: 0.4 },
  { fs: 11.5, k: 0.4 },
  { fs: 11, k: 0.35 },
  { fs: 12, k: 0.4, stack: true },
  { fs: 11, k: 0.35, stack: true },
  { fs: 10.5, k: 0.3, stack: true },
  { fs: 10, k: 0.25, stack: true },
  { fs: 9.5, k: 0.2, stack: true },
  { fs: 9, k: 0.2, stack: true },
]

export function getPaperSize(id) {
  return PAPER_SIZES[id] || PAPER_SIZES[DEFAULT_PAPER_SIZE]
}

// CSS custom properties consumed by the .or-sheet rules in the template.
export function paperSizeCssVars(paper) {
  const { layout: l } = paper
  const mm = v => `${v}mm`
  return {
    '--or-w': mm(paper.widthMm),
    '--or-h': mm(paper.heightMm - SHEET_HEIGHT_SAFETY_MM),
    '--or-mt': mm(l.margin.top),
    '--or-mr': mm(l.margin.right),
    '--or-mb': mm(l.margin.bottom),
    '--or-ml': mm(l.margin.left),
    '--or-cut': mm(l.cutGap),
    '--or-cpt': mm(l.copyPadTop),
    '--or-cpb': mm(l.copyPadBottom),
    '--or-cpx': mm(l.copyPadX),
    '--or-seal': mm(l.seal),
    '--or-hg': mm(l.headerGap),
    '--or-tg': mm(l.titleGap),
    '--or-rg': mm(l.rowGap),
    '--or-bg': mm(l.blockGap),
    '--or-cg': mm(l.colGap),
    '--or-main': `${l.mainPct}%`,
    '--or-lw': mm(l.labelW),
    '--or-slw': mm(l.sideLabelW),
  }
}

function applyTier(sheet, tier) {
  sheet.style.setProperty('--or-fs', `${tier.fs}pt`)
  sheet.style.setProperty('--or-k', String(tier.k))
  if (tier.stack) sheet.dataset.stack = '1'
  else delete sheet.dataset.stack
}

/**
 * Picks the first tier where BOTH copies fit inside their half of the sheet
 * (no vertical or horizontal overflow). Nothing is ever hidden or clipped:
 * if even the last tier overflowed, the content would still be visible.
 * Returns the chosen tier index. Skips (returns 0) if the sheet has no
 * layout box yet (display:none).
 */
export function fitSheet(sheet) {
  if (!sheet || sheet.offsetHeight === 0) return 0
  const copies = Array.from(sheet.querySelectorAll('.or-copy'))
  let chosen = FIT_TIERS.length - 1
  for (let i = 0; i < FIT_TIERS.length; i++) {
    applyTier(sheet, FIT_TIERS[i])
    const ok = copies.every(c =>
      c.scrollHeight <= c.clientHeight + 1 && c.scrollWidth <= c.clientWidth + 1)
    if (ok) { chosen = i; break }
  }
  applyTier(sheet, FIT_TIERS[chosen])
  sheet.dataset.tier = String(chosen)
  return chosen
}

const STORAGE_KEY = 'tmeo.assessment.paperSize'

export function loadPaperSize() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v && PAPER_SIZES[v]) return v
  } catch { /* storage unavailable — fall through to default */ }
  return DEFAULT_PAPER_SIZE
}

export function savePaperSize(id) {
  try { localStorage.setItem(STORAGE_KEY, id) } catch { /* ignore */ }
}