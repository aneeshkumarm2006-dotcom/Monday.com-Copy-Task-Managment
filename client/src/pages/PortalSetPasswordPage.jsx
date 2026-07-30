import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, AlertCircle, KeyRound, ShieldCheck } from 'lucide-react';
import {
  checkPortalSetupToken,
  completePortalPasswordSetup,
  requestPortalPasswordLink,
  setPortalToken,
  rememberPortalLink,
} from '../services/portalService';
import { PORTAL_BRAND, PORTAL_BRAND_INITIAL } from '../utils/portalBrand';
import '../styles/portal.css';

/**
 * PortalSetPasswordPage — `/portal/:portalToken/set-password?t=<one-time token>`.
 *
 * Where a client without a Google account lands from their invitation (or from a
 * password reset). The token in the query is single-use and expiring, so it is
 * validated on mount before anything is rendered: the answer tells us which
 * address it belongs to and whether this is a first set-up or a reset, which is
 * the difference between the two headings.
 *
 * Submitting stores the password AND returns a session token, so they land in
 * the portal signed in rather than bouncing to a login form they just proved
 * they can pass.
 */

const MIN_LENGTH = 8;

const PortalSetPasswordPage = () => {
  const { portalToken } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('t') || '';

  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Re-request panel, shown on the dead-link screen.
  const [resendEmail, setResendEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState('');

  useEffect(() => {
    let alive = true;
    rememberPortalLink(portalToken);
    if (!token) {
      setLoadError('This link is missing its code. Please open the link from your email again.');
      setLoading(false);
      return () => {
        alive = false;
      };
    }
    checkPortalSetupToken(portalToken, token)
      .then((data) => alive && setInfo(data))
      .catch((err) => {
        if (!alive) return;
        const status = err.response?.status;
        if (status === 400 || status === 404) {
          setLoadError(
            err.response?.data?.error ||
              'This link has expired or has already been used. Ask for a new one.'
          );
        } else if (status) {
          setLoadError(err.response?.data?.error || 'Something went wrong. Please try again.');
        } else {
          setLoadError('Could not reach the server. Check your connection and try again.');
        }
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [portalToken, token]);

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (password.length < MIN_LENGTH) {
      setFormError(`Please choose a password of at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setFormError("Those two passwords don't match.");
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const { token: session } = await completePortalPasswordSetup(portalToken, token, password);
      setPortalToken(session);
      navigate('/portal', { replace: true });
    } catch (err) {
      setFormError(
        err.response?.data?.error ||
          (err.response
            ? 'Could not save your password. Please try again.'
            : 'Could not reach the server. Check your connection and try again.')
      );
      setSaving(false);
    }
  };

  const handleResend = async () => {
    const addr = resendEmail.trim();
    if (!addr) return;
    setResending(true);
    try {
      const { message } = await requestPortalPasswordLink(portalToken, addr);
      setResendMsg(message);
    } catch (err) {
      setResendMsg(err.response?.data?.error || 'Could not send the link. Please try again.');
    } finally {
      setResending(false);
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
          <p style={{ fontSize: 17, fontWeight: 700, margin: '0 0 8px' }}>Link no longer valid</p>
          <p style={{ fontSize: 14, color: '#64748B', margin: '0 0 20px', lineHeight: 1.55 }}>
            {loadError}
          </p>

          {resendMsg ? (
            <p className="mcp-note">{resendMsg}</p>
          ) : (
            <div style={{ textAlign: 'left' }}>
              <label className="mcp-label" htmlFor="resend-email">Send me a new link</label>
              <input
                id="resend-email"
                className="mcp-field"
                type="email"
                placeholder="you@company.com"
                value={resendEmail}
                onChange={(e) => setResendEmail(e.target.value)}
                style={{ marginBottom: 10 }}
              />
              <button
                type="button"
                onClick={handleResend}
                disabled={resending || !resendEmail.trim()}
                className="mcp-btn mcp-btn--primary mcp-btn--block"
              >
                {resending ? <><Loader2 size={17} className="mcp-spin" /> Sending…</> : 'Email me a new link'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const isReset = info.purpose === 'reset';
  const company = info.clientName || '';

  return (
    <div className="mcp mcp-page mcp-shell">
      <div className="mcp-card-lg mcp-pop" style={{ width: '100%', maxWidth: 420, padding: '36px 34px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 26 }}>
          <span className="mcp-brand-mark" style={{ width: 42, height: 42 }}>{PORTAL_BRAND_INITIAL}</span>
          <div>
            <div style={{ fontSize: 15.5, fontWeight: 800, letterSpacing: '-0.01em', lineHeight: 1.2 }}>
              {PORTAL_BRAND}
            </div>
            {company && <div style={{ fontSize: 12.5, color: '#64748B' }}>{company} · Support portal</div>}
          </div>
        </div>

        <div
          style={{
            width: 44, height: 44, borderRadius: 12, marginBottom: 16,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#EFF4FF', color: '#2563EB',
          }}
        >
          <KeyRound size={22} />
        </div>

        <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', margin: '0 0 6px' }}>
          {isReset ? 'Choose a new password' : 'Set your password'}
        </h2>
        <p style={{ fontSize: 14, color: '#64748B', margin: '0 0 22px', lineHeight: 1.55 }}>
          {isReset ? 'Your new password replaces the old one for ' : "You'll use this with "}
          <strong style={{ color: '#0F172A' }}>{info.email}</strong>
          {isReset ? '.' : ' every time you sign in.'}
        </p>

        <form onSubmit={handleSubmit} noValidate>
          {/* Hidden username field so password managers save this against the
              right account rather than offering it on every portal. */}
          <input type="text" name="username" autoComplete="username" value={info.email} readOnly hidden />

          <div style={{ marginBottom: 14 }}>
            <label className="mcp-label" htmlFor="new-password">New password</label>
            <input
              id="new-password"
              className="mcp-field"
              type="password"
              autoComplete="new-password"
              placeholder={`At least ${MIN_LENGTH} characters`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label className="mcp-label" htmlFor="confirm-password">Confirm password</label>
            <input
              id="confirm-password"
              className="mcp-field"
              type="password"
              autoComplete="new-password"
              placeholder="Type it again"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>

          {formError && <p className="mcp-error" style={{ marginBottom: 14 }}>{formError}</p>}

          <button
            type="submit"
            disabled={saving}
            className="mcp-btn mcp-btn--primary mcp-btn--block"
          >
            {saving ? (
              <><Loader2 size={17} className="mcp-spin" /> Saving…</>
            ) : isReset ? (
              'Save password & sign in'
            ) : (
              'Set password & sign in'
            )}
          </button>
        </form>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '20px 0 0', color: '#94A3B8' }}>
          <ShieldCheck size={14} />
          <span style={{ fontSize: 12, lineHeight: 1.5 }}>
            This link works once. We'll sign you in as soon as it's saved.
          </span>
        </div>
      </div>
    </div>
  );
};

export default PortalSetPasswordPage;
