/**
 * How a chat/mail message is shown to an EXTERNAL CLIENT.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN REUSING THE TEAM'S SERIALIZATION
 * ---------------------------------------------------------------------------
 *
 * `chatController.MESSAGE_POPULATE` selects `author: 'name profilePic email'`.
 * Reusing it on any portal read — or on an SSE frame addressed to a contact —
 * would push EVERY team member's email address into the client's browser, on a
 * page an outside company loads. It is one word in one populate spec, and
 * nothing about the call site would look wrong.
 *
 * So the portal gets its own populate and its own shape. Not a filter applied
 * to the team's object — a filter is something a future edit can forget to
 * apply, and this is a boundary. Building the payload field by field means a
 * new field on `Message` is invisible to clients until somebody adds it here on
 * purpose.
 *
 * Also deliberately absent, each for its own reason:
 *
 *   `task` / `goal` chips — a chip carries the internal name and status of a
 *       row the client cannot otherwise see. The send paths refuse to attach
 *       one to a client-facing channel, and this refuses to render one even if
 *       a row somehow carries it.
 *   `mentions` as user objects — the client sees the NAME a mention renders as
 *       and nothing else; the ids are ours.
 *   `attachments[].publicId` — the Cloudinary handle. The client needs the URL
 *       to fetch the file, not the id to address it in our account.
 *   `editedAt` is kept: "this was edited" is honest, and hiding it would let a
 *       message be silently rewritten under a client who had already read it.
 */

/** The populate spec for anything a client will read. NO email. */
const PORTAL_MESSAGE_POPULATE = [
  { path: 'author', select: 'name profilePic' },
  { path: 'portalAuthor', select: 'name email' },
  { path: 'mentions', select: 'name' },
  { path: 'mentionsContacts', select: 'name email' },
];

/** A contact's display name, falling back to the address they signed in with. */
const contactLabel = (contact) =>
  (contact?.name || '').trim() || contact?.email || 'Client';

/**
 * One message, as the client's browser should see it.
 *
 * @param {Object} message  - a Message populated with PORTAL_MESSAGE_POPULATE
 * @param {Object} opts
 * @param {string} opts.contactId - the READER, so `mine` can be resolved. A
 *   client room can hold several contacts from the same company, and "mine"
 *   must mean this person, not "someone at my company".
 * @param {number} [opts.replyCount]
 */
const serializeMessageForPortal = (message, { contactId, replyCount } = {}) => {
  if (!message) return null;

  const isClient = message.authorType === 'client';
  const isSystem = message.authorType === 'system';

  return {
    id: String(message._id),
    authorType: message.authorType || 'user',
    // The team shows as the person who wrote it; automated posts show as the
    // product, never as a person who did not type them.
    authorName: isSystem
      ? 'Macan'
      : isClient
        ? contactLabel(message.portalAuthor)
        : message.author?.name || 'Team',
    authorAvatar: isClient || isSystem ? null : message.author?.profilePic || null,
    mine:
      isClient &&
      String(message.portalAuthor?._id || message.portalAuthor || '') === String(contactId),
    body: message.body || null,
    bodyText: message.bodyText || '',
    attachments: (message.attachments || []).map((a) => ({
      url: a.url,
      name: a.name,
      mime: a.mime,
      size: a.size,
    })),
    mentionNames: (message.mentions || []).map((m) => m?.name).filter(Boolean),
    subject: message.subject || undefined,
    replyTo: message.replyTo ? String(message.replyTo) : null,
    ...(replyCount === undefined ? {} : { replyCount }),
    createdAt: message.createdAt,
    editedAt: message.editedAt || null,
  };
};

module.exports = {
  PORTAL_MESSAGE_POPULATE,
  serializeMessageForPortal,
  contactLabel,
};
