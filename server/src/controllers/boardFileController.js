const mongoose = require('mongoose');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const { destroyCloudinaryAssets } = require('../config/cloudinary');

/**
 * Uploading a file to a BOARD rather than to a task.
 *
 * Every other upload in Macan hangs off something that already exists — a task's
 * Files tab, an update's attachments, a vault item. The ledger needs the
 * opposite order: you drop an invoice PDF onto a board and the row is created
 * FROM it, so the bytes have to land somewhere before there is a task to hang
 * them on.
 *
 * ---- WHY THE FILE GOES FIRST ----------------------------------------------
 *
 * The alternative is to create the row, then upload into it, which is one fewer
 * endpoint. It is also how you get an invoice row with no invoice on it: the
 * task is created, the upload fails, and the board now holds a line item that
 * looks real and has nothing behind it. On a billing board that is the one
 * failure that matters. Uploading first means a failure leaves the board
 * exactly as it was.
 *
 * The cost is an orphaned Cloudinary asset when the caller abandons the flow
 * after a successful upload. That is the right way round: a stray blob nobody
 * links to is invisible and cheap, and a phantom invoice is neither.
 *
 * ---- WHY THE CHECK RUNS BEFORE MULTER --------------------------------------
 *
 * multer-storage-cloudinary uploads WHILE it parses the request. This check
 * used to live inside `uploadBoardFile`, which runs AFTER multer — so any
 * signed-in user of any workspace could post 25 MB to any board id and have it
 * stored in our account before being told 403, with nothing ever deleting it.
 * `authorizeBoardFile` is route middleware mounted ahead of the storage
 * (routes/boards.js), the same order logoController keeps, and it hands the
 * resolved context on as `req.boardCtx`.
 *
 * ---- WHERE THE BYTES GO ---------------------------------------------------
 *
 * Into `macan/board-files/<boardId>/` (config/cloudinary.js `boardFileUpload`),
 * never the shared task-attachment folder, and only for a PDF, an image or an
 * office document. The folder is what makes the returned `publicId` safe to
 * destroy later: utils/fileColumnAssets.js deletes an asset on a row's behalf
 * only when its id sits under the prefix of the board that row belongs to, so
 * a cell carrying anybody else's id — another board's, another workspace's, an
 * avatar's — is left alone.
 *
 * ---- WHAT THIS DOES NOT DO ------------------------------------------------
 *
 * It does not write to any task, board or column. It authorises the caller
 * against the board, stores the bytes, and hands back the descriptor. Deciding
 * where that descriptor is written is the caller's business, and is separately
 * validated by the `file` column type when it lands in `columnValues`.
 */

const DENIED = 'You do not have permission to add files to this board';

/**
 * Who may put bytes here: anyone who may create a row on the board.
 *
 * `task.create` rather than an upload-specific capability, because that is what
 * this is FOR — the next call this enables is creating a row. A viewer who
 * cannot add a row has no reason to be able to put bytes in the account's
 * storage.
 *
 * @returns {Promise<{ ctx } | { status, error }>}
 */
const authorise = async (req) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return { status: 400, error: 'Invalid board id' };
  }
  const ctx = await loadBoardContext(req.params.id, req.user.userId);
  if (ctx.error) return { status: ctx.status, error: ctx.error };
  const denied = requireCapability(ctx, 'task.create', DENIED);
  if (denied) return denied;
  return { ctx };
};

/**
 * Delete what multer already stored, when the request is not going to use it.
 * Never throws: it runs on the way out of a refusal or a failure, and a cleanup
 * error must not replace the answer the caller is owed.
 */
const discardUploadedFile = async (file) => {
  if (!file || !file.filename) return;
  try {
    await destroyCloudinaryAssets([{ publicId: file.filename, mime: file.mimetype }]);
  } catch (err) {
    console.error('uploadBoardFile: discard failed:', err.message);
  }
};

/**
 * Route middleware — runs BEFORE the storage middleware. Refuses without ever
 * letting a byte reach Cloudinary.
 */
const authorizeBoardFile = async (req, res, next) => {
  try {
    const verdict = await authorise(req);
    if (verdict.error) return res.status(verdict.status).json({ error: verdict.error });
    req.boardCtx = verdict.ctx;
    return next();
  } catch (err) {
    console.error('authorizeBoardFile error:', err);
    return res.status(500).json({ error: 'Failed to upload the file' });
  }
};

/**
 * POST /api/boards/:id/files
 *
 * Multipart, field name `file`. Returns the descriptor shape the `file` column
 * type stores: `{ url, name, mime, size, publicId }`.
 *
 * Expects `authorizeBoardFile` to have run first. If it is ever mounted without
 * it, it authorises here instead — too late to stop the upload, which is why
 * the refusal also deletes what was stored.
 */
const uploadBoardFile = async (req, res) => {
  try {
    if (!req.boardCtx) {
      const verdict = await authorise(req);
      if (verdict.error) {
        await discardUploadedFile(req.file);
        return res.status(verdict.status).json({ error: verdict.error });
      }
      req.boardCtx = verdict.ctx;
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded' });
    }

    return res.status(201).json({
      file: {
        url: req.file.path,
        name: req.file.originalname || 'file',
        mime: req.file.mimetype || 'application/octet-stream',
        size: typeof req.file.size === 'number' ? req.file.size : 0,
        publicId: req.file.filename || null,
      },
    });
  } catch (err) {
    console.error('uploadBoardFile error:', err);
    await discardUploadedFile(req.file);
    return res.status(500).json({ error: 'Failed to upload the file' });
  }
};

module.exports = { authorizeBoardFile, uploadBoardFile };
