# Codebase Improvement Report — Macan (monday.com clone)

_Generated 2026-06-12. Stack: React 19 + Vite + Zustand + Tailwind (client) · Node/Express 5 + Mongoose 9 + MongoDB (server)._

This is a review of the whole codebase with concrete, prioritized findings. Each item cites
`file:line` and proposes a specific fix. Findings are grouped **Backend** and **Frontend**, ordered
by severity within each.

The codebase is well-organized and the hard domain logic (board access grants, mirror refresh,
flexible columns, optimistic updates with rollback) is genuinely well done. The gaps are mostly
**operational and cross-cutting**: hardening, indexes, tests, and a few real authorization holes.

---

## Top 10 — fix these first

| # | Area | Finding | Severity |
|---|------|---------|----------|
| 1 | Backend | Comment access bypasses the shared `resolveBoardAccess` contract — any org member can read/post on private-board tasks | Critical |
| 2 | Backend | `/api/proxy/download` lets any authenticated user fetch **any** Cloudinary asset in the account (cross-tenant), and signing bypasses access restrictions | Critical |
| 3 | Backend | No rate limiting anywhere (invite brute-force, proxy abuse, notification-poll write amplification) | Critical |
| 4 | Backend | No `helmet`, no explicit body-size limit; CORS allows all origins if `CLIENT_URL` is unset | High |
| 5 | Backend | Missing DB indexes on hot paths: `Task.board/assignedTo/dueDate`, `Comment.task`, `Notification.user` | High |
| 6 | Frontend | JWT stored in `localStorage` → XSS-exfiltratable; should be httpOnly cookie | Critical |
| 7 | Frontend | No error boundaries anywhere — any render throw white-screens the whole SPA | Critical |
| 8 | Both | Zero configured test runner; `.test.js` files can't even run via `npm test` | Critical |
| 9 | Frontend | `BoardDetailPage.jsx` is a 1,615-line god component; optimistic-update boilerplate duplicated ~7× | High |
| 10 | Frontend | Both `moment` and `date-fns` shipped; `date-fns` is dead, `moment` used in 2 files only | High |

---

## Backend (`server/`)

### Critical

**B-C1 · Comment authorization bypasses the permission contract.**
`controllers/commentController.js:22-45` — `checkTaskAccess` documents (lines 16-21) that regular members
get access "only on public boards AND only when assignee," but the implementation returns
`{ ok: true }` for **any** org member (line 44). On a **private** board, a non-granted member can read and
post comments on tasks they cannot otherwise see. Your own memory note records that
`resolveBoardAccess` in `utils/boardAccess.js` is the shared permission contract — comments should call
`loadBoardContext`/`resolveBoardAccess` instead of rolling a weaker check.
**Fix:** replace the bespoke membership check with `resolveBoardAccess(board, org, userId)` and gate on `canRead`.

**B-C2 · Proxy download allows cross-tenant Cloudinary asset access.**
`routes/proxy.js:57-142`. The route requires auth (`router.use(authMiddleware)`, line 7) and the host
allowlist (`res.cloudinary.com`, line 66) correctly prevents general SSRF. But there is **no check that the
requesting user may access the specific asset** — any authenticated user can download any avatar/attachment
in the entire Cloudinary account by URL, and the signing step (lines 85-91) deliberately *bypasses*
Cloudinary access restrictions, removing the last backstop.
**Fix:** resolve the asset back to its owning task/board/update and run `resolveBoardAccess` before signing.
Also remove the signed-URL `console.log` (lines 80-92, 105) — signed URLs are credentials (see B-L1).

**B-C3 · No rate limiting.**
`app.js` mounts no limiter (`express-rate-limit` isn't even a dependency). Abusable surfaces:
`POST /api/orgs/join/:inviteCode` (12-char hex invite code, brute-forceable — `orgController.js:78-102`),
`/api/proxy/download` (server-side fetch), and `GET /api/notifications` which runs
`ensureDueSoonNotifications` — 2-3 queries + `insertMany` — on **every poll** with no throttle
(`notificationController.js:106`).
**Fix:** add a global limiter + stricter ones on `/auth`, `/api/proxy`, and the invite-join route.

### High

**B-H1 · Missing security/hardening middleware.** `app.js:7-17` — no `helmet`; `express.json()` /
`urlencoded()` have no explicit `limit`; and `cors({ origin: process.env.CLIENT_URL })` (line 9) reflects
**all** origins when `CLIENT_URL` is unset. Add `helmet()`, explicit `limit: '1mb'`, and fail startup if
`CLIENT_URL` is missing.

**B-H2 · No JWT/env startup validation.** `middleware/auth.js:19` and `authController.js:14` use
`process.env.JWT_SECRET` directly with no boot-time assertion. (Good: there is no hardcoded fallback secret.)
Add a startup check that throws if `JWT_SECRET` is missing — alongside the existing `MONGODB_URI` check.

**B-H3 · Missing indexes on the hottest fields.**
- `models/Task.js` — no index on `board`, `group`, `assignedTo`, `isPersonal`, `dueDate`. Add compound
  `{ board: 1, parent: 1, isPersonal: 1 }`, `{ assignedTo: 1, dueDate: 1 }`, `{ board: 1, group: 1 }`.
- `models/Comment.js` — no index on `task` despite per-board `Comment.aggregate({ task: { $in } })` on every
  board load. Add `{ task: 1, createdAt: 1 }`.
- `models/Notification.js` — no index on `user` despite find/count/updateMany on every poll. Add
  `{ user: 1, createdAt: -1 }` and `{ user: 1, isRead: 1 }`.
- `models/Board.js` — add `{ organisation: 1, order: 1 }`.

**B-H4 · `express-validator` installed but never used.** `package.json:20` lists it; nothing imports it.
Validation is hand-rolled and uneven — `orgController.sendInvite` (`:197-198`) accepts any string as an email.
Standardize on a per-route validation middleware layer.

**B-H5 · Unbounded queries / writes on read paths.**
- `taskController.js:378` (`getTasks`) returns **all** top-level tasks for a board, unpaginated.
- `boardController.js:103-115` (`getBoards`) loops `await board.save()` for status seeding — write
  amplification on a read endpoint; this belongs in a one-time migration script (which already exists in
  `scripts/`).
- `analyticsController.js:122` loads every matching task into memory to bucket statuses; use a `$group`
  aggregation like the priority/per-board ones already do.

### Medium

**B-M1 · `loadBoardContext` / `isOrgAdmin` / `validateAssignees` duplicated 3×** across `taskController.js:66`,
`boardController.js:37`, `automationController.js:27` — with subtly different semantics (the automation copy
skips `resolveBoardAccess` entirely). Extract into `utils/boardAccess.js` + `utils/validators.js`.

**B-M2 · Inverted dependency: services import a controller.** The automation *execution engine*
(`runAutomationOnce`, etc.) lives in `automationController.js` and is imported by the
`automationRunner`/`automationEventDispatcher` *services*. Move the engine into a service.

**B-M3 · Notification + email fan-out block copy-pasted 3×** (`taskController.js:740-772`, `1052-1094`, and the
cleaner `notifyAssignees` in `automationController.js:338`). Consolidate on the helper.

**B-M4 · Automation runner has no overlap guard.** `automationRunner.js:8-32` runs every minute with no lock;
a tick >60s overlaps the next, and `nextRunAt` is persisted *after* running (lines 24-26) → double-runs. On
multi-instance deploys every instance runs the cron. Add a per-tick "skip if running" guard and an atomic
`findOneAndUpdate` claim on `nextRunAt`.

**B-M5 · Lossy/unstructured error handling.** Every controller returns `{ error: 'Server error' }` + bare
`console.error`. No structured logger, levels, request IDs, or redaction. Adopt `pino`/`winston` + an
`asyncHandler` wrapper feeding the existing global handler in `app.js:49`.

### Low

- **B-L1** `proxy.js:80-92,105` logs full signed URLs (credentials). Remove/gate behind debug.
- **B-L2** `authController.logout` (`:64-66`) is a no-op; 7-day tokens can't be revoked. Consider short-lived
  tokens + refresh or a `jti` denylist.
- **B-L3** `Comment`/`Organisation`/`TaskGroup`/`User` use manual `createdAt` defaults instead of
  `{ timestamps: true }` — inconsistent with the other models; no `updatedAt`.
- **B-L4** `joinOrg` (`orgController.js:78-102`) read-modify-writes `members`; use `$addToSet` via
  `findOneAndUpdate` to avoid the race.
- **B-L5** Lazy migration-on-read (`ensureBoardStatuses`, `getBoards` seed loop) should be removed once the
  `scripts/migrate*` have run.

---

## Frontend (`client/`)

### Critical

**F-C1 · JWT in `localStorage`.** `services/api.js:9` and `store/authStore.js:9` store/read `macan_token` from
`localStorage`, exposing it to any XSS (e.g. via the TipTap editor in `UpdatesTab.jsx`). **Fix:** move to an
httpOnly, SameSite cookie set by the backend and drop manual `Authorization` header injection.

**F-C2 · No error boundaries.** Zero matches for `ErrorBoundary`/`componentDidCatch` in `src/`. A render throw
in any cell/row/modal white-screens the whole app. Wrap routes (at minimum `BoardDetailPage`, `CommentPanel`,
`DataGrid`) in an error boundary with a recoverable fallback.

**F-C3 · No tests, no runner.** No `*.test.*` on the client, no `vitest`/`jest`, no `test` script. (On the
server, three `.test.js` files exist but `npm test` is still the default `exit 1` — no runner installed
either.) **Fix:** add Vitest; start with the pure, high-value targets: `utils/taskFilters.js`,
`utils/dateUtils.js`, `utils/boardAccess` resolution, and the `taskStore` re-bucketing logic.

### High

**F-H1 · Drop `moment` + `date-fns`.** `package.json:22-23` — `date-fns` is imported **nowhere** (dead dep);
`moment` (~70KB, not tree-shakable) is used only in `CalendarPage.jsx:4` and `MyTasksPage.jsx:3` for
`momentLocalizer`. Switch `react-big-calendar` to `dateFnsLocalizer` (or `luxonLocalizer`) and remove both.

**F-H2 · No memoization on hot list components.** Zero `React.memo` usage. `TaskRow.jsx` (639 LOC) and
`DataGrid`'s inner `Row` (`DataGrid.jsx:281`) re-render the whole group on every cell edit, worsened by
per-cell inline closures (`DataGrid.jsx:304`, `BoardDetailPage.jsx:1244`). Wrap rows in `React.memo` and
stabilize handlers with `useCallback`.

**F-H3 · `BoardDetailPage.jsx` is a 1,615-line god component** with ~25 `useState` slices and a 60-line inline
`onUpdateTask` (`:1523-1582`). Extract a `useBoardMutations` hook, a DnD `onDragEnd` hook, and a reducer for
the menu state. Same applies to `AutomationsModal.jsx` (2,002 LOC) and `CommentPanel.jsx` (1,866 LOC).

**F-H4 · Optimistic-update boilerplate duplicated ~7×** (`BoardDetailPage.jsx:531-661, 766-783`):
`handleStatusSelect`/`handlePrioritySelect`/`handleOwnerChange`/`handleDueDateChange`/`handleLabelToggle`/
`handleBulkAssign` all repeat save-prev → optimistic → await → reconcile → rollback+toast. Collapse into one
`optimisticUpdate(task, patch)` in `taskStore` (it already owns the cache + rollback for reorders).

**F-H5 · Server state cached but never invalidated.** `boardStore`/`taskStore`/`orgStore` are fetched once and
mutated locally forever — no TTL, refetch-on-focus, or sync (the app is collaborative; two editors silently
diverge). Strongly consider TanStack Query / SWR to replace the hand-rolled fetch/cache/optimistic/rollback in
all five stores.

**F-H6 · 401 doesn't reactively log out.** `services/api.js:25-27` only removes the token on 401;
`authStore.isAuthenticated` is set once at init (`authStore.js:10`) and isn't updated, so the user stays on a
broken page until reload. **Fix:** call `useAuthStore.getState().logout()` from the interceptor.

### Medium

**F-M1 · No retry/backoff or request cancellation** in `services/api.js`; rapid board navigation can land a
stale `fetchBoardData` after a newer one. Add `AbortController` wiring in `BoardDetailPage` cleanup (`:243`).

**F-M2 · ~15 column cells re-implement the same inline-edit pattern** (`TextCell.jsx:7-53` ≈ `NumberCell.jsx:4-56`,
plus LongText/Phone/Email/Link/Location). Extract a `useInlineEditable(value, onChange, {parse, format})` hook;
the text-like cells collapse to thin wrappers.

**F-M3 · Native `window.confirm`/`prompt`** for destructive/edit actions (`DataGrid.jsx:81, 210`; also
`AutomationsModal`, `UpdatesTab`) — inconsistent with the app's own `Modal` and inaccessible. Use `Modal`.

**F-M4 · Org-admin resolution copy-pasted** in `App.jsx:75-86` (`RequireAdmin`) and `BoardDetailPage.jsx:84-94`
(`useIsCurrentOrgAdmin`). Fold into a shared `useIsOrgAdmin` hook in `utils/`.

**F-M5 · `eslint-disable exhaustive-deps`** in several effects (`App.jsx:111,119,131`, `BoardDetailPage.jsx:246`).
Zustand actions are already stable — prefer including them in deps over blanket disables.

### Low

- **F-L1** Custom `<div onClick>` cells (`TextCell.jsx:25`, `NumberCell.jsx:29`) aren't keyboard-operable — add
  `tabIndex`/`role`/`onKeyDown`. The `DataGrid` header menu closes on `onMouseLeave` only (no Escape).
- **F-L2** No code-splitting — `AutomationsModal`, `CommentPanel`, `recharts`, `react-big-calendar`+moment all
  ship in the main bundle. Route-level `React.lazy` for Analytics/Productivity/Calendar pages.
- **F-L3** Inconsistent loading states — `MyTasksPage.jsx:188` hand-rolls `animate-pulse` instead of reusing the
  existing `Skeleton`/`EmptyState` primitives.
- **F-L4** `formatDate` defined 3× (`dateUtils.js:25`, `columns/cellShared.js:53`, `MyTasksPage.jsx:48`).
  Consolidate on `dateUtils`.
- **F-L5** 30+ silent `console.error` in catch blocks; no production error reporting (Sentry hook).

---

## Suggested execution order

1. **Security correctness (1 PR):** B-C1, B-C2, F-C1, F-H6 — close the auth holes and fix session handling.
2. **Hardening (1 PR):** B-C3, B-H1, B-H2 — rate limiter, helmet, env validation.
3. **Safety net before refactors:** F-C2 (error boundary) + B/F-C3 (Vitest on pure utils & stores).
4. **Indexes & quick wins:** B-H3, B-H5, F-H1 (drop moment/date-fns) — measurable perf/bundle gains.
5. **De-dup & perf:** F-H2, F-H4, B-M1, B-M3 — memoize rows, centralize optimistic updates, extract helpers.
6. **Architecture (larger):** F-H3/F-H5 (decompose god components, adopt TanStack Query), B-M2/B-M4
   (automation engine → service, runner overlap guard).

## What's already good (preserve it)

- `resolveBoardAccess` as a shared permission contract (where it's actually used).
- `searchController` escapes user regex to prevent ReDoS; `validateAssignees`/`sanitizeLabelsForBoard` guard
  cross-org IDs.
- `taskStore`/`notificationStore` optimistic updates + rollback correctly handle orphaned subitems,
  cross-group moves, and comment-count preservation.
- `annotateCommentCounts`/`annotateHasSubitems` deliberately avoid N+1 with a single aggregate.
- `ActivityLog`/`BoardConnection` models have thoughtful compound indexes — the pattern to copy onto the
  other models (B-H3).
