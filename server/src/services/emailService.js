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

// All the INTERNAL app emails (assignment, mention, invite, update) go through
// Gmail too when it's configured — so the workspace needs ONE mail provider and
// no Resend domain verification. Falls back to the Resend transporter only if
// Gmail creds are absent.
const gmailReady = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const appTransporter = () => (gmailReady() ? getPortalTransporter() : transporter);
const appFrom = () => (gmailReady() ? portalFrom() : process.env.EMAIL_FROM || 'noreply@davnoot.com');

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

const buildHtml = ({ taskName, priority, dueDate, taskLink, assignedByName }) => {
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
      <p class="title">${assignedByName ? `${escapeHtml(assignedByName)} assigned you a task` : "You've been assigned a task"}</p>
      <p class="subtitle">${assignedByName ? `<strong>${escapeHtml(assignedByName)}</strong> assigned this task to you.` : 'A new task has been assigned to you.'} Review the details below and click the button to open it.</p>
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
const sendTaskAssignmentEmail = async ({ to, taskName, priority, dueDate, taskLink, assignedByName }) => {
  const html = buildHtml({ taskName, priority, dueDate, taskLink, assignedByName });
  await appTransporter().sendMail({
    from: appFrom(),
    to,
    subject: assignedByName
      ? `${assignedByName} assigned you "${taskName}"`
      : `You've been assigned: ${taskName}`,
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
  await appTransporter().sendMail({
    from: appFrom(),
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
  await appTransporter().sendMail({
    from: appFrom(),
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
const buildUpdateHtml = ({ authorName, taskName, commentText, taskLink, thread }) =>
  buildMentionHtml({ mentionedByName: authorName, taskName, commentText, taskLink })
    .replace(
      'You were mentioned in a comment',
      thread === 'client' ? 'New message on the client thread' : 'New update on a task'
    )
    .replace(
      `<strong>${escapeHtml(authorName)}</strong> mentioned you in a comment on a task.`,
      thread === 'client'
        ? `<strong>${escapeHtml(authorName)}</strong> posted on the CLIENT thread of a task you're assigned to or following. The client can read this thread &mdash; including anything you send by replying to this email.`
        : `<strong>${escapeHtml(authorName)}</strong> posted an update on a task you're assigned to or following.`
    )
    .replace(
      'You received this email because you were mentioned in a comment in Macan. If you believe this is an error, contact your administrator.',
      "You received this email because you're assigned to or following this task in Macan. Manage this in your notification settings."
    );

/**
 * Email a task's audience about a new post.
 *
 * `thread` picks the framing AND — more importantly — the Reply-To, because on a
 * client board the two threads have different audiences and hitting reply must
 * land in the same one the mail came from:
 *
 *   'team'    — the team thread (Updates). Reply-To is the INTERNAL task address,
 *               so a reply stays team-only. Using the plain address here would
 *               publish that reply to the client and email it to them.
 *   'client'  — the client-facing thread. Plain address, and the copy says so, so
 *               nobody replies to an external audience by accident.
 *   'default' — a standard board: one thread, no client, no warning needed.
 */
const sendUpdateEmail = async ({ to, authorName, taskName, commentText, taskLink, taskId, thread = 'default' }) => {
  const html = buildUpdateHtml({ authorName, taskName, commentText, taskLink, thread });
  const replyTo = taskReplyAddress(taskId, { internal: thread === 'team' });
  await appTransporter().sendMail({
    from: appFrom(),
    ...(replyTo ? { replyTo } : {}),
    to,
    subject:
      thread === 'client'
        ? `${authorName} posted on the client thread of "${taskName}"`
        : `${authorName} posted an update on "${taskName}"`,
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
 * Email a client their portal INVITATION link, for clients who sign in with
 * GOOGLE. Opening it lands them on the portal landing page, where "Accept
 * invitation" starts Google sign-in. The link is the group's public portal URL
 * (`/portal/:portalToken`) — no passcode, no one-time token. Sends from the
 * team's Gmail.
 *
 * Clients without a Google account get sendPortalPasswordInviteEmail instead.
 *
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
 * The coloured list of services in a multi-service invitation.
 *
 * `linked` is false for the password flow, and that is not a styling choice: a
 * client who has not chosen a password yet cannot open a service link, so every
 * row would be a dead end. One CTA, one destination — the set-password link.
 */
const portalServiceRows = (services, { linked = true } = {}) =>
  (services || [])
    .map((s) => {
      const dot = `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${escapeHtml(
        s.color || '#2563EB'
      )};margin-right:10px;vertical-align:middle;"></span>`;
      const label = escapeHtml(s.name || '');
      const text =
        linked && s.link
          ? `<a href="${s.link}" style="color:#111827;text-decoration:none;font-weight:600;">${label}</a>`
          : `<span style="color:#111827;font-weight:600;">${label}</span>`;
      return `<tr><td style="padding:9px 0;border-bottom:1px solid #E5E7EB;font-size:14px;">${dot}${text}</td></tr>`;
    })
    .join('');

/**
 * Email a client their portal invitation when they have been set up for one or
 * more SERVICES — the multi-service form of sendPortalInviteEmail.
 *
 * ONE EMAIL PER PERSON, however many services they manage. That is the whole
 * point of the batch invite: an address appearing on four rows of the invite
 * table produces this message once, listing four services, rather than four
 * near-identical emails a client would reasonably read as a mistake.
 *
 * A single service gets a specific title and a CTA straight into it; several get
 * a general title and a linked list, because "Open SEO" is wrong when three of
 * the four things they were given are not SEO.
 *
 * @param {object}   opts
 * @param {string}   opts.to
 * @param {string}   opts.orgName
 * @param {string}   opts.clientName
 * @param {string}   opts.link      — the bare /portal/:portalToken URL
 * @param {Array}    opts.services  — [{ name, color, link }]
 */
const sendPortalServicesInviteEmail = async ({ to, orgName, clientName, link, services = [] }) => {
  const company = clientName || orgName || '';
  const one = services.length === 1 ? services[0] : null;

  const html = buildPortalHtml({
    orgName,
    title: one
      ? `You've been invited to your ${escapeHtml(one.name)} portal`
      : "You've been invited to your client portal",
    intro: one
      ? `You've been set up on the ${escapeHtml(company)} portal for <b>${escapeHtml(
        one.name
      )}</b>, where you can raise requests, chat with the team and send messages. Click below to accept — you'll sign in securely with your Google account.`
      : `You've been set up on the ${escapeHtml(company)} portal for ${
        services.length
      } services. For each one you can raise requests, chat with the team and send messages. Click below to accept — you'll sign in securely with your Google account.`,
    bodyCard: services.length
      ? `<div class="card"><p class="card-label">${
        one ? 'YOUR SERVICE' : 'YOUR SERVICES'
      }</p><table style="width:100%;border-collapse:collapse;">${portalServiceRows(
        services
      )}</table></div>`
      : '',
    ctaLabel: one ? `Open ${one.name}` : 'Open my portal',
    ctaLink: one && one.link ? one.link : link,
  });

  await getPortalTransporter().sendMail({
    from: portalFrom(),
    to,
    subject: one
      ? `You're invited to the ${company} ${one.name} portal`
      : `You're invited to the ${company} client portal`,
    html,
  });
};

/**
 * The password-flow twin of the above: the client's address is not a Google
 * account, so the CTA must be their one-time set-password link.
 *
 * The service list is rendered UNLINKED here — see `portalServiceRows`.
 */
const sendPortalPasswordServicesInviteEmail = async ({
  to,
  orgName,
  clientName,
  link,
  services = [],
  expiresIn = '7 days',
}) => {
  const company = clientName || orgName || '';
  const one = services.length === 1 ? services[0] : null;

  const serviceBlock =
    services.length > 1
      ? '<p class="card-label" style="margin-top:16px;">YOUR SERVICES</p>' +
        '<table style="width:100%;border-collapse:collapse;">' +
        portalServiceRows(services, { linked: false }) +
        '</table>'
      : '';

  const html = buildPortalHtml({
    orgName,
    title: 'Set up your client portal',
    intro:
      "You've been set up on the " +
      escapeHtml(company) +
      ' portal' +
      (one ? ' for <b>' + escapeHtml(one.name) + '</b>' : '') +
      '. Choose a password below and you can raise requests, chat with the team and send messages.',
    bodyCard:
      '<div class="card"><p class="card-label">SIGNING IN AS</p>' +
      '<p class="card-text">' + escapeHtml(to) + '</p>' +
      serviceBlock +
      '<p class="card-label" style="margin-top:16px;">THIS LINK EXPIRES IN ' +
      escapeHtml(String(expiresIn).toUpperCase()) +
      '</p><p class="card-text">It can only be used once.</p></div>',
    ctaLabel: 'Set my password',
    ctaLink: link,
  });

  await getPortalTransporter().sendMail({
    from: portalFrom(),
    to,
    subject: 'Set up your ' + company + ' client portal',
    html,
  });
};

/**
 * Tell a client that a team message is waiting in their portal.
 *
 * NOTIFY-ONLY. Chat and mail live inside Macan and have no inbound email path,
 * so this deliberately sets NO `Reply-To` — see services/portalNotify.js, which
 * owns when this is sent and is the only thing that should call it.
 *
 * The copy names the SERVICE, because a client with four of them needs to know
 * which one is waiting before deciding whether to open it now.
 */
const sendPortalNewMessageEmail = async ({
  to,
  orgName,
  clientName,
  serviceName,
  mode = 'chat',
  authorName = '',
  subject = null,
  snippet = '',
  link,
}) => {
  const who = authorName ? escapeHtml(authorName) : 'Someone';
  const where = escapeHtml(serviceName || '');
  const isMail = mode === 'mail';

  const card = subject
    ? '<div class="card"><p class="card-label">' + escapeHtml(subject) + '</p>' +
      '<p class="card-text">' + escapeHtml(snippet) + '</p></div>'
    : snippet
      ? '<div class="card"><p class="card-text">' + escapeHtml(snippet) + '</p></div>'
      : '';

  const html = buildPortalHtml({
    orgName,
    title: 'You have a new message',
    intro:
      who + ' sent you a message in the <b>' + where + '</b> ' +
      (isMail ? 'mailbox' : 'chat') + ' on the ' + escapeHtml(clientName || orgName || '') +
      ' portal. Replies happen in the portal — this email is just a heads-up.',
    bodyCard: card,
    ctaLabel: 'Open my portal',
    ctaLink: link,
  });

  await getPortalTransporter().sendMail({
    from: portalFrom(),
    to,
    subject: isMail
      ? 'New message in your ' + (serviceName || 'client') + ' mailbox'
      : (authorName || 'Someone') + ' sent you a message about ' + (serviceName || 'your portal'),
    html,
  });
};

/**
 * The daily catch-all: everything still unread across every service, once.
 *
 * The companion to the first-unread email rather than a replacement for it. That
 * one is prompt and per-conversation; this one exists for the client who has not
 * opened the portal all day and whose six-hour ceiling has quietly lapsed.
 *
 * A contact with nothing unread gets NOTHING — see services/portalDigestRunner.js.
 * An empty digest is how a digest gets filtered to a folder nobody opens.
 */
const sendPortalDigestEmail = async ({ to, orgName, clientName, name = '', rows = [], link }) => {
  const body = rows
    .map((r) => {
      const bits = [];
      if (r.chat) bits.push(r.chat + ' new message' + (r.chat === 1 ? '' : 's'));
      if (r.mail) bits.push(r.mail + ' new mail');
      if (r.requests) bits.push(r.requests + ' request update' + (r.requests === 1 ? '' : 's'));
      const dot =
        '<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:' +
        escapeHtml(r.color || '#2563EB') + ';margin-right:10px;vertical-align:middle;"></span>';
      return (
        '<tr><td style="padding:9px 0;border-bottom:1px solid #E5E7EB;font-size:14px;">' + dot +
        '<span style="color:#111827;font-weight:600;">' + escapeHtml(r.name) + '</span>' +
        '<span style="color:#6B7280;"> — ' + escapeHtml(bits.join(' · ')) + '</span></td></tr>'
      );
    })
    .join('');

  const html = buildPortalHtml({
    orgName,
    title: 'Waiting for you in your portal',
    intro:
      (name ? escapeHtml(name.split(' ')[0]) + ', there' : 'There') +
      ' are updates on the ' + escapeHtml(clientName || orgName || '') + ' portal you have not read yet.',
    bodyCard:
      '<div class="card"><table style="width:100%;border-collapse:collapse;">' + body + '</table></div>',
    ctaLabel: 'Open my portal',
    ctaLink: link,
  });

  await getPortalTransporter().sendMail({
    from: portalFrom(),
    to,
    subject: 'Your ' + (clientName || orgName || 'client') + ' portal — what is waiting',
    html,
  });
};

/**
 * Email a client a ONE-TIME link to choose their portal password. This is the
 * invitation for clients whose email isn't a Google account — the link carries a
 * single-use token and drops them on the set-password page, after which they
 * sign in with email + password like any normal login.
 *
 * Unlike the Google invite, this link is per-person and expires, so it must not
 * be forwarded.
 *
 * @param {object} opts
 * @param {string} opts.to        — client email
 * @param {string} opts.orgName   — organisation name (branding)
 * @param {string} opts.clientName— client/company label
 * @param {string} opts.link      — full /portal/:portalToken/set-password?t=… URL
 * @param {string} opts.expiresIn — human expiry, e.g. '7 days'
 */
const sendPortalPasswordInviteEmail = async ({ to, orgName, clientName, link, expiresIn = '7 days' }) => {
  const html = buildPortalHtml({
    orgName,
    title: 'Set up your support portal',
    intro: `You've been invited to the ${escapeHtml(
      clientName || orgName || ''
    )} support portal, where you can raise issues and track their progress. Choose a password below to get started — you'll use it with this email address to sign in from now on. This link works once and expires in ${escapeHtml(
      expiresIn
    )}.`,
    bodyCard: `<div class="card"><p class="card-label">Signing in as</p><p class="card-text">${escapeHtml(
      to
    )}</p></div>`,
    ctaLabel: 'Set my password',
    ctaLink: link,
  });
  await getPortalTransporter().sendMail({
    from: portalFrom(),
    to,
    subject: `Set up your ${orgName || 'client'} support portal`,
    html,
  });
};

/**
 * Email a client a ONE-TIME link to replace a forgotten portal password.
 * Same machinery as the invite above, shorter expiry, and worded so an
 * unrequested one is obviously safe to ignore.
 *
 * @param {object} opts
 * @param {string} opts.to, opts.orgName, opts.clientName, opts.link
 * @param {string} opts.expiresIn — human expiry, e.g. '24 hours'
 */
const sendPortalPasswordResetEmail = async ({ to, orgName, clientName, link, expiresIn = '24 hours' }) => {
  const html = buildPortalHtml({
    orgName,
    title: 'Reset your portal password',
    intro: `Someone asked to reset the password for your ${escapeHtml(
      clientName || orgName || ''
    )} support portal account. Choose a new one below — the link works once and expires in ${escapeHtml(
      expiresIn
    )}. If this wasn't you, ignore this email and your current password stays as it is.`,
    bodyCard: `<div class="card"><p class="card-label">Account</p><p class="card-text">${escapeHtml(
      to
    )}</p></div>`,
    ctaLabel: 'Choose a new password',
    ctaLink: link,
  });
  await getPortalTransporter().sendMail({
    from: portalFrom(),
    to,
    subject: `Reset your ${orgName || 'client'} portal password`,
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
 *
 * `{ internal: true }` appends the `-int` tag → `+task-<id>-int@…`. Gmail ignores
 * everything after the first `+`, so it still delivers to the same inbox; the
 * inbound pipeline reads the tag back and files the reply in the team-only thread
 * (see services/inboundEmail.js). The tag is only ever put on mail addressed to
 * team Users — never on a client's, whose replies must stay shared.
 */
const taskReplyAddress = (taskId, { internal = false } = {}) => {
  const base = process.env.GMAIL_USER || '';
  const at = base.indexOf('@');
  if (!taskId || at <= 0) return null;
  const tag = `task-${taskId}${internal ? '-int' : ''}`;
  return `${base.slice(0, at)}+${tag}@${base.slice(at + 1)}`;
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
 * Email the client when the team publishes a task to their portal — the team
 * asking something OF the client, so the copy frames it as a request rather than
 * as progress on a ticket they raised.
 *
 * Reply-To is the task's plain (non-`-int`) address: the inbound poller resolves
 * a sender against the group's contacts, so the client can answer from their
 * mail client and land in the shared thread.
 *
 * @param {object} opts
 * @param {string} opts.to        — client email
 * @param {string} opts.orgName   — organisation name (branding)
 * @param {string} opts.clientName— client/company label
 * @param {string} opts.taskName  — the request title
 * @param {string} opts.ref       — human reference, e.g. "REQ-1042"
 * @param {Date|string|null} opts.dueDate — optional date the team needs it by
 * @param {string} opts.note      — optional details (the same note the portal shows)
 * @param {string} opts.link      — full portal URL
 * @param {string} opts.taskId    — for the Reply-To address
 */
const sendPortalSharedTaskEmail = async ({
  to,
  orgName,
  clientName,
  taskName,
  ref,
  dueDate,
  note,
  link,
  taskId,
}) => {
  const dueStr = dueDate
    ? new Date(dueDate).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '';
  const bodyCard = `<div class="card">
        <p class="card-label">${escapeHtml(ref || 'Request')}</p>
        <p class="card-text">${escapeHtml(taskName)}</p>
        ${
          dueStr
            ? `<p class="card-label" style="margin-top:16px">Needed by</p><p class="card-text">${escapeHtml(
                dueStr
              )}</p>`
            : ''
        }
        ${
          note
            ? `<p class="card-label" style="margin-top:16px">Details</p><p class="card-text">${escapeHtml(
                note
              )}</p>`
            : ''
        }
      </div>`;
  const html = buildPortalHtml({
    orgName,
    title: 'A new request needs you',
    intro: `The ${escapeHtml(
      clientName || orgName || ''
    )} team added a request to your portal. Open it to see the details and upload anything they need — or just reply to this email.`,
    bodyCard,
    ctaLabel: 'Open my portal',
    ctaLink: link,
  });
  const replyTo = taskReplyAddress(taskId);
  await getPortalTransporter().sendMail({
    from: portalFrom(),
    ...(replyTo ? { replyTo } : {}),
    to,
    subject: `New request: "${taskName}"`,
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
  sendPortalServicesInviteEmail,
  sendPortalNewMessageEmail,
  sendPortalDigestEmail,
  sendPortalPasswordServicesInviteEmail,
  sendPortalPasswordInviteEmail,
  sendPortalPasswordResetEmail,
  sendPortalReplyEmail,
  sendPortalSharedTaskEmail,
  sendPortalResolvedEmail,
};

/* ---------------------------------------------------------------------------
 * The morning due-task digest.
 * ------------------------------------------------------------------------- */

/**
 * One row of the digest — a task with where it lives and how late it is.
 * Inline styles throughout, because email clients strip <style> blocks
 * unpredictably; the classes on the assignment email above survive most
 * clients, but a digest is read on phones at 9am and gets the paranoid
 * treatment.
 */
/**
 * One task row. A two-cell table per row rather than floats or flex: email
 * clients agree on almost nothing, but they agree on tables. The badge cell
 * carries a FIXED width and `white-space:nowrap`, so however long the task
 * name runs, the pill can never be squeezed into wrapping or pushed out of
 * its rounded edges — the name wraps instead, which is the right thing to
 * give way.
 */
const digestRow = ({ name, context, daysLate, priority }, { overdue, first }) => {
  const badgeText = overdue ? (daysLate === 1 ? '1 day late' : `${daysLate} days late`) : 'today';
  const badgeColor = overdue ? '#B91C1C' : '#1E40AF';
  const badgeBg = overdue ? '#FEF2F2' : '#EFF6FF';
  const badgeBorder = overdue ? '#FECACA' : '#BFDBFE';
  const borderTop = first ? 'border-top:0' : 'border-top:1px solid #F3F4F6';
  const prio = priority === 'critical' || priority === 'high'
    ? `<span style="color:${priority === 'critical' ? '#DC2626' : '#EA580C'};font-weight:700">&nbsp;&middot;&nbsp;${priority}</span>`
    : '';
  return `
        <tr>
          <td style="padding:11px 14px;${borderTop};vertical-align:top">
            <div style="font-size:14px;font-weight:600;color:#111827;line-height:1.4;word-break:break-word">${escapeHtml(name)}</div>
            <div style="font-size:12px;color:#9CA3AF;margin-top:2px">${escapeHtml(context)}${prio}</div>
          </td>
          <td width="92" align="right" style="padding:13px 14px 11px 4px;${borderTop};vertical-align:top;white-space:nowrap">
            <span style="display:inline-block;font-size:11px;line-height:16px;font-weight:600;color:${badgeColor};background:${badgeBg};border:1px solid ${badgeBorder};border-radius:999px;padding:2px 10px;white-space:nowrap">${badgeText}</span>
          </td>
        </tr>`;
};

const digestSection = (title, color, tasks, { overdue }) => {
  if (!tasks.length) return '';
  return `
      <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${color};margin:0 0 8px">${title} &middot; ${tasks.length}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #E5E7EB;border-radius:10px;border-collapse:separate;margin:0 0 20px">
${tasks.map((t, i) => digestRow(t, { overdue, first: i === 0 })).join('')}
      </table>`;
};

/**
 * The full document. Everything critical is INLINE (email clients strip or
 * sandbox <style> unpredictably); the one <style> block below is a pure
 * enhancement — tighter margins on small screens — that loses nothing when a
 * client throws it away. The container is width:100% with a max-width, so a
 * 360px phone gets a full-bleed card and a desktop client gets 560px centred.
 */
const buildDueDigestHtml = ({ name, overdue, dueToday, link }) => {
  const total = overdue.length + dueToday.length;
  const firstName = escapeHtml(String(name || '').trim().split(/\s+/)[0] || 'there');
  const summary = overdue.length
    ? `${total} task${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} you today &mdash; <strong style="color:#B91C1C">${overdue.length} overdue</strong>.`
    : `${total} task${total === 1 ? '' : 's'} due today. Clear morning, clear list.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Your tasks this morning</title>
<style>
  @media (max-width: 480px) {
    .dg-shell { padding: 0 !important; }
    .dg-card  { margin: 0 auto !important; border-radius: 0 !important; }
    .dg-pad   { padding-left: 20px !important; padding-right: 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#F3F4F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div class="dg-shell" style="padding:32px 12px">
    <div class="dg-card" style="max-width:560px;width:100%;margin:0 auto;background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
      <div class="dg-pad" style="background:#2563EB;padding:22px 28px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="padding-right:10px">
            <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:2px">
              <tr>
                <td style="width:9px;height:9px;background:#FFFFFF;border-radius:2px;font-size:0;line-height:0">&nbsp;</td>
                <td style="width:9px;height:9px;background:#FFFFFF;border-radius:2px;font-size:0;line-height:0">&nbsp;</td>
              </tr>
              <tr>
                <td style="width:9px;height:9px;background:#FFFFFF;border-radius:2px;font-size:0;line-height:0">&nbsp;</td>
                <td style="width:9px;height:9px;background:rgba(255,255,255,0.35);border-radius:2px;font-size:0;line-height:0">&nbsp;</td>
              </tr>
            </table>
          </td>
          <td style="font-size:20px;font-weight:800;color:#FFFFFF;letter-spacing:-0.02em">Macan</td>
        </tr></table>
      </div>
      <div class="dg-pad" style="padding:26px 28px">
        <p style="font-size:20px;font-weight:700;color:#111827;margin:0 0 6px">Good morning, ${firstName}</p>
        <p style="font-size:14px;color:#6B7280;margin:0 0 22px;line-height:1.5">${summary}</p>
        ${digestSection('Overdue', '#B91C1C', overdue, { overdue: true })}
        ${digestSection('Due today', '#1E40AF', dueToday, { overdue: false })}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td align="center" style="padding-top:6px">
            <a href="${link}" style="display:inline-block;background:#2563EB;color:#FFFFFF;font-size:14px;font-weight:600;line-height:20px;padding:12px 28px;border-radius:8px;text-decoration:none;white-space:nowrap">Open My Work &rarr;</a>
          </td>
        </tr></table>
      </div>
      <div class="dg-pad" style="background:#F9FAFB;border-top:1px solid #E5E7EB;padding:16px 28px">
        <p style="font-size:12px;color:#9CA3AF;margin:0;line-height:1.5">You get this each morning when tasks are due. Turn it off under Settings &rarr; Notifications &rarr; Due dates.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
};

/**
 * The 9am digest: everything overdue, everything due today, one email.
 * Sent by services/dueDigestRunner.js after the preference gate has already
 * said yes — this function formats and sends, nothing more.
 */
const sendDueDigestEmail = async ({ to, name, overdue = [], dueToday = [] }) => {
  const link = `${process.env.CLIENT_URL || 'http://localhost:5173'}/my-tasks`;
  const total = overdue.length + dueToday.length;
  const subject = overdue.length
    ? `${total} task${total === 1 ? '' : 's'} today — ${overdue.length} overdue`
    : `${total} task${total === 1 ? '' : 's'} due today`;
  const html = buildDueDigestHtml({ name, overdue, dueToday, link });
  await appTransporter().sendMail({ from: appFrom(), to, subject, html });
};

// Exported here rather than in the object above: that object is assigned
// mid-file, before this const exists, and a name in it would be read out of
// its temporal dead zone the moment anything requires this module.
module.exports.sendDueDigestEmail = sendDueDigestEmail;
// Exported for preview/test rendering; the sender above remains the one caller
// in production code.
module.exports.buildDueDigestHtml = buildDueDigestHtml;
