import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, AlertCircle } from 'lucide-react';
import { setPortalToken, getLastPortalLink } from '../services/portalService';
import '../styles/portal.css';

/**
 * PortalVerifyPage — `/portal/verify`. The landing spot after Google sign-in.
 * The API's OAuth callback redirects here with `?ptoken=<scoped portal JWT>`
 * (already minted server-side); we just store it and route to the dashboard.
 * `?error=1` means sign-in failed. Mirrors AuthCallbackPage for the portal plane.
 *
 * Both failure paths are ordinary, not exotic: cancelling at Google's consent
 * screen lands here, and so does a portal the team disabled mid-flow. So the
 * failure card carries the way back — the remembered link id, the same one the
 * dashboard's expired screen uses — because "reopen your invitation link" is
 * not something a client can act on from this page.
 */
const PortalVerifyPage = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [lastLink] = useState(getLastPortalLink);

  useEffect(() => {
    if (searchParams.get('error')) {
      setError("We couldn't sign you in. Please try again.");
      return;
    }
    const ptoken = searchParams.get('ptoken');
    if (!ptoken) {
      setError('This sign-in link is missing its access token, so we could not finish signing you in.');
      return;
    }
    setPortalToken(ptoken);
    navigate('/portal', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
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
          <p style={{ fontSize: 17, fontWeight: 700, margin: '0 0 8px' }}>Sign-in failed</p>
          <p style={{ fontSize: 14, color: '#64748B', margin: 0, lineHeight: 1.55 }}>
            {error}{' '}
            {lastLink
              ? 'You can go straight back to the sign-in page.'
              : 'Please open your invitation link from your email again.'}
          </p>
          {lastLink && (
            <a
              href={`/portal/${lastLink}`}
              className="mcp-btn mcp-btn--primary mcp-btn--block"
              style={{ marginTop: 20, textDecoration: 'none' }}
            >
              Back to sign in
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mcp mcp-page mcp-shell">
      <div className="mcp-pop" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div className="mcp-brand-mark" style={{ width: 54, height: 54, borderRadius: 15, position: 'relative' }}>
          <Loader2 size={26} className="mcp-spin" color="#fff" />
        </div>
        <span style={{ color: '#475569', fontSize: 14.5, fontWeight: 500 }}>Signing you in…</span>
      </div>
    </div>
  );
};

export default PortalVerifyPage;
