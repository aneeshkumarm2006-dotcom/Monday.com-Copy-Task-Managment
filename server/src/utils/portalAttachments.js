const Update = require('../models/Update');

/**
 * Which of a task's files belong to the client's ORIGINAL REQUEST.
 *
 * A Client Portal task has one file drawer (`Task.attachments`) fed from three
 * places: the client's intake form, the client's thread messages, and the team's
 * own Files tab. Only the first group is part of the request itself, so anything
 * rendering "the request the client raised" — the portal's own detail view and
 * the team's Client tab — has to filter, or a screenshot posted in week three
 * shows up as if it had been attached on day one.
 *
 * New rows say so outright via `source`. Rows written before that field existed
 * are classified from what they do carry:
 *   - `uploadedBy` is set ONLY by the team's Files-tab upload (the portal writes
 *     null, since a ClientContact is not a User) → team.
 *   - a client's thread file is mirrored onto the Update it was sent with, so its
 *     URL appears in `threadUrls` → thread.
 *   - what's left came in with the request.
 *
 * `threadUrls` is a Set of every attachment URL referenced by this task's
 * Updates; build it with `loadThreadAttachmentUrls`.
 */
const isRequestAttachment = (attachment, threadUrls) => {
  if (!attachment) return false;
  if (attachment.source) return attachment.source === 'request';
  if (attachment.uploadedBy) return false;
  return !threadUrls.has(attachment.url);
};

/**
 * Can the client see this file anywhere in their portal? True for what they sent
 * themselves (with the request or in a message), false for what the team put in
 * the Files tab — which the portal never renders. Synchronous, so list endpoints
 * can count files per issue without a query per row.
 */
const isClientVisibleAttachment = (attachment) => {
  if (!attachment) return false;
  if (attachment.source) return attachment.source !== 'team';
  return !attachment.uploadedBy;
};

/**
 * Every attachment URL that appears on one of this task's Updates — the marker
 * that a file arrived through the thread rather than with the request. Reads the
 * whole thread regardless of visibility: an internal team post can carry a file
 * too, and it is no more part of the client's request than a shared one.
 */
const loadThreadAttachmentUrls = async (taskId) => {
  const updates = await Update.find({ task: taskId }).select('attachments').lean();
  const urls = new Set();
  updates.forEach((u) => {
    (u.attachments || []).forEach((a) => {
      if (a?.url) urls.add(a.url);
    });
  });
  return urls;
};

/**
 * The request's own attachments, in upload order. Convenience wrapper that does
 * both steps — use the two pieces separately only if you already hold the URLs.
 */
const loadRequestAttachments = async (task) => {
  const all = Array.isArray(task?.attachments) ? task.attachments : [];
  if (all.length === 0) return [];
  const threadUrls = await loadThreadAttachmentUrls(task._id);
  return all.filter((a) => isRequestAttachment(a, threadUrls));
};

module.exports = {
  isRequestAttachment,
  isClientVisibleAttachment,
  loadThreadAttachmentUrls,
  loadRequestAttachments,
};
