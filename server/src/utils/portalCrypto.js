const crypto = require('crypto');

/**
 * Crypto helper for the Client Portal, built on Node's `crypto` so we add no
 * dependency (the codebase already uses `crypto.randomBytes` for org invite
 * codes). Client sign-in is Google OAuth, so the only secret left here is the
 * public link id stamped into a group's portal URL.
 */

/**
 * Generate the public link id stamped into a group's portal URL.
 * @returns {string} 48-char hex
 */
const generatePortalToken = () => crypto.randomBytes(24).toString('hex');

module.exports = {
  generatePortalToken,
};
