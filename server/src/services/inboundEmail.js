const mongoose = require('mongoose');
const Task = require('../models/Task');
const User = require('../models/User');
const Board = require('../models/Board');
const Update = require('../models/Update');
const ClientContact = require('../models/ClientContact');
const Organisation = require('../models/Organisation');
const { loadBoardContext } = require('../utils/boardContext');
const { createNotificationsForUsers } = require('./notificationService');
const { logActivity } = require('./activityService');

/**
 * Provider-agnostic "received email → task Update" pipeline. Both the Gmail IMAP
 * poller and the Resend webhook parse their own transport, then hand the same
 * shape here: { recipients, from, text }.
 *
 * Security model: the SENDER must resolve to a team User who can read the board,
 * or to the task's own ClientContact. Unknown senders are dropped. (The Gmail
 * poller only reads our own inbox; the Resend path additionally verifies the
 * webhook signature before calling in.)
 */

// A recipient/address string containing `task-<24 hex>` → the task id (else null).
// Matches both `task-<id>@domain` and Gmail plus form `you+task-<id>@domain`.
const extractTaskId = (recipients) => {
  const arr = Array.isArray(recipients) ? recipients : [recipients];
  for (const addr of arr) {
    const m = String(addr || '').match(/task-([a-f0-9]{24})/i);
    if (m && mongoose.Types.ObjectId.isValid(m[1])) return m[1];
  }
  return null;
};

// "Name <a@b.com>" | "a@b.com" → "a@b.com" (lowercased).
const parseFromAddress = (from) => {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
};

// Trim quoted reply history and signatures from a plain-text reply.
const cleanReply = (text) => {
  if (!text) return '';
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break; // quoted line
    if (/^\s*On\b.+\bwrote:\s*$/.test(line)) break; // "On <date> X wrote:"
    if (/^--\s*$/.test(line)) break; // signature delimiter
    if (/^_{5,}\s*$/.test(line)) break; // Outlook divider
    if (out.length && /^\s*From:\s.+/i.test(line)) break; // forwarded header
    out.push(line);
  }
  return out.join('\n').trim();
};

/**
 * @returns {Promise<{ok:boolean, skipped?:string, updateId?:string}>}
 */
const processInboundEmail = async ({ recipients, from, text: rawText }) => {
  const taskId = extractTaskId(recipients);
  if (!taskId) return { ok: true, skipped: 'no task address' };

  const task = await Task.findById(taskId);
  if (!task || !task.board) return { ok: true, skipped: 'task not found' };

  const text = cleanReply(rawText || '');
  if (!text) return { ok: true, skipped: 'empty body' };

  const senderEmail = parseFromAddress(from);

  // Authorise the sender: a team User who can read the board, else the task's
  // own ClientContact.
  let authorType = null;
  let author = null;
  let portalAuthor = null;
  let actorLabel = '';

  const user = await User.findOne({ email: senderEmail }).select('_id name');
  if (user) {
    const ctx = await loadBoardContext(task.board, String(user._id));
    if (!ctx.error) {
      authorType = 'user';
      author = user._id;
    }
  }
  if (!authorType && task.group) {
    const contact = await ClientContact.findOne({ group: task.group, email: senderEmail }).select('_id name');
    if (contact) {
      authorType = 'client';
      portalAuthor = contact._id;
      actorLabel = contact.name || senderEmail;
    }
  }
  if (!authorType) return { ok: true, skipped: 'sender not authorised' };

  const update = await Update.create({
    task: task._id,
    authorType,
    author: authorType === 'user' ? author : null,
    portalAuthor,
    body: null,
    bodyText: text.slice(0, 8000),
    attachments: [],
  });

  const snippet = text.slice(0, 140);
  const board = await Board.findById(task.board).select('organisation');
  const orgId = board?.organisation;

  if (authorType === 'client') {
    try {
      if (orgId) {
        const org = await Organisation.findById(orgId).select('members');
        const memberIds = (org?.members || []).map((m) => String(m?._id || m));
        if (memberIds.length) {
          await createNotificationsForUsers({
            userIds: memberIds,
            type: 'clientReplied',
            message: `Client replied by email on "${task.name}"`,
            taskId: task._id,
            orgId,
            actorId: null,
            tab: 'updates',
            boardId: task.board,
          });
        }
      }
    } catch (notifyErr) {
      console.error('inboundEmail client notify error:', notifyErr);
    }
    logActivity({
      task,
      actorType: 'client',
      actorLabel,
      type: 'client.update_added',
      metadata: { updateSnippet: snippet },
    });
  } else {
    logActivity({ task, actor: String(author), type: 'update.added', metadata: { updateSnippet: snippet } });
    // Team member replied by email → if this is a client task, email the client.
    try {
      const { sendPortalReplyEmailForTask } = require('../controllers/portalController');
      sendPortalReplyEmailForTask(task, text);
    } catch (hookErr) {
      console.error('inboundEmail portal reply hook error:', hookErr);
    }
  }

  return { ok: true, updateId: String(update._id) };
};

module.exports = { processInboundEmail, extractTaskId, parseFromAddress, cleanReply };
