const cron = require('node-cron');
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
 * IMPORTANT: `imapflow` ships as an ES module, so it CANNOT be `require()`d from
 * this CommonJS server — doing so throws ERR_REQUIRE_ESM and would crash the
 * whole process on boot. We load it (and mailparser) lazily via dynamic import()
 * inside the poll, wrapped so any failure disables ONLY this feature.
 *
 * Disabled automatically when GMAIL_USER / GMAIL_APP_PASSWORD are unset.
 */

let started = false;
let running = false;
let libs = null; // { ImapFlow, simpleParser }, loaded once on first poll

const loadLibs = async () => {
  if (libs) return libs;
  const [imap, mp] = await Promise.all([import('imapflow'), import('mailparser')]);
  libs = { ImapFlow: imap.ImapFlow, simpleParser: mp.simpleParser };
  return libs;
};

const collectAddresses = (addressObj, out) => {
  if (addressObj && Array.isArray(addressObj.value)) {
    for (const v of addressObj.value) if (v && v.address) out.push(v.address);
  }
};

const poll = async () => {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return;

  let ImapFlow;
  let simpleParser;
  try {
    ({ ImapFlow, simpleParser } = await loadLibs());
  } catch (err) {
    console.error('[inbound-mail] could not load imapflow/mailparser — disabling this run:', err.message);
    return;
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    // Fail fast instead of hanging the poll on a slow/blocked network.
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });

  // CRITICAL: an ImapFlow instance with no 'error' listener CRASHES the whole
  // process when its socket errors/times out (Node treats an unhandled 'error'
  // event as fatal). Swallow it here — the next scheduled poll reconnects.
  client.on('error', (err) => {
    console.error('[inbound-mail] imap socket error (non-fatal):', err?.message || err);
  });

  try {
    await client.connect();
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
  console.log('inbound mail poller scheduled (Gmail IMAP)');
};

module.exports = { startInboundMailPoller };
