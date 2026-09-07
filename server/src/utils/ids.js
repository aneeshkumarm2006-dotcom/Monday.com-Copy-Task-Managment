/**
 * Collecting ids out of aggregate rows, without the `"null"` trap.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 *
 * `[...new Set(rows.map((r) => String(r.someId)).filter(Boolean))]` reads as
 * "the distinct ids that are present". It is not. `String(null)` is the
 * four-character STRING `"null"`, which is truthy, so `filter(Boolean)` keeps
 * it and the array handed to `{ _id: { $in: ids } }` contains a value Mongoose
 * cannot cast. The whole query throws a CastError, the handler's catch turns it
 * into a 500, and an endpoint that worked yesterday is dead — not for a bad
 * request, but because one perfectly ordinary row had a null in that field.
 *
 * That is exactly how the chat surfaces broke. `Message.author` is null on
 * every message a CLIENT posted (`portalAuthor` holds them instead) and on
 * every message the SYSTEM posted; `Message.portalAuthor` is null on every
 * message a TEAM MEMBER posted. So the moment a client said anything, the
 * team's board Chat tab and the client's own channel list both answered 500 —
 * from opposite halves of the same expression.
 *
 * A null id is the NORMAL case in a polymorphic-author collection, so the
 * collector has to treat it as one.
 */

/**
 * The distinct, present ids at `key` across `rows`, as strings.
 *
 * Null, undefined and empty are dropped BEFORE stringification, so nothing that
 * cannot be cast to an ObjectId ever reaches a query. ObjectIds, strings and
 * populated documents all work — `String(x)` on an ObjectId is its hex, which
 * is what `$in` wants.
 *
 * @param {Array<Object>} rows
 * @param {string} key
 * @returns {string[]} distinct ids, in first-seen order; `[]` for no rows
 */
const distinctIds = (rows, key) => [
  ...new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => row?.[key])
      .filter((v) => v !== null && v !== undefined && v !== '')
      .map(String)
      .filter(Boolean)
  ),
];

module.exports = { distinctIds };
