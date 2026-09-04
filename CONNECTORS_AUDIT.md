# Connectors — Ubersuggest & DataForSEO: full context audit

> Compiled **2026-09-04** against branch `main` at `f7fc2b7`.
>
> Method: 24 parallel subsystem reads over every connector file (server, client, models,
> routes, tests, docs), 56 adversarial staleness checks against code and git history, a
> full server test run, and direct read-only inspection of the Atlas `macan` database.
> No project file was modified while auditing.
>
> **This document supersedes `_ai_context/dataforseo_TODO.md`, `_ai_context/ubersuggest_TODO.md`
> and `_ai_context/dataforseo_RESEARCH.md` wherever they disagree.** Those three predate five
> commits and one of them opens with a sentence that is the opposite of the truth. See
> [§9 Stale-documentation register](#9-stale-documentation-register).

---

## Contents

- [0. The blocking bug](#0-the-blocking-bug)
- [1. State of play](#1-state-of-play)
- [2. The generic engine](#2-the-generic-engine)
- [3. Ubersuggest](#3-ubersuggest)
- [4. DataForSEO](#4-dataforseo)
- [5. Client surfaces](#5-client-surfaces)
- [6. What the tests pin](#6-what-the-tests-pin)
- [7. Operations](#7-operations)
- [8. Timeline](#8-timeline)
- [9. Stale-documentation register](#9-stale-documentation-register)
- [10. Outstanding work and risks](#10-outstanding-work-and-risks)
- [11. File index](#11-file-index)

---

## 0. The blocking bug

**DataForSEO has been silently unable to collect anything since 2026-09-01.** Found by
reconciling the live database against the code; reproduced against the real cluster.

### What is wrong

`DfsTask` declares the field with an explicit default:

```js
// server/src/models/DfsTask.js:180
externalId: { type: String, default: null },
```

and indexes it:

```js
// server/src/models/DfsTask.js:407
dfsTaskSchema.index({ externalId: 1 }, { unique: true, sparse: true });
```

A sparse index skips a document whose field is **absent**. It still indexes a document whose
field is **present and null**. Mongoose writes the default on every insert, so every batch row
carries an explicit null and **only one such row can ever exist in the collection**.

### Why it is silent

Both post paths catch the resulting `E11000` and interpret it as the anti-double-charge claim
firing — that is, as "another process already holds this identity":

| Path | Location | Note returned | Becomes |
|---|---|---|---|
| Task transport | `dataforseo/tasks.js:618-630` | `Already queued at DataForSEO.` | `pending` |
| Live transport | `dataforseo/liveJob.js:217-228` | `This collection is already running.` | `pending` |

The `pending` sentinel by design writes no snapshot, claims no `periodKey`, and is counted as
*queued* rather than failed (`snapshotService.js:534`). So the failure produces no error, no
failed count, no budget reservation and no HTTP call.

One row has occupied the null slot since **2026-09-01 06:03Z**. Every hourly pass since has
reported `ok 0 / failed 0 / skipped 1 / queued 12`.

### The reproduction

Run against the live cluster in a throwaway collection carrying the same index, then dropped.
No project data touched.

```
index: { externalId: 1 }, unique: true, sparse: true

A) externalId present and null          ← what DfsTask actually writes
   first  {externalId: null} : INSERTED
   second {externalId: null} : REJECTED · 11000 dup key: { externalId: null }

B) externalId absent                     ← what sparse is meant to permit
   first  {} : INSERTED
   second {} : INSERTED

C) proposed fix — partialFilterExpression { externalId: { $type: "string" } }
   first  {externalId: null}  : INSERTED
   second {externalId: null}  : INSERTED
   third  {externalId: "abc"} : INSERTED
   fourth {externalId: "abc"} : REJECTED     ← real ids still deduplicated
```

The live `dfstasks` collection was also confirmed to carry `externalId_1` as
`unique: true, sparse: true`, and its single row stores `externalId` as an explicit null.

### Why no test caught it

Every test that exercises a post replaces `DfsTask.create` with a fake modelling **only** the
`(project, kind, variant, state:'open')` rule — `dataforseo/tasks.test.js:262-277`,
`labs.test.js:217`, `backlinks.test.js:359`. The schema test then asserts the index must be
sparse *"or every batch row collides on null"* (`tasks.test.js:1156-1158`), which is precisely
the misconception, written down and pinned as a requirement.

### The fix, in order

1. Replace `sparse: true` with `partialFilterExpression: { externalId: { $type: 'string' } }`
   at `models/DfsTask.js:407`.
2. Drop `externalId_1` on the live collection so it rebuilds. **Mongoose will not rebuild an
   index whose options changed** — this needs an explicit `dropIndex` or `syncIndexes()`.
3. Correct `tasks.test.js:1156-1158` to pin the partial filter rather than sparseness.
4. Deleting the one stuck row is **not** a fix: the next claim would succeed and the one after
   it would collide again.

### Second, independent problem: `40501 Invalid Field: 'language_name'`

The one post that did go out (4 keywords, 2026-09-01 06:03Z) was refused per task with
`40501 Invalid Field: 'language_name'`. The payload builder never sends `language_name`; it
sends the documented `language_code` (`dataforseo/tasks.js:473-481`), and the string appears
nowhere in `server/src` or `client/src`.

- `40501` maps to `STATUS_INVALID_FIELD` → `'invalid'` with no retryable/forbidden/quota flag
  (`constants.js:719`, `errors.js:104, 207-208`).
- The job closed `failed` with `posted: 0`, and **the stored job note reads `"Ok."`** because it
  is written from the envelope message rather than the per-item text (`tasks.js:722`). The truth
  is in `items[].statusMessage`.
- The only sandbox-specific handling in the code is `40404 → no_sandbox_data`. Neither research
  doc records a sandbox `40501` or anything about `language_name`.

Most likely a sandbox validator quirk, but the same validator fronts the live host, so it is not
settled. **Settle it for free on the sandbox first**: post the same task three ways — our exact
shape, our shape with `location_code: 2840`, and our shape with `language_name: "English"` in
place of `language_code`. If only the third returns `20100`, it is a sandbox quirk. One live call
at depth 10 (~$0.0006) settles it definitively.

---

## 1. State of play

Two providers registered against one engine. One works and has run live. One is fully built,
fully tested, and has never successfully collected a row.

### Ubersuggest — live and collecting

| | |
|---|---|
| Auth | MCP over OAuth 2.1 + PKCE |
| Cost model | Plan quota, no money |
| Phases built | 7 |
| Account | 1 active, tier3, connected 2026-08-26 |
| Projects | 29 mirrored, 14 bound to groups |
| Snapshots | 111 rows, periodKeys 2026-08-26 → 2026-09-02 |
| Kinds present | positions 23 · site_audit 19 · backlinks 18 · domain_overview 18 · keyword_metrics 15 `ok` + 18 `partial` |
| Last sync | 2026-09-02 20:17Z — ok 3, failed 0, skipped 71, quota fine |
| Field mappings | 3 |
| Goal links | **0** |

### DataForSEO — blocked

| | |
|---|---|
| Auth | REST over HTTP Basic (API key) |
| Cost model | Pay per posted task |
| Phases built | 12 (0–11) |
| Origin | **sandbox** (`DATAFORSEO_API_ORIGIN` unset) |
| Account | 1 active, connected 2026-08-31 |
| Sites | 1 authored: `davnoot.com`, 105 keywords, 1 target `2124|en|desktop` |
| Boards | 2 enabled, both `kinds: []` and `enabledScreens: []` |
| Snapshots | **0** |
| Tasks | 1 row, `state: failed`, all 4 items `40501` |
| Spend | $0.00 — estimate $0.024 reserved then released |
| Last sync | 2026-09-02 20:17Z — queued 12, skipped 1 |

The 12 queued and 1 skipped decompose exactly: 13 catalog kinds, minus `business_profile`
(gated on `businessName`, which is `''`), each with one variant, all returning `pending`.

### The single most important thing about each

**Ubersuggest:** per-keyword rank history does not exist in its API. `project_position_info`
returns only `old_position`/`new_position` per keyword — two points. The only series is
`average_positions.positions`, which is the project-aggregate mean and counts non-ranking
keywords as +100, so it must never be recomputed from stored ranks. **Our `ConnectorSnapshot`
rows are the history.** Storage is a requirement, not a cache, and it cannot be backfilled.
Ubersuggest also retains only 3 years, starts history at each keyword's add date, and
permanently loses data after 30 days of account inactivity.

**DataForSEO:** it bills at POST while the runner re-enters every hour. The entire `DfsTask`
design — claim, reserve, post, settle — exists to stop that hourly re-entry from buying the
same batch 168 times a week. The claim is a partial unique index; §0 is the story of a *second*
index on the same collection now refusing that claim outright.

### What has never happened on either provider

There are **zero `GoalConnectorLink` rows** in the database. The writeback engine, its ownership
rule, the provenance sidecar, accept, bulk linking and carry-forward of links are all built and
covered by ~150 fixture tests, but **no connector has ever written a value into a real goal
cell**. Every Actual on screen today was typed by a person. This is the largest
untested-in-production surface in the feature.

---

## 2. The generic engine

Eleven files under `services/connectors/` that name no provider, plus the models and routes they
share. Two tests enforce the silence: the string `ubersuggest` may not appear in non-comment
lines of the generic files, and nothing outside the provider directory may `require` it. The
registry is the single exemption.

### 2.1 The descriptor contract

A provider is one object in the `REGISTRY` in `services/connectors/index.js`, keyed by a name
from `utils/connectorProviders.js`. `validateDescriptor` runs at boot and enforces only a few
things; everything else is read defensively, so a descriptor that omits a hook simply does less.

| Hook | Required | What it decides | Ubersuggest | DataForSEO |
|---|---|---|---|---|
| `oauth.buildAuthorizeUrl` | XOR | Browser-consent mode | yes | — |
| `apiKey {label, fields[]}` | XOR | Paste-a-credential mode; ≥1 `secret` field | — | yes |
| `refreshTokens` | with `apiKey` | Must throw `needsReauth` so a 401 drives the account dead | via oauth | yes |
| `kinds` / `resolveKinds` | optional | What can be collected; empty selection means everything | 5 | 13 |
| `fetch(kind, ctx)` | optional | Returns `ok` / `partial` / `pending` | yes | yes |
| `fields` / `readField` | optional | The mappable catalog; pure readers | 26 | 146 |
| `screens` / `screenGroups` / `resolveScreens` | optional | **Presence routes the board to the SEO tab** instead of the generic tab | — | 14 |
| `variantsFor` / `sameVariant` | optional | Variant fan-out; which rows are comparable | fan-out only | both |
| `projectAuthoring.readForm` | optional | Projects are authored here rather than mirrored | — | yes |
| `collectReady` / `reconcile` / `queuedCount` | optional | Async collection and reservation repair | — | yes |
| `comparability` / `alerts` / `describeUsage` | optional | Delta guards, alert rules, the money screen | — | yes |
| `metered` / `forceRefetchIsFree` | optional | Cap field in settings; whether plain Refresh re-buys | false / **true** | **true** / false |
| `actions` | optional | Manual buttons | `audit` | — |
| `verifyCredentials` | optional | Pre-store credential check | — | yes |

Notes:

- `validateDescriptor` **does not** check `oauth.createPkcePair`, `createState` or
  `exchangeCode`, all of which `startAuthorization` / `handleCallback` actually call. The
  unregistered ads sketch passes validation without the first two.
- A boot failure only logs. `checkRegistry` and `connectorCrypto.checkConfigured` warn and never
  exit (`server/server.js:47-62`).
- `listConnectors` hand-copies every catalog field and drops every function by construction, so
  no executable and no secret can reach the client.

### 2.2 Credentials

`utils/connectorCrypto.js` seals with AES-256-GCM into
`v1:<keyId>:<iv>:<tag>:<ciphertext>` (base64url), binding `orgId|provider` as additional
authenticated data. Keyring is `{1: 'CONNECTOR_MASTER_KEY_V1'}`; rotation is documented but not
built; `open` throws rather than returning null.

**It is deliberately NOT the zero-knowledge Vault.** The key lives server-side because an
unattended sync has no browser and no passphrase. Both files carry comments saying so. If
someone "fixes" connectors to match the Vault, every scheduled sync stops.

`services/connectors/session.js` is the **only** file that selects `+sealedTokens`. It exposes:

- `getAccessToken()` — one bearer string. One production caller today (`ubersuggest/mcpClient.js:252`).
- `getCredentials()` — a shallow **copy** of the whole bag, for HTTP Basic. The copy is enforced by test.
- `refresh` — reactive; re-seals a rotated refresh token; a keyed provider's `refreshTokens`
  throws straight to `needs_reauth` through the same catch, with no provider branch.
- `recordIdentity` / `recordQuota` / `getQuota` — display and estimation only, never a gate.
- `getMonthlyCapUsd()` — the one accessor that actually gates anything. Null/undefined/≤0 all
  collapse to null, meaning unbounded.

Two mutually-refusing endpoints create accounts, both on `org.manage_settings`:
`POST /orgs/:orgId/connectors/:provider/authorize` (400 `REQUIRES_CREDENTIALS` without `oauth`)
and `POST .../credentials` (400 `REQUIRES_BROWSER_CONSENT` without `apiKey`).
`readCredentialForm` builds the sealed object from the descriptor's declared fields, never from
the request: extra keys dropped, every declared field required, trimmed, capped at 500 chars. A
`verifyCredentials` **refusal** blocks storage with 400 `CREDENTIALS_REJECTED`; a **transport
failure** is logged and allowed through. Nothing from the check is persisted or returned.

### 2.3 Collections

| Model | Identity | Load-bearing rule |
|---|---|---|
| `ConnectorAccount` | org + provider + label (partial unique, excludes revoked) | Plural pool. Disconnect is a **soft delete**: `status:'revoked'` plus `$unset sealedTokens`, because snapshots, project bindings and mappings reference the id. `monthlyCapUsd` default null = **no ceiling**. |
| `ConnectorAuthAttempt` | `state` unique, 15-min TTL | Holds the PKCE verifier. Consumed by `findOneAndDelete`, so a replay or double-click cannot create two accounts. |
| `BoardConnector` | board + provider (unique) | `kinds` = what the board **pays** to collect, **unioned** across every board mapping the project. `enabledScreens` = what it **renders**, free and local. `intervalHours` resolves as the **MIN** across boards. `alertState` is the dedupe claim. `perRefreshUsd` deliberately never shipped. |
| `ConnectorProject` | account + externalId; one per (provider, group) | Mirrored half (name, domain, keywordCount, locations, `raw`) vs authored half (`trackedKeywords`, `targets`, `competitors`, `businessName`, `locallyAuthored`). A project that vanishes at the provider is flagged `missing`, **never deleted** — it parents the only rank history that exists. |
| `ConnectorSnapshot` | project + kind + variant + periodKey (unique) | Status enum is exactly `['ok','partial']`. There is deliberately **no `failed` status**: a failure would claim today's periodKey and the unique index would block the real reading. Failures live on `ConnectorAccount.lastSyncReport`. A `partial` can never overwrite an `ok` row for the same period (the write filter narrows with `status: {$ne:'ok'}`). |
| `ConnectorBudget` | org + provider + scope + scopeId + month | Reserve is **two steps**: an existence upsert with no cap logic, then a guarded `$expr` update with **no upsert**, because the one-liner with `upsert:true` fails open. Settle and release are unguarded — overshoot is recorded, not prevented. `reservedUsd` is a recomputable cache. |
| `ConnectorFieldMapping` | board + provider + sourceField | Targets `goalColumns[]._id`, **never the key slug** — one SEO board misspells the difficulty key as `keyword_difficultly`. Two partial-unique indexes give one source per target, scoped to the **board**, across all providers. |
| `GoalConnectorLink` | goal (unique) | Provenance is a **sidecar**: `applied[field]` / `suggested[field]`. Wrapping the cell value was rejected because ~8 readers of `Goal.actual` / `columnValues` would have had to tolerate two shapes forever. `connectorLeak.test.js` asserts the shape has not moved. |
| `DfsTask` | project + kind + variant where `state:'open'` (partial unique) | The money ledger and the only real concurrency control. Its key **deliberately carries no date**. `state` (work) and `budgetState` (money) are orthogonal — `reserving` is a *budgetState* so the claim stays under the partial index. |
| `DfsSerpResult` | project + kind + variant + periodKey + keyword | The bulky SERP bodies, trimmed to render depth 20, measured with `Buffer.byteLength` against a 4 MB ceiling, 90-day TTL (`expiresAt` null = pinned). The aggregate lives on the snapshot forever. |
| `DfsSerpCache` | cacheKey + periodKey | The only connector collection with **no `organisation` field**; refcounted by an `orgs[]` set the org cascade `$pull`s. 48-hour TTL. Off by default. |
| `DfsCacheProbe` | project + kind + variant + UTC day | Measures would-be cache hits on every SERP purchase **regardless of whether the cache is on**. 400-day retention. |

### 2.4 Snapshots and freshness

`snapshotService.js` is the plan/fetch/write engine and names no provider.

- `planProjectWork` is **pure**. It decides per (kind, variant) whether to fetch, skips a kind
  whose `requires` field the project lacks, records dropped variants as a skip reason rather than
  swallowing them, and passes `existing` + `force` to the fetcher so a per-call-billed provider
  can refuse a re-buy without a second query.
- `isFresh` returns false for a missing row, for **any status other than `ok`** (so a partial is
  never fresh), and for age past `kind.intervalHours ?? board-min ?? descriptor.syncIntervalHours ?? 168`.
- `writeSnapshot` returns `{written:false, periodKey:null, pending:true}` for a `pending` result
  **before any period is computed**. `pending` is deliberately not a status enum value.
- `periodKey` is `YYYY-MM-DD` in UTC, taken from the provider's own `collectedAt` where it gives
  one, so two polls in a week collapse to one point.
- `syncProject` rethrows only `quotaExhausted` and `needsReauth`; every other fetch error
  increments `failed` and continues. `syncAccount` breaks the account loop on those two and
  persists `lastSyncReport {at, ok, failed, skipped, queued, error, quotaExhausted}`.
- `scheduleForProvider` is driven by enabled `BoardConnector` rows, unions kinds across boards
  sharing a project (empty on **either** board means everything), and takes the MIN cadence.

> **Trap.** The `requires` gate checks truthiness, and an empty array is truthy.
> `requires:'trackedKeywords'` and `requires:'competitors'` therefore never protect against an
> empty list; the fetchers check length themselves. `requires:'businessName'` is the only gate
> that actually works, because an empty string is falsy.

### 2.5 The three clocks

| Runner | Cron | Can spend | What it does |
|---|---|---|---|
| `connectorSyncRunner` | `17 * * * *` | **Yes** | The only buyer. Ticks hourly, works weekly: freshness is decided per (project, kind), so 167 ticks in 168 do nothing. A weekly cron would silently skip a whole week whenever Render restarted through its window. Always `force:false`, never `includeManualOnly`, so it never starts a Ubersuggest crawl. |
| `connectorCollectRunner` | `*/10 * * * *` | No | Calls the optional `collectReady` hook, which only DataForSEO declares. Wrapped in a transport allowlisting free endpoints, so it **cannot buy by construction**. |
| `seoAlertRunner` | `30 * * * *` | No | Pairs the newest two `ok` snapshots per (kind, variant), evaluates the descriptor's rules, and claims `BoardConnector.alertState` **atomically before fanning out**, so a rank drop notifies once, not hourly for a week. |

Boot order in `server/server.js`: connectDB → eventBus → dispatchers → automation/goal/digest
runners → `reportConnectorReadiness` (warn-only) → sync → collect → alert → mail poller → listen.

**There is no weekly cron and no 04:00 run.** That vocabulary survives only in comments inherited
from the original design plan.

### 2.6 Field mapping

`fieldMapping.js` is the generic half.

- `GOAL_BUILTINS` — exactly four: `actual` (number, `goal.track`, latest), `actualDayKey` (date,
  `goal.track`, latest), `config.baseline` (number, `goal.manage`, **monthStart**),
  `config.target` (number, `goal.manage`, latest). Only `config.baseline` reads monthStart —
  without it a rank goal would score itself against itself.
- `SOURCE_TYPES` is derived from the accepts table: `number | text | date | link`. Widening is
  allowed (number → text); narrowing is not; `dropdown` and `person` accept **nothing**. There is
  no boolean type, which is why DataForSEO's eleven crawl booleans and `ssl.valid` are
  deliberately unmappable.
- `checkCompatibility` is the **only** implementation of the rule. The GET endpoint ships
  `fields[i].refusals = { [targetId]: sentence }` (absence = allowed) and the panel looks a
  sentence up. The client never re-derives type rules.
- **Refusal happens at save time with a sentence naming both sides.** An incompatible mapping
  breaks nothing on save and everything at 3am, where the symptom — a cell that never fills — is
  indistinguishable from "the sync has not run yet".
- Mapping is `connector.manage`, not `goal.manage`, because it writes nothing to a goal. The
  capability a target *implies* rides on the target and is enforced at write time.
- A goal-column **purge** deletes the mapping; **archiving** does not.

### 2.7 Goal writeback

`connectorGoalWriteback.js` is the generic engine; `planGoalWrites` is pure and is where the rule
lives.

**The ownership rule.** The first run after linking **claims** — it writes regardless, because
every existing row was typed by hand and a pure never-overwrite rule would fill nothing. After
that it writes only if the cell is empty or still equals `applied[field].value`; otherwise it
records `suggested[field]` with reason `humanEdited` and the row offers it. `claimedAt` is
stamped **once** and is deliberately absent from `upsertLink`'s `$set`, from
`acceptGoalSuggestions`, and from carry-forward — so re-linking can never re-claim a cell a
person corrected.

Other rules:

- **A null is never written.** "Not in top 100" and "no reading" both become a note on the link,
  because an empty goal cell already means "not reported" and writing one would clobber a real
  number during a claim. `0` and `false` are real values.
- **Period lives on the target.** `config.baseline` reads the last snapshot at or before the 1st
  of the month; everything else the newest inside the month.
- **An unattended run fills the result half only.** `actor: null` ⇒ `goal.track` targets only, so
  `config.baseline` / `config.target` become suggestions. A person pressing **Fill goals now**
  runs as themselves and can land those if they hold `goal.manage`.
- **Variants are resolved by the descriptor.** `selectSnapshots` asks the optional
  `sameVariant(kind, rowVariant, selected)` hook and keeps the old literal `positions`-only rule
  only as a fallback for a descriptor that declares none.
- **The comparability guard blanks only the starting point.** On refusal the baseline is skipped
  with a note and the result still writes.
- The project is **re-resolved from the group on every run**, never trusted from the link.
- Writes bypass `PUT /api/goals/:id` deliberately (that handler validates a human payload and
  would refuse on unrelated required columns). The scheduled path logs to the shared `ActivityLog`
  with `actorType: 'system'`; a manual run logs as the user.
- The writeback contacts **no provider**. It reads stored snapshots, which is why it is free and
  runs behind every collection.

**Five paths now trigger it:** the hourly runner, the ten-minute DataForSEO collection pass, the
manual Refresh (with the caller as principal), the writeback endpoint, and `GoalBulkLinkModal`
immediately after a bulk link.

> **Gap found:** `acceptGoalSuggestions` writes goal values via `applyWrite` but never calls
> `snapshotGoal` / `logGoalChanges`, so an accepted suggestion leaves **no ActivityLog row**,
> unlike `updateGoal` and the writeback itself.

### 2.8 Bulk linking — the split is the safety property

- `GET /boards/:id/goal-links/matches` proposes a keyword per goal and **can write nothing**.
- `POST /boards/:id/connectors/:provider/goal-links/bulk` writes an **explicit list of pairs** and
  **does no matching**.

Neither can become a fuzzy match on its own, because the person in between is not optional.
`matchKey` is lowercase plus collapsed whitespace and **nothing else** — no stemming, no plural
folding ("thca quarter pound" and "thca quarter pounds" rank differently). A goal matching two
tracked keywords comes back `ambiguous`, never resolved. The value stored is always the
provider's own spelling. `upsertLink` is the single writer of a link, so the bulk path cannot
drift from the single path. Capped at 300 pairs.

### 2.9 Endpoints

| Route | Capability | Contacts provider | Spends |
|---|---|---|---|
| `GET /connectors/callback` | public (single-use state) | yes | no |
| `POST /connectors/dataforseo/pingback/:token` | public | no | no (501) |
| `GET /connectors` | member | no | no |
| `GET /orgs/:id/connectors` | member | no | no |
| `POST /orgs/:id/connectors/:p/authorize` | `org.manage_settings` | no | no |
| `POST /orgs/:id/connectors/:p/credentials` | `org.manage_settings` | optional verify | no |
| `PATCH /connectors/:accountId/budget` | `org.manage_settings` | no | no |
| `DELETE /connectors/:accountId` | `org.manage_settings` | no | no |
| `GET / PUT /boards/:id/connectors[/:p]` | `connector.view` / `.manage` | no | no |
| `GET /boards/:id/connectors/:p/projects` | `connector.view` | no | no |
| `POST .../projects/refresh` | `connector.manage` | **yes** | quota |
| `PUT .../projects/:projectId` | `connector.manage` | no | no |
| `POST / PUT .../sites[/:id]` | `connector.manage` | no | sets the bill size |
| `GET .../data` | `connector.view` | **never** | no |
| `GET .../usage` | `connector.view` (org cap withheld below `.manage`) | **never** | no |
| `POST .../refresh` | `connector.manage`, 5/hour | yes | **real money** |
| `POST .../projects/:id/actions/:action` | `connector.manage` | yes | quota |
| `GET / PUT / DELETE .../fields[/:field]` | `connector.view` / `.manage` | no | no |
| `GET /boards/:id/goal-links[/matches]` | `connector.view` / `.manage` | no | no |
| `POST .../goal-links/bulk`, `POST .../writeback` | `connector.manage` | no | no |
| `PUT / DELETE /goals/:id/connector-link` | `connector.manage` | no | no |
| `POST /goals/:id/connector-link/accept` | `goal.track`, then per field | no | no |

**Mount order matters.** The router is mounted bare at `/api` and **before** every other bare
router, because the OAuth callback and the pingback are public and the other routers apply
`authMiddleware` to every `/api/*` path they see.

The board plane gates in order: board context → capability → `boardType === 'tracker'`. A
non-tracker board gets **404 `NOT_TRACKER_BOARD`**, not 403.

`connector.view` sits on the board *view* rung and `connector.manage` on *edit*. Guests
deliberately hold neither, because the board endpoint lists every workspace account by label.
Connecting an account is org-scoped `org.manage_settings`, not a connector capability.

> **Worth knowing:** both `refreshBoardConnectorProjects` and `refreshConnectorData` upsert
> `BoardConnector` with `$setOnInsert {enabled:true}` — a refresh on a board that never enabled
> the connector silently enables it.

### 2.10 Cascades

Deleting a **group** or a **board** only *unbinds* `ConnectorProject` (group, board, boundBy,
boundAt set null) and deletes that board's `BoardConnector`, field mappings and goal links.

Only the **org** cascade deletes connector data, children first:
`ConnectorSnapshot` → `DfsSerpResult` → `DfsTask` → `DfsCacheProbe` → `DfsSerpCache`
(`$pull orgs`, then delete rows with an empty `orgs`) → `ConnectorBudget` → `ConnectorProject` →
`ConnectorAccount` → `ConnectorAuthAttempt` → `BoardConnector` → `ConnectorFieldMapping` →
`GoalConnectorLink`. No transaction.

---

## 3. Ubersuggest

Nine files, one descriptor, an official MCP server launched 2026-07-17 at
`https://ubersuggest-mcp.neilpatelapi.com/mcp`. Canonical docs are `${MCP_ORIGIN}/llms.md`, **not**
the launch blog (which says 37 tools and "read-only"; the manifest has gone 37 → 42 → 46 and
three tools write) and **not** Zendesk (which still says Ubersuggest has no API).

### 3.1 Auth

OAuth 2.1 with PKCE against a public client (`client_id: ubersuggest-mcp`, no secret,
`token_endpoint_auth_methods_supported: ['none']`). The token request includes
`resource=MCP_ENDPOINT` (RFC 8707). **There is no `client_credentials` grant**, so an account
cannot be onboarded headlessly: one interactive browser consent, then the refresh token sustains
unattended operation. Discovery results — including the fallback endpoints after a failed
discovery — are cached for the process lifetime and never re-fetched.

Token normalisation keeps the previous refresh token when the response omits one, stores the
granted scope string, and leaves `expiresAt` null when `expires_in` is absent (a null expiry is
treated as fresh). `refreshTokens` sets `needsReauth` on `invalid_grant` or HTTP 400.

> **Do not "simplify" `buildAuthorizeUrl`.** It returns
> `https://app.neilpatel.com/en/login?next=<authorize url>` rather than the authorize URL itself,
> because a logged-out browser hitting `/authorize` is bounced into a nested `next=` parameter
> that re-encodes geometrically and hits CloudFront's 414 after four bounces. **The bug only
> reproduces logged out.**

No `process.env` is read anywhere inside the provider directory.

### 3.2 Transport and error classification

`mcpClient.js` is hand-rolled, **not** `@modelcontextprotocol/sdk`, because the server is
stateless, `GET /mcp` is 405, and there is no session id. It speaks protocol `2025-06-18`,
refreshes exactly once on a 401 then throws `needsReauth` (never loop a revoked account), retries
retryable failures at 600 ms then 2000 ms, treats HTTP ≥500 and network errors as retryable, and
treats JSON-RPC errors as fatal unless the message mentions `initializ`.

**Quota exhaustion arrives as HTTP 200 with `isError: true`** — never a 429, no `Retry-After`, no
published rate limits. It can only be detected by string-matching the body.

| Flag | Matches | Blast radius |
|---|---|---|
| `quotaExhausted` | `limit reached`, `quota`, `\b429\b`, `too many requests` | **Whole account** — `syncAccount` breaks its project loop |
| `forbidden` | bare 403 | **One call** |
| `retryable` | HTTP ≥500, network errors, "still pending" | Retried twice |
| `needsReauth` | 401 after one refresh | **Whole account** |

`classifyToolError` checks quota → forbidden → retryable → fatal, in that order.

> **The `forbidden` class exists because of a real outage.** `traffic_value` answers 403 on every
> call for this tier3 plan; `QUOTA_ERROR_PATTERNS` contained `\b403\b`; so one unavailable
> *secondary* tool killed `domain_overview`, `backlinks`, and every project after the first.
> **Never put a bare status code back in the quota list.**

An HTTP-level 429 (as opposed to tool-result text containing "429") is thrown as an unflagged
error — fatal for the call, not quota — because only tool-result text is classified.

### 3.3 Five kinds

| Kind | MCP tools | Variants | Notes |
|---|---|---|---|
| `positions` | `project_position_info` | up to 4 desktop `(locId, lang)` | The only kind that fans out. **Mobile is never polled.** `collectedAt` comes from the provider's `updated_at`, so two polls in a week collapse to one period. Report window defaults to 30 days. |
| `keyword_metrics` | **none** (`tools: []`) | — | Spends nothing. Derives keyword, volume, difficulty (`sd`) and competition from the positions snapshot. Returns `partial` when no row carries metrics, so the runner retries. `cpc`, `paidDifficulty` and `intent` stay permanently null and must never be fabricated as 0. The old 100-keyword cap is gone. |
| `site_audit` | `site_audit_status` | domain | The scheduled read **never starts a crawl**. Starting one is the `audit` action behind a button (`site_audit` with `recrawl: true`). |
| `domain_overview` | `domain_overview`, `traffic_value` | domain | `traffic_value` is 403 on this plan; `trafficValue` stays null and the card degrades with a note. |
| `backlinks` | `backlinks_overview`, `anchor_texts` | domain | `anchor_texts` intermittently returns `MCP error -32602: Output validation error … at next_key` — their own output schema. Degrades to zero anchors with a note. |

`resolveKinds` treats an empty or all-unknown selection as everything, pulls in one level of
dependencies, and orders by catalog array order rather than topologically — so the
dependency-first guarantee relies on `positions` being listed before `keyword_metrics`.

Fetchers catch failures only on **secondary** calls and rethrow `quotaExhausted`/`needsReauth`
from them; the primary call's error always propagates.

### 3.4 Normalisers

`normalise.js` is pure and never throws.

- `pick` tries literal key spellings in order, then falls back to a **canonical spelling**
  (lowercase, strip `_`, `-`, whitespace) — because undocumented payloads mix casing *inside one
  response*. `backlinks_overview` returns `refDomains`, one capital away from the `refdomains`
  already in the candidate list.
- `pickNum` **steps over a candidate that is not a number**, because `domain_overview` returns
  both an `organicKeywords` sample array and an `organic` count, and the array used to shadow the
  count.
- A `position` of null with status ok means **"not in the top 100"** and is preserved as distinct
  from an absent field. That distinction survives to `utils/connectorFormat.js formatRank`, whose
  three outputs — `#4`, `Not in top 100`, em dash — **must stay three**, or a failed sync becomes
  indistinguishable from an honest "not ranking".
- `normaliseSiteAudit` reads `report.overview.overall_score` (not `health_score`),
  `report.overview.crawled` (not root `crawl_count`), and unwraps each category as
  `{count, issues: []}` by passing `issues` explicitly. Zero-count issues are checks that
  **passed** and are filtered out. All four corrections came from the 2026-08-28 live run.

`projects.js` has its own plain `pick` **without** the canonical-spelling fallback added on
2026-08-28. `ConnectorProject.raw` holds the payload verbatim because the project tools are the
one part of `llms.md` with no response table.

### 3.5 The 26-field catalog

4 keyword + 6 project fields on `positions`; 6 keyword on `keyword_metrics`; 4 on
`domain_overview`; 2 on `backlinks`; 4 on `site_audit`. Each declares `type`, `kind`, `scope` and
a pure `read(data, {keyword})`. `readField` returns null for an unknown key, an undefined value,
or a throwing reader. Only `rank` and `rank_previous` carry `nullMeans` (`NOT_IN_TOP_100`).

> **Dead entries:** `paid_difficulty`, `cpc` and `search_intent` are mappable but can never fill,
> because the fetcher hard-codes them null and the writeback never writes a null. `traffic_value`
> is likewise inert on this plan.

### 3.6 What changed after the 2026-08-28 fix

Only two things: `forceRefetchIsFree: true` added 2026-08-30 (Ubersuggest bills per report
subject per day, so a same-day Refresh re-reads a paid report), and a comment-only edit to
`kinds.js` on 2026-09-01. The provider logic has been stable for a week.

> **Dead code:** `normaliseKeywordMetric` and `normaliseKeywordMetrics` are exported and tested
> but called by nothing since `keyword_metrics` became derived. Their docblocks still describe
> `match_keywords` as the live path.

### 3.7 Quota model

Enterprise/Agency plan: 15 projects, 900 reports/day, 300 tracked keywords per project, 1000
monthly credits. **MCP shares the web-app quota.** Same report subject on the same day is free —
consumed on fetch, never on view, which is why all reads come from Mongo and viewers cost
nothing. `add_project_keywords` is a full-map PUT (an omitted keyword is silent deletion), so the
integration is read-only by design.

---

## 4. DataForSEO

Thirty-four files, thirteen kinds, fourteen screens, 146 mappable fields, four dedicated
collections, twelve phases — landed in a single 57,000-line commit on 2026-08-30 and revised on
2026-09-02. Every line is covered by fixture tests. None of it has ever collected a row.

### 4.1 What makes it different from Ubersuggest

It authenticates with an API key against an engine that assumed OAuth, and it bills per posted
task against a runner that re-enters every hour. Everything else follows.

### 4.2 The credential model changed on 2026-09-02

The design docs describe **one shared account owned by us** with per-org metering. **That is no
longer the arrangement.** Commit `647d49c` moved to **bring your own key**: each workspace pastes
its own DataForSEO login and API password, spends its own funded balance, and sets an optional
`ConnectorAccount.monthlyCapUsd`. The provider's balance is now the hard ceiling; the org budget
scope is only a safety rail against our own bugs.

The same commit **deleted the `DATAFORSEO_LIVE_PROJECTS` allowlist and the $5 default cap**.

> **Consequence nobody has written down.** The two guard rails that made it impossible to spend
> money by accident are both gone. Today, a workspace that pastes a key while
> `DATAFORSEO_API_ORIGIN` points at the live host **will spend**, with no per-project allowlist
> and no default cap. The only brakes left are the account cap (null by default), the per-kind
> `minRebuyHours` floors, and `forceRefetchIsFree: false`.

`DATAFORSEO_MONTHLY_CAP_USD` survives in `constants.js` as a "self-hosted fallback" but is
**dead on the real path**: `scopesFor` only falls back when `capUsd === undefined`, and both
callers pass `session.getMonthlyCapUsd?.()`, which returns null. Only the account field works.

### 4.3 The transport

`client.js` is a hand-rolled HTTP Basic transport.

- **HTTP 200 is never success on its own.** `sendOnce` checks the HTTP status (401/403
  `needsReauth`, 429 and ≥500 retryable), then the envelope `status_code !== 20000`, then **every**
  `tasks[].status_code`; an account-stop code found at task level throws for the whole account.
- `20100` "Task Created" is returned flagged `created` — not ok, not error — because it is
  **already charged**. `40601`/`40602`/`20100` classify as `notReady`; reading them as failure
  would close an open `DfsTask` and cause the next tick to re-buy the batch.
- Status-code fall-through is **asymmetric by design**: any unrecognised code ≥50000 is
  retryable; anything else unrecognised (including non-finite) is fatal.
- Retries only on the `retryable` flag, at 600 ms then 2000 ms (at most three attempts). The pool
  slot is released during backoff because the semaphore wraps one round trip, not the retry loop.
- **Our own cap never throws.** It calls `client.suppressPosting(note)` so free `task_get`
  collection continues for every remaining project in the pass. Only DataForSEO's own
  `40200`/`40203`/`40210` throw `quotaExhausted` and stop the account.
- `pool.js` is a module-level FIFO semaphore at **25** under DataForSEO's ceiling of 30, applied
  by path prefix (`dataforseo_labs/`, `backlinks/`, `on_page/`, `content_analysis/`,
  `domain_analytics/`). `serp/` is excluded; **`business_data/` is not listed**, so the phase-10
  Business Data call bypasses the pool.
- **Origin defaults to the sandbox.** `DATAFORSEO_API_ORIGIN` is accepted only if it is one of
  two known hosts; anything else warns loudly and falls back. Resolved **once at require time**,
  so a change needs a restart.

> **Confirmed defect:** `warmAccountData` is destructured in `createDfsClient` and **never used**,
> despite comments and a test title claiming it eagerly starts the free `user_data` read. So
> `lastSeenQuota.price` is only written via `describeAccount` on a project-list refresh, and
> estimates always fall back to the published constants. Cosmetic — settlement still reads the
> envelope's own cost.

### 4.4 The async design, end to end

`postJob` runs a fixed sequence, and the order **is** the safety property:

1. **Claim first.** Insert `state:'open'`. The partial unique index on `(project, kind, variant)`
   where state is open is the only real concurrency control; the loser of a race gets `E11000` and
   returns pending. The key deliberately carries **no date**, so a job posted at 23:50 UTC does not
   repost at 00:17.
2. **Reserve second**, against the estimate, after the claim exists.
3. **Write `budgetDocs` before the counters move**, because `reservedUsd` is defined as the sum
   over tasks naming a document — a crash in between would leave a counter nothing can trace.
4. **Post in batches of 100** (`MAX_TASKS_PER_POST`), pushing items and incrementing `costUsd`
   after **each** HTTP call. A 200-keyword site is two posts, and if the second throws, the first's
   ids are already money spent.
5. **Settle** from the envelope's own `cost`, never from the estimate. Settlement is deliberately
   **unguarded** — overshoot is recorded, not prevented.

A cap refusal returns `capped: true` and **releases the claim** (`state:'failed'`,
`budgetState:'released'`) so an open row for a purchase that never happened does not suppress the
site for 12 hours.

`reconcileReservations` sweeps up to 500 rows in `budgetState:'reserving'` older than 10 minutes:
`costUsd === 0` → release and mark failed; `costUsd > 0` → settle and leave the row open. Every
touched scope is recomputed. It never throws, and runs once per account per pass for both
transports.

**Collection is polling, not webhooks.** Every ten minutes `collectAllReady`:

- Wraps the client in `collectOnlyClient`, an **allowlist enforced at the transport**
  (`task_get`, `tasks_ready`, `errors`, `user_data`, `on_page/summary`, `on_page/pages`,
  `labs/status`, `backlinks/index`). It has no import path to `postJob`.
- Sweeps `tasks_ready` — a **destructive read**, so announced ids are persisted to
  `items[].readyAt` in one unordered bulkWrite, **including unmatched ghost ids**, *before* any
  `task_get`. A sweep failure returns null, meaning "poll everything".
- `isPollable` admits a `task_get` four ways: no announcement channel, `readyAt` already
  persisted, announced this pass, or the 2-hour grace expired.
- `sweepErrors` posts `serp/errors` solely to make failed ids pollable, never to decide the answer.
- Stores SERP bodies **before** closing the job, derives `periodKey` from `collectedAt`, and files
  the aggregate through the generic `writeSnapshot`.

`pingback.js` answers **501 by design**. `task_get` is free so a webhook saves nothing, and
DataForSEO neither signs nor retries its callbacks — a trustworthy receiver would have to call
`task_get` anyway. The route reserves both its mount position (above auth) and its shape (a token
in the **path**, never an HMAC over the body, so `app.js` body parsing stays untouched).

Expiry: `TASK_EXPIRY_HOURS` 12 × 3 attempts = 36 h worst case, inside the 3-day `tasks_ready`
retention. OnPage uses 36 h expiry.

### 4.5 Thirteen kinds

| Kind | Transport · family | Scope | Interval | Rebuy floor | Notes |
|---|---|---|---|---|---|
| `positions` | task · serp | target | 168 h | 144 h | Depth 100 census |
| `movement` | task · serp | target | 24 h | 20 h | Depth 10. **Deliberately no `dependsOn`**, because `syncProject` skips a dependant whose dependency produced nothing, and positions produces nothing six days a week |
| `keyword_metrics` | live · labs | market | 720 h | 600 h | Enrichment, not discovery |
| `competitors` | live · labs | market | 168 h | 144 h | Shared and full-domain metrics kept apart |
| `keyword_gap` | live · labs | market | 168 h | 144 h | **Directional**: competitor is `target1`, we are `target2`; swapping silently returns the opposite report. `intersections: false`, max 3 competitors |
| `top_pages` | live · labs | market | 168 h | 144 h | |
| `backlinks_summary` | live · backlinks | domain | 168 h | 144 h | Two summary calls — dofollow comes from a filtered second call |
| `backlinks_timeseries` | live · backlinks | domain | 168 h | 144 h | |
| `referring_domains` | live · backlinks | domain | 168 h | 144 h | Every row stamped with a toxicity verdict server-side |
| `anchors` | live · backlinks | domain | 168 h | 144 h | |
| `referring_networks` | live · backlinks | domain | 168 h | 144 h | Subnet census; never feeds the disavow file |
| `business_profile` | live · business | market | 168 h | 144 h | `requires: 'businessName'`, never defaults to the domain. Not in the concurrency pool |
| `site_audit` | task · onpage | domain | 720 h | 600 h | The hourly pass **does** buy crawls automatically, unlike Ubersuggest |

`resolveKinds([])` means **everything**, and an empty list on *either* board mapping a project
sets that for the project. Both live boards are currently `[]`.

Every kind carries `minRebuyHours` deliberately below its cadence, because `intervalHours`
resolves as a MIN across boards. `rebuyGuard` refuses while
`now - (existing.fetchedAt || updatedAt) < minRebuyHours`.

`fetchKind` dispatches on `kind.family` through two separate tables (`TASK_RUNNERS`,
`LIVE_RUNNERS`); an unknown family **throws** rather than defaulting. The buy branch orders its
guards: rebuy floor → posting-suppressed → dead-hash refusal → SERP cache → attempt cap → post.

### 4.6 Cost rules that are enforced, not documented

- **Search operators are refused, not warned about.** Each multiplies the SERP price by five and
  they stack. The detector flags 31 colon-prefix operators, quotes, `*`, parentheses, `|`,
  uppercase OR/AND, leading `-`/`+`/`~` and numeric ranges, and runs server-side in both the site
  form and the Labs keyword builder.
- **`enable_browser_rendering` throws**, never silently strips. 34× base: $0.15 → $5.10 per
  1,000-page crawl.
- **`include_clickstream_data` throws** unless the kind opts in. It silently doubles the request
  cost. No shipped kind opts in.
- **OnPage multipliers take the largest, never the product** (34× rendering, 10× JS, 3×
  resources, 2× keyword density). The crawl reserves against the 1,000-page ceiling ($0.15) and
  settles on pages actually crawled.
- **Estimates are never a gate.** Unit prices come from the account's own price book walked by
  endpoint path, with published constants as fallback (SERP $0.0006/unit; Labs $0.012 + $0.00012/row;
  Backlinks $0.024 + $0.000036/row; OnPage $0.00015/page; Business $0.0054). `readLeaf` takes the
  **minimum** positive number in a SERP subtree, but Labs task/item prices are read from explicit
  key lists because min-of-subtree would return the per-item figure as the request price.
- Site caps are cost ceilings, not API ceilings: 200 tracked keywords, 200-char keyword, 4
  targets, 10 competitors, desktop/mobile only.

### 4.7 Semantic traps the code stops

- **Backlink rank is 0–1000**, DataForSEO's own PageRank-derived metric with damping 0.5.
  DataForSEO explicitly says it should not be expected to match Ahrefs DR. **It must never be
  labelled DA or DR.** The client renders it through a dedicated `formatDomainRank`, never
  `formatRank`, which would print "Not in top 100" for a missing reading. `referring_domains[].rank`
  is carried as `linksRank`; authority comes only from `bulk_ranks`.
- **`*_nofollow` is not the dofollow complement**, so dofollow is never computed by subtraction
  anywhere — server or client. It is a second filtered call or it is null.
- **Ten OnPage counters count pages that PASS** (canonical, is_https, has_html_doctype,
  has_meta_title, meta_charset_consistency, seo_friendly_url and its four sub-checks).
  `issueCountFor` is the only function that inverts them, returns null when the denominator is
  missing, and clamps at 0. `onpage_score` is carried verbatim and never recomputed.
- **There is no INP and no CrUX field data anywhere in the API.** Core Web Vitals are lab-only,
  FID is carried as `retired: true`, CLS is read from `meta.cumulative_layout_shift` while LCP/FID
  come from `page_timing`, and with rendering off all three are null with an explicit
  "not measured" state rather than 0.
- **Cited and mentioned are never blended** into one AI-visibility number: two tiles, two columns,
  two export columns, different denominators (`presenceRate` over all tracked keywords;
  `citedRate`/`mentionedRate` over keywords *with* an overview).
- `parseDfsTime` **throws** on an unparseable or missing timestamp, because V8's legacy parser
  would treat an offset-less stamp as server-local time and collide the snapshot with the previous
  day on Asia/Kolkata.
- `normaliseSerpResult` **throws the SERP items away on purpose** — depth-100 bodies for 200
  keywords would be 20–40 MB, over Mongo's 16 MB ceiling. The snapshot keeps ~80 bytes per keyword.

### 4.8 Comparability

`comparability(kind, current, previous)` refuses a subtraction when the two readings are not the
same measurement:

| Kinds | Refuses when |
|---|---|
| `positions`, `movement` | depths differ |
| the five backlinks kinds | `statusType` or `rankScale` differ |
| `site_audit` | `configHash` differs, either crawl's `stopReason !== 'finished'`, or `pagesCrawled` drifted >20% |
| `business_profile` | `cid` differs (when both present), or either `found === false` |
| Labs and unknown | always OK |

The writeback consults it **only for the baseline** write and still lands the result, recording
the refusal as a note. The alert rules ask it before every subtraction. The rule is deliberately
duplicated client-side in four row utilities (`aiRows`, `auditRows`, `backlinkRows`, `localRows`)
with the same named threshold — five implementations in all.

### 4.9 Site audit

One kind. `onpage.js` supplies a plan to `postJob` (one `on_page/task_post`), then polls
`on_page/summary/{id}` **for free** until `crawl_progress === 'finished'`, only then reads the 100
worst pages from `on_page/pages` (best effort, wrapped in try/catch so the paid summary is never
lost). Dates the reading from `domain_info.crawl_end`. A crawl whose `crawl_stop_reason` is set and
not `finished` is stored **`partial`**, so the controller never uses it as a baseline.

The frozen crawl config keeps all four paid flags false. The catalog (`onpageChecks.js`) has 12
errors (weights summing 78), 22 warnings (123) and 22 weight-0 notices; eleven weights are
DataForSEO's own, the rest are ours and are used **only** for ordering by weight × share.

**There is no Lighthouse code anywhere in the repo** — it exists only as a v2 plan in the research
doc.

### 4.10 Alerts

Exactly two rules, declared as data:

| Rule | Type | Fires when | Reads |
|---|---|---|---|
| `rank_drop` | `seoRankDrop` | previous rank ≤20 **and** ≥5 places worse, or left the bought depth | `positions` before `movement`, never both |
| `lost_backlinks` | `seoLostBacklinks` | referring domains down ≥5% **and** ≥5 domains | `backlinks_summary` |

Thresholds are conjunctive. Every rule asks `comparability` first. `evaluateAll` emits a row for
every rule even when nothing is collected, and is consumed identically by `seoAlertRunner` (for
notifications) and `connectorDataController` (for the Alerts screen).

Alerts needed **four** registrations — the Notification enum, `TYPE_CATEGORY`,
`NotificationPreference.categories.seo`, and `notificationController.PREFERENCE_CATEGORIES`. The
fourth was missing `goals` all along, meaning the goals preference switch was silently discarded
on save until phase 10 fixed it.

### 4.11 The cross-tenant SERP cache

Built, measured, and shipped **default-off** behind `DATAFORSEO_SERP_CACHE_ORGS` (empty means
nobody).

- Keyed on a sha256 of `[endpoint, depth, locationCode, languageCode, device, keyword]` —
  deliberately **not** `DfsTask.requestHash`, which covers the domain and the whole keyword list
  and would guarantee a zero hit rate.
- Only `positions` and `movement` are cacheable (`family === 'serp' && transport === 'task'`).
- Serving is **all-or-nothing** and same-UTC-day only, with **no pre-post claim** (in-flight
  identical tasks miss and buy).
- `force` bypasses it entirely, which closes the timing side-channel.
- Nothing is labelled per keyword as cache-served; a test greps for `/cache/i` to enforce that.
- A cache-served collection writes a zero-cost `DfsTask` row (`source:'cache'`, `state:'done'`)
  counted apart from spend.
- **Off is byte-identical**, proved by a test that makes every cache method throw through a full
  buy → poll → collect cycle.

Independently, `DfsCacheProbe` measures would-be hits on **every** SERP purchase whether or not
the cache is on. The threshold is derived, not chosen: a kind clears at a 20% servable rate over
28 days after 1,000 observed units. Every kind currently reads `insufficient` by construction,
because exactly one probe row exists.

> One reading worth confirming: `probe()` excludes only the asking **project**, not the asking
> **org**, so a second site in the same workspace counts as a hit and `otherOrgs` may include the
> asker's own org.

---

## 5. Client surfaces

Two planes, two tabs, one rule that holds everywhere: **nothing contacts a provider on render.**

### 5.1 Which tab a provider gets

`BoardDetailPage` splits enabled connectors **by capability, not by name**: a provider declaring
`availableScreens` gets the SEO dashboard, one declaring none gets the generic per-kind Data tab.
This ended the old `enabledConnectors[0]` limitation where a board with two connectors showed only
the first. The `[0]` residue survives deliberately *within* each group; a picker inside the tab is
the future fix.

| Surface | Path | Gate | What it does |
|---|---|---|---|
| Settings → Connectors | `components/settings/ConnectorsTab.jsx` | `org.manage_settings` | The account pool. Renders the connect dialog entirely from the catalog: `requiresBrowserConsent` picks OAuth redirect vs credential form, `credentialForm` **is** the form, `metered` shows a cap field. Names no provider. Credential inputs are masked but **not** `type=password`, so Chrome never offers to save a workspace credential. |
| Board → Add-ons | `board/addons/AddonsTab.jsx` | `connector.view` / `.manage` | Enablement, per-group project mapping, site authoring, field mapping, screens, cadence, allocation. Also hosts the non-connector Ads Budget and Goal Vocabulary cards. |
| Board → Data | `board/addons/connector/` | `connector.view` | The generic tab. Rail derived client-side from the kind catalog. Ubersuggest today. |
| Board → SEO | `board/addons/seo/` | `connector.view` | 14 screens in 5 nav groups, catalog and grouping both from the server. DataForSEO today. |
| Board → Goals | `board/goals/GoalConnectorChip.jsx` | `connector.manage` to link, `goal.track` to accept | The chip lives **inside the frozen name cell** — there is deliberately no connector column, because three extra columns already pushed Start/Target/Actual off a 1280px screen. `goalGrid.js` buys 26px only when `canLink`. |

`canViewAddons = isTrackerBoard && (connector.view || adsBudget.view)` — the OR exists because
roles are data and a custom role may hold `adsBudget.view` alone.

### 5.2 Things worth knowing before touching the client

- **There is no UI anywhere for `BoardConnector.kinds`** — the field that decides what is actually
  bought. Only `enabledScreens` (free, local) is offered. Kinds are settable only through the API.
- **Plain Refresh on the SEO tab does not force.** "Buy this collection again" is a separate
  confirmed modal and the only client path sending `force: true`.
- **Exports are one registry.** Thirteen reports in `labsExport.js`, each a single columns array
  driving both CSV and PDF, with a freshness-specific context column, a UTF-8 BOM and RFC 4180
  escaping. The disavow file is built only from rows the server marked `disavow && !lost`, one
  `domain:` line each, with provenance comment lines.
- **Both tabs quietly refetch** on the `board.changed` SSE ping with a 1500 ms debounce. That chain
  was inert until commit `99a6f1d` (2026-09-02) fixed the notification mount order; **not verified
  live since**.
- The client report is five closed widget primitives with a **deterministic** narrative
  (`reportWidgets.narrativeFrom`) — not an LLM call — exported as an A4 portrait PDF. Portal
  publishing is deferred; the share modal explains that and offers the PDF.

### 5.3 Small defects noticed while reading

- `SiteFormModal`'s reset effect never restores `businessName` on edit, and site update is a **full
  replacement** — so editing a DataForSEO site likely clears its stored Google Business Profile
  name and silently disables the `business_profile` kind.
- The Add-ons quota toast hardcodes "Ubersuggest is out of quota", inside a file whose comment
  says nothing below names a provider. Same for two user-facing sentences in `PositionsSection`
  and two in `KeywordTrendChart`.
- `UsageScreen` takes a `boardId` prop it never uses. `SiteAuditScreen` carries a byte-identical
  local copy of `Panel`/`PanelHead` that `LabsBits` already exports. `CompetitorsScreen` does the
  same.
- The Alerts screen's "not collected" banner is driven by a regex over server prose
  (`/not being collected/i`), so rewording one sentence in `alerts.js` would silently disable it.
- `PositionsSection` reads the last element of `averagePositions` while `OverviewScreen` and
  `RankChart` scan backwards for the last numeric value — the two screens can disagree about
  "Average position" if the series ends in a null.
- `KeywordsSection`'s "the run is capped" note is unreachable (the server always reports
  `truncated: false` now), and its CPC/intent columns are permanent em dashes on Ubersuggest.

---

## 6. What the tests pin

Forty connector test files, 950 flat `test()` calls, no `describe`. No database and no network:
every Mongoose static is stubbed in place per file, transports are injected `fetchImpl`s, and the
master key is set to a random value at file top. An unstubbed call **hangs** on Mongoose's 10 s
buffering timeout rather than failing loudly.

**Run 2026-09-03: 1453 tests, 1453 passing, 0 failing, 0 skipped, ~57 s, exit 0.**

`npm test` is an explicit file allowlist in `package.json`, **not a glob**, so an unlisted test
file never runs.

| File | Pins |
|---|---|
| `registrySeam.test.js` | The Ads sketch is driven through the generic engines while staying unregistered; `getConnector('ads')` must be null. Greps ten generic files for `ubersuggest` outside comments. |
| `credentialSeam.test.js` | The oauth-XOR-apiKey rule with exact refusal messages; the 13-kind DataForSEO catalog asserted in full and in order; the field catalog checked by property. |
| `connectorLeak.test.js` | The provenance sidecar has not moved onto the goal value; snapshot status enum is exactly `['ok','partial']`. |
| `budget.test.js` ×2 | Reserve never upserts; the guard is `reserved+spent+estimate ≤ cap`; org reserved first and released last with compensation; our cap answers pending and never `quotaExhausted`; the live-project allowlist must stay absent; money rounds to the millionth. |
| `tasks.test.js` | Post-once by counting `task_post` calls; the midnight trap; the attempt cap (3, states abandoned/abandoned/dead); two racing processes buy one batch. |
| `ready.test.js` | Announced ids persisted in one bulkWrite **before** any `task_get`, with a crash test and a negative control. |
| `collect.test.js` | The ten-minute collector cannot spend — the allowlist is enforced at the transport; the pingback answers 501. |
| `serpCache.test.js` | Off is byte-identical; force bypasses with zero lookups; only two kinds cacheable; the refcount cascade. |
| `serpResults.test.js` | The 16 MB BSON trap closed both ways. |
| `goalGuards.test.js` | Comparability refuses across crawl config, status type, rank scale and depth; `sameVariant` lets market- and domain-scoped rows answer a device-scoped selection. |
| `onpage.test.js` | The ten positive counters inverted against `pagesCrawled`; `enable_browser_rendering` throws with `/34x/`. |
| `backlinks.test.js` | Dofollow from a second filtered call (fixture 1010 vs 900); no label says DA/DR. |
| `labs.test.js` | Clickstream refused and built into no payload; the ledger records the envelope cost; `keyword_gap` is directional. |
| `extras.test.js` | Alert types gated end-to-end by notification preferences; GBP never defaults to the domain; Business Data is not in the pool; `KINDS.length === 13`. |
| `ubersuggest/normalise.test.js` | **Payloads captured live on 2026-08-28** — the strongest evidence in the repo that this provider has really run. |
| `ubersuggest/fetchers.test.js` | `keyword_metrics` spends nothing; mobile is never polled; the scheduled audit never starts a crawl. |
| `mcpClient.test.js` | A bare 403 classifies as `forbidden`, never quota — the regression that killed whole passes. |

**Two gaps in the seam.** The direct-import scan only greps for `ubersuggest`; there is no
equivalent for `dataforseo`, and three non-registry files import that directory today
(`routes/connectors.js:40`, `scripts/syncSiteKeywordsFromSitemap.js:55,59`,
`services/seoAlertRunner.js:283`). And `connectorCollectRunner.js` and `seoAlertRunner.js` are
generic runners the genericity scans do not cover — the latter would fail if it were added.

---

## 7. Operations

### 7.1 Environment variables

| Variable | In `server/.env` | Default if unset | Consequence |
|---|---|---|---|
| `CONNECTOR_MASTER_KEY_V1` | present | connectors disabled (warn, no exit) | Must be byte-identical everywhere sharing the Atlas database, or sealed rows are unopenable. |
| `SERVER_PUBLIC_URL` | present | — | The OAuth redirect target. |
| `CLIENT_URL` | present | — | Where the callback returns the browser. |
| `DATAFORSEO_API_ORIGIN` | **absent** | `https://sandbox.dataforseo.com` | Resolved once at require time, so changing it needs a restart. Any value that is not one of the two known hosts warns and falls back to sandbox. |
| `DATAFORSEO_MONTHLY_CAP_USD` | **absent** | null (no ceiling) | Effectively dead — see §4.2. |
| `DATAFORSEO_SERP_CACHE_ORGS` | **absent** | empty (nobody) | The cross-tenant cache is inert. |

There is no `server/.env.example` documenting any of these.

### 7.2 Migration and scripts

- **`npm run migrate:connectors`** → `grantConnectorCapabilities.js`. Additive, idempotent, system
  roles only. Admin and member get `connector.view` + `connector.manage`, viewer gets view,
  **guests deliberately get nothing** (the board endpoint lists every workspace account by label).
  Without it the Add-ons tab never appears for anyone, including the owner. **Already run.**
- **`scripts/syncSiteKeywordsFromSitemap.js`** (no npm alias). Fills a locally-authored DataForSEO
  site's `trackedKeywords` from sitemap page titles (falling back to `<h1>`, then the URL slug).
  Dry-run by default, **merges rather than replaces**, skips other-language pages via hreflang
  alternates, refuses mirrored projects, and validates through the same `readForm` as the HTTP
  route, so the 200-keyword cap and operator refusal apply identically. **This is what took
  davnoot.com from 4 keywords to 105**, on 2026-09-01 at 19:55Z — after the one task was posted,
  which is why that task carried only 4 keywords.
- No `CLAUDE.md` or `README.md` exists at the root or in `server/`. `_ai_context/Issues.md` and
  `MIGRATION_NOTES.md` contain no connector content. `pyusuggest-master/` is an archived Python
  scraper that nothing imports and whose hardcoded endpoint no longer resolves.

### 7.3 Getting DataForSEO to a first real collection

1. **Fix the index** (§0). Nothing else matters until this is done.
2. **Settle the 40501** on the free sandbox with the three-way experiment (§0).
3. **Point at the live host**: add `DATAFORSEO_API_ORIGIN=https://api.dataforseo.com` and
   **restart** the server.
4. **Set the cap on the account**, not in the environment, via Settings → Connectors
   (`PATCH /api/connectors/:accountId/budget`). That also rewrites the current month's budget row,
   which still carries the obsolete `capUsd: 5` from the deleted default.
5. **Narrow the first pass.** Set `kinds: ['positions']` on **both** board rows, or disable the
   second board's connector (the `intervalHours: 72`, never-refreshed one). Empty means everything
   on either board.
6. **Press Refresh** (a plain Refresh suffices; do **not** send `force: true`) and watch:
   - Response note: `positions: Queued 105 keywords at DataForSEO…`
     ("Already queued at DataForSEO." means step 1 is not done.)
   - `dfstasks`: a new row `state: 'open'`, `budgetState: 'settled'`, 105 items at `20100` with
     non-null `externalId`, `costUsd ≈ 0.63`.
   - `connectorbudgets`: `reservedUsd` back to 0 after settle, `spentUsd ≈ 0.63`.
   - Within ~10 minutes: the collector flips the row to `done` and writes the first
     `connectorsnapshots` row for provider `dataforseo`.

**Cost:** one `positions` pass at 105 keywords, depth 100 estimates **$0.63** (105 × 10 × $0.0006),
about **$2.70/month** at the weekly cadence; adding `movement` costs $0.063/day. Leaving `kinds`
empty reserves roughly **$1.10** for a full first pass across all thirteen kinds. The published
unit price predates DataForSEO's 2026-07-01 price move, so expect the settled figure to differ.
DataForSEO's minimum deposit is $50.

---

## 8. Timeline

| Date | Commit | What landed |
|---|---|---|
| 2026-08-26 | `42db067` | Ubersuggest connector: credentials, OAuth, org-admin connect UI. |
| 2026-08-27 | `3984c5e` | Phases 2–6 in one commit: MCP client, project mirror, snapshots, the runner, the data tab, field mapping, goal links and writeback, the second-provider proof. Bulk goal linking rode alongside in `8dfed1d`. |
| 2026-08-28 | `337e224` | The four bugs the first live run exposed: bare 403 misread as quota, `match_keywords` capped at 1–3 seeds, three wrong site-audit paths, mixed-case payload keys. |
| 2026-08-30 | `9c78ca0` | **DataForSEO, all twelve phases, 147 files, +57,449 lines.** Four collections, 13 kinds, 14 screens, 146 fields, the budget ledger, the SERP cache, the alert runner, and the `band` goal type. |
| 2026-08-31 | `82556b2` | Add-ons split into "Board add-ons" and "Connectors"; a connector read failure no longer blanks the tab. |
| 2026-09-01 | `ef78505` | Grouped SEO nav rail: server-side `SCREEN_GROUPS` and a `group` per screen. Plus an unrelated permissions overhaul. |
| 2026-09-01 | `eb23c0b` | The Ubersuggest tab adopts the DataForSEO shell: `SeoChrome` → `connector/ProviderChrome`, `RankChart` moved and shared, a new Overview with deltas, a 90-day window sent to the server, a rail derived from the kind catalog. |
| 2026-09-02 | `99a6f1d` | Notification SSE mounted above the bare routers — the fix for the mount-order bug that made connector live-refresh inert. |
| 2026-09-02 | `647d49c` | Bring-your-own-key: per-account `monthlyCapUsd`, a budget PATCH endpoint, `descriptor.metered`, and **deletion of both the $5 default cap and the `DATAFORSEO_LIVE_PROJECTS` allowlist**. Added the sitemap keyword script. |

---

## 9. Stale-documentation register

Fifty-six suspected-stale statements were checked against code and git history: **33 false, 20
partly true, 1 unverifiable without a live account.** These are the ones that would actively
mislead.

| Claim | Where | Verdict | What is true now |
|---|---|---|---|
| "Nothing here is built yet. This is the plan." | `dataforseo_TODO.md:5` | **False** | All twelve phases are built and committed. The status table three lines below says so; only the header was never rewritten. `_ai_context/` is git-ignored, so the file has no history and its mtime predates both build commits. |
| "NOTHING has ever run against a live account" | `MEMORY.md` index line | **Half** | True for DataForSEO. False for Ubersuggest, which ran live 2026-08-27 and whose normaliser tests carry payloads captured live on 08-28. The index line also omits the second provider entirely and contradicts the body of the file it indexes. |
| "No project list, no snapshot and no goal cell has ever been produced from live data" | `ubersuggest_TODO.md:8-11, 648-664` | **Half** | Projects and snapshots have. **Goal cells have not**, on either provider — zero link rows exist. No document currently draws that distinction. |
| "One shared DataForSEO account owned by us, with per-org metering" | `dataforseo_TODO.md:31` | **Reversed** | Each workspace connects its own credential and spends its own balance (`647d49c`). Three model comments still describe the old model; `dataforseo/budget.js` quotes and retracts them. |
| "`DATAFORSEO_LIVE_PROJECTS` empty means nothing may post"; "$5 default cap" | seven places in the TODO + `serpCache.js:28` | **Deleted** | Both removed 2026-09-02. Connecting a credential is now the only authorisation to spend. The SERP-cache allowlist is the only survivor of that shape, and it protects a different party. |
| "There is no paste-a-key endpoint; `handleCallback` is the only path that creates an account" | `dataforseo_TODO.md:44-51` | **False** | `saveCredentials` is a second creator. `validateDescriptor` now accepts either mode and rejects a descriptor declaring both. |
| "Result delivery is via `postback_url`, a WebhookInbox collection and `upsertFromCallback`" | `dataforseo_RESEARCH.md:439-460` | **Opposite** | Delivery is polling. A pending fetch writes no row at all, the in-flight record is `DfsTask`, the pingback is inert. No `express.raw`, no trust proxy, no such entry point. |
| "Sixteen kinds"; "~60 mappable fields"; "110 fields" | `RESEARCH.md:787`, `TODO.md:1200` | **Superseded** | **13 kinds and 146 fields**, verified by executing the module. The count changed twice and both snapshots were left in place. |
| "`kind === 'positions'` is hardcoded in five places, and the writeback resolves variants by that name" | `kinds.js:30-38` + TODO | **Half paid** | Six sites, not five. The writeback half is fixed (it asks `sameVariant`). Four sites in `connectorDataController` and one Mongo filter in `connectorLinkController` remain, by intent. |
| "The notification SSE stream is broken on main, so live refresh is inert" | `ubersuggest_TODO.md:732-745` | **Fixed** | Commit `99a6f1d` moved the mount above the bare routers. Not re-verified at runtime. |
| "`capabilityUsage.test.js` fails until a new capability is enforced somewhere" | memory note | **Passing** | 6/6 pass. Read it as a rule about adding capabilities, not a current failure. |
| "Suite is green at 679 / 748 / 1312 tests" | both TODOs, memory | **Historical** | 1453 passing as of 2026-09-03. |
| "The weekly runner"; "the first 04:00 sync" | six code comments | **Never existed** | Three hourly-or-faster crons. "Weekly" describes only the collection cadence. |
| "keyword_metrics is capped at 100 keywords and says so in the UI" | `ubersuggest_TODO.md:246-249` | **Removed** | The cap and the batch are gone; the kind derives from the positions snapshot with `tools: []`. The UI note is now dead code. |
| "`getAccessToken` has exactly two callers" | `session.js:101-103` | **One** | Only `ubersuggest/mcpClient.js:252`. |
| "`round6` rounds to the cent-of-a-cent" | `budget.js:38` | **Wrong unit** | Rounds to a millionth (1e-6), not 1e-4. |
| "Four tools write"; "42 tools" | TODO, plan | **Drifting** | Three write tools by the provider's own constants; the manifest has gone 37 → 42 → 46 without announcement. Nothing in the code counts tools. |
| "`DfsSerpResult`, one document per (task, keyword)" | `dataforseo_TODO.md:384` | **Wrong key** | Keyed on the measurement: `(project, kind, variant, periodKey, keyword)`. The `kind` axis is required because positions and movement are separate kinds. |
| "Local/GBP gated behind the per-user Extra Feature toggle" | `RESEARCH.md:738` | **False** | Gated per **board** via `BoardConnector.enabledScreens`. The Extra Features table knows nothing about connectors. |
| "Client files land at `client/src/components/board/seo/…` with `services/seoService.js` and `routes/seo.js`" | `RESEARCH.md:1093` | **False** | Everything lives under `board/addons/seo/`, going through the existing `connectorService.js` → `routes/connectors.js` → `connectorDataController.js`. |
| "A board with two enabled connectors shows only the first" | `RESEARCH.md:1129`, `BoardDetailPage.jsx:191-193` | **Fixed** | Split by capability into two tabs. The comment is now true only *within* each group. |

Line numbers throughout both design docs drifted by tens to hundreds of lines after the
2026-08-30 build. **Treat every citation in `_ai_context/` as a locator hint, not a reference.**

Two whole sections near the end of `dataforseo_TODO.md` — "Phases 8-10 — the rest of the
dashboard" and "Phase 11 — cross-tenant keyword cache, only if measured" — are **superseded
pre-build drafts left below the build logs**. Only the second carries a "Resolved" marker. The
first still proposes portal publishing for client reports and an LLM narrative, both explicitly
decided against.

---

## 10. Outstanding work and risks

| Item | Status | Note |
|---|---|---|
| `DfsTask.externalId` index collision | **Open · blocking** | §0. Nothing DataForSEO does works until this is fixed. |
| The 40501 `language_name` refusal | **Open** | Sandbox quirk or real payload bug. Free to settle, ~$0.0006 to confirm. |
| No goal cell has ever been written by a connector | **Unproven** | Zero link rows on either provider. The largest untested-in-production surface. |
| Store a DataForSEO credential and point at the live host | Not done | The account exists; the origin is still the sandbox. |
| Two spend guard rails deleted on 09-02 | **Accepted risk** | No allowlist and no default cap. Set an account cap before going live. |
| Observed `list_projects` shape never pinned as a test case | Not done | The account has run live since 08-28; `projects.test.js` still reads as if no authenticated call has happened. |
| Confirm `CONNECTOR_MASTER_KEY_V1` on Render | Effectively done | Ubersuggest has run live, which requires it. The DataForSEO TODO lists it open; the Ubersuggest TODO marks the same item done. |
| Decide the org monthly cap (~$318/mo) | **Obsolete** | Wrong shape since 09-02. The cap is per-account data the workspace owner sets. |
| Resolve Bing Labs pricing | Non-blocking | Settlement reads the envelope's own cost, so an unpublished price can only over-reserve. No production code calls a Bing endpoint. |
| Ask about a DataForSEO partner/OAuth arrangement | Stale premise | Still worth asking, but the credential design already moved to per-workspace keys. |
| Backlink Gap (`backlinks/domain_intersection`) | Deferred | `referring_networks` shipped in its place. |
| Boolean source type for field mapping | Deferred | Eleven crawl booleans and GBP `is_claimed` stay unmappable until `ACCEPTS` is widened. |
| Keyword picker is `positions`-only | Known gap | A board keeping only the daily `movement` kind cannot pick keywords to link. |

### Risks that are not on anyone's list

- **The design docs are actively misleading.** Both TODOs predate five commits, and one opens with
  a sentence that is the opposite of the truth. Anyone onboarding from `_ai_context/` will build
  against a model that was reversed on 2026-09-02.
- **`keyword_metrics` is stuck partial.** Eighteen Ubersuggest rows are `partial` against fifteen
  `ok`, which by design means the runner keeps retrying them forever. Worth checking whether those
  are pre-fix rows that can never resolve.
- **The alert runner has no overlap guard**, unlike the other two, and it claims the dedupe state
  *before* resolving recipients — so a period with zero eligible recipients is consumed and never
  announced.
- **Two DataForSEO accounts in one workspace would share one budget document**, whose `capUsd` is
  set by whichever account's session runs first and rewritten by a PATCH on either.
- **`backlinksNormalise.num()` turns an explicit null into 0** (`Number(null) === 0`),
  contradicting the file's own stated rule, and that value feeds the toxicity scorer as a real spam
  score of zero. Its two sibling normalisers use a `typeof` guard and do not have this issue.
- **`acceptGoalSuggestions` writes no ActivityLog row** (§2.7).
- **A refresh silently enables the connector** on a board that never enabled it (§2.9).
- **`warmAccountData` is inert**, so the account price book is never warmed on a sync pass (§4.3).

---

## 11. File index

~44,000 lines of server code, ~13,000 of client code, ~4,000 lines of design documentation.

### Generic engine — `server/src/services/connectors/`

| File | Purpose |
|---|---|
| `index.js` | Registry, `validateDescriptor`, the function-free serialisable catalog |
| `session.js` | The only reader of sealed credentials |
| `snapshotService.js` | Plan, fetch, write, freshness, reports |
| `fieldMapping.js` | Builtins, accepts table, `checkCompatibility` |
| `budget.js` | The only writer of `ConnectorBudget` |
| `projectMirror.js` | Refreshes the project pool; never deletes |
| `__sketch__/ads.js` | An unregistered descriptor that exists to be run by the generic engines |

### Runners and services

`connectorSyncRunner.js` (the buyer) · `connectorCollectRunner.js` (the free collector) ·
`seoAlertRunner.js` · `connectorGoalWriteback.js` (the ownership rule) · `orgCascade.js`

### Controllers and routes

`routes/connectors.js` (29 routes, mounted bare and first) · `connectorController.js` (accounts,
enablement, projects, sites) · `connectorDataController.js` (read plane and Refresh) ·
`connectorFieldController.js` · `connectorLinkController.js`

### Utilities and scripts

`utils/connectorProviders.js` (the two names, single source of truth) · `utils/connectorCrypto.js`
· `utils/capabilities.js` · `scripts/grantConnectorCapabilities.js` (`migrate:connectors`) ·
`scripts/syncSiteKeywordsFromSitemap.js`

### Ubersuggest — 9 files, ~3,100 lines

`index.js` · `constants.js` (error-pattern lists) · `oauth.js` (PKCE, discovery, the 414 login
hop) · `mcpClient.js` (hand-rolled JSON-RPC, four error flags) · `projects.js` · `kinds.js` ·
`fetchers.js` · `normalise.js` · `fields.js`

### DataForSEO — 34 files, ~19,000 lines

- Core: `index.js` · `constants.js` (1,506 lines of hosts, caps, floors, prices) · `client.js` ·
  `errors.js` · `pool.js` · `pricing.js` · `operators.js`
- Task pipeline: `tasks.js` · `ready.js` · `collect.js` · `liveJob.js` · `serpResults.js` ·
  `pingback.js`
- Projects: `sites.js`
- Money: `budget.js` · `usage.js`
- Catalogs: `kinds.js` · `screens.js` · `fetchers.js` · `fields.js` · `comparability.js` ·
  `alerts.js`
- Families: `labs.js` · `backlinks.js` · `onpage.js` · `business.js` · `toxicity.js` ·
  `onpageChecks.js` + `normalise.js`, `labsNormalise.js`, `backlinksNormalise.js`,
  `onpageNormalise.js`, `businessNormalise.js`
- Cache: `serpCache.js`

### Client

`settings/ConnectorsTab.jsx` · `board/addons/` (AddonsTab, ConnectorSettingsPanel, SiteFormModal,
FieldMappingPanel, GoalVocabularyCard) · `board/addons/connector/` (11 files — the generic tab and
the shared chrome) · `board/addons/seo/` (17 files — the dashboard shell and 14 screens) ·
`board/goals/` (GoalConnectorChip, GoalLinkModal, GoalBulkLinkModal) ·
`services/connectorService.js` (27 calls, every one suppressing its error toast) ·
`hooks/useBoardConnectors.js` · `utils/` (connectorFormat, connectorScreens, labsRows, labsExport,
backlinkRows, auditRows, aiRows, localRows, toxicRows, reportWidgets, cannibalRows, rankRows,
reportExport)

### Models — `server/src/models/`

`ConnectorAccount` · `ConnectorAuthAttempt` · `BoardConnector` · `ConnectorProject` ·
`ConnectorSnapshot` · `ConnectorBudget` · `ConnectorFieldMapping` · `GoalConnectorLink` ·
`DfsTask` · `DfsSerpResult` · `DfsSerpCache` · `DfsCacheProbe`

### Documentation (git-ignored, and stale)

`_ai_context/dataforseo_RESEARCH.md` (1,174 lines, pre-build brief) ·
`_ai_context/dataforseo_TODO.md` (2,081 lines, build log) ·
`_ai_context/ubersuggest_TODO.md` (767 lines, status doc) ·
`~/.claude/plans/the-final-goal-is-soft-mist.md` (the original design plan, overruled in many
places during the build)
