import { useEffect } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  useLocation,
} from 'react-router-dom';
import useAuthStore from './store/authStore';
import useOrgStore from './store/orgStore';
import useNotificationStore from './store/notificationStore';
import useChatStore from './store/chatStore';
import usePermissionStore from './store/permissionStore';
import usePermissions from './hooks/usePermissions';
import LoginPage from './pages/LoginPage';
import AuthCallbackPage from './pages/AuthCallbackPage';
import PortalLandingPage from './pages/PortalLandingPage';
import PortalVerifyPage from './pages/PortalVerifyPage';
import PortalSetPasswordPage from './pages/PortalSetPasswordPage';
import PortalDashboardPage from './pages/PortalDashboardPage';
import OnboardingPage from './pages/OnboardingPage';
import DashboardPage from './pages/DashboardPage';
import MyBoardsPage from './pages/MyBoardsPage';
import BoardDetailPage from './pages/BoardDetailPage';
import CalendarPage from './pages/CalendarPage';
import AnalyticsPage from './pages/AnalyticsPage';
import ProductivityPage from './pages/ProductivityPage';
import MyTasksPage from './pages/MyTasksPage';
import SettingsPage from './pages/SettingsPage';
import NotificationsPage from './pages/NotificationsPage';
import ChatPage from './pages/ChatPage';
import MembersPage from './pages/MembersPage';
import NotFoundPage from './pages/NotFoundPage';
import ToastContainer from './components/ui/Toast';
import useNotificationPoll from './hooks/useNotificationPoll';
import useNotificationStream from './hooks/useNotificationStream';
import { syncSubscription } from './services/pushService';

/**
 * ProtectedRoute — redirects to /login when not authenticated.
 */
const ProtectedRoute = () => {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const location = useLocation();

  if (!isAuthenticated) {
    // Save intended destination (e.g. /onboarding?invite=xxx) so we can
    // redirect back after login instead of losing query params.
    const intended = location.pathname + location.search;
    if (intended !== '/login') {
      sessionStorage.setItem('postLoginRedirect', intended);
    }
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
};

/**
 * RequireOrg — for app pages that need a selected org. If the user has no
 * organisations, send them to onboarding.
 */
const RequireOrg = () => {
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);

  // While hydrating the user, don't redirect yet
  if (loading || !user) return <Outlet />;

  const hasOrg =
    Array.isArray(user.organisations) && user.organisations.length > 0;
  return hasOrg ? <Outlet /> : <Navigate to="/onboarding" replace />;
};

/**
 * RequireCapability — gate a route on a capability the SERVER resolved.
 *
 * Replaces RequireAdmin, which re-derived "is this person an admin" from
 * `org.admin` + `org.admins` — a block copy-pasted into eight files, each free to
 * drift from what the API actually enforces. Now there is one answer, and the
 * client reads it.
 *
 * This is a courtesy redirect, never a control: every one of these routes is
 * enforced server-side regardless of what the router renders.
 */
const RequireCapability = ({ capability }) => {
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const permissionsLoading = usePermissionStore((s) => s.loading);
  const loadedForOrg = usePermissionStore((s) => s.loadedForOrg);
  const { can } = usePermissions();

  // Don't decide while anything is still hydrating — a premature "no" would
  // bounce a user who does in fact hold the capability.
  if (loading || !user || !currentOrg) return <Outlet />;
  if (permissionsLoading || loadedForOrg !== currentOrg._id) return <Outlet />;

  return can(capability) ? <Outlet /> : <Navigate to="/dashboard" replace />;
};

/**
 * PublicOnlyRoute — if already logged in, bounce to /dashboard.
 */
const PublicOnlyRoute = ({ children }) => {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return isAuthenticated ? <Navigate to="/dashboard" replace /> : children;
};

function App() {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const fetchCurrentUser = useAuthStore((s) => s.fetchCurrentUser);
  const setOrgsFromUser = useOrgStore((s) => s.setOrgsFromUser);
  const currentOrgId = useOrgStore((s) => s.currentOrg?._id);
  const ensureHolidays = useOrgStore((s) => s.ensureHolidays);
  const fetchNotifications = useNotificationStore((s) => s.fetchNotifications);
  const clearNotifications = useNotificationStore((s) => s.clear);
  const fetchChannels = useChatStore((s) => s.fetchChannels);
  const clearChat = useChatStore((s) => s.clear);

  // On mount (or token change), hydrate the user profile from the backend.
  useEffect(() => {
    if (token && !user) {
      fetchCurrentUser();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Keep orgStore synced with the user's organisations
  useEffect(() => {
    if (user) {
      setOrgsFromUser(user);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Pull notifications once the user is hydrated and re-fetch whenever the
  // active organisation changes so the bell only shows notifications for
  // the workspace the user is currently looking at. Clear on logout.
  useEffect(() => {
    if (user) {
      fetchNotifications(currentOrgId || undefined);
      // Channels too, so the Chat tab's unread badge is live from first paint
      // (this is also what lazily creates the auto client channels).
      if (currentOrgId) fetchChannels(currentOrgId);
    } else if (!token) {
      // Actually logged out — not merely still hydrating. On a cold load
      // `user` is null for a beat while the profile fetch runs, and clearing
      // here wiped the conversation a /chat?channel= deep link had just
      // opened. No token is the real logout signal.
      clearNotifications();
      clearChat();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?._id, currentOrgId]);

  // Re-register this browser's push subscription on sign-in.
  //
  // A REPAIR, not a feature: it never prompts and never subscribes, it only
  // re-posts a subscription the browser already holds. It covers the drift case
  // where the browser is still subscribed but the server is not — a row pruned
  // after a run of delivery failures, or a different account signing in on this
  // browser — which otherwise leaves someone looking at a settings page that
  // says notifications are on while none ever arrive.
  useEffect(() => {
    if (user) syncSubscription();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?._id]);

  // Load the workspace holiday calendar once per org, up here rather than per
  // page, because the surfaces that need it are not just the calendars: every
  // DatePickerPopover in the app marks holidays, and those live on board pages
  // that would otherwise never have loaded the list. `ensureHolidays` is a
  // no-op once loaded, so this costs one request per workspace per session.
  useEffect(() => {
    if (user && currentOrgId) ensureHolidays(currentOrgId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?._id, currentOrgId]);

  // Real-time delivery: SSE stream for instant pushes, with an always-on poll
  // that keeps the unread badge fresh and covers any stream gaps.
  useNotificationStream(token, currentOrgId || undefined, !!user);
  useNotificationPoll(currentOrgId || undefined, !!user);

  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route
          path="/login"
          element={
            <PublicOnlyRoute>
              <LoginPage />
            </PublicOnlyRoute>
          }
        />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />

        {/* Client Portal — fully public, external-client surface. NOT behind
            ProtectedRoute and deliberately not using the app shell or app stores;
            it authenticates with its own portal token (see portalService). The
            more specific /portal/verify must precede /portal/:portalToken.
            /portal/:portalToken/set-password is where a password client lands
            from their one-time invite or reset email; it has two segments, so
            the single-segment :portalToken route can't shadow it. */}
        <Route path="/portal" element={<PortalDashboardPage />} />
        <Route path="/portal/verify" element={<PortalVerifyPage />} />
        <Route path="/portal/:portalToken" element={<PortalLandingPage />} />
        <Route path="/portal/:portalToken/set-password" element={<PortalSetPasswordPage />} />

        {/* Protected */}
        <Route element={<ProtectedRoute />}>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route element={<RequireOrg />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/boards" element={<MyBoardsPage />} />
            <Route path="/boards/:id" element={<BoardDetailPage />} />
            <Route path="/my-tasks" element={<MyTasksPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            {/* Analytics and Productivity were admin-only. They are now gated on
                the capabilities that mean the same thing, so a custom role can be
                given one without the other. */}
            <Route element={<RequireCapability capability="analytics.view" />}>
              <Route path="/analytics" element={<AnalyticsPage />} />
            </Route>
            <Route
              element={<RequireCapability capability="productivity.view_others" />}
            >
              <Route path="/productivity" element={<ProductivityPage />} />
            </Route>
            <Route element={<RequireCapability capability="org.view_members" />}>
              <Route path="/members" element={<MembersPage />} />
            </Route>
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Route>

        {/* Default */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <ToastContainer />
    </BrowserRouter>
  );
}

export default App;
