/**
 * columnTypes.js — registry of supported column types for the flexible
 * column engine (Phase 1, F1).
 *
 * Each entry exposes:
 *   - validate(value, settings)  : throws on invalid; returns void
 *   - serialize(value)           : pre-write transform (e.g. trim, normalise)
 *   - deserialize(value)         : post-read transform (defaults to identity)
 *   - defaultValue(settings)     : what an empty cell holds
 *   - indexable                  : hint for Mongo index strategy
 *
 * Callers (column CRUD, task PUT, migration) look up the entry by `type` and
 * call the relevant method. Unknown types throw immediately at lookup so a
 * malformed column never lands in the DB.
 *
 * `connect_boards` and `mirror` are registered here as F2 stubs so the
 * registry shape is stable; their `validate` throws `NOT_IMPLEMENTED` until
 * F2 fills them in.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

/** How many payments one row may hold. An invoice paid in 500 parts is data entry gone wrong. */
const MAX_PAYMENTS = 500;

/**
 * The largest single payment a row may record: a trillion, in the column's own
 * unit. Not a business rule — no agency invoice is near it — but a ceiling on
 * what a slipped key or a script can put into a figure that the strip, the
 * summaries and the auto-Paid rule then add up. Past ~9e15 a double stops
 * representing whole units exactly, and every total built on it quietly lies.
 */
const MAX_PAYMENT_AMOUNT = 1e12;

/** The longest client name a `client` cell stores — the same cap the ledger tile can show. */
const MAX_CLIENT_NAME = 120;

const DAY_KEY_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * A payment's date as 'YYYY-MM-DD', or null when it is not a date.
 *
 * A string that STARTS with a day key is taken at its word — its own Y-M-D,
 * not re-parsed through a timezone. The client sends the day the person picked
 * ('2026-09-05'); parsing that as UTC midnight and reading it back in IST, or
 * the reverse, is exactly how a payment made on the 5th gets filed on the 4th.
 * Anything else (a Date, a looser string) is parsed and read in UTC, the only
 * zone the server can claim to know.
 */
const paymentDayKey = (value) => {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const m = value.trim().match(DAY_KEY_PREFIX);
    if (m) {
      const [, y, mo, d] = m;
      const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
      // Round-trip, so '2026-02-31' is refused rather than rolled into March.
      if (
        probe.getUTCFullYear() === Number(y)
        && probe.getUTCMonth() === Number(mo) - 1
        && probe.getUTCDate() === Number(d)
      ) {
        return `${y}-${mo}-${d}`;
      }
      return null;
    }
  }
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

const isObjectIdLike = (value) =>
  value && (mongoose.Types.ObjectId.isValid(value) || typeof value?.toString === 'function');

const toIdString = (value) => {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toString === 'function') return value.toString();
  return String(value);
};

const ValidationError = (message, code = 'INVALID_VALUE') => {
  const err = new Error(message);
  err.code = code;
  return err;
};

const requireString = (value, field = 'value') => {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') {
    throw ValidationError(`${field} must be a string`);
  }
  return value;
};

/**
 * Whether `value` is an absolute https:// URL with a host. Parsed with the
 * WHATWG parser rather than a prefix test, so `https:javascript:…`,
 * `https://` with no host and whitespace-padded tricks are all refused.
 */
const isHttpsUrl = (value) => {
  if (typeof value !== 'string' || !value || value.length > 2048) return false;
  if (value !== value.trim()) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !!u.hostname;
  } catch (_err) {
    return false;
  }
};

const optionIdsFromSettings = (settings) => {
  const opts = settings && Array.isArray(settings.options) ? settings.options : [];
  return new Set(
    opts.map((o) => (o && o.id != null ? o.id.toString() : '')).filter(Boolean)
  );
};

const identity = (v) => v;

const baseEntry = (overrides) => ({
  serialize: identity,
  deserialize: identity,
  defaultValue: () => null,
  indexable: false,
  ...overrides,
});

const columnTypes = {
  // ----- Plain text --------------------------------------------------------
  text: baseEntry({
    validate: (value) => {
      if (value == null) return;
      if (typeof value !== 'string') throw ValidationError('text must be a string');
      if (value.length > 500) throw ValidationError('text exceeds 500 characters');
    },
    serialize: (value) => (typeof value === 'string' ? value.trim() : value),
    defaultValue: () => '',
    indexable: true,
  }),

  long_text: baseEntry({
    validate: (value) => {
      if (value == null) return;
      if (typeof value !== 'string') throw ValidationError('long_text must be a string');
      if (value.length > 20000) throw ValidationError('long_text exceeds 20000 characters');
    },
    defaultValue: () => '',
  }),

  // ----- Numbers -----------------------------------------------------------
  number: baseEntry({
    validate: (value, settings) => {
      if (value == null || value === '') return;
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || Number.isNaN(n)) {
        throw ValidationError('number must be a valid number');
      }
      if (settings && typeof settings.min === 'number' && n < settings.min) {
        throw ValidationError(`number must be >= ${settings.min}`);
      }
      if (settings && typeof settings.max === 'number' && n > settings.max) {
        throw ValidationError(`number must be <= ${settings.max}`);
      }
    },
    serialize: (value) => {
      if (value == null || value === '') return null;
      const n = typeof value === 'string' ? Number(value) : value;
      return Number.isNaN(n) ? null : n;
    },
    defaultValue: () => null,
    indexable: true,
  }),

  // ----- Dates -------------------------------------------------------------
  date: baseEntry({
    validate: (value) => {
      if (value == null || value === '') return;
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) throw ValidationError('date is not a valid date');
    },
    serialize: (value) => {
      if (value == null || value === '') return null;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    },
    defaultValue: () => null,
    indexable: true,
  }),

  timeline: baseEntry({
    // Value: { start, end } — both ISO date strings.
    validate: (value) => {
      if (value == null) return;
      if (typeof value !== 'object') throw ValidationError('timeline must be an object');
      const { start, end } = value;
      if (start) {
        const d = new Date(start);
        if (Number.isNaN(d.getTime())) throw ValidationError('timeline.start invalid');
      }
      if (end) {
        const d = new Date(end);
        if (Number.isNaN(d.getTime())) throw ValidationError('timeline.end invalid');
      }
      if (start && end && new Date(start).getTime() > new Date(end).getTime()) {
        throw ValidationError('timeline.start must be <= timeline.end');
      }
    },
    serialize: (value) => {
      if (!value || typeof value !== 'object') return null;
      const out = {};
      if (value.start) out.start = new Date(value.start).toISOString();
      if (value.end) out.end = new Date(value.end).toISOString();
      return Object.keys(out).length ? out : null;
    },
    defaultValue: () => null,
  }),

  // ----- People ------------------------------------------------------------
  person: baseEntry({
    // Value: ObjectId[] of User. Empty array allowed.
    validate: (value) => {
      if (value == null) return;
      if (!Array.isArray(value)) throw ValidationError('person must be an array of user ids');
      for (const raw of value) {
        if (!isObjectIdLike(raw) || !mongoose.Types.ObjectId.isValid(toIdString(raw))) {
          throw ValidationError('person contains an invalid user id');
        }
      }
    },
    serialize: (value) => {
      if (!Array.isArray(value)) return [];
      const seen = new Set();
      const out = [];
      for (const raw of value) {
        const id = toIdString(raw);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
      return out;
    },
    defaultValue: () => [],
    indexable: true,
  }),

  // ----- Status / Dropdown -------------------------------------------------
  status: baseEntry({
    // Value: one option id (string). Settings: { options: [{ id, label, color, order }] }
    validate: (value, settings) => {
      if (value == null || value === '') return;
      const ids = optionIdsFromSettings(settings);
      if (!ids.has(value.toString())) {
        throw ValidationError('status value is not one of the configured options');
      }
    },
    serialize: (value) => (value == null || value === '' ? null : value.toString()),
    defaultValue: (settings) => {
      const opts = settings && Array.isArray(settings.options) ? settings.options : [];
      const def = opts.find((o) => o && o.isDefault);
      const pick = def || opts[0];
      return pick && pick.id != null ? pick.id.toString() : null;
    },
    indexable: true,
  }),

  dropdown: baseEntry({
    validate: (value, settings) => {
      if (value == null || value === '') return;
      const ids = optionIdsFromSettings(settings);
      if (!ids.has(value.toString())) {
        throw ValidationError('dropdown value is not one of the configured options');
      }
    },
    serialize: (value) => (value == null || value === '' ? null : value.toString()),
    defaultValue: () => null,
    indexable: true,
  }),

  // ----- Tags --------------------------------------------------------------
  tags: baseEntry({
    // Value: option-id[] referencing settings.options[].id
    validate: (value, settings) => {
      if (value == null) return;
      if (!Array.isArray(value)) throw ValidationError('tags must be an array');
      const ids = optionIdsFromSettings(settings);
      for (const v of value) {
        if (v == null) continue;
        if (!ids.has(v.toString())) {
          throw ValidationError('tags contains an unknown option id');
        }
      }
    },
    serialize: (value) => {
      if (!Array.isArray(value)) return [];
      const seen = new Set();
      const out = [];
      for (const v of value) {
        if (v == null) continue;
        const id = v.toString();
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
      return out;
    },
    defaultValue: () => [],
    indexable: true,
  }),

  // ----- Booleans ----------------------------------------------------------
  checkbox: baseEntry({
    validate: (value) => {
      if (value == null) return;
      if (typeof value !== 'boolean') throw ValidationError('checkbox must be a boolean');
    },
    serialize: (value) => !!value,
    defaultValue: () => false,
    indexable: true,
  }),

  // ----- Simple structured -------------------------------------------------
  link: baseEntry({
    // Value: { url, label? }
    validate: (value) => {
      if (value == null) return;
      if (typeof value === 'string') return;
      if (typeof value !== 'object') throw ValidationError('link must be an object');
      if (value.url && typeof value.url !== 'string') {
        throw ValidationError('link.url must be a string');
      }
      if (value.label && typeof value.label !== 'string') {
        throw ValidationError('link.label must be a string');
      }
    },
    serialize: (value) => {
      if (value == null) return null;
      if (typeof value === 'string') return { url: value.trim(), label: '' };
      return {
        url: requireString(value.url, 'link.url').trim(),
        label: requireString(value.label, 'link.label').trim(),
      };
    },
    defaultValue: () => null,
  }),

  phone: baseEntry({
    validate: (value) => {
      if (value == null || value === '') return;
      if (typeof value !== 'string') throw ValidationError('phone must be a string');
      // Loose check: allow +, digits, spaces, dashes, parens — most international forms.
      if (!/^[+\d][\d\s()\-.]{2,30}$/.test(value.trim())) {
        throw ValidationError('phone is not a recognisable phone number');
      }
    },
    serialize: (value) => (typeof value === 'string' ? value.trim() : value),
    defaultValue: () => '',
    indexable: true,
  }),

  email: baseEntry({
    validate: (value) => {
      if (value == null || value === '') return;
      if (typeof value !== 'string') throw ValidationError('email must be a string');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
        throw ValidationError('email is not a valid email address');
      }
    },
    serialize: (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    defaultValue: () => '',
    indexable: true,
  }),

  location: baseEntry({
    // Value: { lat, lng, label }. Client supplies lat/lng from navigator.geolocation.
    validate: (value) => {
      if (value == null) return;
      if (typeof value !== 'object') throw ValidationError('location must be an object');
      const { lat, lng, label } = value;
      if (lat != null) {
        if (typeof lat !== 'number' || lat < -90 || lat > 90) {
          throw ValidationError('location.lat must be a number between -90 and 90');
        }
      }
      if (lng != null) {
        if (typeof lng !== 'number' || lng < -180 || lng > 180) {
          throw ValidationError('location.lng must be a number between -180 and 180');
        }
      }
      if (label != null && typeof label !== 'string') {
        throw ValidationError('location.label must be a string');
      }
    },
    serialize: (value) => {
      if (!value || typeof value !== 'object') return null;
      const out = {};
      if (typeof value.lat === 'number') out.lat = value.lat;
      if (typeof value.lng === 'number') out.lng = value.lng;
      if (typeof value.label === 'string') out.label = value.label.trim();
      return Object.keys(out).length ? out : null;
    },
    defaultValue: () => null,
  }),

  file: baseEntry({
    // Value: [{ url, name, mime, size, publicId }]
    //
    // `publicId` is the Cloudinary handle `POST /api/boards/:id/files` hands
    // back. It used to be dropped here, which made every file in a file column
    // undeletable: the delete cascades (utils/fileColumnAssets.js) need the id
    // to destroy the asset, and a PDF nobody can destroy stays publicly
    // fetchable at its URL after the invoice it belonged to is gone. Always a
    // string on the way out ('' when the caller never had one — older rows,
    // which the cascades then leave alone).
    //
    // The id is stored as sent, and that is safe ONLY because the cascades
    // never trust it: they destroy an id solely when it sits under
    // `macan/board-files/<the row's own board>/` (see fileColumnAssets.js).
    //
    // `url` must be an https:// link. Every URL this app issues is (Cloudinary
    // hands back `secure_url`), and the cell is rendered as a link and fetched
    // for the PDF preview — a `javascript:` or `data:` URL here is a script in
    // somebody else's browser, and an `http:` one is an invoice fetched in the
    // clear. Refused on the way in rather than sanitised on the way out.
    validate: (value) => {
      if (value == null) return;
      if (!Array.isArray(value)) throw ValidationError('file must be an array of attachments');
      for (const f of value) {
        if (!f || typeof f !== 'object') throw ValidationError('file entry must be an object');
        if (f.url != null && typeof f.url !== 'string') throw ValidationError('file.url must be a string');
        if (!isHttpsUrl(f.url)) throw ValidationError('file.url must be an https:// link');
        if (f.name != null && typeof f.name !== 'string') throw ValidationError('file.name must be a string');
        if (f.mime != null && typeof f.mime !== 'string') throw ValidationError('file.mime must be a string');
        if (f.size != null && typeof f.size !== 'number') throw ValidationError('file.size must be a number');
        if (f.publicId != null && typeof f.publicId !== 'string') {
          throw ValidationError('file.publicId must be a string');
        }
      }
    },
    serialize: (value) => {
      if (!Array.isArray(value)) return [];
      return value.map((f) => ({
        url: typeof f.url === 'string' ? f.url : '',
        name: typeof f.name === 'string' ? f.name : '',
        mime: typeof f.mime === 'string' ? f.mime : '',
        size: typeof f.size === 'number' ? f.size : 0,
        publicId: typeof f.publicId === 'string' ? f.publicId : '',
      }));
    },
    defaultValue: () => [],
  }),

  // ----- Money received ----------------------------------------------------
  // payments: the ledger of what has been paid against a row — an invoice
  // paid in three instalments is three entries, not one number overwritten
  // three times.
  //   value:    [{ id, amount, date: 'YYYY-MM-DD', method, note, by, at }]
  //   settings: { format: 'currency', currency, summary: 'sum' }
  //
  // Its NUMERIC value — what summaries, formulas, mirrors and sorting read —
  // is the sum of the amounts (`paymentsTotal` on the client). A list rather
  // than a running total because "how much is paid" is only half the question
  // somebody chasing an invoice asks; the other half is when, and how.
  payments: baseEntry({
    validate: (value) => {
      if (value == null) return;
      if (!Array.isArray(value)) throw ValidationError('payments must be an array of payments');
      if (value.length > MAX_PAYMENTS) {
        throw ValidationError(`a row can hold at most ${MAX_PAYMENTS} payments`);
      }
      for (const p of value) {
        if (!p || typeof p !== 'object' || Array.isArray(p)) {
          throw ValidationError('each payment must be an object');
        }
        const amount = typeof p.amount === 'string' && p.amount.trim() !== '' ? Number(p.amount) : p.amount;
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
          throw ValidationError('a payment amount must be a number greater than zero');
        }
        if (amount > MAX_PAYMENT_AMOUNT) {
          throw ValidationError('a payment amount cannot be more than 1,000,000,000,000');
        }
        if (!paymentDayKey(p.date)) throw ValidationError('a payment needs a valid date');
        if (p.method != null && typeof p.method !== 'string') {
          throw ValidationError('payment.method must be a string');
        }
        if (p.note != null && typeof p.note !== 'string') {
          throw ValidationError('payment.note must be a string');
        }
        if (p.by != null && !mongoose.Types.ObjectId.isValid(toIdString(p.by))) {
          throw ValidationError('payment.by must be a user id');
        }
      }
    },
    serialize: (value) => {
      if (!Array.isArray(value)) return [];
      const seen = new Set();
      const out = [];
      value.forEach((p, index) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) return;
        const amount = typeof p.amount === 'string' ? Number(p.amount) : p.amount;
        const date = paymentDayKey(p.date);
        if (
          typeof amount !== 'number' || !Number.isFinite(amount)
          || amount <= 0 || amount > MAX_PAYMENT_AMOUNT || !date
        ) return;
        // An existing id is KEPT — it is how the activity log and the client
        // tell "this payment was edited" from "one removed, another added".
        // A duplicate is treated as missing rather than trusted twice.
        let id = typeof p.id === 'string' ? p.id.trim().slice(0, 40) : '';
        if (!id || seen.has(id)) id = crypto.randomBytes(6).toString('hex');
        seen.add(id);
        const at = p.at ? new Date(p.at) : null;
        out.push({
          entry: {
            id,
            amount,
            date,
            method: typeof p.method === 'string' ? p.method.trim().slice(0, 40) : '',
            note: typeof p.note === 'string' ? p.note.trim().slice(0, 200) : '',
            by: p.by != null && mongoose.Types.ObjectId.isValid(toIdString(p.by)) ? toIdString(p.by) : null,
            at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : new Date().toISOString(),
          },
          index,
        });
      });
      // Date order, STABLE: two payments on the same day keep the order they
      // were entered in, so the list never reshuffles itself on a save.
      out.sort((a, b) => (a.entry.date < b.entry.date ? -1 : a.entry.date > b.entry.date ? 1 : a.index - b.index));
      // Validation already refuses more than the cap; this only protects a
      // caller that skipped it. The NEWEST are kept — dropping the payment
      // somebody just recorded would be the worst possible choice.
      return out.slice(-MAX_PAYMENTS).map((o) => o.entry);
    },
    defaultValue: () => [],
  }),

  rating: baseEntry({
    // Value: integer 0..max (default max = 5)
    validate: (value, settings) => {
      if (value == null || value === '') return;
      const max = settings && typeof settings.max === 'number' ? settings.max : 5;
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max) {
        throw ValidationError(`rating must be an integer between 0 and ${max}`);
      }
    },
    serialize: (value) => {
      if (value == null || value === '') return 0;
      const n = typeof value === 'string' ? Number(value) : value;
      return Number.isFinite(n) ? Math.round(n) : 0;
    },
    defaultValue: () => 0,
    indexable: true,
  }),

  // ----- Read-only computed ------------------------------------------------
  formula: baseEntry({
    // Read-only. The value is never written directly; it's computed at read
    // time from a narrow expression over sibling number columns.
    //
    // A `null`/empty probe is allowed, exactly as on `mirror` below: adding or
    // re-configuring a column validates its default value against the new
    // settings, and a guard that also threw on "nothing" made every formula
    // column impossible to create or edit through the API. A real write is
    // still refused.
    validate: (value) => {
      if (value == null) return;
      throw ValidationError(
        'formula is read-only — set the formula in settings.expression instead of writing a value',
        'READ_ONLY'
      );
    },
    serialize: () => null,
    defaultValue: () => null,
  }),

  // ----- Who a row is for --------------------------------------------------
  // client: ONE client of this workspace.
  //   value:    { boardId: string|null, name: string } | null
  //   settings: none of its own (summary/width like any column)
  //
  // A client board (`Board.boardType === 'client'`) IS one client — its portal,
  // its contacts, its services — so "which client is this invoice for" is a
  // pick among the workspace's client boards, not a link to a ROW on some
  // board. That is why this is its own type rather than `connect_boards`,
  // which billing's Client column used to be and which nobody could fill: a
  // connect column needs target boards and a row on them, and a client board
  // has no row that is "the client".
  //
  //   boardId — the client board, or null for a client that has no board yet
  //             (a one-off, a prospect): then `name` is all there is.
  //   name    — a SNAPSHOT of the client's display name
  //             (`portalClientName || name`), so a reader who cannot open the
  //             client board — most people, since client boards are private —
  //             still sees who the invoice is for. On every write that names a
  //             board, the server overwrites it with that board's CURRENT name
  //             (taskController, which also checks the board is a live client
  //             board in the same workspace; that check needs the database, so
  //             it cannot live in this synchronous registry).
  //
  // Filters, sorting and footers treat it like text — by `name`.
  client: baseEntry({
    validate: (value) => {
      if (value == null) return;
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw ValidationError('client must be an object { boardId, name }');
      }
      const { boardId, name } = value;
      if (boardId != null && boardId !== '') {
        const id = toIdString(boardId);
        if (!id || !mongoose.Types.ObjectId.isValid(id) || !/^[a-f0-9]{24}$/i.test(id)) {
          throw ValidationError('client.boardId is not a valid board id');
        }
      }
      if (name != null && typeof name !== 'string') {
        throw ValidationError('client.name must be a string');
      }
      if (typeof name === 'string' && name.trim().length > MAX_CLIENT_NAME) {
        throw ValidationError(`client.name exceeds ${MAX_CLIENT_NAME} characters`);
      }
    },
    serialize: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const raw = value.boardId == null || value.boardId === '' ? null : toIdString(value.boardId);
      const boardId = raw && /^[a-f0-9]{24}$/i.test(raw) ? raw.toLowerCase() : null;
      const name = typeof value.name === 'string'
        ? value.name.trim().replace(/\s+/g, ' ').slice(0, MAX_CLIENT_NAME)
        : '';
      if (!boardId && !name) return null;
      return { boardId, name };
    },
    defaultValue: () => null,
  }),

  // ----- Cross-board connectivity (F2) -------------------------------------
  // connect_boards: a multi-pointer to rows on another board.
  //   settings: { targetBoardIds: [ObjectId], allowMultiple: bool,
  //               restrictTo?: { columnId, value } }
  //   value:    { links: [{ boardId, taskId }] }
  //
  // The registry validate is SYNCHRONOUS, so it only checks shape +
  // settings-level invariants (valid ObjectIds, target-board membership,
  // allowMultiple). Deep checks that need the DB — that a `taskId` actually
  // resolves to a row on a target board, and the `restrictTo` filter — run in
  // the link endpoint (controllers/linkController.js), which is async.
  connect_boards: baseEntry({
    validate: (value, settings) => {
      if (value == null) return;
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw ValidationError('connect_boards value must be an object { links: [] }');
      }
      const links = value.links;
      if (links == null) return;
      if (!Array.isArray(links)) {
        throw ValidationError('connect_boards.links must be an array');
      }
      const allowMultiple = !!(settings && settings.allowMultiple);
      if (!allowMultiple && links.length > 1) {
        throw ValidationError('this connect column allows only a single linked row');
      }
      const targetIds =
        settings && Array.isArray(settings.targetBoardIds)
          ? new Set(settings.targetBoardIds.map((id) => toIdString(id)))
          : null;
      for (const link of links) {
        if (!link || typeof link !== 'object') {
          throw ValidationError('each connect_boards link must be an object');
        }
        const boardId = toIdString(link.boardId);
        const taskId = toIdString(link.taskId);
        if (!boardId || !mongoose.Types.ObjectId.isValid(boardId)) {
          throw ValidationError('connect_boards link has an invalid boardId');
        }
        if (!taskId || !mongoose.Types.ObjectId.isValid(taskId)) {
          throw ValidationError('connect_boards link has an invalid taskId');
        }
        if (targetIds && targetIds.size > 0 && !targetIds.has(boardId)) {
          throw ValidationError('connect_boards link points at a board outside targetBoardIds');
        }
      }
    },
    serialize: (value) => {
      if (!value || typeof value !== 'object') return { links: [] };
      const links = Array.isArray(value.links) ? value.links : [];
      const seen = new Set();
      const out = [];
      for (const link of links) {
        if (!link || typeof link !== 'object') continue;
        const boardId = toIdString(link.boardId);
        const taskId = toIdString(link.taskId);
        if (!boardId || !taskId || seen.has(taskId)) continue;
        seen.add(taskId);
        out.push({ boardId, taskId });
      }
      return { links: out };
    },
    defaultValue: () => ({ links: [] }),
  }),

  // mirror: a read-only projection of a column on the rows a sibling
  // connect_boards column points at.
  //   settings: { sourceConnectColumnId, sourceColumnId,
  //               aggregation: 'first'|'concat'|'sum'|'min'|'max'|'count' }
  //   value:    computed at read time (services/mirrorRefresh.js), cached on
  //             Task.columnValues with a freshness marker.
  //
  // Direct writes are rejected (like `formula`). A `null`/empty probe is
  // allowed so column creation — which validates the default value against
  // the new settings — doesn't trip the read-only guard.
  mirror: baseEntry({
    validate: (value) => {
      if (value == null) return;
      throw ValidationError(
        'mirror is read-only — it is computed from the source column, not written directly',
        'READ_ONLY'
      );
    },
    serialize: () => null,
    defaultValue: () => null,
  }),
};

// Valid aggregation modes for a `mirror` column. Shared with mirrorRefresh.js
// and the column-settings validation in columnController.js.
const MIRROR_AGGREGATIONS = ['first', 'concat', 'sum', 'min', 'max', 'count'];

/**
 * Evaluate a formula column's expression over a task's column values.
 *
 * v1 scope (intentionally narrow): a simple numeric expression over sibling
 * column slugs. Supported tokens: numbers, +, -, *, /, parentheses, and
 * `column.<key>` references. Anything else throws.
 *
 * Returns a number, or null if any referenced cell is empty / non-numeric.
 */
const evaluateFormula = (expression, columnValuesByKey) => {
  if (typeof expression !== 'string' || !expression.trim()) return null;
  // Replace `column.<key>` with the numeric value, or `null` if missing.
  const referencePattern = /column\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let usedNull = false;
  const substituted = expression.replace(referencePattern, (_match, key) => {
    const raw = columnValuesByKey ? columnValuesByKey[key] : undefined;
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (raw == null || raw === '' || typeof n !== 'number' || Number.isNaN(n)) {
      usedNull = true;
      return '0';
    }
    return String(n);
  });
  // Whitelist: digits, dots, whitespace, operators, parens.
  if (!/^[\d\s+\-*/().]+$/.test(substituted)) {
    throw ValidationError('formula expression contains unsupported tokens', 'INVALID_FORMULA');
  }
  if (usedNull) return null;
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${substituted});`)();
    return typeof result === 'number' && Number.isFinite(result) ? result : null;
  } catch (err) {
    throw ValidationError(`formula evaluation failed: ${err.message}`, 'INVALID_FORMULA');
  }
};

/**
 * The column types a formula may reference: the ones with a NUMERIC value.
 * A payments column counts as the sum of its amounts, a mirror as the number
 * it mirrors. Mirrored by the client's `numericValue` in utils/columnValues.js.
 */
const FORMULA_SOURCE_TYPES = ['number', 'formula', 'mirror', 'payments'];

const FORMULA_REF = /column\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Validate a formula column's `settings.expression` against the board it will
 * live on. Returns `{ ok: true }` or `{ error }` with a sentence a person can act
 * on — this is what a 400 from add/update column says.
 *
 * `evaluateFormula` alone could not catch any of these: it returns null for a
 * reference to a column that does not exist, so a typo ('column.spend' for
 * `spent`) saved happily and the cell sat empty forever with no hint why.
 *
 * @param {string} expression
 * @param {Array}  columns  the board's columns (the formula itself may be among them)
 * @param {string} [selfKey] this formula's own key, when it already has one
 */
const validateFormulaExpression = (expression, columns, selfKey = null) => {
  if (typeof expression !== 'string' || !expression.trim()) {
    return { error: 'A formula needs an expression, like column.amount - column.paid.' };
  }
  if (expression.length > 500) {
    return { error: 'That formula is too long.' };
  }
  const byKey = new Map((columns || []).map((c) => [c.key, c]));
  const refs = [...new Set([...expression.matchAll(FORMULA_REF)].map((m) => m[1]))];
  for (const key of refs) {
    if (selfKey && key === selfKey) {
      return { error: 'A formula cannot refer to itself.' };
    }
    const col = byKey.get(key);
    if (!col) return { error: `The formula refers to "column.${key}", which is not a column on this board.` };
    if (!FORMULA_SOURCE_TYPES.includes(col.type)) {
      return { error: `"${col.name}" is not a number column, so a formula cannot use it.` };
    }
  }

  // A formula that reaches itself THROUGH another formula is the same loop one
  // step removed, and the client evaluator would recurse until the tab died.
  if (selfKey) {
    const seen = new Set();
    const stack = refs.slice();
    while (stack.length) {
      const key = stack.pop();
      if (key === selfKey) return { error: 'This formula would refer back to itself through another formula.' };
      if (seen.has(key)) continue;
      seen.add(key);
      const col = byKey.get(key);
      if (col && col.type === 'formula' && col.settings && typeof col.settings.expression === 'string') {
        for (const m of col.settings.expression.matchAll(FORMULA_REF)) stack.push(m[1]);
      }
    }
  }

  // Parse it under the same whitelist the evaluator uses, with every reference
  // standing in as 1. Division by zero is not a parse error (it evaluates to
  // null); a dangling operator or a stray word is.
  try {
    evaluateFormula(expression, Object.fromEntries(refs.map((k) => [k, 1])));
  } catch (err) {
    return { error: 'That formula is not valid. Use numbers, + - * / ( ) and column.<key> references.' };
  }
  return { ok: true };
};

/**
 * Look up a registry entry by type name. Returns null on unknown type so
 * callers can decide whether to 400 or fall through.
 */
const getColumnType = (type) =>
  Object.prototype.hasOwnProperty.call(columnTypes, type) ? columnTypes[type] : null;

/**
 * Convenience: validate `value` against the registry. Wraps the
 * registry-thrown error with a stable shape `{ columnId, message }` for
 * controllers to ship straight back to clients.
 */
const validateColumnValue = (column, value) => {
  const entry = column ? getColumnType(column.type) : null;
  if (!entry) {
    return {
      ok: false,
      error: { columnId: column?._id?.toString() || null, message: `Unknown column type: ${column?.type}` },
    };
  }
  try {
    entry.validate(value, column.settings || {});
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: { columnId: column._id?.toString() || null, message: err.message, code: err.code },
    };
  }
};

module.exports = {
  columnTypes,
  getColumnType,
  validateColumnValue,
  evaluateFormula,
  validateFormulaExpression,
  FORMULA_SOURCE_TYPES,
  ValidationError,
  MIRROR_AGGREGATIONS,
  MAX_PAYMENTS,
  MAX_PAYMENT_AMOUNT,
  MAX_CLIENT_NAME,
  isHttpsUrl,
};
