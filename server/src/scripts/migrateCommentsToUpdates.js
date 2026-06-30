/**
 * One-time migration: convert legacy Comments into Updates.
 *
 * Background
 * ----------
 * The Comments feature was merged into Updates (Updates is a superset:
 * rich text + attachments + delete + everything Comments had). This script
 * copies every existing `comments` document into the `updates` collection so
 * no discussion history is lost. Once you've verified the result you can drop
 * the `comments` collection.
 *
 * What it preserves
 * -----------------
 *   - author, task, mentions, mentionReads
 *   - createdAt and editedAt (so timestamps and newest-first ordering are
 *     unchanged; updatedAt is set to editedAt || createdAt)
 *   - replyTo threading (remapped from comment ids to the new update ids)
 *
 * The plain-text comment body becomes a minimal TipTap document (one paragraph
 * per line) plus a `bodyText` mirror, matching how Updates store content.
 * (Legacy comments stored @mentions as a "@Name " text prefix; that text is
 * carried over verbatim, and the structured `mentions` array is preserved, so
 * mention highlighting and read-state keep working.)
 *
 * Safety
 * ------
 *   - Idempotent: each created update is tagged with `migratedFromComment`
 *     (the source comment id). Re-running skips comments already migrated and
 *     still resolves replyTo against the earlier run.
 *   - Dry run: pass `--dry` (or set DRY_RUN=1) to report counts without writing.
 *   - Reads/writes the raw collections via the native driver so Mongoose's
 *     `timestamps: true` cannot overwrite the preserved createdAt/updatedAt.
 *
 * Usage (from the `server/` directory):
 *   node src/scripts/migrateCommentsToUpdates.js --dry   # preview, writes nothing
 *   node src/scripts/migrateCommentsToUpdates.js         # run the migration
 */

try {
  // dotenv is optional — env vars may already be present in the environment.
  require('dotenv').config();
} catch {
  /* ignore */
}

const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry') || process.env.DRY_RUN === '1';

/**
 * Turn a plain-text comment body into a minimal TipTap document (one paragraph
 * per line). Empty lines become empty paragraphs so blank-line spacing is
 * roughly preserved when rendered by the Updates read-only renderer.
 */
const textToTipTap = (text) => {
  const lines = String(text || '').split('\n');
  const content = lines.map((line) =>
    line.length
      ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
      : { type: 'paragraph' }
  );
  if (content.length === 0) content.push({ type: 'paragraph' });
  return { type: 'doc', content };
};

const run = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error(
      'MONGODB_URI is not defined. Set it (or add it to server/.env) and retry.'
    );
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const commentsCol = db.collection('comments');
  const updatesCol = db.collection('updates');

  const comments = await commentsCol.find({}).toArray();
  console.log(`Found ${comments.length} comment(s).`);

  if (comments.length === 0) {
    console.log('Nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  // Comments already migrated in a previous run, keyed by source comment id so
  // we can both skip them and resolve replyTo references that point at them.
  const alreadyMigrated = await updatesCol
    .find(
      { migratedFromComment: { $exists: true } },
      { projection: { migratedFromComment: 1 } }
    )
    .toArray();
  const existingByComment = new Map(
    alreadyMigrated.map((u) => [u.migratedFromComment.toString(), u._id])
  );

  // Map EVERY comment id -> the update id it corresponds to (existing for
  // already-migrated comments, freshly generated otherwise) so replyTo can be
  // remapped in a single pass, even across re-runs.
  const idMap = new Map();
  for (const c of comments) {
    const key = c._id.toString();
    idMap.set(key, existingByComment.get(key) || new mongoose.Types.ObjectId());
  }

  // Build update docs only for comments that haven't been migrated yet.
  const docs = [];
  for (const c of comments) {
    const key = c._id.toString();
    if (existingByComment.has(key)) continue;

    const createdAt = c.createdAt ? new Date(c.createdAt) : c._id.getTimestamp();
    const editedAt = c.editedAt ? new Date(c.editedAt) : null;
    const replyToKey = c.replyTo ? c.replyTo.toString() : null;

    docs.push({
      _id: idMap.get(key),
      task: c.task,
      author: c.author,
      body: textToTipTap(c.text),
      bodyText: String(c.text || '').slice(0, 4000),
      attachments: [],
      mentions: Array.isArray(c.mentions) ? c.mentions : [],
      replyTo: replyToKey ? idMap.get(replyToKey) || null : null,
      mentionReads: Array.isArray(c.mentionReads) ? c.mentionReads : [],
      editedAt,
      createdAt,
      updatedAt: editedAt || createdAt,
      migratedFromComment: c._id,
    });
  }

  console.log(
    `${existingByComment.size} already migrated; ${docs.length} to migrate now.`
  );

  if (DRY_RUN) {
    console.log('[dry run] No documents written.');
    await mongoose.disconnect();
    return;
  }

  if (docs.length > 0) {
    const res = await updatesCol.insertMany(docs, { ordered: false });
    console.log(`Inserted ${res.insertedCount} update(s).`);
  } else {
    console.log('No new comments to migrate.');
  }

  await mongoose.disconnect();
  console.log(
    'Done. Verify the Updates feed, then drop the legacy `comments` collection.'
  );
};

run().catch(async (err) => {
  console.error('Migration failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
