import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Lock, Mail, ShieldCheck, Loader2 } from 'lucide-react';
import { getPortalMeta, requestMagicLink } from '../services/portalService';

/**
 * PortalLandingPage — `/portal/:portalToken`. The pre-sign-in screen an external
 * client sees when they open their shared link. Collects passcode + email and
 * triggers the magic-link email. Bare shell — no app chrome, no app stores.
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
const inputWrap = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  border: '1.5px solid #E5E7EB',
  borderRadius: 8,
  padding: '0 12px',
  height: 44,
  background: '#F9FAFB',
};
const inputEl = {
  flex: 1,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontSize: 14,
  color: '#111827',
};

const PortalLandingPage = () => {
  const { portalToken } = useParams();
  const [meta, setMeta] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  const [email, setEmail] = useState('');
  const [passcode, setPasscode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let alive = true;
    getPortalMeta(portalToken)
      .then((data) => alive && setMeta(data))
      .catch((err) =>
        alive &&
        setLoadError(
          err.response?.status === 404
            ? "This portal link isn't valid or has been turned off."
            : 'Could not load this portal. Please try again later.'
        )
      )
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [portalToken]);

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await requestMagicLink(portalToken, {
        email: email.trim(),
        passcode,
      });
      setSent(true);
    } catch (err) {
      setError(
        err.response?.data?.error || 'Something went wrong. Please try again.'
      );
    } finally {
      setSubmitting(false);
    }
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
          {sent ? (
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: 48, height: 48, borderRadius: '50%', background: '#ECFDF5',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
                }}
              >
                <ShieldCheck size={24} color="#16A34A" />
              </div>
              <p style={{ fontSize: 17, fontWeight: 700, color: '#111827', margin: '0 0 6px' }}>
                Check your email
              </p>
              <p style={{ fontSize: 14, color: '#6B7280', margin: 0, lineHeight: 1.5 }}>
                If everything checks out, we've sent a sign-in link to
                <br />
                <strong style={{ color: '#374151' }}>{email.trim()}</strong>.
                The link expires shortly.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <p style={{ fontSize: 18, fontWeight: 700, color: '#111827', margin: '0 0 4px' }}>
                Sign in to your portal
              </p>
              <p style={{ fontSize: 13.5, color: '#6B7280', margin: '0 0 22px', lineHeight: 1.5 }}>
                Enter your details and we'll email you a secure sign-in link — no
                password to remember.
              </p>

              {meta.passcodeRequired && (
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#6B7280', display: 'block', marginBottom: 6 }}>
                    Passcode
                  </label>
                  <div style={inputWrap}>
                    <Lock size={15} color="#9CA3AF" />
                    <input
                      style={inputEl}
                      type="password"
                      value={passcode}
                      onChange={(e) => setPasscode(e.target.value)}
                      placeholder="Passcode from your contact"
                      autoComplete="off"
                    />
                  </div>
                </div>
              )}

              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#6B7280', display: 'block', marginBottom: 6 }}>
                  Email address
                </label>
                <div style={inputWrap}>
                  <Mail size={15} color="#9CA3AF" />
                  <input
                    style={inputEl}
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    autoFocus
                  />
                </div>
              </div>

              {error && (
                <p style={{ fontSize: 13, color: '#DC2626', margin: '0 0 14px' }}>{error}</p>
              )}

              <button
                type="submit"
                disabled={submitting}
                style={{
                  width: '100%', height: 44, border: 'none', borderRadius: 8,
                  background: '#2563EB', color: '#FFF', fontSize: 14.5, fontWeight: 600,
                  cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.7 : 1,
                }}
              >
                {submitting ? 'Sending…' : 'Email me a sign-in link'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default PortalLandingPage;
