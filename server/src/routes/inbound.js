const express = require('express');
const inbound = require('../controllers/inboundController');

/**
 * Inbound email webhooks — mounted at /api/inbound. PUBLIC (no app auth): the
 * caller is the email provider, not a user. Authenticity is enforced inside the
 * handler by verifying the provider's signature against RESEND_WEBHOOK_SECRET.
 */
const router = express.Router();

router.post('/resend', inbound.receiveResendEmail);

module.exports = router;
