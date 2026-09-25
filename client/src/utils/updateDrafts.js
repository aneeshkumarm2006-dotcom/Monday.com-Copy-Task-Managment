/**
 * Unsent update drafts.
 *
 * Anything typed into an Updates composer but not yet posted is kept locally so
 * that closing the browser, switching board, or clicking into another task no
 * longer throws it away. A draft is exactly that — *not sent*. Nothing here ever
 * reaches the server, nobody is notified, and on a client thread the client sees
 * nothing until Send is actually pressed.
 *
 * Storage is per browser (localStorage), keyed by user + task + thread:
 *
 *   task:updateDraft:<userId>:<taskId>:<audience>
 *
 * The user id keeps two people sharing a machine out of each other's drafts, and
 * the audience keeps the team thread and the client thread apart on a client
 * board — they are two different composers on the same task, and a half-written
 * internal note must never resurface in the box that emails the client.
 *
 * Attachments are safe to store: they are uploaded the moment they are picked,
 * so the draft only carries their metadata and the files are already on the
 * server whether or not the update is ever posted.
 */

export const DRAFT_KEY_PREFIX = 'task:updateDraft:';

/** How long an untouched draft survives before it is swept up. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * The storage key for one composer. Returns null when the task isn't known yet,
 * which callers treat as "drafting is off" rather than writing to a junk key.
 */
export const draftKeyFor = (userId, taskId, audience = 'default') => {
  if (!taskId) return null;
  return `${DRAFT_KEY_PREFIX}${userId || 'anon'}:${taskId}:${audience}`;
};

/**
 * A draft counts as empty when there is nothing to send: no body and no
 * attachments. A dangling "replying to" on its own is not worth keeping.
 */
export const isDraftEmpty = (draft) => {
  if (!draft) return true;
  if ((draft.attachments?.length || 0) > 0) return false;
  // `isEmpty` comes straight from the editor, so it is the authority on a body
  // that reads as blank but isn't (an attachment chip, a checklist item).
  if (draft.isEmpty === false) return false;
  return !String(draft.bodyText || '').trim();
};

/** Read one draft. Returns null on a missing, corrupt, or empty entry. */
export const loadDraft = (key) => {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const draft = {
      body: parsed.body || null,
      bodyText: parsed.bodyText || '',
      mentions: Array.isArray(parsed.mentions) ? parsed.mentions : [],
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
      isEmpty: parsed.isEmpty !== false,
      replyTo: parsed.replyTo || null,
      savedAt: parsed.savedAt || null,
    };
    return isDraftEmpty(draft) ? null : draft;
  } catch {
    return null;
  }
};

/**
 * Persist one draft, stamping it with the save time. An empty draft removes the
 * entry instead of storing a blank one, so "cleared the box" and "never typed
 * anything" end up in the same state.
 *
 * Returns the savedAt stamp, or null if nothing was stored.
 */
export const saveDraft = (key, draft) => {
  if (!key) return null;
  if (isDraftEmpty(draft)) {
    clearDraft(key);
    return null;
  }
  const savedAt = new Date().toISOString();
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        body: draft.body || null,
        bodyText: draft.bodyText || '',
        mentions: draft.mentions || [],
        attachments: draft.attachments || [],
        isEmpty: draft.isEmpty !== false,
        replyTo: draft.replyTo || null,
        savedAt,
      })
    );
    return savedAt;
  } catch {
    // Private mode / quota — drafting quietly degrades to "not kept".
    return null;
  }
};

/** Drop one draft (posted, or discarded by hand). */
export const clearDraft = (key) => {
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore storage failures */
  }
};

/**
 * Trim drafts nobody came back to. Runs at most once per page load: the sweep
 * walks every localStorage key, which is cheap but pointless to repeat.
 */
let pruned = false;
export const pruneStaleDrafts = (maxAgeMs = MAX_AGE_MS) => {
  if (pruned) return;
  pruned = true;
  try {
    const cutoff = Date.now() - maxAgeMs;
    const doomed = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(DRAFT_KEY_PREFIX)) continue;
      let savedAt = null;
      try {
        savedAt = JSON.parse(localStorage.getItem(key) || '{}')?.savedAt || null;
      } catch {
        doomed.push(key); // unparseable — no way to age it, no way to use it
        continue;
      }
      const stamp = savedAt ? Date.parse(savedAt) : NaN;
      if (Number.isNaN(stamp) || stamp < cutoff) doomed.push(key);
    }
    doomed.forEach((key) => localStorage.removeItem(key));
  } catch {
    /* ignore storage failures */
  }
};

/**
 * Drop every draft belonging to one person, whatever task or thread it is on.
 *
 * This exists because a draft outlives the session that wrote it. Signing out,
 * or deleting the account outright, tore down the server side and the in-memory
 * stores but left the unsent prose sitting in localStorage — and the only
 * sweeper, `pruneStaleDrafts`, runs from inside an Updates composer, which on a
 * single-user machine nobody ever opens again after the account is gone. So the
 * 30-day age limit never fires and the residue is permanent, not stale.
 *
 * It is scoped to ONE user id rather than sweeping the whole `DRAFT_KEY_PREFIX`
 * namespace, and that is the entire point of the signature. The key carries a
 * user segment precisely so two people sharing a browser cannot touch each
 * other's drafts (see the header of this file); a prefix-wide wipe on sign-out
 * would throw away the other person's half-written notes the moment the first
 * one leaves. The `anon:` bucket goes too, because a draft written with no user
 * id is attributable to nobody and there is no session that could ever claim it.
 *
 * Returns the number of entries removed, which is only useful for tests — the
 * callers do not branch on it.
 */
export const clearAllDrafts = (userId) => {
  const owners = [String(userId || 'anon'), 'anon'];
  try {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (owners.some((owner) => key.startsWith(`${DRAFT_KEY_PREFIX}${owner}:`))) {
        doomed.push(key);
      }
    }
    doomed.forEach((key) => localStorage.removeItem(key));
    return doomed.length;
  } catch {
    // Private mode / blocked storage — there was nothing kept to clear either.
    return 0;
  }
};

/**
 * The trimmed copy of the update being replied to that a draft carries. Only
 * what the reply banner renders plus the id the post needs — never the whole
 * populated update, which would go stale in storage.
 */
export const replyToDraft = (update) => {
  if (!update?._id) return null;
  return {
    _id: update._id,
    author: { name: update.author?.name || '' },
    bodyText: update.bodyText || '',
    attachments: (update.attachments || []).map((a) => ({ name: a?.name || '' })),
  };
};
