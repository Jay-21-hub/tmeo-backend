import 'leaflet/dist/leaflet.css'
import './index.css'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ToastProvider } from './context/ToastContext.jsx'
import App from './App.jsx'

// Unregister any old/buggy service workers first, then register the new one
if ('serviceWorker' in navigator) {
  // On first load, clear all old caches and SW registrations to fix stale cache issues
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    const hasOldSW = registrations.some(r => !r.active?.scriptURL?.includes('sw.js'))
    if (hasOldSW) {
      registrations.forEach(r => r.unregister())
      // Clear all caches
      caches.keys().then(keys => keys.forEach(k => caches.delete(k)))
    }
  })
}

// Register the Vite PWA service worker
import { registerSW } from 'virtual:pwa-register'
registerSW({
  onNeedRefresh() {
    window.location.reload()
  },
  onOfflineReady() {},
  onRegisterError(error) {
    console.error('[TMEO PWA] Service worker registration failed:', error)
  }
})

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <ToastProvider>
      <App />
    </ToastProvider>
  </BrowserRouter>
)