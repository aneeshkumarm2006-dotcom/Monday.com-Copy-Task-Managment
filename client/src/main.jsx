import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import App from './App.jsx'
import ErrorBoundary from './components/ui/ErrorBoundary.jsx'

// The outermost net. Anything that throws outside a narrower boundary — a
// store, a provider, a page that has no boundary of its own — stops here with a
// message on screen, instead of unmounting the document to a blank white page.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary label="the app">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

/**
 * Dismiss the boot splash in index.html.
 *
 * `requestAnimationFrame` rather than dismissing on the line above: `render` is
 * asynchronous, so the frame after this call is the first one that can contain
 * actual app markup. Removing it synchronously flashes white between the splash
 * disappearing and React painting — the exact gap the splash exists to cover.
 *
 * The node is removed rather than left hidden, because it sits ABOVE the app in
 * the stacking order and an element with `opacity: 0` still receives clicks.
 * `transitionend` would be the tidy trigger, but it never fires when a user has
 * reduced motion on (the transition is disabled), which would strand the splash
 * over the app forever — so the timeout is the trigger and it always runs.
 */
const splash = document.getElementById('boot')
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add('is-done')
    setTimeout(() => splash.remove(), 320)
  })
}
