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
