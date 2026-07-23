import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, ShieldCheck, MessagesSquare, Clock, AlertCircle } from 'lucide-react';
import { getPortalMeta, portalGoogleSignInUrl } from '../services/portalService';
import '../styles/portal.css';

/**
 * PortalLandingPage — `/portal/:portalToken`. The screen an external client sees
 * when they open their shared/emailed invitation link. It shows who invited them
 * and a single "Continue with Google" button that hands off to Google sign-in.
 * No passcode, no forms. Bare shell — no app chrome, no app stores.
 */

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
    <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
    <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
  </svg>
);

const PERKS = [
  { icon: MessagesSquare, label: 'Raise issues and chat with the team in one place' },
  { icon: Clock, label: 'Follow every request from open through to resolved' },
  { icon: ShieldCheck, label: 'Private to you — secured with your Google account' },
];

const PortalLandingPage = () => {
  const { portalToken } = useParams();
  const [meta, setMeta] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    let alive = true;
    getPortalMeta(portalToken)
      .then((data) => alive && setMeta(data))
      .catch((err) => {
        if (!alive) return;
        const status = err.response?.status;
        if (status === 404) {
          setLoadError("This portal link isn't valid or has been turned off.");
        } else if (status) {
          const msg = err.response?.data?.error || 'server error';
          setLoadError(`Could not load this portal (error ${status}: ${msg}).`);
        } else {
          setLoadError('Could not reach the server. Check your connection and try again.');
        }
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [portalToken]);

  const handleAccept = () => {
    setAccepting(true);
    // Full-page hand-off to the API, which redirects on to Google.
    window.location.href = portalGoogleSignInUrl(portalToken);
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
        </div>
      </div>
    );
  }

  const initial = (meta.orgName || meta.clientName || 'C').trim().charAt(0).toUpperCase();

  return (
    <div className="mcp mcp-page mcp-shell">
      <div className="mcp-card-lg mcp-pop" style={{ width: '100%', maxWidth: 440, overflow: 'hidden' }}>
        {/* Brand header */}
        <div
          style={{
            padding: '30px 34px 26px',
            background:
              'radial-gradient(120% 120% at 0% 0%, #3b82f6 0%, #2563eb 55%, #1d4ed8 100%)',
            color: '#fff',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <div
              style={{
                width: 46, height: 46, borderRadius: 13, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.3)',
                fontSize: 20, fontWeight: 800,
              }}
            >
              {initial}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.15 }}>
                {meta.orgName || 'Client Portal'}
              </div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', marginTop: 3 }}>
                {meta.clientName ? `${meta.clientName} · Support portal` : 'Support portal'}
              </div>
            </div>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '28px 34px 32px' }}>
          <p style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', margin: '0 0 6px' }}>
            You've been invited
          </p>
          <p style={{ fontSize: 14, color: '#64748B', margin: '0 0 22px', lineHeight: 1.6 }}>
            Welcome to the{' '}
            <strong style={{ color: '#334155' }}>{meta.clientName || meta.orgName}</strong>{' '}
            support portal — your direct line to the team. Sign in to raise a request and track it
            through to done.
          </p>

          {/* Perks */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13, marginBottom: 26 }}>
            {PERKS.map(({ icon: Icon, label }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  style={{
                    width: 34, height: 34, borderRadius: 9, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: '#eff4ff', color: '#2563eb',
                  }}
                >
                  <Icon size={17} />
                </span>
                <span style={{ fontSize: 13.5, color: '#475569', lineHeight: 1.4 }}>{label}</span>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={handleAccept}
            disabled={accepting}
            className="mcp-btn mcp-btn--google"
          >
            {accepting ? (
              <>
                <Loader2 size={18} className="mcp-spin" /> Redirecting…
              </>
            ) : (
              <>
                <GoogleIcon /> Continue with Google
              </>
            )}
          </button>

          <p style={{ fontSize: 12, color: '#94A3B8', margin: '16px 0 0', textAlign: 'center', lineHeight: 1.5 }}>
            We only use your Google account to sign you in to this portal.
          </p>
        </div>
      </div>
    </div>
  );
};

export default PortalLandingPage;
