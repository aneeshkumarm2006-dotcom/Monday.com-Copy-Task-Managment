import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, ShieldCheck, MessagesSquare, ListChecks, AlertCircle } from 'lucide-react';
import {
  getPortalMeta,
  portalGoogleSignInUrl,
  portalPasswordLogin,
  requestPortalPasswordLink,
  setPortalToken,
  rememberPortalLink,
} from '../services/portalService';
import { PORTAL_BRAND, PORTAL_BRAND_INITIAL } from '../utils/portalBrand';
import '../styles/portal.css';

/**
 * PortalLandingPage — `/portal/:portalToken`. Full-page split-screen sign-in an
 * external client sees when they open their invitation link. Left: branding +
 * value props. Right: the sign-in card. No app chrome.
 *
 * Two ways in, and a client only ever needs one of them:
 *   - Continue with Google — a full-page redirect out to Google and back via
 *     /portal/verify. Open to anyone holding this link.
 *   - Email + password — a plain XHR that answers with the session token. Only
 *     works for addresses the team invited as password clients; everyone else is
 *     refused with the same wording as a wrong password.
 *
 * `?service=<groupId>` on the invitation link is stashed in sessionStorage on
 * mount, BEFORE anything can navigate: neither the sign-in XHR nor the full-page
 * bounce out to Google and back through /portal/verify can carry a query param,
 * and PortalDashboardPage reads the stash once to open on the right service.
 */

// Shared with PortalDashboardPage, which reads this key ONCE on mount and
// removes it. Both ends tolerate it being absent or naming a service the
// contact cannot see.
const PENDING_SERVICE_KEY = 'macan_portal_pending_service';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
    <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
    <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
  </svg>
);

const FEATURES = [
  { icon: MessagesSquare, title: 'One place to talk to us', body: 'Raise a request and chat with the team in a single thread.' },
  { icon: ListChecks, title: 'Track everything', body: 'Follow each request from open, through in-progress, to resolved.' },
  { icon: ShieldCheck, title: 'Private & secure', body: 'Your workspace is yours alone — signed in with Google or your own password.' },
];

const PortalLandingPage = () => {
  const { portalToken } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [loadError, setLoadError] = useState('');
  // A connection blip is worth a "Try again" button; a link the team turned off
  // is not, so the failure card only offers one for the branch that can recover.
  const [retryable, setRetryable] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);

  // Password sign-in
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [formError, setFormError] = useState('');
  // The "send me a link" panel, opened either by the client or automatically
  // when the server says this address exists but has no password yet.
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpSending, setHelpSending] = useState(false);
  const [helpMsg, setHelpMsg] = useState('');
  // The panel's own failure slot. It used to write into `formError`, which
  // renders inside the sign-in form several controls higher up — a client
  // pressed a button at the bottom of the card and the answer appeared above a
  // different button, off-screen on a phone.
  const [helpError, setHelpError] = useState('');
  // Neutral, not-an-error, not-a-confirmation: the address is a Google contact,
  // so no mail was sent and none is coming.
  const [helpHint, setHelpHint] = useState('');

  // Stash the per-service deep link first thing, so it survives whichever way
  // this page leaves — the Google redirect, or the password XHR + navigate.
  useEffect(() => {
    const service = searchParams.get('service');
    if (!service) return;
    try {
      sessionStorage.setItem(PENDING_SERVICE_KEY, service);
    } catch {
      // Storage refused (private mode, blocked cookies). The deep link is a
      // nicety; the portal still opens on its default service.
    }
  }, [searchParams]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError('');
    setRetryable(false);
    getPortalMeta(portalToken)
      .then((data) => {
        if (!alive) return;
        setMeta(data);
        // Remembered only once the server has confirmed this link is live.
        // Doing it unconditionally let an old invitation email overwrite a good
        // remembered link with a rotated, dead one — and that value is the only
        // thing the dashboard's expired screen has to offer a way back in.
        rememberPortalLink(portalToken);
      })
      .catch((err) => {
        if (!alive) return;
        const status = err.response?.status;
        if (status === 404) {
          setLoadError("This portal link isn't valid or has been turned off.");
        } else if (status) {
          const msg = err.response?.data?.error || 'server error';
          setLoadError(`Could not load this portal (error ${status}: ${msg}).`);
          setRetryable(status >= 500);
        } else {
          setLoadError('Could not reach the server. Check your connection and try again.');
          setRetryable(true);
        }
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [portalToken, reloadKey]);

  // "Continue with Google" is a full-page navigation, and `accepting` disables
  // the button for it. Pressing Back from Google's account chooser restores this
  // page from bfcache with React state intact, which left the button greyed out
  // reading "Redirecting…" forever — and a Google-invited contact has no
  // password, so that is the only control they have.
  useEffect(() => {
    const onShow = (e) => {
      if (e.persisted) setAccepting(false);
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  const handleAccept = () => {
    setAccepting(true);
    // Belt and braces for the bfcache reset above: a navigation that never
    // happens (blocked popup blocker rules, an extension, an offline blip)
    // otherwise leaves the button dead with nothing to un-stick it.
    window.setTimeout(() => setAccepting(false), 8000);
    window.location.href = portalGoogleSignInUrl(portalToken);
  };

  const handlePasswordSignIn = async (e) => {
    e?.preventDefault?.();
    const addr = email.trim();
    if (!addr || !password) {
      setFormError('Enter your email address and password.');
      return;
    }
    setSigningIn(true);
    setFormError('');
    setHelpMsg('');
    setHelpError('');
    setHelpHint('');
    try {
      const { token } = await portalPasswordLogin(portalToken, addr, password);
      setPortalToken(token);
      navigate('/portal', { replace: true });
    } catch (err) {
      const data = err.response?.data;
      // Invited, but never chose a password — open the "email me a link" panel
      // rather than leaving them to guess a password that doesn't exist yet.
      if (data?.code === 'NEEDS_SETUP') {
        setHelpOpen(true);
        setFormError(data.error);
      } else if (err.response) {
        setFormError(data?.error || 'Could not sign you in. Please try again.');
      } else {
        setFormError('Could not reach the server. Check your connection and try again.');
      }
      setPassword('');
    } finally {
      setSigningIn(false);
    }
  };

  const handleSendLink = async () => {
    const addr = email.trim();
    setHelpMsg('');
    setHelpHint('');
    setHelpError('');
    if (!addr || !EMAIL_RE.test(addr)) {
      setHelpError(
        addr
          ? "That address doesn't look right. Check it and try again."
          : 'Enter your email address first.'
      );
      document.getElementById('portal-email')?.focus();
      return;
    }
    setHelpSending(true);
    setFormError('');
    try {
      const data = await requestPortalPasswordLink(portalToken, addr);
      // The answer is deliberately the same for an address that has access and
      // one that doesn't — with one exception the server can name without
      // leaking anything, because the team chose the address themselves: a
      // contact set up to sign in WITH GOOGLE. Nothing is mailed to those, so a
      // green "check your inbox" would be a permanent stall.
      if (data?.sent === false && data?.hint === 'google') {
        setHelpHint(
          data.message ||
            'This address signs in with Google — use Continue with Google above.'
        );
      } else {
        setHelpMsg(
          data?.message || "If that email has portal access, we've sent it a link."
        );
      }
    } catch (err) {
      setHelpError(
        err.response?.data?.error ||
          (err.response
            ? 'Could not send the link. Please try again.'
            : 'Could not reach the server. Check your connection and try again.')
      );
    } finally {
      setHelpSending(false);
    }
  };

  if (loading) {
    return (
      <div className="mcp mcp-page mcp-shell">
        <Loader2 size={30} color="#2563EB" className="mcp-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mcp mcp-page mcp-shell">
        <div className="mcp-card-lg mcp-pop" style={{ maxWidth: 420, padding: 36, textAlign: 'center' }}>
          <div
            style={{
              width: 52, height: 52, borderRadius: 14, margin: '0 auto 16px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#FEF2F2', color: '#DC2626',
            }}
          >
            <AlertCircle size={26} />
          </div>
          <p style={{ fontSize: 17, fontWeight: 700, margin: '0 0 8px' }}>Portal unavailable</p>
          <p style={{ fontSize: 14, color: '#64748B', margin: 0, lineHeight: 1.55 }}>{loadError}</p>
          {/* Only for the branches that can actually recover — telling someone
              to try again while giving them nothing to press is worse than
              saying nothing. */}
          {retryable && (
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mcp-btn mcp-btn--primary mcp-btn--block"
              style={{ marginTop: 20 }}
            >
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  const company = meta.clientName || '';

  return (
    <div className="mcp mcp-split">
      {/* ---- Brand panel ---- */}
      <aside className="mcp-split-brand">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 44, height: 44, borderRadius: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.28)',
                fontSize: 19, fontWeight: 800,
              }}
            >
              {PORTAL_BRAND_INITIAL}
            </div>
            <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.01em' }}>{PORTAL_BRAND}</span>
          </div>
        </div>

        <div style={{ position: 'relative', zIndex: 1, maxWidth: 460 }}>
          <h1 style={{ fontSize: 38, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.12, margin: '0 0 14px' }}>
            Your support,<br />all in one place.
          </h1>
          <p style={{ fontSize: 15.5, color: 'rgba(255,255,255,0.82)', lineHeight: 1.6, margin: '0 0 34px' }}>
            Welcome to the {company ? <><strong style={{ color: '#fff' }}>{company}</strong> support portal</> : 'support portal'} —
            raise requests, share screenshots, and follow every update through to done.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="mcp-feat">
                <span className="mcp-feat-ico"><Icon size={19} color="#fff" /></span>
                <div>
                  <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 2 }}>{title}</div>
                  <div style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>{body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ position: 'relative', zIndex: 1, fontSize: 12.5, color: 'rgba(255,255,255,0.6)' }}>
          Powered by {PORTAL_BRAND}
        </div>
      </aside>

      {/* ---- Sign-in panel ---- */}
      <main className="mcp-split-form">
        <div className="mcp-card-lg mcp-pop" style={{ width: '100%', maxWidth: 400, padding: '38px 34px' }}>
          {/* compact brand for mobile (brand panel is hidden < 860px) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 26 }}>
            <span className="mcp-brand-mark" style={{ width: 42, height: 42 }}>{PORTAL_BRAND_INITIAL}</span>
            <div>
              <div style={{ fontSize: 15.5, fontWeight: 800, letterSpacing: '-0.01em', lineHeight: 1.2 }}>{PORTAL_BRAND}</div>
              {company && <div style={{ fontSize: 12.5, color: '#64748B' }}>{company} · Support portal</div>}
            </div>
          </div>

          <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', margin: '0 0 6px' }}>Sign in</h2>
          <p style={{ fontSize: 14, color: '#64748B', margin: '0 0 24px', lineHeight: 1.55 }}>
            Continue with Google, or use the email and password you set up.
          </p>

          <button type="button" onClick={handleAccept} disabled={accepting} className="mcp-btn mcp-btn--google">
            {accepting ? (
              <><Loader2 size={18} className="mcp-spin" /> Redirecting…</>
            ) : (
              <><GoogleIcon /> Continue with Google</>
            )}
          </button>

          <div className="mcp-or">or</div>

          <form onSubmit={handlePasswordSignIn} noValidate>
            <div style={{ marginBottom: 14 }}>
              <label className="mcp-label" htmlFor="portal-email">Email address</label>
              <input
                id="portal-email"
                className="mcp-field"
                type="email"
                autoComplete="username"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  // A confirmation for the previous address must not sit under
                  // a sentence that now names a different one.
                  setHelpMsg('');
                  setHelpHint('');
                  setHelpError('');
                }}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label className="mcp-label" htmlFor="portal-password">Password</label>
              <input
                id="portal-password"
                className="mcp-field"
                type="password"
                autoComplete="current-password"
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {formError && (
              <p className="mcp-error" role="alert" style={{ marginBottom: 14 }}>{formError}</p>
            )}

            <button
              type="submit"
              disabled={signingIn}
              className="mcp-btn mcp-btn--primary mcp-btn--block"
            >
              {signingIn ? <><Loader2 size={17} className="mcp-spin" /> Signing in…</> : 'Sign in'}
            </button>
          </form>

          {/* First-time setup and forgotten passwords are the same request: mail
              this address a one-time link. */}
          <div style={{ marginTop: 14 }}>
            {helpOpen ? (
              <div>
                <p style={{ fontSize: 13, color: '#64748B', margin: '0 0 10px', lineHeight: 1.55 }}>
                  We'll email <strong style={{ color: '#0F172A' }}>{email.trim() || 'your address'}</strong> a
                  link to set a password. It only works if your address has portal access.
                </p>
                {/* Every answer lands HERE, next to the button that asked for
                    it, and the buttons stay mounted: correcting a mistyped
                    address has to be one edit and one press, not a reload. */}
                {helpMsg && (
                  <p className="mcp-note" role="status" style={{ marginBottom: 10 }}>{helpMsg}</p>
                )}
                {helpHint && (
                  <p
                    role="status"
                    style={{ fontSize: 13, color: '#475569', margin: '0 0 10px', lineHeight: 1.5 }}
                  >
                    {helpHint}
                  </p>
                )}
                {helpError && (
                  <p className="mcp-error" role="alert" style={{ marginBottom: 10 }}>{helpError}</p>
                )}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={handleSendLink}
                    disabled={helpSending}
                    className="mcp-btn mcp-btn--primary"
                    style={{ height: 38, flex: 1 }}
                  >
                    {helpSending ? <><Loader2 size={16} className="mcp-spin" /> Sending…</> : 'Email me a link'}
                  </button>
                  <button type="button" className="mcp-linkbtn" onClick={() => setHelpOpen(false)}>
                    Cancel
                  </button>
                </div>
                {/* Said plainly and always, because the send itself cannot say
                    it: a contact the team invited through Google is never
                    mailed a password link, and the reply reads like one is on
                    its way. */}
                <p style={{ fontSize: 12.5, color: '#64748B', margin: '10px 0 0', lineHeight: 1.5 }}>
                  Were you invited to sign in with Google? No link is sent for those accounts —
                  use Continue with Google above.
                </p>
              </div>
            ) : (
              <button
                type="button"
                className="mcp-linkbtn"
                onClick={() => {
                  setHelpOpen(true);
                  setHelpMsg('');
                  setHelpHint('');
                  setHelpError('');
                }}
              >
                First time here, or forgot your password?
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '20px 0 0', color: '#94A3B8' }}>
            <ShieldCheck size={14} />
            <span style={{ fontSize: 12, lineHeight: 1.5 }}>
              Your sign-in only identifies you — nothing is posted on your behalf.
            </span>
          </div>
        </div>
      </main>
    </div>
  );
};

export default PortalLandingPage;
