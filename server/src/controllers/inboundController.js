const crypto = require('crypto');
const { processInboundEmail } = require('../services/inboundEmail');

/**
 * Resend inbound-email webhook (optional / dormant). The workspace's default
 * inbound transport is the Gmail IMAP poller (services/inboundMailPoller) — this
 * exists only if someone wires Resend Inbound instead. It verifies Resend's Svix
 * signature, fetches the (metadata-only webhook's) body from the Receiving API,
 * then hands off to the shared processInboundEmail pipeline.
 *
 * Safe when unconfigured: with no RESEND_WEBHOOK_SECRET the signature check fails
 * and nothing is created.
 */

const RESEND_API = 'https://api.resend.com';

const verifyResendSignature = (rawBody, headers) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const sigHeader = headers['svix-signature'];
  if (!id || !timestamp || !sigHeader) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

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

    // The webhook carries no body — fetch it.
    let text = '';
    try {
      const full = await fetchReceivedBody(data.email_id);
      text = full.text || (full.html ? String(full.html).replace(/<[^>]+>/g, ' ') : '');
    } catch (fetchErr) {
      console.error('inbound body fetch error:', fetchErr);
      return res.status(500).json({ error: 'Could not fetch email body' }); // let Resend retry
    }

    const result = await processInboundEmail({
      recipients: [...(data.to || []), ...(data.received_for || [])],
      from: data.from,
      text,
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error('receiveResendEmail error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { receiveResendEmail };
