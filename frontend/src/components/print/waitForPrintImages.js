/**
 * waitForPrintImages(root)
 *
 * Resolves once EVERY <img> under `root` has finished loading AND decoding,
 * so window.print() can never open native Print Preview while a seal PNG is
 * still in flight (Chrome prints whatever is painted at that instant; an
 * image that is not loaded yet prints as blank space).
 *
 * Deterministic: it waits on each image's own load/error events and
 * HTMLImageElement.decode(), not on a fixed delay. Images already cached
 * (img.complete) resolve immediately. A broken image resolves too (it must
 * not block printing forever). `maxWaitMs` is only a last-resort safety
 * net against a request that never settles — it is not the mechanism.
 */
export function waitForPrintImages(root, maxWaitMs = 8000) {
  const imgs = root ? Array.from(root.querySelectorAll('img')) : []
  const one = img => new Promise(resolve => {
    const finish = () => {
      if (typeof img.decode === 'function') img.decode().then(resolve, resolve)
      else resolve()
    }
    if (img.complete && img.naturalWidth > 0) { finish(); return }
    if (img.complete && img.naturalWidth === 0 && img.currentSrc) { resolve(); return } // already failed
    img.addEventListener('load', finish, { once: true })
    img.addEventListener('error', () => resolve(), { once: true })
  })
  const all = Promise.all(imgs.map(one))
  const cap = new Promise(resolve => setTimeout(resolve, maxWaitMs))
  return Promise.race([all, cap])
}