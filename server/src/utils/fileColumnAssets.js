/**
 * fileColumnAssets.js — the Cloudinary files that live in FILE COLUMNS.
 *
 * A task carries files in two places. `task.attachments` (the Files tab) has
 * always been swept by every delete path. A `file`-type column —
 * `columnValues[<col id>] = [{ url, name, mime, size, publicId }]`, which is
 * where the billing ledger keeps an invoice's PDF — was swept by none of them.
 * Deleting an invoice therefore left its PDF in the account: still billed, and
 * still publicly fetchable by anyone holding the URL, which for a client's
 * invoice is the part that matters.
 *
 * This module is the one reader of those cells for cleanup, so every teardown
 * (a task, a group, a board, a workspace, a replaced cell) answers "which files
 * does this take with it" the same way.
 *
 * ---- ONLY WHAT THIS BOARD UPLOADED ---------------------------------------
 *
 * A cell is written by the CLIENT, and the destroy call runs with the
 * account-wide API secret, so "whatever publicId the cell names" is not a thing
 * this module may ever destroy. It used to be: an editor of any row could plant
 * another tenant's id (an avatar, a logo, somebody else's invoice) in a file
 * cell, clear the cell, and have the server delete that asset for them. Deleting
 * the row did the same, and would even DERIVE an id from any Cloudinary URL.
 *
 * So an asset is destroyed on a row's behalf only when its id sits under
 * `macan/board-files/<the row's own board id>/` — the folder
 * `POST /api/boards/:id/files` uploads into (config/cloudinary.js
 * `boardFileUpload`). Anything else a cell names is left exactly where it is:
 * another board's file, a task attachment, a legacy `macan/tasks/…` upload
 * from before the per-board folder existed. `destroyAssets` repeats the
 * folder check for any caller that hands it a list directly.
 *
 * The board id comes from `task.board` when the caller loaded it, else from the
 * `boardId` option — a caller that can supply neither destroys nothing, which
 * is the failure mode to have: a leaked blob is billed, a wrongly destroyed one
 * is somebody's invoice gone.
 *
 * ---- NO IDS FROM URLS ------------------------------------------------------
 *
 * `publicIdFromUrl` still exists (a one-off legacy cleanup script may want it)
 * but nothing here calls it any more. A URL in a cell is exactly as
 * client-controlled as a publicId, and a URL-derived id is exactly as
 * plantable. Legacy cells that hold only a URL are therefore never destroyed
 * by a request; if their blobs must go, that is a migration's job, done once,
 * against the database's own knowledge of which board holds them.
 */

const { destroyCloudinaryAssets, boardFileFolder, BOARD_FILES_ROOT } = require('../config/cloudinary');

/**
 * The prefix every id this board may destroy starts with —
 * `macan/board-files/<boardId>/` — or null when `boardId` is not a board id.
 * Accepts an ObjectId, a string, or a populated board.
 */
const boardFilePrefix = (boardId) => {
  const raw = boardId && typeof boardId === 'object' && boardId._id != null ? boardId._id : boardId;
  const folder = boardFileFolder(raw);
  return folder ? `${folder}/` : null;
};

/**
 * A public id is only ever a plain path under the prefix: no `..` segment, no
 * empty segment, nothing after the prefix that could climb back out of it. A
 * Cloudinary id is an opaque string and would not resolve `..` — this refuses
 * it anyway, because "probably opaque" is not the standard for a delete.
 */
const isPlainId = (id) =>
  typeof id === 'string'
  && id.length > 0
  && id.length <= 512
  && !id.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');

/** Whether `publicId` is a file uploaded for THIS board. */
const isBoardFileOf = (publicId, boardId) => {
  const prefix = boardFilePrefix(boardId);
  if (!prefix || !isPlainId(publicId)) return false;
  return publicId.startsWith(prefix) && publicId.length > prefix.length;
};

/** Whether `publicId` is a board file of ANY board — the floor `destroyAssets` keeps. */
const isBoardFileId = (publicId) => {
  if (!isPlainId(publicId)) return false;
  const root = `${BOARD_FILES_ROOT}/`;
  if (!publicId.startsWith(root)) return false;
  const [boardId, ...rest] = publicId.slice(root.length).split('/');
  return /^[a-f0-9]{24}$/.test(boardId) && rest.length > 0;
};

/** The board a task (doc or lean) belongs to, as a string, or null. */
const boardIdOfTask = (task) => {
  const b = task && task.board;
  if (b == null) return null;
  if (typeof b === 'object' && b._id != null) return String(b._id);
  return String(b);
};

/** One cell out of `columnValues`, whether it is a Mongoose Map or a lean object. */
const cellOf = (columnValues, colId) => {
  if (!columnValues) return undefined;
  if (typeof columnValues.get === 'function') return columnValues.get(colId);
  return columnValues[colId];
};

/** Which Cloudinary resource type a URL was delivered as, or null. */
const resourceTypeOfUrl = (url) => {
  const m = /\/(image|video|raw)\/upload\//.exec(url || '');
  return m ? m[1] : null;
};

/** The resource type a mime maps to — the same rule as config/cloudinary.js. */
const resourceTypeOfMime = (mime) => {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'raw';
};

/**
 * The Cloudinary public id a delivery URL points at, or null when the URL is
 * not a versioned Cloudinary upload URL:
 *
 *   https://res.cloudinary.com/<cloud>/<type>/upload/[<transforms>/]v<digits>/<public id>[.<ext>]
 *
 * For `image` and `video` resources the extension is the delivery format, not
 * part of the id, so it is stripped. For `raw` resources (PDFs, docs) the
 * extension IS part of the id, so it is kept. A URL with no version segment is
 * not guessed at: without it there is no reliable line between transformations
 * and the id.
 *
 * NOT used by any destroy path — see the header. Kept for one-off migrations.
 */
const publicIdFromUrl = (url, mime = '') => {
  if (typeof url !== 'string' || !url) return null;
  const at = url.indexOf('/upload/');
  if (at === -1) return null;
  // Query string and fragment are delivery details, never part of the id.
  const rest = url.slice(at + '/upload/'.length).split(/[?#]/)[0];
  const segments = rest.split('/').filter(Boolean);
  const v = segments.findIndex((s) => /^v\d+$/.test(s));
  if (v === -1 || v === segments.length - 1) return null;
  let id = segments.slice(v + 1).join('/');
  try {
    id = decodeURIComponent(id);
  } catch (_err) {
    // A malformed escape is left as written; destroy will simply not find it.
  }
  const type = resourceTypeOfUrl(url) || resourceTypeOfMime(mime);
  if (type !== 'raw') id = id.replace(/\.[^./]+$/, '');
  return id || null;
};

/**
 * A mime to hand `destroyCloudinaryAssets` when the stored one is empty, so it
 * picks the resource type the URL was actually delivered as. Destroying an
 * image under `resource_type: 'raw'` quietly does nothing.
 */
const mimeHintFromUrl = (url) => {
  const type = resourceTypeOfUrl(url);
  if (type === 'image') return 'image/*';
  if (type === 'video') return 'video/*';
  return '';
};

/**
 * Every file held in a file-type column of `tasks` that this app uploaded for
 * the task's own board, as `{ publicId, url, mime }`. Entries with no id, or an
 * id outside `macan/board-files/<board>/`, are not returned — see the header.
 *
 * @param {Array} columns - board columns; only `type === 'file'` ones are read.
 *   Columns from SEVERAL boards may be passed at once (a workspace teardown
 *   does): column ids are ObjectIds, so a task only ever matches its own
 *   board's.
 * @param {Array} tasks - task docs or lean objects with `columnValues`. Load
 *   `board` with them — it is what names the only folder their files may be
 *   destroyed from.
 * @param {{ boardId?: string|ObjectId }} [opts] - the board, for callers whose
 *   tasks were loaded without `board` (every task must then be on it).
 *   `task.board` wins when both are present.
 */
const fileColumnAssets = (columns, tasks, { boardId = null } = {}) => {
  const fileColIds = (Array.isArray(columns) ? columns : [])
    .filter((c) => c && c.type === 'file' && c._id != null)
    .map((c) => String(c._id));
  if (!fileColIds.length) return [];

  const out = [];
  const seen = new Set();
  const fallbackBoard = boardFilePrefix(boardId) ? boardId : null;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const cv = task && task.columnValues;
    if (!cv) continue;
    const owner = boardIdOfTask(task) || fallbackBoard;
    if (!boardFilePrefix(owner)) continue;
    for (const colId of fileColIds) {
      const cell = cellOf(cv, colId);
      if (!Array.isArray(cell)) continue;
      for (const f of cell) {
        if (!f || typeof f !== 'object') continue;
        const url = typeof f.url === 'string' ? f.url : '';
        const mime = typeof f.mime === 'string' ? f.mime : '';
        const publicId = typeof f.publicId === 'string' ? f.publicId.trim() : '';
        if (!publicId || seen.has(publicId) || !isBoardFileOf(publicId, owner)) continue;
        seen.add(publicId);
        out.push({ publicId, url, mime });
      }
    }
  }
  return out;
};

/**
 * The entries of `prevCell` a write to `nextCell` let go of — only those that
 * carried their own `publicId` under THIS board's folder, i.e. files this app
 * uploaded for this board and can name. Returned in the
 * `{ publicId, url, mime }` shape.
 *
 * `boardId` is REQUIRED: without it nothing is returned, so a caller that
 * forgets it leaks rather than deletes. A cell edit only knows that a file left
 * THIS cell, so the caller still has to check nothing else on the task holds an
 * id before destroying it.
 *
 * ---- KEPT means the same id OR the same URL --------------------------------
 *
 * An entry survives the write when the next cell holds one with its
 * `publicId`, or one at its `url`. Matching on the id alone destroyed files
 * that never left: a client that echoes the cell back as `{ url, name }` —
 * anything built before `publicId` was kept, or that simply does not carry it
 * — sends the very same file with a blank id, and the old check read that as
 * "dropped" and deleted a PDF the cell still links to. The URL is the delivery
 * address of one asset, so the same URL is the same file.
 */
const droppedFileAssets = (prevCell, nextCell, boardId) => {
  if (!Array.isArray(prevCell) || !prevCell.length) return [];
  if (!boardFilePrefix(boardId)) return [];
  const next = Array.isArray(nextCell) ? nextCell : [];
  const idOf = (f) => (f && typeof f.publicId === 'string' ? f.publicId.trim() : '');
  const urlOf = (f) => (f && typeof f.url === 'string' ? f.url.trim() : '');
  const kept = new Set(next.map(idOf).filter(Boolean));
  const keptUrls = new Set(next.map(urlOf).filter(Boolean));
  const out = [];
  for (const f of prevCell) {
    const publicId = idOf(f);
    if (!publicId || kept.has(publicId) || !isBoardFileOf(publicId, boardId)) continue;
    const url = urlOf(f);
    if (url && keptUrls.has(url)) continue;
    kept.add(publicId);
    out.push({
      publicId,
      url: typeof f.url === 'string' ? f.url : '',
      mime: typeof f.mime === 'string' ? f.mime : '',
    });
  }
  return out;
};

/**
 * Destroy a list of `{ publicId, url, mime }` in Cloudinary. Never throws — a
 * cleanup that fails must not fail the delete it rides on; the worst case is
 * the leak this module exists to close, not a lost request.
 *
 * The floor, for callers that build their own list: an id that is not a board
 * file of SOME board is dropped here whatever the caller meant. The per-board
 * check is the caller's (`fileColumnAssets` / `droppedFileAssets` already
 * made it); this only guarantees that no path through this module can ever
 * reach an avatar, a logo, a vault blob or a task attachment.
 */
const destroyAssets = async (assets) => {
  try {
    const list = (Array.isArray(assets) ? assets : [])
      .filter((a) => a && isBoardFileId(a.publicId))
      .map((a) => ({ publicId: a.publicId, mime: a.mime || mimeHintFromUrl(a.url) }));
    if (!list.length) return 0;
    await destroyCloudinaryAssets(list);
    return list.length;
  } catch (err) {
    console.error('fileColumnAssets: destroy failed:', err && err.message);
    return 0;
  }
};

/**
 * `assets` minus every id that ANOTHER row on the same board still holds in a
 * file column.
 *
 * ---- Why the board prefix alone is not enough --------------------------------
 *
 * The prefix rule scopes a destroy to a board, not to a row, and every reader
 * of the board receives every row's cells — ids included. So a member who may
 * edit only their OWN row could copy a colleague's invoice id into it, clear
 * it, and have the server destroy the colleague's PDF while her row still links
 * to it. There is an innocent way in too: the ledger drop's Retry reuses a
 * stored upload, so a first create that landed despite a failed reply leaves
 * two rows sharing one id, and deleting either killed the other's file.
 *
 * So before any per-row teardown destroys, it asks the database whether some
 * row it is NOT tearing down (`excludeTaskIds`) still names the id in one of
 * `columns`' file columns, and keeps those. A fresh upload's id is unique (the
 * upload prefixes it with random bytes), so this spares nothing that should go.
 *
 * Fails CLOSED: if the lookup throws, nothing is destroyed — a leaked blob is
 * billed, a wrongly destroyed one is somebody's invoice gone (see the header).
 *
 * Board, workspace and user teardowns take the whole board with them and do not
 * call this: every other row is going too.
 *
 * @param {Array<{publicId}>} assets
 * @param {{ boardId, columns: Array, excludeTaskIds?: Array }} opts
 */
const withoutIdsHeldElsewhere = async (assets, { boardId, columns, excludeTaskIds = [] } = {}) => {
  const list = (Array.isArray(assets) ? assets : []).filter((a) => a && a.publicId);
  const fileCols = (Array.isArray(columns) ? columns : []).filter(
    (c) => c && c.type === 'file' && c._id != null
  );
  // No other file column left on the board → no other cell can hold the id.
  if (!list.length || !fileCols.length) return list;
  if (!boardFilePrefix(boardId)) return [];
  try {
    // Lazy: keeps this util free of a require cycle through the models.
    const Task = require('../models/Task');
    const board = typeof boardId === 'object' && boardId._id != null ? boardId._id : boardId;
    const ids = list.map((a) => a.publicId);
    const rows = await Task.find({
      board,
      _id: { $nin: (Array.isArray(excludeTaskIds) ? excludeTaskIds : []).filter(Boolean) },
      $or: fileCols.map((c) => ({ [`columnValues.${String(c._id)}.publicId`]: { $in: ids } })),
    })
      .select('columnValues board')
      .lean();
    const held = new Set(fileColumnAssets(fileCols, rows, { boardId }).map((a) => a.publicId));
    return list.filter((a) => !held.has(a.publicId));
  } catch (err) {
    console.error('fileColumnAssets: held-elsewhere lookup failed:', err && err.message);
    return [];
  }
};

/**
 * Destroy every file-column asset on `tasks` (same arguments as
 * `fileColumnAssets`). Never throws.
 *
 * `opts.excludeTaskIds` marks a PER-ROW teardown (a task, a group): the rows
 * being deleted. Any id another row on the board still holds is then kept —
 * see `withoutIdsHeldElsewhere`. Omit it only when the whole board goes.
 */
const destroyFileColumnAssets = async (columns, tasks, opts = {}) => {
  let assets = [];
  try {
    assets = fileColumnAssets(columns, tasks, opts);
    if (assets.length && Array.isArray(opts.excludeTaskIds)) {
      const first = (Array.isArray(tasks) ? tasks : []).find((t) => boardIdOfTask(t));
      assets = await withoutIdsHeldElsewhere(assets, {
        boardId: opts.boardId || boardIdOfTask(first),
        columns,
        excludeTaskIds: opts.excludeTaskIds,
      });
    }
  } catch (err) {
    console.error('fileColumnAssets: collect failed:', err && err.message);
    return 0;
  }
  return destroyAssets(assets);
};

module.exports = {
  fileColumnAssets,
  destroyFileColumnAssets,
  droppedFileAssets,
  destroyAssets,
  withoutIdsHeldElsewhere,
  publicIdFromUrl,
  boardFilePrefix,
  isBoardFileOf,
  isBoardFileId,
};
