# Executive View — Implementation TODO

> Companion to the design in [EXECUTIVE_VIEW.md](EXECUTIVE_VIEW.md). Read that
> first; this file is the build order, the file list, and the traps.
>
> **All four phases are built, tested and accepted.** 1883 server tests and 432
> client tests pass, and the client builds.
>
> `npm run migrate:executive` HAS BEEN RUN against the live cluster
> (2026-09-16): 13 organisations updated, 26 capability grants, 23 `executive`
> roles seeded. A workspace created after that date is seeded by
> `ensureSystemRoles` and needs nothing; the script stays idempotent and safe to
> re-run.
>
> Every "Prove before moving on" box was exercised end to end against the live
> API on 2026-09-16, in the two-member workspace "Aneesh" against a test member,
> and the account was restored to its exact prior state afterwards (Member role,
> three public boards, no profile, scratch board deleted). The one result worth
> recording: the home page's goal summary came back byte-identical to the Goals
> tab's — `pct: 50`, same counts — which is the "same scorer" claim holding on
> real data rather than in a stub.

---

## Status at a glance

| Phase | Delivers | Status |
|---|---|---|
| 0 | Catalog: `executive` role preset, `org.manage_executive_views` capability, grant script | ☑ Built |
| 1 | `ExecutiveView` model + service + routes, Members entry point, board picker with grants, nav switches, tile-only home | ☑ Built |
| 2 | Home composer: section types, composer endpoint, in-place section editor, "My view" Settings tab | ☑ Built |
| 3 | Per-board presets (default tab, tab allowlist), labels, "Other boards" group | ☑ Built |
| 4 | Multiple executives: Executives list, copy-from, "Preview as", report widgets as sections | ☑ Built |

**Definition of done for the whole feature:** an owner can open Members, click
"Make executive" on David, pick four boards, and David signs in to a home page
of goal and delivery scores, a rail he can trim, and a board list that is those
four boards and nothing else. Nobody else's screen changed. Deleting the
profile puts David back on the standard app with no migration.

---

## Traps found while reading the code (read before phase 0)

These are facts about the codebase that will bite if forgotten. Each one is
already written up in a comment somewhere; this is the index.

- **`ensureSystemRoles` seeds MISSING ROLES, never missing capabilities.** Adding
  `org.manage_executive_views` to the Admin preset does nothing for any
  workspace that already exists. Ship a grant script beside
  `server/src/scripts/grantTrackerCapabilities.js` and a `migrate:*` entry in
  `server/package.json`, or no existing admin will ever see the button.
- **Board order is `Board.order`, workspace-wide.** `reorderBoards` in
  `boardController.js` rewrites it for everyone and rejects any list that is not
  a full permutation of the caller's visible boards. An Executive dragging
  boards on My Boards must write the PROFILE's order, never `Board.order`, or
  David reorders the whole company's board list.
- **The board page's tab gate throws on unknown keys.** `resolveViewTabs` in
  `client/src/utils/boardViewTabs.js` reads the gate through a Proxy. A preset
  that adds `allowedTabs` / `defaultTab` must add them to the gate literal in
  `BoardDetailPage.jsx` (around line 787), and the memo key derives itself from
  the gate's contents, so nothing else to remember.
- **Tests are an explicit file list.** Both `server/package.json` and
  `client/package.json` run `node --test <files…>`. A new test file that is not
  appended to the script never runs.
- **Populated refs.** Compare ids with `idOf` (see `permissions.js`), never
  `ref.toString()`. Both `getOrg` and the members list populate.
- **Every new `ActivityLog` subject widens the conditional-required condition
  on `task`** (see the comment in `models/ActivityLog.js`) and must be added to
  the export's orphan filter (`group.deleted` is the precedent).
- **Route mounting.** Org-scoped routers live in `routes/orgs.js` under
  `/api/orgs`; feature routers are mounted bare at `/api` (see `app.js` lines
  122–133). Pick one and follow it; do not invent a third prefix.
- **`org.view_members` gates people pickers.** The Executive preset must keep
  it or every avatar on his boards becomes "Unknown".
- **Settings tabs are flag-gated in `SettingsSidebar.jsx`** (`adminOnly`,
  `holidayTab`, `featureTab`). Add an `executiveTab` flag; do not hardcode a
  role check in the sidebar.
- **Grant writing lives in `setBoardAccess`** (`boardController.js` ~1795) and
  carries the "revoking a grant also unfollows / unassigns" cleanup. Extract
  the write into a helper the executive service can call. Do not copy the
  loop.

---

## Phase 0 — Catalog

Goal: the role and the capability exist and can be granted. No UI yet.

### Server

- [x] `server/src/utils/capabilities.js`
  - [x] Add `['org.manage_executive_views', 'Set up and edit executive views']`
        to the `workspace` group.
  - [x] Add the `executive` preset to `SYSTEM_ROLES`: **Admin's list minus
        `board.view_public` and `board.manage_public`**, plus the new
        capability. Colour and description of its own. `isSystem: true`.
  - [x] Add the new capability to the `owner` and `admin` presets.
  - [x] Confirm `OWNER_BOARD_CAPABILITIES` / `BOARD_SCOPED` are untouched (this
        capability is org-scoped).
- [x] `server/src/scripts/grantExecutiveCapabilities.js` — for every org, add
      `org.manage_executive_views` to roles with key `owner` and `admin`, and
      call `ensureSystemRoles()` so `executive` appears. Idempotent.
- [x] `server/package.json` — `"migrate:executive": "node src/scripts/grantExecutiveCapabilities.js"`.
- [x] Tests: `server/src/utils/permissions.test.js` gains cases:
  - [x] Executive on a PUBLIC board with no grant → `canRead === false`.
  - [x] Executive on a public board with a `view` grant → level `view`, not
        `edit` (proves `manage_public` is gone).
  - [x] Executive with full-access grant → `canManageAccess === true`.
  - [x] Owner cannot be resolved to the executive role (owner short-circuit
        still wins).

### Client

- [x] `client/src/components/settings/PermissionsMatrix.jsx` — nothing to do
      if it renders from `CAPABILITY_GROUPS`; verify the new row appears.
- [x] Members page role dropdown lists "Executive" automatically (it lists all
      non-owner roles). Verify.

### Prove before moving on

- [x] Run the grant script against the dev DB; open Settings → Permissions;
      the Executive column and the new row both render.
- [x] Assign Executive to a test user by hand; their board list drops every
      public board they had no grant to.

---

## Phase 1 — Reach + shell

Goal: an admin can declare an Executive and give them boards; the Executive
sees a curated board list, a rail with switches, and a tile-only home.

### Server

- [x] `server/src/models/ExecutiveView.js`
  - [x] Fields per spec §5. Unique compound index `{ organisation: 1, user: 1 }`.
  - [x] `boards[]` subdocs: `board`, `label`, `order`, `defaultTab: null`,
        `tabs: null` (presets are phase 3 but the shape ships now so no
        migration later).
  - [x] `home[]` subdocs: `type`, `order`, `width`, `config: Mixed`.
  - [x] `nav`: eight booleans, all default `true`.
  - [x] `createdBy`, `updatedBy`, timestamps.
  - [x] Register in `models/index.js`.
- [x] `server/src/services/executiveView.js` — the ONLY reader/writer.
  - [x] `getForUser(orgId, userId)`.
  - [x] `resolveForViewer(orgId, userId)` → profile with boards the viewer can
        no longer `canRead` dropped into `skipped[]`. Uses `resolveAccess`.
  - [x] `validateShape(body)` — shared by admin PUT and self PUT. Unknown
        section types rejected; nav keys whitelisted; board entries must be
        ObjectIds.
  - [x] `upsert(orgId, userId, shape, { actor, allowReachChange })`.
  - [x] `addBoard(orgId, userId, boardId, { level, canManage, actor })` — calls
        the grant helper extracted from `setBoardAccess`; refuses unless the
        ACTOR's `resolveAccess(board).canManageAccess` is true.
  - [x] `removeBoard(..., { revoke })`.
  - [x] `remove(orgId, userId)` — deletes the profile; does NOT touch grants or
        role (the controller decides that with the caller).
- [x] Extract the grant write from `boardController.setBoardAccess` into
      `server/src/services/boardGrants.js` (`grant`, `revoke`) and make
      `setBoardAccess` call it. No behaviour change; existing tests must pass.
- [x] `server/src/controllers/executiveViewController.js`
  - [x] Admin plane (all gated `org.manage_executive_views` via the org
        context loader): `list`, `get`, `put`, `delete`, `addBoard`,
        `removeBoard`, `declare` (assign role via `roleController.assignRole`'s
        internals + create empty profile, one transaction-ish sequence, owner
        refused with 400).
  - [x] Self plane: `getMine`, `putMine` (shape only, `allowReachChange:false`,
        board entries filtered to `canRead`).
- [x] `server/src/routes/executiveViews.js` — mounted bare at `/api` beside
      the other feature routers. Paths:
      `/orgs/:orgId/executive-views[...]` and `/me/executive-view`.
- [x] `app.js` — mount it.
- [x] Activity log: add an `org` subject with types `executive.declared`,
      `executive.updated`, `executive.removed`, `executive.board_added`,
      `executive.board_removed`. Writer: `services/executiveActivity.js`
      (mirror `groupActivity.js`). Widen the conditional-required condition and
      the export orphan filter.
- [x] Tests (append to `server/package.json` test list):
  - [x] `services/executiveView.test.js` — `resolveForViewer` drops
        unreadable boards; `validateShape` rejects unknown section types and
        nav keys; self `upsert` cannot add an unreadable board; `addBoard`
        refuses when the actor cannot manage access on that board.
  - [x] `controllers/executiveDeclare.test.js` — owner refused; role assigned
        and profile created together; declaring twice is idempotent.
  - [x] `services/boardGrants.test.js` — extraction preserves the
        unfollow/unassign cleanup on revoke.

### Client

- [x] `client/src/services/executiveViewService.js` — API wrapper for both
      planes.
- [x] `client/src/store/executiveViewStore.js`
  - [x] `profile`, `loading`, `isExecutive` (derived: profile !== null).
  - [x] `fetchMine(orgId)` called from wherever `fetchMembers` / org selection
        runs; cleared on org switch and logout (mirror `orgStore.clearOrgs`).
  - [x] `saveMine(shape)`.
- [x] `client/src/components/layout/SideRail.jsx`
  - [x] When `isExecutive`, filter the entries list by `profile.nav[key]`. The
        capability gates already there stay in front. Home and Settings are
        never filterable.
- [x] `client/src/pages/MyBoardsPage.jsx`
  - [x] When `isExecutive`: order by profile, then "Other boards" for
        anything reachable but unlisted.
  - [x] Drag-reorder writes `saveMine({ boards })`, NOT `reorderBoards`.
- [x] `client/src/pages/ExecutiveHomePage.jsx` — phase 1 version: board
      tiles only (reuse `BoardCard`), an empty-state that says "Your admin has
      not added boards yet".
- [x] `client/src/App.jsx` — `/dashboard` renders `ExecutiveHomePage` when
      `isExecutive`, else `DashboardPage`. Must not flash the standard
      dashboard while the profile loads: gate on `loading` first.
- [x] `client/src/pages/MembersPage.jsx`
  - [x] Per-row action: "Make executive" / "Edit executive view", shown only
        with `can('org.manage_executive_views')`; hidden on the owner row and
        on self.
  - [x] "Make executive" opens a confirm modal explaining the role change,
        then navigates to the configurator.
- [x] `client/src/pages/ExecutiveViewConfigPage.jsx` at
      `/members/:userId/executive-view` (route gated on the capability like
      `/members` is). Phase 1 steps: Role (read-only confirmation), Boards
      (picker + level + remove), Navigation (switches). Home and Preview steps
      are placeholders.
  - [x] Board picker lists boards from `getBoards` for the CALLER (so an admin
        sees public + their private; an Executive editing another Executive
        sees only their own reach). No special-casing.
  - [x] Level select defaults to `edit` + full access.
  - [x] Removing asks "Also revoke access?" with revoke as the default.
- [x] Tests (append to `client/package.json`):
  - [x] `utils/executiveNav.test.mjs` — a pure helper
        `applyNavSwitches(entries, nav)` that hides but never reveals, and
        never hides Home/Settings. Extract it from SideRail so it is testable.

### Prove before moving on

- [x] Declare a test user; add two boards; they sign in and see two boards, a
      full rail, tiles. Switch Chat off from the configurator; their rail
      loses Chat on next load.
- [x] Revoke one grant from the board's share dialog directly; the profile's
      resolved view drops that board and the configurator flags it.
- [x] Delete the profile; the user is back on the standard dashboard with the
      Executive role still assigned (role is the admin's separate decision).

---

## Phase 2 — Home composer

Goal: the home page is composed from sections, editable in place by the
Executive and from the configurator by an admin.

### Server

- [x] `server/src/services/executiveHome.js` — the ONLY composer.
  - [x] `compose(orgId, userId)` walks `profile.home[]`, and for every section
        with a `board` in its config runs `resolveAccess(board).canRead`
        first; unreadable → section returns `{ state: 'unavailable' }`, never
        throws.
  - [x] Section handlers, one per type, each calling an existing function:
    - [x] `boardTiles` — profile boards with labels.
    - [x] `goalScores` — the same loader the Goals tab uses, then
          `scoreGroup` / `scoreBoard` from `utils/goalTypes.js`. Month
          defaults to current via `monthKey.js`.
    - [x] `deliveryScores` — `fetchDeliveryInputs` → `planDelivery` →
          `evaluatePlans` from `services/deliveryReport.js`.
    - [x] `adsBudgetPacing` — `utils/adsBudgetPacing.js` over the board's
          budgets.
    - [x] `workspaceNumbers` — the summary branch of
          `analyticsController.getAnalytics`, refactored so the summary is a
          callable function rather than only a handler. Requires
          `analytics.view`.
    - [x] `myWork` — the same query My Work uses, limited to N.
    - [x] `note` — echo config.
  - [x] A registry `SECTION_TYPES` exported so `validateShape` and the client
        share one list. Add a type = add a handler + a renderer, nothing else.
- [x] `GET /api/me/executive-home` in the controller → `compose`.
- [x] Tests: `services/executiveHome.test.js` — unreadable board yields
      `unavailable`; unknown type yields `unavailable`; each handler is called
      with the board it was configured with (stub the scorers).

### Client

- [x] `client/src/components/executive/sections/` — one renderer per type.
      Reuse `StatCard`, the Goals table, the Delivery grid summary, the Ads
      Budget tile. Every section has an "Open" link built with
      `utils/taskLink.js` conventions (`?view=goals` etc.).
- [x] `client/src/components/executive/SectionEditor.jsx` — add / remove /
      reorder (dnd-kit, already a dependency) / configure a section. Width
      toggle full/half. Board pickers inside it list only boards in the
      profile. Used by BOTH the home page's edit mode and the configurator.
- [x] `client/src/components/executive/SectionConfigForm.jsx` — per-type
      config fields (board, month, range, text).
- [x] `ExecutiveHomePage.jsx` — render `compose()` result in a 2-column grid
      honouring `width`; "Edit home" button toggles `SectionEditor`; save
      calls `saveMine({ home })`.
- [x] `ExecutiveViewConfigPage.jsx` — Home step uses `SectionEditor` against
      the target user's profile via the admin PUT.
- [x] Settings → "My view" tab (`executiveTab` flag in `SettingsSidebar.jsx`):
      nav switches, board order and labels. Shown only when `isExecutive`.
- [x] Tests: `utils/executiveSections.test.mjs` — pure helpers for
      reorder / width toggle / config defaults per type.

### Prove before moving on

- [x] Admin composes a goal-scores section for a tracker board; the Executive
      sees this month's scores on home, matching the board's Goals tab
      exactly (same numbers, because same scorer).
- [x] Executive adds a delivery section themselves, reorders, saves, reloads;
      the layout persists.
- [x] Executive loses access to that board; the section shows "unavailable"
      instead of breaking the page.

---

## Phase 3 — Per-board presets

Goal: a board opens on the tab the profile says, shows only the tabs the
profile allows, and carries the profile's label.

### Client

- [x] `BoardDetailPage.jsx`
  - [x] Read the profile entry for this board from `executiveViewStore`.
  - [x] Add `allowedTabs` and `defaultTab` to the gate literal.
  - [x] `VIEW_TABS` predicates: wrap the resolved list so a tab absent from
        `allowedTabs` (when non-null) is dropped. Prefer doing this in
        `resolveViewTabs` with an optional `allow` argument so the page gains
        no branching.
  - [x] `resolveView(raw, visibleTabs, fallback)` receives `defaultTab` as
        the fallback when the URL names nothing.
- [x] `client/src/utils/boardViewTabs.js` — the `allow` argument above, plus
      tests in `boardViewTabs.test.mjs`: allowlist hides; allowlist never
      shows a tab the gate hid; `board` tab always survives.
- [x] Labels: `BoardCard` and the Navbar breadcrumb show `label || name` for
      an Executive.
- [x] Configurator Boards step and Settings "My view": per-board default tab
      dropdown (options = the board's possible tabs by type) and tab
      checkboxes.

### Server

- [x] `validateShape`: `defaultTab` must be a known tab value; `tabs` must be
      null or a non-empty array of known values containing `board`.

### Prove before moving on

- [x] Set a tracker board to open on Goals with only Board + Goals allowed;
      the Executive lands on Goals, sees two tabs, and `?view=delivery` in
      the URL falls back to Goals.

---

## Phase 4 — Multiple executives

Goal: the second Executive costs one click.

- [x] Members page: "Executives" strip at the top listing everyone with a
      profile (avatars + edit link). Server: `GET /orgs/:orgId/executive-views`
      is already there from phase 1.
- [x] `POST /orgs/:orgId/executive-views/:userId/copy-from/:sourceUserId` —
      copies shape; for each board entry calls `addBoard` with the same level,
      skipping (and reporting) boards the actor cannot share.
- [x] Configurator create flow: "Start from: blank / copy from <Executive>".
- [x] "Preview as": configurator step 5 calls `GET /orgs/:orgId/executive-views/:userId/preview`,
      which runs `compose` and `resolveForViewer` AS THE TARGET USER (server
      side, so the admin's own reach never leaks into the preview). Renders
      the home and rail read-only in a frame.
- [x] `reportWidget` section type: config = board + group + a widget
      definition validated by `isWidgetType` from `reportWidgets.js`; renderer
      reuses the Client Report's widget renderer.
- [x] Tests: copy-from skips unshareable boards and reports them; preview as
      target excludes boards only the admin can read.

---

## Not in scope (decided, do not add)

- Group filters on a board (whole board, decision 7).
- A free-form drag canvas for the home (ordered list with full/half widths).
- Executive switching the feature off themselves (admin-imposed by design).
- Any check on the user's name, title, or a count of executives.
- A new board type.

---

## Open items to confirm during implementation

- Whether `analytics.view` should stay in the Executive preset (spec §12
  assumes yes because "all access like admin").
- Whether `ActivityLog` already has an `org`-level subject from the ownership
  transfer work; if so, reuse its shape rather than adding a fifth.
- Whether the `getAnalytics` summary refactor is worth it in phase 2 or the
  workspace-numbers section should wait for phase 4.
