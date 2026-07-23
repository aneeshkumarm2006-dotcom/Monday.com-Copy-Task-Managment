import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, AlertCircle } from 'lucide-react';
import { setPortalToken } from '../services/portalService';
import '../styles/portal.css';

/**
 * PortalVerifyPage — `/portal/verify`. The landing spot after Google sign-in.
 * The API's OAuth callback redirects here with `?ptoken=<scoped portal JWT>`
 * (already minted server-side); we just store it and route to the dashboard.
 * `?error=1` means sign-in failed. Mirrors AuthCallbackPage for the portal plane.
 */
const PortalVerifyPage = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    if (searchParams.get('error')) {
      setError("We couldn't sign you in. Please reopen your invitation link and try again.");
      return;
    }
    const ptoken = searchParams.get('ptoken');
    if (!ptoken) {
      setError('This sign-in link is missing its access token. Please reopen your invitation link.');
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
          <p style={{ fontSize: 14, color: '#64748B', margin: 0, lineHeight: 1.55 }}>{error}</p>
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
