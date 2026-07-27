const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.resend.com',
  port: 465,
  secure: true,
  auth: {
    user: 'resend',
    pass: process.env.RESEND_API_KEY,
  },
});

/**
 * A SEPARATE transporter for the Client Portal emails (invite / reply / resolved),
 * which send from the team's own Gmail over SMTP — no third-party email API. Set
 * GMAIL_USER + GMAIL_APP_PASSWORD (a Google App Password, not the account
 * password). Built lazily and cached so the app still boots when the vars are
 * absent; the portal senders are all best-effort and log on failure.
 */
let portalTransporter = null;
const getPortalTransporter = () => {
  if (portalTransporter) return portalTransporter;
  portalTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return portalTransporter;
};

// The From for portal mail — the team's Gmail. GMAIL_FROM lets you set a
// friendly "Name <addr>" form; otherwise the raw Gmail address is used.
const portalFrom = () =>
  process.env.GMAIL_FROM || process.env.GMAIL_USER || 'noreply@davnoot.com';

const PRIORITY_LABELS = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const PRIORITY_BG = {
  critical: '#DC2626',
  high: '#EA580C',
  medium: '#D97706',
  low: '#6B7280',
};

const escapeHtml = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

const buildHtml = ({ taskName, priority, dueDate, taskLink }) => {
  const priorLabel = escapeHtml(PRIORITY_LABELS[priority] || priority);
  const priorBg = PRIORITY_BG[priority] || '#6B7280';
  const dueDateStr = dueDate
    ? new Date(dueDate).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : 'No due date set';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New task assigned</title>
  <style>
    body { margin: 0; padding: 0; background: #F3F4F8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif; }
    .wrapper { max-width: 560px; margin: 40px auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .header { background: #2563EB; padding: 28px 32px; }
    .header-logo { font-size: 22px; font-weight: 800; color: #FFFFFF; letter-spacing: -0.02em; }
    .body { padding: 32px; }
    .title { font-size: 20px; font-weight: 700; color: #111827; margin: 0 0 6px; }
    .subtitle { font-size: 14px; color: #6B7280; margin: 0 0 24px; line-height: 1.5; }
    .task-card { background: #F9FAFB; border: 1.5px solid #E5E7EB; border-radius: 10px; padding: 20px 24px; margin-bottom: 28px; }
    .task-name { font-size: 16px; font-weight: 600; color: #111827; margin: 0 0 18px; }
    .meta-row { display: flex; align-items: flex-start; gap: 28px; flex-wrap: wrap; }
    .meta-item { display: flex; flex-direction: column; gap: 4px; }
    .meta-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #9CA3AF; }
    .priority-badge { display: inline-block; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 9999px; color: #FFFFFF; background: ${priorBg}; }
    .meta-value { font-size: 13px; font-weight: 500; color: #374151; }
    .cta { text-align: center; }
    .cta a { display: inline-block; background: #2563EB; color: #FFFFFF !important; font-size: 14px; font-weight: 600; padding: 13px 32px; border-radius: 8px; text-decoration: none; }
    .footer { background: #F9FAFB; border-top: 1px solid #E5E7EB; padding: 18px 32px; }
    .footer p { font-size: 12px; color: #9CA3AF; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="header-logo">Macan</div>
    </div>
    <div class="body">
      <p class="title">You've been assigned a task</p>
      <p class="subtitle">A new task has been assigned to you. Review the details below and click the button to open it.</p>
      <div class="task-card">
        <p class="task-name">${escapeHtml(taskName)}</p>
        <div class="meta-row">
          <div class="meta-item">
            <span class="meta-label">Priority</span>
            <span class="priority-badge">${priorLabel}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Due Date</span>
            <span class="meta-value">${escapeHtml(dueDateStr)}</span>
          </div>
        </div>
      </div>
      <div class="cta">
        <a href="${taskLink}">View Task &rarr;</a>
      </div>
    </div>
    <div class="footer">
      <p>You received this email because a task was assigned to you in Macan. If you believe this is an error, contact your administrator.</p>
    </div>
  </div>
</body>
</html>`;
};

/**
 * Send a task-assignment email to a single recipient.
 *
 * @param {object} opts
 * @param {string} opts.to         — recipient email address
 * @param {string} opts.taskName   — task title
 * @param {string} opts.priority   — "critical" | "high" | "medium" | "low"
 * @param {Date|string|null} opts.dueDate  — optional due date
 * @param {string} opts.taskLink   — direct URL to the board/task
 */
const sendTaskAssignmentEmail = async ({ to, taskName, priority, dueDate, taskLink }) => {
  const html = buildHtml({ taskName, priority, dueDate, taskLink });
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'noreply@davnoot.com',
    to,
    subject: `You've been assigned: ${taskName}`,
    html,
  });
};

const buildInviteHtml = ({ orgName, inviteLink, inviteCode }) => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You're invited to join ${escapeHtml(orgName)}</title>
  <style>
    body { margin: 0; padding: 0; background: #F3F4F8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif; }
    .wrapper { max-width: 560px; margin: 40px auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .header { background: #2563EB; padding: 28px 32px; }
    .header-logo { font-size: 22px; font-weight: 800; color: #FFFFFF; letter-spacing: -0.02em; }
    .body { padding: 32px; }
    .title { font-size: 20px; font-weight: 700; color: #111827; margin: 0 0 6px; }
    .subtitle { font-size: 14px; color: #6B7280; margin: 0 0 24px; line-height: 1.5; }
    .code-box { background: #F3F4F8; border: 1.5px solid #E5E7EB; border-radius: 10px; padding: 16px 24px; margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between; }
    .code-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #9CA3AF; margin-bottom: 4px; }
    .code-value { font-size: 20px; font-weight: 700; color: #111827; letter-spacing: 0.08em; font-family: 'Courier New', monospace; }
    .divider { border: none; border-top: 1px solid #E5E7EB; margin: 24px 0; }
    .cta { text-align: center; }
    .cta a { display: inline-block; background: #2563EB; color: #FFFFFF !important; font-size: 14px; font-weight: 600; padding: 13px 32px; border-radius: 8px; text-decoration: none; }
    .footer { background: #F9FAFB; border-top: 1px solid #E5E7EB; padding: 18px 32px; }
    .footer p { font-size: 12px; color: #9CA3AF; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="header-logo">Macan</div>
    </div>
    <div class="body">
      <p class="title">You've been invited to join ${escapeHtml(orgName)}</p>
      <p class="subtitle">An admin has invited you to collaborate on <strong>${escapeHtml(orgName)}</strong> in Macan. Use the invite code below or click the button to join.</p>
      <div class="code-box">
        <div>
          <div class="code-label">Invite Code</div>
          <div class="code-value">${escapeHtml(inviteCode)}</div>
        </div>
      </div>
      <hr class="divider" />
      <div class="cta">
        <a href="${inviteLink}">Join ${escapeHtml(orgName)} &rarr;</a>
      </div>
    </div>
    <div class="footer">
      <p>You received this invite from an admin of ${escapeHtml(orgName)}. If you don't recognise this, you can safely ignore this email.</p>
    </div>
  </div>
</body>
</html>`;
};

/**
 * Send an organisation invite email.
 *
 * @param {object} opts
 * @param {string} opts.to         — recipient email address
 * @param {string} opts.orgName    — organisation name
 * @param {string} opts.inviteLink — full URL to join the org
 * @param {string} opts.inviteCode — raw invite code (for manual entry)
 */
const sendInviteEmail = async ({ to, orgName, inviteLink, inviteCode }) => {
  const html = buildInviteHtml({ orgName, inviteLink, inviteCode });
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'noreply@davnoot.com',
    to,
    subject: `You've been invited to join ${orgName} on Macan`,
    html,
  });
};

const buildMentionHtml = ({ mentionedByName, taskName, commentText, taskLink }) => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You were mentioned in a comment</title>
  <style>
    body { margin: 0; padding: 0; background: #F3F4F8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif; }
    .wrapper { max-width: 560px; margin: 40px auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .header { background: #2563EB; padding: 28px 32px; }
    .header-logo { font-size: 22px; font-weight: 800; color: #FFFFFF; letter-spacing: -0.02em; }
    .body { padding: 32px; }
    .title { font-size: 20px; font-weight: 700; color: #111827; margin: 0 0 6px; }
    .subtitle { font-size: 14px; color: #6B7280; margin: 0 0 24px; line-height: 1.5; }
    .comment-card { background: #F9FAFB; border: 1.5px solid #E5E7EB; border-radius: 10px; padding: 20px 24px; margin-bottom: 28px; }
    .comment-author { font-size: 13px; font-weight: 600; color: #374151; margin: 0 0 8px; }
    .comment-text { font-size: 14px; color: #111827; line-height: 1.55; margin: 0; white-space: pre-wrap; word-break: break-word; }
    .task-name { font-size: 12px; font-weight: 600; color: #6B7280; margin: 16px 0 0; }
    .cta { text-align: center; }
    .cta a { display: inline-block; background: #2563EB; color: #FFFFFF !important; font-size: 14px; font-weight: 600; padding: 13px 32px; border-radius: 8px; text-decoration: none; }
    .footer { background: #F9FAFB; border-top: 1px solid #E5E7EB; padding: 18px 32px; }
    .footer p { font-size: 12px; color: #9CA3AF; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="header-logo">Macan</div>
    </div>
    <div class="body">
      <p class="title">You were mentioned in a comment</p>
      <p class="subtitle"><strong>${escapeHtml(mentionedByName)}</strong> mentioned you in a comment on a task.</p>
      <div class="comment-card">
        <p class="comment-author">${escapeHtml(mentionedByName)} wrote:</p>
        <p class="comment-text">${escapeHtml(commentText)}</p>
        <p class="task-name">Task: ${escapeHtml(taskName)}</p>
      </div>
      <div class="cta">
        <a href="${taskLink}">View Task &rarr;</a>
      </div>
    </div>
    <div class="footer">
      <p>You received this email because you were mentioned in a comment in Macan. If you believe this is an error, contact your administrator.</p>
    </div>
  </div>
</body>
</html>`;
};

/**
 * Send a mention-notification email to a single recipient.
 *
 * @param {object} opts
 * @param {string} opts.to              — recipient email address
 * @param {string} opts.mentionedByName — name of the person who mentioned them
 * @param {string} opts.taskName        — task title
 * @param {string} opts.commentText     — the comment body
 * @param {string} opts.taskLink        — direct URL to the board/task
 */
const sendMentionEmail = async ({ to, mentionedByName, taskName, commentText, taskLink }) => {
  const html = buildMentionHtml({ mentionedByName, taskName, commentText, taskLink });
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'noreply@davnoot.com',
    to,
    subject: `${mentionedByName} mentioned you in "${taskName}"`,
    html,
  });
};

/**
 * Email a task's audience (assignees + followers) when someone posts an update —
 * works for every board, not just client portals. Same visual language as the
 * mention email; only the framing copy differs.
 */
const buildUpdateHtml = ({ authorName, taskName, commentText, taskLink }) =>
  buildMentionHtml({ mentionedByName: authorName, taskName, commentText, taskLink })
    .replace('You were mentioned in a comment', 'New update on a task')
    .replace(
      `<strong>${escapeHtml(authorName)}</strong> mentioned you in a comment on a task.`,
      `<strong>${escapeHtml(authorName)}</strong> posted an update on a task you're assigned to or following.`
    )
    .replace(
      'You received this email because you were mentioned in a comment in Macan. If you believe this is an error, contact your administrator.',
      "You received this email because you're assigned to or following this task in Macan. Manage this in your notification settings."
    );

const sendUpdateEmail = async ({ to, authorName, taskName, commentText, taskLink, taskId }) => {
  const html = buildUpdateHtml({ authorName, taskName, commentText, taskLink });
  const replyTo = taskReplyAddress(taskId);
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'noreply@davnoot.com',
    ...(replyTo ? { replyTo } : {}),
    to,
    subject: `New update on "${taskName}"`,
    html,
  });
};

/**
 * Shared shell for the Client Portal emails — same visual language as the app
 * emails above, but addressed to an EXTERNAL client (not an app user). `title`
 * and `intro` set the header copy; `bodyCard` is raw inner HTML; `ctaLabel` /
 * `ctaLink` render the button (omitted when no link).
 */
const buildPortalHtml = ({ orgName, title, intro, bodyCard, ctaLabel, ctaLink }) => {
  const cta = ctaLink
    ? `<div class="cta"><a href="${ctaLink}">${escapeHtml(ctaLabel || 'Open')} &rarr;</a></div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; padding: 0; background: #F3F4F8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif; }
    .wrapper { max-width: 560px; margin: 40px auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .header { background: #2563EB; padding: 28px 32px; }
    .header-logo { font-size: 22px; font-weight: 800; color: #FFFFFF; letter-spacing: -0.02em; }
    .body { padding: 32px; }
    .title { font-size: 20px; font-weight: 700; color: #111827; margin: 0 0 6px; }
    .subtitle { font-size: 14px; color: #6B7280; margin: 0 0 24px; line-height: 1.5; }
    .card { background: #F9FAFB; border: 1.5px solid #E5E7EB; border-radius: 10px; padding: 20px 24px; margin-bottom: 28px; }
    .card-text { font-size: 14px; color: #111827; line-height: 1.55; margin: 0; white-space: pre-wrap; word-break: break-word; }
    .card-label { font-size: 12px; font-weight: 600; color: #6B7280; margin: 0 0 8px; }
    .cta { text-align: center; }
    .cta a { display: inline-block; background: #2563EB; color: #FFFFFF !important; font-size: 14px; font-weight: 600; padding: 13px 32px; border-radius: 8px; text-decoration: none; }
    .footer { background: #F9FAFB; border-top: 1px solid #E5E7EB; padding: 18px 32px; }
    .footer p { font-size: 12px; color: #9CA3AF; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="header-logo">${escapeHtml(orgName || 'Client Portal')}</div>
    </div>
    <div class="body">
      <p class="title">${escapeHtml(title)}</p>
      <p class="subtitle">${intro}</p>
      ${bodyCard || ''}
      ${cta}
    </div>
    <div class="footer">
      <p>You received this email because you're using the ${escapeHtml(orgName || 'client')} portal. If you don't recognise this, you can safely ignore it.</p>
    </div>
  </div>
</body>
</html>`;
};

/**
 * Email a client their portal INVITATION link. Opening it lands them on the
 * portal landing page, where "Accept invitation" starts Google sign-in. The link
 * is the group's public portal URL (`/portal/:portalToken`) — no passcode, no
 * one-time token. Sends from the team's Gmail.
 * @param {object} opts
 * @param {string} opts.to        — client email
 * @param {string} opts.orgName   — organisation name (branding)
 * @param {string} opts.clientName— client/company label
 * @param {string} opts.link      — full /portal/:portalToken URL
 */
const sendPortalInviteEmail = async ({ to, orgName, clientName, link }) => {
  const html = buildPortalHtml({
    orgName,
    title: "You've been invited to your support portal",
    intro: `You've been invited to the ${escapeHtml(
      clientName || orgName || ''
    )} support portal, where you can raise issues and track their progress. Click below to accept — you'll sign in securely with your Google account.`,
    ctaLabel: 'Accept invitation',
    ctaLink: link,
  });
  await getPortalTransporter().sendMail({
    from: portalFrom(),
    to,
    subject: `You're invited to the ${orgName || 'client'} support portal`,
    html,
  });
};

/**
 * Email the client when a team member replies on one of their issues.
 * @param {object} opts
 * @param {string} opts.to, opts.orgName, opts.taskName, opts.snippet, opts.link
 */
/**
 * The plus-addressed reply address for a task, e.g. `automations+task-<id>@davnoot.com`.
 * Replies to it land in the GMAIL_USER inbox and the IMAP poller turns them into
 * updates. Null when GMAIL_USER isn't set.
 */
const taskReplyAddress = (taskId) => {
  const base = process.env.GMAIL_USER || '';
  const at = base.indexOf('@');
  if (!taskId || at <= 0) return null;
  return `${base.slice(0, at)}+task-${taskId}@${base.slice(at + 1)}`;
};

const sendPortalReplyEmail = async ({ to, orgName, taskName, snippet, link, taskId }) => {
  const html = buildPortalHtml({
    orgName,
    title: 'New reply on your issue',
    intro: `The team replied on your issue <strong>${escapeHtml(taskName)}</strong>. You can reply straight from your email.`,
    bodyCard: snippet
      ? `<div class="card"><p class="card-label">Reply</p><p class="card-text">${escapeHtml(
          snippet
        )}</p></div>`
      : '',
    ctaLabel: 'View the conversation',
    ctaLink: link,
  });
  const replyTo = taskReplyAddress(taskId);
  await getPortalTransporter().sendMail({
    from: portalFrom(),
    ...(replyTo ? { replyTo } : {}),
    to,
    subject: `New reply on "${taskName}"`,
    html,
  });
};

/**
 * Email the client when their issue is marked resolved.
 * @param {object} opts
 * @param {string} opts.to, opts.orgName, opts.taskName, opts.link
 */
const sendPortalResolvedEmail = async ({ to, orgName, taskName, link }) => {
  const html = buildPortalHtml({
    orgName,
    title: 'Your issue was resolved',
    intro: `Your issue <strong>${escapeHtml(
      taskName
    )}</strong> has been marked as resolved. If it still needs attention, reply on the thread and we'll take another look.`,
    ctaLabel: 'View my issues',
    ctaLink: link,
  });
  await getPortalTransporter().sendMail({
    from: portalFrom(),
    to,
    subject: `Resolved: "${taskName}"`,
    html,
  });
};

module.exports = {
  sendTaskAssignmentEmail,
  sendInviteEmail,
  sendMentionEmail,
  sendUpdateEmail,
  sendPortalInviteEmail,
  sendPortalReplyEmail,
  sendPortalResolvedEmail,
};
