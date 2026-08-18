const Update = require('../models/Update');
const User = require('../models/User');
const ClientContact = require('../models/ClientContact');

/**
 * updateThread.js — a task's discussion, flattened for export.
 *
 * The activity log records that someone posted, not what they posted: the row
 * it writes carries an 80-character `updateSnippet` and nothing more, which is
 * enough for a timeline and useless for a report someone has to read. This
 * rebuilds the actual conversation from the `Update` collection so the board
 * activity export can carry the whole thread of every task it mentions.
 *
 * Kept out of the export controller because two things here are not that
 * controller's business and are both easy to get wrong: turning a TipTap
 * document back into text, and remembering that an update's author may be a
 * `ClientContact` rather than a `User`.
 *
 * Nothing here filters by visibility. The only caller is a team-side export
 * already behind board read access + `board.export_activity`, and for that
 * reader the internal thread is the half of the conversation they most need;
 * each message is instead LABELLED with the thread it belongs to. Any future
 * caller on the portal side must filter (`visibility: { $ne: 'internal' }`) —
 * see the note on `Update.visibility`.
 */

/** Messages per task in one export. A thread this long is already unreadable. */
const MAX_MESSAGES_PER_TASK = 500;

/**
 * Nodes whose content is a block: their text ends with a line break so a
 * bulleted list does not come out as one run-on sentence.
 */
const BLOCK_NODES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'codeBlock',
  'tableRow',
]);

/**
 * TipTap JSON → plain text.
 *
 * Mirrors the editor's own `getText()`, including the two nodes that carry no
 * text children and would otherwise vanish: a mention renders as `@Name` (see
 * RichEditor's `Mention.configure`) and a Drive chip as its URL (see
 * `driveChipExtension`'s `renderText`). Everything else recurses.
 */
const textFromDoc = (node) => {
  if (!node || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(textFromDoc).join('');

  if (node.type === 'text') return node.text || '';
  if (node.type === 'mention') return `@${node.attrs?.label || node.attrs?.id || ''}`;
  if (node.type === 'driveChip') return node.attrs?.href || '';
  if (node.type === 'hardBreak') return '\n';

  const inner = Array.isArray(node.content) ? node.content.map(textFromDoc).join('') : '';
  return BLOCK_NODES.has(node.type) ? `${inner}\n` : inner;
};

/**
 * The message's text.
 *
 * `bodyText` is the plain-text mirror the composer sends alongside the document
 * and is what almost every row has; the document is walked only when it is
 * missing, which is the case for rows written before the mirror existed and for
 * any client that skipped it.
 */
const messageText = (update) => {
  const mirror = (update.bodyText || '').trim();
  if (mirror) return mirror;
  return textFromDoc(update.body).replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * Build `{ [taskId]: { count, truncated, messages } }` for a set of tasks.
 *
 * The messages are ordered oldest-first — a conversation read top to bottom —
 * and are returned as data, not as a rendered string: the export's formatting
 * (dates, the shape of one line) lives client-side with the rest of it, and a
 * PDF is free to ignore them entirely.
 *
 * @param {Array} taskIds        - task ids (strings or ObjectIds)
 * @param {Object} [opts]
 * @param {boolean} [opts.labelThreads=false] - tag each message with which
 *        thread it was posted on. Only meaningful on a client board, where
 *        'internal' is the team's Updates tab and 'shared' is the Client tab;
 *        on a standard board every message is 'shared' and the label is noise.
 */
const buildTaskThreads = async (taskIds, { labelThreads = false } = {}) => {
  const ids = [...new Set((taskIds || []).map(String))].filter(Boolean);
  if (!ids.length) return {};

  // 'system' rows are the portal's automated timeline ("Status changed to
  // Done"). They are not part of the discussion, and the export already has a
  // row of its own for the change that produced them.
  const updates = await Update.find({
    task: { $in: ids },
    authorType: { $ne: 'system' },
  })
    .select('task author portalAuthor authorType bodyText body attachments visibility replyTo createdAt editedAt')
    .sort({ createdAt: 1 })
    .lean();

  if (!updates.length) return {};

  const userIds = new Set();
  const contactIds = new Set();
  for (const u of updates) {
    if (u.author) userIds.add(u.author.toString());
    if (u.portalAuthor) contactIds.add(u.portalAuthor.toString());
  }

  const [users, contacts] = await Promise.all([
    userIds.size
      ? User.find({ _id: { $in: [...userIds] } }).select('name').lean()
      : [],
    contactIds.size
      ? ClientContact.find({ _id: { $in: [...contactIds] } }).select('name email').lean()
      : [],
  ]);
  const userMap = new Map(users.map((u) => [u._id.toString(), u.name]));
  // A contact may never have given a name; the email is the identity they
  // signed in with, so it is the right fallback rather than "Client".
  const contactMap = new Map(
    contacts.map((c) => [c._id.toString(), c.name || c.email || 'Client'])
  );

  const authorOf = (u) => {
    if (u.authorType === 'client') {
      return contactMap.get(u.portalAuthor?.toString()) || 'Client';
    }
    return userMap.get(u.author?.toString()) || 'Unknown';
  };

  // Replies are one level deep and always within the same task, so every parent
  // is somewhere in this same result set.
  const authorById = new Map(updates.map((u) => [u._id.toString(), authorOf(u)]));

  const threads = {};
  for (const u of updates) {
    const key = u.task.toString();
    if (!threads[key]) threads[key] = { count: 0, truncated: false, messages: [] };
    const thread = threads[key];
    thread.count += 1;

    thread.messages.push({
      at: u.createdAt,
      authorName: authorOf(u),
      // The reader needs to know a message came from outside the team even when
      // the name alone does not say so.
      isClient: u.authorType === 'client',
      thread: labelThreads ? (u.visibility === 'internal' ? 'team' : 'client') : '',
      replyToAuthor: u.replyTo ? (authorById.get(u.replyTo.toString()) || '') : '',
      text: messageText(u),
      attachments: (u.attachments || []).map((a) => a.name || a.url).filter(Boolean),
      edited: !!u.editedAt,
    });
  }

  // Overflow drops the OLDEST messages, not the newest: a thread long enough
  // to hit the cap is one where the recent exchange is the part being read,
  // and the count above still reports the true total.
  for (const thread of Object.values(threads)) {
    if (thread.messages.length > MAX_MESSAGES_PER_TASK) {
      thread.messages = thread.messages.slice(-MAX_MESSAGES_PER_TASK);
      thread.truncated = true;
    }
  }

  return threads;
};

module.exports = {
  buildTaskThreads,
  textFromDoc,
  messageText,
  MAX_MESSAGES_PER_TASK,
};
