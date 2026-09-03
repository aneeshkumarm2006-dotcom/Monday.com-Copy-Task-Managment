import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),

    /**
     * The installable app.
     *
     * WHAT THE SERVICE WORKER IS FOR HERE: the bundle is ~2.7MB, and before
     * this existed every cold load pulled all of it down while the user looked
     * at the boot splash. The worker precaches the shell on first visit, so a
     * returning user boots from disk. That is the whole performance case.
     *
     * WHAT IT IS DELIBERATELY NOT FOR: `/api/*` is never intercepted — see
     * `navigateFallbackDenylist` and the absence of any runtime route for it.
     * A task app that serves yesterday's board from a cache is worse than a
     * slow one, and a stale-data bug behind a service worker is close to
     * undiagnosable from a user report. Data freshness stays the server's
     * problem; the worker only owns the shell.
     *
     * `autoUpdate`: a new deploy takes over on the next navigation without a
     * "refresh to update" banner nobody understands. The SSE stream and every
     * API call keep working across the swap because none of them pass through
     * the worker at all.
     */
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Macan',
        short_name: 'Macan',
        description: 'Organize. Track. Succeed.',
        start_url: '/',
        display: 'standalone',
        background_color: '#FFFFFF',
        theme_color: '#FFFFFF',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          // Maskable: full-bleed ground with the mark inside the safe zone,
          // so Android can round/squircle it without shaving the squares.
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The bundle exceeds workbox's 2MB default per-file cap; without this
        // the main chunk is silently left OUT of the precache and the PWA
        // boots over the network anyway — the failure mode with no error.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: '/index.html',
        // Never let a navigation to the API (OAuth redirects land there) be
        // answered with the app shell.
        navigateFallbackDenylist: [/^\/api\//],
        // Web Push handlers. `generateSW` writes the worker, so there is no
        // source file to add a `push` listener to — this pulls one in. See
        // public/push-sw.js; it registers listeners only and leaves the
        // caching contract above untouched.
        importScripts: ['/push-sw.js'],
      },
    }),
  ],
})
