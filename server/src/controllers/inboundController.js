const crypto = require('crypto');
const mongoose = require('mongoose');
const Task = require('../models/Task');
const User = require('../models/User');
const Board = require('../models/Board');
const Update = require('../models/Update');
const ClientContact = require('../models/ClientContact');
const Organisation = require('../models/Organisation');
const { loadBoardContext } = require('../utils/boardContext');
const { createNotificationsForUsers } = require('../services/notificationService');
const { logActivity } = require('../services/activityService');

/**
 * Inbound email → task Update.
 *
 * Resend receives mail sent to `task-<taskId>@<inbound-domain>` and POSTs an
 * `email.received` webhook here. The webhook carries METADATA only (from/to/
 * subject + attachment metadata) — the body is fetched separately from Resend's
 * Receiving API. Flow:
 *
 *   1. Verify the Resend/Svix signature (the security gate — only Resend holds
 *      RESEND_WEBHOOK_SECRET, so a spoofed POST can't inject updates).
 *   2. Pull the task id out of the recipient address.
 *   3. Fetch the plain-text body, strip quoted history / signatures.
 *   4. Authorise the SENDER: a team User who can read the board, or the task's
 *      own ClientContact. Unknown senders are dropped.
 *   5. Create the Update as that author, notify the other side, log activity.
 *
 * Safe when unconfigured: with no RESEND_WEBHOOK_SECRET the signature check
 * fails and nothing is created.
 */

const RESEND_API = 'https://api.resend.com';

// ---- Svix (Resend) webhook signature verification — no extra dependency. -----
const verifyResendSignature = (rawBody, headers) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const sigHeader = headers['svix-signature'];
  if (!id || !timestamp || !sigHeader) return false;

  // Replay guard: reject timestamps more than 5 minutes off.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  // The header holds one or more space-separated `v1,<base64sig>` entries.
  return sigHeader.split(' ').some((part) => {
    const sig = part.split(',')[1] || '';
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });
};

// task-<24 hex>@anything → the task id (or null).
const extractTaskId = (recipients) => {
  const arr = Array.isArray(recipients) ? recipients : [recipients];
  for (const addr of arr) {
    const m = String(addr || '').match(/task-([a-f0-9]{24})@/i);
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
  const lines = text.replace(/\r\n/g, '\n').split('\n');
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

const fetchReceivedBody = async (emailId) => {
  const res = await fetch(`${RESEND_API}/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Resend receiving fetch failed: ${res.status}`);
  return res.json();
};

/**
 * POST /api/inbound/resend
 */
const receiveResendEmail = async (req, res) => {
  try {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
    if (!verifyResendSignature(rawBody, req.headers)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.body || {};
    if (event.type !== 'email.received') {
      return res.status(200).json({ ok: true, ignored: event.type || 'unknown' });
    }

    const data = event.data || {};
    const taskId = extractTaskId([...(data.to || []), ...(data.received_for || [])]);
    if (!taskId) return res.status(200).json({ ok: true, skipped: 'no task address' });

    const task = await Task.findById(taskId);
    if (!task || !task.board) return res.status(200).json({ ok: true, skipped: 'task not found' });

    // The webhook carries no body — fetch it.
    let text = '';
    try {
      const full = await fetchReceivedBody(data.email_id);
      text = cleanReply(full.text || '');
      if (!text && full.html) text = cleanReply(String(full.html).replace(/<[^>]+>/g, ' '));
    } catch (fetchErr) {
      console.error('inbound body fetch error:', fetchErr);
      return res.status(500).json({ error: 'Could not fetch email body' }); // let Resend retry
    }
    if (!text) return res.status(200).json({ ok: true, skipped: 'empty body' });

    const senderEmail = parseFromAddress(data.from);

    // Authorise the sender: a team User who can read the board, else the task's
    // own ClientContact. Unknown senders are dropped (acknowledged, not stored).
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
    if (!authorType) {
      return res.status(200).json({ ok: true, skipped: 'sender not authorised' });
    }

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
      // Alert the team, and record in the Activity Log as a client message.
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
        console.error('inbound client notify error:', notifyErr);
      }
      logActivity({
        task,
        actorType: 'client',
        actorLabel,
        type: 'client.update_added',
        metadata: { updateSnippet: snippet },
      });
    } else {
      // Team member replied by email. Log it, and if this is a client task email
      // the client (reuse the portal reply hook).
      logActivity({ task, actor: String(author), type: 'update.added', metadata: { updateSnippet: snippet } });
      try {
        const { sendPortalReplyEmailForTask } = require('./portalController');
        sendPortalReplyEmailForTask(task, text);
      } catch (hookErr) {
        console.error('inbound portal reply hook error:', hookErr);
      }
    }

    return res.status(200).json({ ok: true, updateId: String(update._id) });
  } catch (err) {
    console.error('receiveResendEmail error:', err);
    // 500 → Resend retries (it retains inbound mail), so a transient failure
    // isn't lost.
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { receiveResendEmail };
