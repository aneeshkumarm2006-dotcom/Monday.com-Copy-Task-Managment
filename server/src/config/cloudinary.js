const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Cloudinary storage for profile avatars.
 * Uploads go directly to Cloudinary with face-crop 200x200 webp.
 * See Macan_TechStack.md Section 8.5.
 */
const avatarStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'macan/avatars',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [
      {
        width: 200,
        height: 200,
        crop: 'fill',
        gravity: 'face',
        format: 'webp',
      },
    ],
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

/**
 * Cloudinary storage for LOGOS — workspaces, boards and groups.
 *
 * Deliberately NOT the avatar storage: that one crops to a face at 200x200,
 * which on a wordmark means a random 200px bite out of the middle of it. A logo
 * keeps its whole shape — `limit` only ever scales DOWN, never crops and never
 * pads — and every surface draws it `object-fit: contain` inside its own tile,
 * so a wide wordmark and a square mark both sit correctly. 512px covers the
 * largest place one is drawn (the 72px settings preview) at any pixel density.
 *
 * webp keeps transparency, which is the whole point of most logo files: a
 * transparent PNG flattened to a white JPEG would put a white box on every
 * tinted tile it lands on.
 */
const LOGO_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'svg', 'gif'];
const logoStorage = new CloudinaryStorage({
  cloudinary,
  params: (req) => ({
    folder: `macan/logos/${req.logoFolder || 'misc'}`,
    allowed_formats: LOGO_FORMATS,
    transformation: [{ width: 512, height: 512, crop: 'limit', format: 'webp' }],
  }),
});

const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2MB — a logo, not a photograph

const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: LOGO_MAX_BYTES },
  // Reject by MIME before a single byte reaches Cloudinary. `allowed_formats`
  // above would also refuse, but only after the upload had been attempted.
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|svg\+xml|gif)$/i.test(file.mimetype || '')) {
      return cb(null, true);
    }
    const err = new Error('Logos must be a PNG, JPG, WEBP, SVG or GIF image.');
    err.code = 'LOGO_BAD_TYPE';
    return cb(err);
  },
});

const mimeToResourceType = (mime) => {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'raw';
};

// Resolve the correct Cloudinary resource_type from a multer file object.
// Images → 'image', Videos → 'video', everything else (PDFs, docs…) → 'raw'
// so non-image files are served with the correct Content-Type and are not
// misidentified as images by Cloudinary.
const resolveResourceType = (file) => mimeToResourceType(file.mimetype || '');

// Delete an array of attachments from Cloudinary. Silently skips attachments
// without a publicId (legacy records) and swallows per-asset errors so one
// missing asset doesn't abort a cascade delete.
const destroyCloudinaryAssets = async (attachments) => {
  if (!Array.isArray(attachments) || !attachments.length) return;
  await Promise.all(
    attachments
      .filter((a) => a && a.publicId)
      .map((a) =>
        cloudinary.uploader
          .destroy(a.publicId, { resource_type: mimeToResourceType(a.mime) })
          .catch(() => {})
      )
  );
};

/**
 * The folder every Update attachment is uploaded into. Exported because it is
 * also the ONLY folder an update's stored `publicId` may name: the id arrives in
 * the request body and is later destroyed with the account-wide secret, so
 * updateController refuses anything outside it (`ownUpdatePublicId`).
 */
const UPDATE_ATTACHMENTS_ROOT = 'macan/updates';

/**
 * Cloudinary storage for task update attachments (images, PDFs, docs).
 * resource_type is derived from the actual MIME type so PDFs land under
 * /raw/upload/ and are served as application/pdf, not image/jpeg.
 */
const updateAttachmentStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => {
    const nameWithoutExt = (file.originalname || 'file')
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    return {
      folder: UPDATE_ATTACHMENTS_ROOT,
      resource_type: resolveResourceType(file),
      public_id: `${Date.now()}-${nameWithoutExt}`,
    };
  },
});

const updateUpload = multer({
  storage: updateAttachmentStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
});

/**
 * Cloudinary storage for task-level attachments (Files tab).
 * Same resource_type logic as updateAttachmentStorage.
 */
const taskAttachmentStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => {
    const nameWithoutExt = (file.originalname || 'file')
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    return {
      folder: 'macan/tasks',
      resource_type: resolveResourceType(file),
      public_id: `${Date.now()}-${nameWithoutExt}`,
    };
  },
});

const taskAttachmentUpload = multer({
  storage: taskAttachmentStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
});

/**
 * Cloudinary storage for BOARD FILES — what `POST /api/boards/:id/files` stores
 * before the row that will hold it exists (an invoice PDF dropped on a ledger,
 * a CV on a hiring board, a receipt on an expenses board).
 *
 * ---- ONE FOLDER PER BOARD, and why that is the security boundary -----------
 *
 * These files used to land in `macan/tasks`, the same flat folder every
 * workspace's Files-tab attachments share. That made the file COLUMN's cleanup
 * (utils/fileColumnAssets.js) dangerous: the only handle on an asset is the
 * `publicId` the cell carries, the cell is written by the client, and the
 * destroy call runs with the account-wide API secret. So an editor of any row,
 * on any board, could plant another tenant's id in a cell, clear the cell, and
 * have the server delete that asset for them.
 *
 * Every board file now lives under `macan/board-files/<boardId>/`, and the
 * cleanup destroys ONLY ids under the prefix of the board the row belongs to.
 * A planted id from another board, another workspace, or another folder
 * (avatars, logos, vault blobs) is simply never destroyed. The folder is not a
 * permission — anybody holding a URL can still fetch the file — it is how the
 * server knows which assets it is allowed to delete on this board's behalf.
 *
 * ---- WHY THE PUBLIC ID IS PART RANDOM -------------------------------------
 *
 * A Cloudinary URL is readable by anyone holding it, and the task-attachment
 * scheme (`<Date.now()>-<filename>`) makes one guessable to anybody who knows
 * roughly when an invoice called "invoice" was uploaded. Sixteen random hex
 * characters in front of the (sanitised) name make it unguessable while the
 * URL still says what the file is to the person it was sent to. The vault goes
 * further and drops the name entirely; an invoice's filename is not a secret.
 *
 * `boardFileParams` is exported on its own so the tests can assert the folder
 * without a Cloudinary round-trip. The board id it reads has already been
 * checked by `authorizeBoardFile` (routes/boards.js), which runs BEFORE this
 * storage; the shape check here is only so a future route that forgets the gate
 * fails loudly instead of uploading into `macan/board-files/undefined`.
 */
const BOARD_FILES_ROOT = 'macan/board-files';
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/** The folder one board's files live in, or null for anything that is not a board id. */
const boardFileFolder = (boardId) => {
  const id = boardId == null ? '' : String(boardId);
  return OBJECT_ID_RE.test(id) ? `${BOARD_FILES_ROOT}/${id.toLowerCase()}` : null;
};

const boardFileParams = (req, file) => {
  const folder = boardFileFolder(req && req.params && req.params.id);
  if (!folder) {
    const err = new Error('A board file needs a valid board id.');
    err.code = 'BOARD_FILE_NO_BOARD';
    throw err;
  }
  const nameWithoutExt = ((file && file.originalname) || 'file')
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 60);
  return {
    folder,
    resource_type: resolveResourceType(file || {}),
    public_id: `${crypto.randomBytes(8).toString('hex')}-${nameWithoutExt || 'file'}`,
  };
};

const boardFileStorage = new CloudinaryStorage({
  cloudinary,
  params: boardFileParams,
});

/**
 * What may be stored as a board file: a PDF, any image, or a common office
 * document. Checked by MIME before a byte reaches Cloudinary (multer runs the
 * filter before the storage), the same order the logo upload keeps.
 *
 * Not a security control on its own — the MIME is whatever the browser (or a
 * script) declares — but it is what stops a board becoming somewhere to park
 * executables and archives behind a URL on our account, and it turns "that
 * file couldn't be attached" into a sentence that says why.
 *
 * `application/octet-stream` and an empty type are what a browser sends when it
 * cannot name a file (Windows does this for CSVs with no associated app). Those
 * are let through when the EXTENSION is one we accept, rather than refusing a
 * perfectly ordinary spreadsheet because the OS had no opinion about it.
 */
const BOARD_FILE_MIMES = new Set([
  'application/pdf',
  // Word
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Excel
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // PowerPoint
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // CSV, under every name browsers have been seen to give it
  'text/csv',
  'application/csv',
  'text/x-csv',
  'application/x-csv',
  'text/comma-separated-values',
  // Plain text
  'text/plain',
]);

const BOARD_FILE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg',
]);

const BOARD_FILE_BAD_TYPE =
  "That kind of file can't be added here. Use a PDF, an image, or a Word, Excel, PowerPoint, CSV or text file.";

/** Whether a multer file object is one a board may store. Pure. */
const isAllowedBoardFile = (file) => {
  const mime = String((file && file.mimetype) || '').toLowerCase().split(';')[0].trim();
  if (mime.startsWith('image/')) return true;
  if (BOARD_FILE_MIMES.has(mime)) return true;
  if (!mime || mime === 'application/octet-stream') {
    const m = /\.([a-z0-9]+)$/i.exec(String((file && file.originalname) || ''));
    return !!m && BOARD_FILE_EXTENSIONS.has(m[1].toLowerCase());
  }
  return false;
};

const boardFileFilter = (req, file, cb) => {
  if (isAllowedBoardFile(file)) return cb(null, true);
  const err = new Error(BOARD_FILE_BAD_TYPE);
  err.code = 'BOARD_FILE_BAD_TYPE';
  return cb(err);
};

const boardFileUpload = multer({
  storage: boardFileStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file, as elsewhere
  fileFilter: boardFileFilter,
});

/**
 * Cloudinary storage for VAULT blobs — and the one storage here whose params do
 * not resemble the others, for reasons worth stating.
 *
 *   resource_type: 'raw'  — always. The bytes arriving are AES-GCM ciphertext,
 *       so there is no image to transform and nothing to sniff. Letting
 *       Cloudinary decide would occasionally guess 'image' on random bytes and
 *       then serve, resize or re-encode them, which corrupts the payload.
 *
 *   public_id: random    — NOT `Date.now()-originalname` like every sibling
 *       above. A Cloudinary URL is public to anyone holding it, and the real
 *       filename ("aws-root-recovery-codes.pdf") is most of the secret. The
 *       filename is sealed inside the item's ciphertext instead; what lands here
 *       is 32 hex characters that say nothing.
 *
 * The browser encrypts BEFORE the request is made, so plaintext never reaches
 * this process, let alone Cloudinary.
 */
const vaultBlobStorage = new CloudinaryStorage({
  cloudinary,
  params: () => ({
    folder: 'macan/vault',
    resource_type: 'raw',
    public_id: crypto.randomBytes(16).toString('hex'),
  }),
});

const vaultBlobUpload = multer({
  storage: vaultBlobStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file, as elsewhere
});

// Error-handling middleware for the attachment upload routes. Turns multer's
// file-size error (and any other upload failure) into a clear, friendly
// message instead of letting it fall through to the generic 500 handler.
// eslint-disable-next-line no-unused-vars
const handleUploadError = (err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res
      .status(400)
      .json({ error: 'That file is too big. Please attach a file under 25MB.' });
  }
  // A board file of a type the board refuses (see `boardFileFilter`). 415, and
  // the filter's own sentence, which names what IS accepted — the generic
  // "couldn't be attached" below would send somebody to retry a PDF-shaped
  // .zip forever.
  if (err.code === 'BOARD_FILE_BAD_TYPE') {
    return res.status(415).json({ error: err.message, code: err.code });
  }
  console.error('Attachment upload error:', err);
  return res
    .status(400)
    .json({ error: "Sorry, that file couldn't be attached. Please try again." });
};

/**
 * Destroy logo assets by publicId. Takes the documents themselves (anything
 * with a `logoPublicId`) so a cascade can hand over whatever it already loaded.
 * Swallows per-asset errors, like `destroyCloudinaryAssets`: a missing logo
 * must never abort the delete that is cleaning it up.
 */
const destroyLogos = async (docs) => {
  const ids = (docs || []).map((d) => d && d.logoPublicId).filter(Boolean);
  if (!ids.length) return;
  await Promise.all(
    ids.map((id) => cloudinary.uploader.destroy(id, { resource_type: 'image' }).catch(() => {}))
  );
};

module.exports = {
  cloudinary,
  destroyLogos,
  avatarUpload,
  logoUpload,
  LOGO_MAX_BYTES,
  updateUpload,
  UPDATE_ATTACHMENTS_ROOT,
  taskAttachmentUpload,
  boardFileUpload,
  boardFileParams,
  boardFileFilter,
  isAllowedBoardFile,
  boardFileFolder,
  BOARD_FILES_ROOT,
  vaultBlobUpload,
  destroyCloudinaryAssets,
  handleUploadError,
};
