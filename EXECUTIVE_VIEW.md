# Executive View — a curated workspace for one important person

Status: **discussion draft v0.2**, 2026-09-15. No code yet. Written for Aneesh
and for whoever implements it. Section 11 records the decisions taken so far;
section 12 lists what is still assumed rather than decided.

---

## 1. The problem

Davnoot Digital runs everything in one workspace: SEO boards, ads boards, tech
and coding projects, client boards, tracker boards. That is right for the team,
and it is wrong for David, the CEO.

David is an admin today. An admin sees every public board, the full nav rail,
the generic dashboard with four stat cards, and a board list that is the whole
company. He does not want any of that. He wants a handful of boards (a tracker
board is the reference example) and nothing else on the screen.

The obvious fix is to make every board private and grant David only the ones
he needs. That fixes David's screen and breaks everyone else's: there would be
no public boards left, every new hire needs manual grants, and the "private"
flag stops meaning anything. Board visibility is a fact about the board. The
problem here is a fact about the person.

## 2. The idea

The owner or an admin can declare a member an **Executive**. An Executive gets:

1. **Reach only to the boards they were given.** Public boards are not
   automatically theirs. On the boards they are given they have full,
   admin-level power. Their board list is exactly the curated list.
2. **A different home page.** Not the four stat cards. A composed page of the
   things they actually check: goal scores, delivery scores, ads pacing, board
   tiles. Set up by the admin, and fully editable by the Executive afterwards.
3. **A navigation rail they control.** Every entry is a switch. All on by
   default.
4. **Per-board presets.** Which tab a board opens on for them (Goals instead
   of Board, say) and which tabs they see at all.

One person today (David). The model is one document per person, so a second
Executive is a second document and a "copy from David" button.

## 3. What already exists (facts from the code)

The design leans on these, so they are stated here rather than assumed.

- **Roles are data.** `Organisation.roles[]` is a list of named capability
  bundles; `memberRoles[]` maps a user to one. The five seeded roles are
  owner / admin / member / viewer / guest, and the matrix in Settings edits
  them. Adding a role preset is adding a row to `SYSTEM_ROLES` in
  `server/src/utils/capabilities.js`.
- **Permission is a two-layer AND**, resolved only by `resolveAccess` in
  `server/src/utils/permissions.js`: org role AND board level. Nothing in this
  feature may add a third path.
- **`board.view_public` is the one capability that decides whether public
  boards exist for you.** The Guest role lacks it: a Guest sees only boards
  explicitly granted in `Board.memberAccess`. That is the exact reach
  behaviour an Executive needs, and it already works end to end (board list,
  dashboard stats, My Work, notification fan-out all go through `canRead`).
- **`board.manage_public` is what makes an admin `edit` on every public
  board.** Without it, a person's level on a public board is whatever their
  grant says. So "admin power, but only where granted" is: keep every admin
  capability, drop those two.
- **The board list is filtered server-side** (`getBoards` / `getDashboardStats`
  filter on `resolveAccess(...).canRead`). A person who cannot reach a board
  never receives it. "Hide everything else" is not a UI trick; it falls out
  of reach.
- **The nav rail is capability-gated** (`SideRail.jsx`: Members, Analytics,
  Productivity appear only with the matching capability). Dashboard, My Boards,
  My Work, Chat, Settings are unconditional today.
- **The board page's tabs are a registry with a gate object**
  (`VIEW_TABS` + `resolveViewTabs` in `client/src/utils/boardViewTabs.js`).
  Tabs: Board, Chat, Delivery, Goals, People, Vault, Add-ons, Ads Budget,
  connector Data, connector Report. The default tab is fixed (`board`) and
  the URL `?view=` carries the choice.
- **Reporting surfaces already exist and are server-scored:**
  goals (`goalTypes.js`, the only scorer), Delivery (`deliveryReport.js`, the
  only pipeline), Ads budget pacing (`adsBudgetPacing.js`), the org Analytics
  page (`analytics.view`), and the connector Client Report built from five
  closed widget types in `client/src/utils/reportWidgets.js`.
- **Opt-in per-user features have a contract** (`client/src/utils/extraFeatures.js`
  + `User.features`). Those are things a person switches on for themselves.
  The Executive View is imposed by an admin and cannot be switched off by the
  person. It is not an extra feature.

## 4. Design

### 4.1 Two halves: reach and shape

| Half | Question it answers | Where it lives | Who may change it |
|---|---|---|---|
| **Reach** | Which boards may David open, and what may he do there? | The existing permission system: a role + per-board grants | Owner and admins |
| **Shape** | What does David's screen look like? | A new **Executive profile** document | Owner, admins, **and David himself** |

The profile never grants anything. If the profile lists a board David has no
grant to, the board is skipped and the configurator flags it. That rule keeps
this from becoming a second permission system, and it is what makes
self-editing safe: David can rearrange his shape all he likes and never widen
his reach.

### 4.2 Reach: the Executive role

A new seeded role preset, key `executive`, editable in the matrix like every
other role. Its default permission list is **the Admin preset minus exactly
two capabilities**:

- `board.view_public` (so public boards are not automatically his)
- `board.manage_public` (so his level on a board is his grant, not "edit
  everywhere")

Everything else an admin holds stays: org management, board create/rename/
delete, all content capabilities, automations, trackers, goals, ads budgets,
vault, connectors, analytics, productivity, activity export. Since the role is
data, the owner can trim it in the matrix later without a code change.

Declaring someone an Executive assigns this role (through the existing
`assignRole` path) and creates their profile in one action. They remain two
records, so the role can be changed independently afterwards.

**Grants.** Adding a board to an Executive's profile writes a grant on that
board through the existing share path. Default level is `edit` with
`canManage` (full access), matching "all access like admin". The configurator
lets the admin lower it per board.

**Boards outside the profile.** With `board.create` he can make boards, and
someone may share a board with him directly. Those are reachable and must not
vanish. The board list shows profile boards first, in profile order, then an
"Other boards" group with everything else he can read.

### 4.3 Shape: the Executive profile

One document per (organisation, user). Contents:

- **Boards**, ordered. For each: the board id, an optional display label
  (call "SEO Tracker 2026" simply "SEO"), an optional per-board preset (4.5).
- **Home layout**: an ordered list of sections (4.4).
- **Navigation**: which rail entries are on (4.6).
- **Audit**: who created it, who last changed it, when.

Two kinds of writer:

- **Admin path**: may change everything, including adding boards (which writes
  grants) and removing them (which asks whether to revoke the grant too).
- **Self path**: the Executive edits their own home, nav, board order, labels
  and presets. Their board picker offers only boards they can already read.
  Same document, same validator, one service; the only difference is which
  boards the picker lists and that the self path never touches grants.

Last write wins. Both paths are single-user edits of one small document; no
locking is needed.

Removing the profile or the role restores the standard app for that user
immediately, with nothing to migrate back, because the profile only ever
described a view.

### 4.4 The executive home

Replaces `/dashboard` for an Executive. The generic dashboard (greeting, four
stat cards, recent boards, quick actions) is not shown.

The page is a grid of **sections** the admin composes and the Executive may
then rearrange, add to, remove from, or reconfigure through an edit mode on
the page itself. The reference use case is a tracker board: "this month's
goal scores and delivery for the clients I care about, at a glance."

Section types for the first version, each backed by a scorer or endpoint that
already exists:

| Section | Source | Config |
|---|---|---|
| **Board tiles** | The profile's board list | Which boards, label, which tab the tile opens on |
| **Goal scores** | `goalTypes.js` via the board's Goals endpoint | Board, month (current by default) |
| **Delivery scores** | `deliveryReport.js` | Board, month |
| **Ads budget pacing** | `adsBudgetPacing.js` | Board, month |
| **Workspace numbers** | The Analytics summary (`analytics.view`) | Range (7d / 30d / all), board filter |
| **Report widget** | A connector Client Report widget (`reportWidgets.js` five types) | Board, group, widget definition |
| **My work** | The caller's own open tasks (same query as My Work) | Due filter |
| **Note** | Static rich text | Text |

Sections render read-only. Each carries an "open in board" link that deep-links
to the right tab (`?view=goals`, etc.) using the existing link builders.

Layout is a simple ordered list with a width per section (full / half). No
free-form drag canvas; reorder by drag within the list. That is enough for
"fully customizable" without building a page builder.

One server endpoint composes the page. It walks the profile's sections,
checks `resolveAccess(...).canRead` per board, and calls the existing scorers.
Nothing is computed client-side that the server has not already gated.

### 4.5 Per-board presets

Optional, per board in the profile:

- **Default tab**: which `?view=` the board opens on for this person. The
  board page already resolves the view from the URL against the visible tabs;
  the preset only supplies the fallback when the URL has none.
- **Tab allowlist**: a subset of the board's tabs. Applied in the gate object
  the page already builds, so a hidden tab is hidden the same way a
  capability-gated one is. A tab hidden here is still reachable by URL; that
  is acceptable because hiding is about noise, not secrecy. Secrecy is the
  role's job.

The whole board is shown. There is no group filter.

### 4.6 Navigation

Rail entries, each an on/off switch in the profile, **all on by default**:

- Home (always on; it is the executive home)
- Boards (the curated list, then "Other boards")
- My Work, Chat, Calendar, Notifications
- Members, Analytics, Productivity (still require the capability, which the
  Executive preset holds)
- Settings (always on)

A switch can only hide an entry the capability would allow. It can never show
one the capability forbids. The rail is the same component; when a profile is
present it reads the switches, otherwise it renders exactly as today.

### 4.7 Who configures it, and where

- New capability `org.manage_executive_views` ("Set up and edit executive
  views"). Seeded on owner and admin, and therefore on the Executive preset
  too, so David can set up the next Executive if he wants to. Assigning the
  role itself still needs `org.assign_roles`.
- **Admin entry point:** Members page, per row: "Make executive" (when not
  one) or "Edit executive view" (when one). The owner cannot be made an
  Executive. A small "Executives" list at the top of the Members page shows
  who has a profile, with "Copy from" on the create flow once there is more
  than one.
- **The configurator** (admin): one page, `/members/:userId/executive-view`,
  in steps:
  1. Role: confirm the Executive role (or pick another; the page warns if the
     chosen role still holds `board.view_public`, because the curated list
     would then not be the whole list).
  2. Boards: pick boards; for each, level (default full access), label,
     default tab, tab allowlist. Adding writes the grant. Removing asks
     whether to revoke.
  3. Home: add, order, and configure sections.
  4. Navigation: the switches.
  5. Preview: render the executive home and rail as that person will see it,
     using their resolved access, not the admin's.
- **Self entry point:** an "Edit home" button on the executive home (opens
  the same section editor in place) and a "My view" tab in Settings for nav
  switches, board order, labels and presets.
- Changes are logged. `ActivityLog` has task / goal / group subjects today;
  this adds an `org` subject (to confirm against what the ownership-transfer
  work already writes).

### 4.8 As David sees it

He signs in. The rail shows everything, because nobody turned anything off
yet. Home shows "SEO — September" goal scores for the three clients he cares
about, a Delivery percentage for the ads board, a spend-vs-budget tile, and
four board tiles. He clicks a tile and lands on that board's Goals tab with
full edit rights. He decides he does not want Productivity in the rail and
switches it off himself. The other forty boards in the workspace do not exist
for him, and nobody else's screen changed.

## 5. Data model

**New collection `ExecutiveView`** (one per org + user, unique index on the pair):

```
organisation   ObjectId -> Organisation
user           ObjectId -> User
boards[]       { board, label, defaultTab, tabs[] | null, order }
home[]         { type, order, width: 'full' | 'half', config }
nav            { boards, myWork, chat, calendar, notifications,
                 members, analytics, productivity }   // all default true
createdBy, updatedBy, createdAt, updatedAt
```

A separate collection rather than a field on `Organisation`: the Organisation
model deliberately avoids a settings blob (see the comment above `holidays`),
and a profile is per person with its own lifecycle. This is also what makes
"multiple executives later" free: it is already a collection.

**`Organisation.roles`** gains the seeded `executive` preset via
`ensureSystemRoles`, which only adds missing keys, so existing matrices are
untouched.

**No change to `Board`, `Task`, `User`.** Reach is `memberAccess` grants as
today.

## 6. Server

- `SYSTEM_ROLES` gains `executive`; the catalog gains
  `org.manage_executive_views` in the Workspace group.
- `models/ExecutiveView.js`.
- `services/executiveView.js`: the only validator and writer of the profile
  document. Both routes below call it.
- `services/executiveHome.js`: the only composer of the home page. Calls the
  existing scorers; adds none of its own.
- Admin routes under `/api/orgs/:orgId/executive-views`, gated on
  `org.manage_executive_views`:
  - `GET /` list, `GET /:userId`, `PUT /:userId` (create or replace),
    `DELETE /:userId`.
  - `POST /:userId/boards` adds a board and writes the grant in one step,
    reusing the share controller's grant logic. The caller must be able to
    share that board (`canManageAccess`), which is what stops an Executive
    using this route to reach a board they were not given.
  - `POST /:userId/copy-from/:sourceUserId` copies shape only (boards are
    copied as entries; grants are written for each, same rule as above).
- Self routes:
  - `GET /api/me/executive-view`: the caller's profile, resolved. Boards they
    can no longer read are dropped and reported in `skipped[]`.
  - `PUT /api/me/executive-view`: shape only. Board entries are accepted only
    for boards the caller can read; grants are never touched.
  - `GET /api/me/executive-home`: composes the sections (4.4). Every board
    passes through `resolveAccess(...).canRead` before any scorer runs.

## 7. Client

- `store/executiveViewStore`: loads `/api/me/executive-view` after org
  selection; `isExecutive` derived from its presence.
- `pages/ExecutiveHomePage.jsx` mounted at `/dashboard` when `isExecutive`;
  otherwise the current `DashboardPage`. Carries the in-place section editor.
- `SideRail.jsx`: when `isExecutive`, apply the profile's switches on top of
  the capability gates it already has.
- `MyBoardsPage.jsx`: when `isExecutive`, profile boards first with labels,
  then "Other boards".
- `BoardDetailPage.jsx`: the gate object gains `allowedTabs` and `defaultTab`
  from the profile so `resolveViewTabs` and `resolveView` handle it with no
  new branching in the page.
- `pages/ExecutiveViewConfigPage.jsx` (admin configurator) and
  `components/executive/*` (section renderers, section editor, nav switches).
  Section renderers reuse `StatCard`, the Goals/Delivery table components,
  and the report widget renderer already used by the connector Client Report.
  The section editor is one component used by both the admin configurator
  and the executive's own home.
- Settings gains a "My view" tab, shown only when `isExecutive`.
- Desktop stays pixel-identical for non-executives; the executive shell
  follows the same responsive rules as the rest of the app.

## 8. Invariants

1. The profile never grants access. Reach is role + grants, resolved by
   `resolveAccess`, and every executive endpoint re-checks it per board.
2. The self path can change shape only. It never writes a grant and never
   accepts a board the caller cannot already read.
3. Removing the profile or the role restores the standard app with no data
   migration.
4. A board in the profile that the person cannot read is skipped, never
   errored, and surfaced to the admin in the configurator.
5. The executive home computes nothing itself; it composes existing scorers.
6. A nav switch can hide, never reveal.
7. Nobody else's screen changes when someone is made an Executive.
8. The owner cannot be made an Executive.
9. Nothing in the code refers to David, a CEO, or a count of one. Every path
   is per (org, user).

## 9. Rejected alternatives

- **Make every board private and grant David each one.** Solves David, breaks
  the workspace for everyone else, and turns "private" into noise.
- **Keep him Admin and hide boards client-side.** Public boards would still
  reach him through My Work, notifications, search and stats. Hiding would be
  a UI trick that leaks.
- **Just a role.** A role is a capability bundle. It can hide Analytics from
  the rail but cannot say "open this board on Goals" or "put this score on the
  home page". Presentation is not permission.
- **A new `boardType: 'executive'`.** The boards David reads are the same
  boards the team works in. A copy would drift.
- **An extra feature the person switches on.** Extra features are self-serve
  opt-ins. This is imposed by an admin, and the person should not be able to
  switch it off.
- **A free-form drag-and-drop dashboard builder.** An ordered list with
  full/half widths covers "fully customizable" at a fraction of the surface.

## 10. Delivery phases

1. **Reach + shell.** Executive role preset, capability, `ExecutiveView`
   model, service and routes, Members-page entry point, board picker with
   grants, nav switches, and a minimal home that is just the board tiles.
2. **Home composer.** Section types (goal scores, delivery, ads pacing,
   workspace numbers, my work, note), the composer endpoint, the section
   editor used by both the admin configurator and the executive's own home,
   the "My view" Settings tab.
3. **Per-board presets.** Default tab and tab allowlist through the gate;
   labels on tiles and board list; "Other boards" group.
4. **Multiple executives.** Executives list on Members, copy-from, "Preview
   as" in the configurator, connector report widgets as home sections.

## 11. Decisions taken (2026-09-15)

| # | Question | Decision |
|---|---|---|
| 1 | What may the Executive change on a board? | Everything an admin can. Role = Admin minus `board.view_public` and `board.manage_public`; grants default to full access. |
| 2 | What is "reports"? | A tracker board he uses to keep track. It was the reference example, not a separate report product. The home is board-driven. |
| 3 | Can the Executive rearrange his own home? | Yes. Fully customizable by him; admin sets it up. Shape only, never reach. |
| 4 | Who may set it up? | Owner and admins (new capability, seeded on both). |
| 5 | Auto-grant when a board is added? | Yes, through the existing share path. |
| 6 | Which nav entries? | All of them, each a switch, all on by default. |
| 7 | Whole board or some groups? | Whole board. No group filter. |
| 8 | Name | "Executive" (role, profile, rail). |
| 9 | How many people? | One now, several later. One document per person, copy-from, no singleton anywhere. |

## 12. Still assumed, not decided

- The Executive keeps org-level admin powers (invite, roles, settings,
  holidays). If he should not, the preset drops the `org.*` capabilities;
  nothing else changes.
- Default grant level is full access (`edit` + `canManage`). The
  configurator can lower it per board.
- Home layout is an ordered list with full/half widths, not a free canvas.
- Making an existing admin an Executive starts with an empty board list; the
  configurator does not pre-fill it with every public board he could see.
