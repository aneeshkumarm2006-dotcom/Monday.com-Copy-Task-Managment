import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { verifyMagicLink, setPortalToken } from '../services/portalService';

/**
 * PortalVerifyPage — `/portal/verify?token=...`. Exchanges the one-time magic
 * token for a scoped portal session, stores it under `macan_portal_token`, and
 * routes to the dashboard. Mirrors AuthCallbackPage but for the portal plane.
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

const PortalVerifyPage = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setError('This link is missing its verification code.');
      return;
    }
    verifyMagicLink(token)
      .then((data) => {
        setPortalToken(data.token);
        navigate('/portal', { replace: true });
      })
      .catch((err) => {
        setError(
          err.response?.data?.error ||
            'This sign-in link is invalid or has expired. Please request a new one.'
        );
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div style={shell}>
        <div
          style={{
            width: '100%', maxWidth: 420, background: '#FFF', borderRadius: 14,
            boxShadow: '0 4px 24px rgba(0,0,0,0.10)', padding: 32, textAlign: 'center',
          }}
        >
          <p style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: '0 0 8px' }}>
            Sign-in link expired
          </p>
          <p style={{ fontSize: 14, color: '#6B7280', margin: 0, lineHeight: 1.5 }}>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={shell}>
      <Loader2 size={28} color="#2563EB" style={{ animation: 'spin 1s linear infinite' }} />
      <span style={{ marginLeft: 12, color: '#6B7280', fontSize: 14 }}>Signing you in…</span>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
};

export default PortalVerifyPage;
