# Deploying Client Portal v2

Read this before pushing to `main`. The order matters, and one step is a point
of no return.

## Why order matters

The old code reads a client portal's token off the **group**. The new code reads
it off the **board**. Right now every one of your live portals has its token on a
group, so:

> **If you deploy the code before running the migration, every client portal link
> stops working immediately.**

The fix is that `--promote` **copies** the token up rather than moving it. Between
`--promote` and `--drop-legacy`, the token exists in both places and **both
versions of the code work against the same database**. That window is your
zero-downtime deploy and your rollback.

---

## Your data, as of the last audit

| Board | State |
| --- | --- |
| `Clients` | live portal on a group → promotes normally |
| `Customer Support` | live portal on a group → promotes normally |
| `Prem` | live portal on a group → promotes normally |
| `Ralf` | no portal anywhere → gets a **disabled** token minted |
| `company 1` | **REFUSED** — two groups carry a token |

107 chat channels, all predating `mode`/`audience`. No duplicate surface keys, so
the new index can build. No duplicate `(board, email)` contacts.

### The one decision that is yours

`company 1` has two live portal links:

| group | contact | tasks |
| --- | --- | --- |
| `company 1` | aneeshmongodb@gmail.com | 2 |
| `company 2` | bcs_2023038@iiitm.ac.in | 4 |

Both contacts are **you**, at two of your own addresses — this looks like test
data from the old "group = client" model. A board is one client now, so exactly
one of those links can survive.

- **If it is test data**: release the one you do not want, e.g.
  `npm run migrate:portal-board -- --release-token 6a6b88632b7a587e563741a4 --force`
  (drop `--force` first to see who loses access). Or delete the board.
- **If they are genuinely two companies**: move one group onto its own client
  board from the team UI first. Do **not** release — the released side would keep
  seeing the other's tasks through the surviving link.

You can also **skip it**: `--promote` refuses that board and migrates the rest.
Both of its links then go dead until you resolve it. Nobody but you is affected.

---

## The run

### Phase A — before deploying (old code still serving)

```bash
cd server

# 1. Read-only. Confirm nothing has changed since you last looked.
npm run migrate:portal-board  -- --report
npm run inspect:client-board  -- --all-refused

# 2. Resolve `company 1` (see above), or accept that it is skipped.

# 3. Copy every portal token up to its board. Groups keep theirs, so the
#    currently-deployed code carries on working.
npm run migrate:portal-board -- --promote --dry-run
npm run migrate:portal-board -- --promote

# 4. Swap the ClientContact index to (board, email). Must happen before the
#    new code writes a contact: new contacts carry no `group`, and the old
#    non-partial unique index reads a missing field as null, so the second
#    such contact would collide.
npm run migrate:portal-board -- --indexes

# 5. Give all 107 channels the surface they already effectively had
#    (private team chat rooms). Nothing gains an audience from this.
npm run migrate:chat-surfaces -- --backfill --dry-run
npm run migrate:chat-surfaces -- --backfill
```

**Checkpoint.** Open a live client portal link. It must still work — you are
still on the old code, and the group still holds its token.

### Phase B — deploy

Push to `main` and let it roll out.

### Phase C — immediately after

```bash
cd server

# 6. Catch anything the old code created during the deploy window. Idempotent.
npm run migrate:chat-surfaces -- --backfill

# 7. Swap the channel index to (board, group, mode, audience).
#    RUN THIS BEFORE UPGRADING ANY BOARD TO ADVANCED. Until it runs, the old
#    one-room-per-group unique index is still in place and would reject the
#    second surface on a workstream.
npm run migrate:chat-surfaces -- --indexes --verify
```

**Checkpoint.** Open a client portal link again — it must still work, now showing
the whole board. Raise a request against a workstream. Then upgrade one board to
Advanced and use *Set up communication*.

### Phase D — once you are satisfied (hours or days later)

```bash
npm run migrate:portal-board -- --verify
npm run migrate:portal-board -- --drop-legacy
```

> **This is the point of no return.** It unsets the group-level portal fields and
> `ClientContact.group`. Until you run it, rolling the code back restores a fully
> working old system. After it, the old code cannot find any portal.
>
> It refuses to run while any client board still holds its token on a group,
> because there the group is the *only* copy and unsetting it would destroy those
> links rather than move them.

---

## If you need to roll back

**Before Phase D:** redeploy the previous commit. Nothing else. The group tokens
are untouched and the old code finds them exactly where it left them. The
board-level tokens and the channel `mode`/`audience` fields it will ignore.

**After Phase D:** you cannot roll back the code without re-minting every portal
link and re-inviting every contact. This is why Phase D is deliberately separate
and deliberately last.

---

## What is *not* covered by any of this

Nothing here has been exercised against a real client using a real browser. The
automated coverage is 1504 unit tests plus 103 end-to-end checks against a
throwaway in-memory MongoDB — which drives the real Express app on both auth
planes, including live SSE and both migrations run as real subprocesses. It does
not prove anything about your Atlas cluster's data beyond what `--report` showed.

The manual checks worth doing after Phase C, in order of what would hurt most:

1. An **existing** client link still opens, and shows the whole board.
2. The private team room is invisible in the portal.
3. A `POST_TO_CHANNEL` automation lands in the team room, not the client's.
4. Rotating the board link kills the client's live session on the next request.
5. Revoking a team member's board access removes every surface for them.
