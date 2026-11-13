/** True when the app is running as an installed PWA, not in a browser tab. */
export function isInstalledPwa() {
  if (typeof window === 'undefined') return false
  const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true
  const iosStandalone = window.navigator?.standalone === true
  return standalone || iosStandalone
}
