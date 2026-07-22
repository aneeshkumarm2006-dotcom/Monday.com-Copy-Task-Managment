import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { getPortalMeta, portalGoogleSignInUrl } from '../services/portalService';

/**
 * PortalLandingPage — `/portal/:portalToken`. The screen an external client sees
 * when they open their shared/emailed invitation link. It shows who invited them
 * and a single "Accept invitation" button that hands off to Google sign-in. No
 * passcode, no forms. Bare shell — no app chrome, no app stores.
 */
const shell = {
  minHeight: '100vh',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#F3F4F8',
  padding: 24,
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif",
};
const card = {
  width: '100%',
  maxWidth: 420,
  background: '#FFFFFF',
  borderRadius: 14,
  boxShadow: '0 4px 24px rgba(0,0,0,0.10)',
  overflow: 'hidden',
};

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
    <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
    <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
  </svg>
);

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
      <div style={shell}>
        <Loader2 size={28} color="#2563EB" style={{ animation: 'spin 1s linear infinite' }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={shell}>
        <div style={{ ...card, padding: 32, textAlign: 'center' }}>
          <p style={{ fontSize: 16, fontWeight: 600, color: '#111827', margin: '0 0 8px' }}>
            Portal unavailable
          </p>
          <p style={{ fontSize: 14, color: '#6B7280', margin: 0 }}>{loadError}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={shell}>
      <div style={card}>
        <div style={{ background: '#2563EB', padding: '26px 32px' }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#FFF', letterSpacing: '-0.02em' }}>
            {meta.orgName || 'Client Portal'}
          </div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', marginTop: 4 }}>
            {meta.clientName} · Support portal
          </div>
        </div>

        <div style={{ padding: 32 }}>
          <p style={{ fontSize: 18, fontWeight: 700, color: '#111827', margin: '0 0 4px' }}>
            You've been invited
          </p>
          <p style={{ fontSize: 13.5, color: '#6B7280', margin: '0 0 24px', lineHeight: 1.55 }}>
            Accept your invitation to the{' '}
            <strong style={{ color: '#374151' }}>{meta.clientName || meta.orgName}</strong>{' '}
            support portal, where you can raise issues and follow their progress.
            You'll sign in securely with your Google account.
          </p>

          <button
            type="button"
            onClick={handleAccept}
            disabled={accepting}
            style={{
              width: '100%', height: 46, border: 'none', borderRadius: 8,
              background: '#2563EB', color: '#FFF', fontSize: 14.5, fontWeight: 600,
              cursor: accepting ? 'not-allowed' : 'pointer', opacity: accepting ? 0.7 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            }}
          >
            {accepting ? (
              'Redirecting…'
            ) : (
              <>
                <span
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 24, height: 24, borderRadius: 6, background: '#FFF',
                  }}
                >
                  <GoogleIcon />
                </span>
                Accept invitation
              </>
            )}
          </button>

          <p style={{ fontSize: 12, color: '#9CA3AF', margin: '16px 0 0', textAlign: 'center' }}>
            By accepting you agree to sign in with Google to access this portal.
          </p>
        </div>
      </div>
    </div>
  );
};

export default PortalLandingPage;
