import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, Users } from 'lucide-react';
import useOrgStore from '../store/orgStore';
import useAuthStore from '../store/authStore';

const OnboardingPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const createOrg = useOrgStore((s) => s.createOrg);
  const joinOrg = useOrgStore((s) => s.joinOrg);
  const fetchCurrentUser = useAuthStore((s) => s.fetchCurrentUser);

  const prefilledCode = searchParams.get('invite') || '';
  const [mode, setMode] = useState(prefilledCode ? 'join' : null); // null | 'create' | 'join'
  const [orgName, setOrgName] = useState('');
  const [inviteCode, setInviteCode] = useState(prefilledCode);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const autoJoinAttempted = useRef(false);

  // Auto-join when arriving with an invite code from the URL
  useEffect(() => {
    if (prefilledCode && !autoJoinAttempted.current) {
      autoJoinAttempted.current = true;
      setSubmitting(true);
      joinOrg(prefilledCode)
        .then(() => fetchCurrentUser())
        .then(() => navigate('/dashboard', { replace: true }))
        .catch((err) => {
          setError(err.response?.data?.error || 'Invalid invite code');
          setSubmitting(false);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!orgName.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await createOrg(orgName.trim());
      await fetchCurrentUser();
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create organisation');
      setSubmitting(false);
    }
  };

  const handleJoin = async (e) => {
    e.preventDefault();
    if (!inviteCode.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await joinOrg(inviteCode.trim());
      await fetchCurrentUser();
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid invite code');
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-base px-4 py-12">
      <div
        className="w-full max-w-[520px] bg-surface"
        style={{
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-md)',
          padding: '48px',
        }}
      >
        {/* Heading */}
        <h1 className="font-display font-bold text-[26px] text-center text-[color:var(--color-text-primary)] tracking-tight">
          Welcome to Macan 👋
        </h1>
        <p className="mt-2 text-center text-sm text-[color:var(--color-text-secondary)] font-body">
          Get started by creating or joining your workspace
        </p>

        {/* Option cards */}
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Create Workspace */}
          <button
            type="button"
            onClick={() => {
              setMode('create');
              setError('');
            }}
            className="text-left transition-colors"
            style={{
              border:
                mode === 'create'
                  ? '2px solid var(--color-accent)'
                  : '2px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              padding: '24px',
              background:
                mode === 'create' ? 'var(--color-accent-light)' : 'transparent',
            }}
          >
            <Building2
              size={32}
              color="var(--color-accent)"
              strokeWidth={2}
            />
            <h3 className="mt-3 font-display font-bold text-[15px] text-[color:var(--color-text-primary)]">
              Create Workspace
            </h3>
            <p className="mt-1 text-sm text-[color:var(--color-text-secondary)] font-body">
              Start a new workspace for your team
            </p>
          </button>

          {/* Join Workspace */}
          <button
            type="button"
            onClick={() => {
              setMode('join');
              setError('');
            }}
            className="text-left transition-colors"
            style={{
              border:
                mode === 'join'
                  ? '2px solid var(--color-status-done)'
                  : '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              padding: '24px',
              background:
                mode === 'join' ? 'var(--color-status-done-bg)' : 'transparent',
            }}
          >
            <Users
              size={32}
              color="var(--color-status-done)"
              strokeWidth={2}
            />
            <h3 className="mt-3 font-display font-bold text-[15px] text-[color:var(--color-text-primary)]">
              Join Workspace
            </h3>
            <p className="mt-1 text-sm text-[color:var(--color-text-secondary)] font-body">
              Enter an invite code to join a workspace
            </p>
          </button>
        </div>

        {/* Create form */}
        {mode === 'create' && (
          <form onSubmit={handleCreate} className="mt-6">
            <label className="block text-xs font-body font-medium text-[color:var(--color-text-secondary)] mb-2 uppercase tracking-wide">
              Workspace name
            </label>
            <input
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="e.g. Davnoot Digital"
              autoFocus
              disabled={submitting}
              className="w-full h-11 px-4 font-body text-sm text-[color:var(--color-text-primary)] bg-[color:var(--color-bg-input)] focus:outline-none"
              style={{
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
              }}
            />
            <button
              type="submit"
              disabled={submitting || !orgName.trim()}
              className="mt-4 w-full h-11 font-body font-semibold text-sm text-white bg-accent hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              style={{ borderRadius: 'var(--radius-md)' }}
            >
              {submitting ? 'Creating…' : 'Create Workspace'}
            </button>
          </form>
        )}

        {/* Join form */}
        {mode === 'join' && (
          <form onSubmit={handleJoin} className="mt-6">
            <label className="block text-xs font-body font-medium text-[color:var(--color-text-secondary)] mb-2 uppercase tracking-wide">
              Invite code
            </label>
            <input
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="Paste your invite code"
              autoFocus
              disabled={submitting}
              className="w-full h-11 px-4 font-body text-sm text-[color:var(--color-text-primary)] bg-[color:var(--color-bg-input)] focus:outline-none"
              style={{
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
              }}
            />
            <button
              type="submit"
              disabled={submitting || !inviteCode.trim()}
              className="mt-4 w-full h-11 font-body font-semibold text-sm text-[color:var(--color-text-primary)] bg-white hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              style={{
                border: '1.5px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              {submitting ? 'Joining…' : 'Join via Invite'}
            </button>
          </form>
        )}

        {/* Error */}
        {error && (
          <p className="mt-4 text-xs text-center font-body text-[color:var(--color-status-stuck)]">
            {error}
          </p>
        )}
      </div>
    </div>
  );
};

export default OnboardingPage;
