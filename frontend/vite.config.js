import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: {
        enabled: true
      },
      includeAssets: ['favicon.svg', 'pwa-192x192.png', 'pwa-512x512.png'],
      manifest: {
        name: 'TMEO - Traffic Management and Enforcement Office',
        short_name: 'TMEO',
        description: 'Traffic Enforcement and Violation Management System for Lucena City',
        theme_color: '#1e3a5f',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        // Only cache built/compiled assets — NEVER raw /src/ files
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        globIgnores: [
          '**/node_modules/**',
          'src/**'
        ],
        // The main bundle is ~2.1 MB, above workbox's 2 MiB default, which made `vite build` fail
        // in the PWA step. Raise the precache limit so the app shell stays cached for offline use.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Don't cache /src/ paths at runtime either
        runtimeCaching: [
          {
            // Only cache compiled API responses, not source files
            urlPattern: /\/api\/violations\/types\//,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'violation-types-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24
              }
            }
          },
          {
            urlPattern: /\/api\/enforcers\/my-schedule\//,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'schedule-cache',
              expiration: {
                maxEntries: 5,
                maxAgeSeconds: 60 * 60 * 24
              }
            }
          }
        ],
        // Exclude /src/ paths from navigation preload completely
        navigateFallbackDenylist: [/^\/src\//],
        skipWaiting: true,
        clientsClaim: true
      }
    })
  ],
  test: { exclude: ['**/node_modules/**', '**/dist/**', '**/dev-dist/**'] },
})