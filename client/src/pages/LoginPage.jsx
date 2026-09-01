import { useSearchParams } from 'react-router-dom';
import macanMark from '../assets/macan-mark.png';

const GoogleIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      fill="#4285F4"
      d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
    />
    <path
      fill="#34A853"
      d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
    />
    <path
      fill="#FBBC05"
      d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
    />
    <path
      fill="#EA4335"
      d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
    />
  </svg>
);

const LoginPage = () => {
  const [searchParams] = useSearchParams();
  const error = searchParams.get('error');

  const handleGoogleSignIn = () => {
    window.location.href = `${import.meta.env.VITE_API_BASE_URL}/auth/google`;
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-base px-4">
      <div
        className="w-full max-w-[400px] bg-surface p-10"
        style={{
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        {/* Logo + wordmark. The mark is decorative — the <h1> below is the
            accessible name, so it carries an empty alt rather than "Macan",
            which would otherwise be announced twice in a row. */}
        <div className="flex flex-col items-center">
          <img
            src={macanMark}
            alt=""
            aria-hidden="true"
            width={56}
            height={56}
            style={{ width: 56, height: 56, objectFit: 'contain' }}
          />
          <h1 className="mt-4 font-display font-extrabold text-[22px] tracking-tight text-[color:var(--color-text-primary)]">
            Macan
          </h1>
          <p className="mt-2 text-[color:var(--color-text-secondary)] text-[13px] text-center">
            Task management for Davnoot Digital
          </p>
        </div>

        {/* Google OAuth button */}
        <div className="mt-8">
          <button
            type="button"
            onClick={handleGoogleSignIn}
            className="w-full h-11 flex items-center justify-center gap-3 bg-white font-body font-semibold text-[14px] text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-bg-subtle)]"
            style={{
              border: '1.5px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <GoogleIcon />
            Sign in with Google
          </button>
        </div>

        {/* Error message */}
        {error && (
          <p className="mt-3 text-xs text-center text-[color:var(--color-status-stuck)]">
            Sign-in failed. Please try again.
          </p>
        )}

        {/* Fine print */}
        <p className="mt-4 text-xs text-center text-[color:var(--color-text-muted)]">
          By signing in you agree to internal usage terms.
        </p>
      </div>
    </div>
  );
};

export default LoginPage;
