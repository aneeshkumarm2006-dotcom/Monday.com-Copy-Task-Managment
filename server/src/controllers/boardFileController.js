const { loadBoardContext, requireCapability } = require('../utils/boardContext');

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
 * ---- WHAT THIS DOES NOT DO ------------------------------------------------
 *
 * It does not write to any task, board or column. It authorises the caller
 * against the board, stores the bytes, and hands back the descriptor. Deciding
 * where that descriptor is written is the caller's business, and is separately
 * validated by the `file` column type when it lands in `columnValues`.
 */

/**
 * POST /api/boards/:id/files
 *
 * Multipart, field name `file`. Returns the descriptor shape the `file` column
 * type stores: `{ url, name, mime, size, publicId }`.
 *
 * Gated on `task.create` rather than an upload-specific capability, because
 * that is what this is FOR — the next call this enables is creating a row. A
 * viewer who cannot add a row has no reason to be able to put bytes in the
 * account's storage, and gating it any looser would make this the one endpoint
 * on the board that anybody who can read it could write through.
 */
const uploadBoardFile = async (req, res) => {
  try {
    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const denied = requireCapability(
      ctx,
      'task.create',
      'You do not have permission to add files to this board'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded' });
    }

    // Multer + CloudinaryStorage has already stored it by the time we get here,
    // which is also why the capability check above cannot be skipped: reaching
    // this function at all means the bytes are in the account.
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
    return res.status(500).json({ error: 'Failed to upload the file' });
  }
};

module.exports = { uploadBoardFile };
