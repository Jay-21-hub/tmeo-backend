import { useEffect, useRef } from 'react'
import OfficialReceiptPrintTemplate from '../../../../components/print/OfficialReceiptPrintTemplate'

/**
 * Assessment-only wrapper that opens the NATIVE browser print preview
 * directly, without showing the custom "Assessment Form Print Preview" modal.
 *
 * It mounts the unchanged official template inside a display:none box (the
 * template's print sheet is portaled to <body>, so it is unaffected), waits
 * for fonts, then triggers the template's own "Print Assessment Form" handler.
 * That handler waits for every header image (both seals) to load + decode
 * (waitForPrintImages), then runs fitSheet() -> onPrinted() (mark-printed
 * audit) -> window.print(), so print content, paper-size fitting, two-copy
 * layout and audit behaviour are exactly the existing ones. The paper size is
 * whatever savePaperSize() last stored (the success modal's selector).
 *
 * Remount with a new `key` for every click so repeat prints work.
 */
export default function AssessmentDirectPrint({ ticket, formatCurrency, onPrinted, onDone }) {
  const hostRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try { await document.fonts?.ready } catch { /* ignore */ }
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      if (cancelled) return
      const btn = Array.from(hostRef.current?.querySelectorAll('button') || [])
        .find(b => b.textContent.includes('Print Assessment Form'))
      if (btn) btn.click()
      else onDone?.()
    }
    run()
    const after = () => onDone?.()
    window.addEventListener('afterprint', after)
    return () => { cancelled = true; window.removeEventListener('afterprint', after) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount
  }, [])

  return (
    <div ref={hostRef} style={{ display: 'none' }} aria-hidden="true">
      <OfficialReceiptPrintTemplate ticket={ticket} formatCurrency={formatCurrency} onPrinted={onPrinted} onClose={onDone} />
    </div>
  )
}