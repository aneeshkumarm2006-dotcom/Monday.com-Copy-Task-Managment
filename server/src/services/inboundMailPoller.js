const cron = require('node-cron');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { processInboundEmail } = require('./inboundEmail');

/**
 * Gmail "update via email" via IMAP polling.
 *
 * Gmail has no inbound webhook, so we poll the mailbox (GMAIL_USER) once a minute
 * over IMAP using the same App Password already used for SMTP. Each task exposes
 * a plus-addressed reply address — `<local>+task-<id>@<domain>` — which Gmail
 * delivers to the base inbox; we read the `+task-<id>` tag off the recipient to
 * know which task the message belongs to. Processing (authorise sender, create
 * the Update, notify, log) is shared with the Resend path via processInboundEmail.
 *
 * Disabled automatically when GMAIL_USER / GMAIL_APP_PASSWORD are unset.
 */

let started = false;
let running = false;

const collectAddresses = (addressObj, out) => {
  if (addressObj && Array.isArray(addressObj.value)) {
    for (const v of addressObj.value) if (v && v.address) out.push(v.address);
  }
};

const poll = async () => {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return;

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Only unseen messages; marking them seen after processing avoids re-work.
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return;

      for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
        try {
          const parsed = await simpleParser(msg.source);

          const recipients = [];
          collectAddresses(parsed.to, recipients);
          collectAddresses(parsed.cc, recipients);
          // Gmail strips the +tag from Delivered-To, but original headers keep it.
          const deliveredTo = parsed.headers.get('delivered-to');
          if (deliveredTo) recipients.push(String(deliveredTo));
          const xOriginalTo = parsed.headers.get('x-original-to');
          if (xOriginalTo) recipients.push(String(xOriginalTo));

          const from = parsed.from?.value?.[0]?.address || parsed.from?.text || '';
          const text = parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : '');

          const result = await processInboundEmail({ recipients, from, text });
          if (result?.skipped) {
            console.log(`[inbound-mail] uid ${msg.uid} skipped: ${result.skipped}`);
          }
        } catch (msgErr) {
          console.error('[inbound-mail] message error:', msgErr);
        } finally {
          // Mark seen either way so a permanently-unmatchable email isn't retried
          // forever. (Transient DB errors are rare; the trade-off favours not
          // reprocessing the same reply into duplicate updates.)
          try {
            await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
          } catch (flagErr) {
            console.error('[inbound-mail] flag error:', flagErr);
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
};

const startInboundMailPoller = () => {
  if (started) return;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log('inbound mail poller: GMAIL_USER/GMAIL_APP_PASSWORD not set — disabled');
    return;
  }
  started = true;
  cron.schedule('* * * * *', async () => {
    if (running) return; // overlap guard — a slow poll must not stack
    running = true;
    try {
      await poll();
    } catch (err) {
      console.error('[inbound-mail] poll error:', err);
    } finally {
      running = false;
    }
  });
  console.log('inbound mail poller started (Gmail IMAP)');
};

module.exports = { startInboundMailPoller };
