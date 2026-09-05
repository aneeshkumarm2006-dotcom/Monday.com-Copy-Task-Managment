import { Component } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import Button from './Button';
import { checkForNewBuild } from '../../utils/swUpdate';

/**
 * The app's only stop against a white screen.
 *
 * React unmounts the ENTIRE tree when a render throws and nothing catches it —
 * not the failing panel, the whole document, navbar and all. Until this existed
 * every component in the app had that power, and one bad row in one tab took
 * the page down to a blank white rectangle with no message, nothing in the UI
 * to click, and no clue for the person looking at it.
 *
 * Three distinct failures land here and they need different answers:
 *
 * 1. A STALE CHUNK. `lazy(() => import(...))` resolves a filename that was
 *    minted at build time. Deploy again while someone has the tab open and that
 *    file is gone from the CDN, so the import rejects and Suspense rethrows it
 *    here. Nothing is actually broken — their tab is just older than the site —
 *    so this reloads once, silently, and they land on the new build. Guarded by
 *    a sessionStorage flag: if the reload does not fix it the second pass falls
 *    through to the panel rather than looping forever.
 *
 * 2. A STALE BUILD. The chunk loaded fine, but the whole bundle running this
 *    tab predates the current deploy — the service worker precaches the shell,
 *    so a tab opened around a release runs the old build until something
 *    reloads it. The crash is then a bug that is already fixed on the server,
 *    and no amount of retrying the component will help. So every error asks the
 *    worker whether a newer build exists; if one does it activates, claims the
 *    page, and utils/swUpdate.js reloads onto it. This is why a person hitting
 *    "Reload the page" here used to be the only thing that worked.
 *
 * 3. A REAL BUG. Show the error, in words, on the screen. `resetKey` (pass the
 *    tab name, the route, whatever scopes this boundary) clears the error when
 *    it changes, so a broken tab stays broken but every OTHER tab keeps working
 *    — you can navigate away from it instead of reloading.
 */

const RELOAD_FLAG = 'macan:chunk-reload';

/** Vite/Rollup wording for "the file this build asked for is not there". */
const isStaleChunk = (error) => {
  const msg = String(error?.message || error || '');
  return (
    /dynamically imported module/i.test(msg)
    || /Importing a module script failed/i.test(msg)
    || /Loading chunk .* failed/i.test(msg)
    || /error loading dynamically imported module/i.test(msg)
  );
};

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // The stack is the only place the component tree survives, and it is what
    // makes the difference between "Goals is broken" and a fixable line number.
    console.error('[ErrorBoundary]', error, info?.componentStack);

    if (isStaleChunk(error) && !sessionStorage.getItem(RELOAD_FLAG)) {
      try {
        sessionStorage.setItem(RELOAD_FLAG, '1');
      } catch {
        // Private browsing. Reloading once unguarded is still better than a
        // dead panel; a genuine loop needs the file to 404 on a fresh load too.
      }
      window.location.reload();
      return;
    }

    // Anything else: the build running this tab may simply be older than the
    // one on the server, in which case the fix is already deployed and the page
    // just has to get to it. Nothing happens if this IS the newest build — the
    // panel below stays up and the error is the real story. Fire-and-forget;
    // the reload, if there is one, comes from utils/swUpdate.js.
    checkForNewBuild();
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    const { children, label = 'this view' } = this.props;
    if (!error) {
      // A render that got this far is proof the last reload worked, so the
      // guard is spent — the next deploy gets its own free reload.
      try {
        sessionStorage.removeItem(RELOAD_FLAG);
      } catch {
        // Nothing to clear.
      }
      return children;
    }

    return (
      <div
        role="alert"
        className="flex flex-col items-center text-center gap-3 mt-6 px-6 py-10"
        style={{
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
        }}
      >
        <AlertTriangle size={40} strokeWidth={1.5} color="var(--color-status-stuck)" aria-hidden="true" />
        <h3
          className="font-display font-semibold"
          style={{ fontSize: 16, color: 'var(--color-text-primary)' }}
        >
          Something went wrong in {label}
        </h3>
        <p
          className="font-body max-w-md"
          style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
        >
          The rest of the app is fine — you can switch to another view. If this
          keeps happening, send this line on:
        </p>
        <code
          className="font-mono max-w-full overflow-x-auto px-3 py-2 text-left"
          style={{
            fontSize: 12,
            color: 'var(--color-status-stuck)',
            background: 'var(--color-bg-subtle)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          {String(error?.message || error)}
        </code>
        <div className="flex gap-2 mt-1">
          <Button variant="secondary" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button variant="primary" icon={RefreshCw} onClick={() => window.location.reload()}>
            Reload the page
          </Button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
