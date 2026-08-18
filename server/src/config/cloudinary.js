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
      folder: 'macan/updates',
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
  console.error('Attachment upload error:', err);
  return res
    .status(400)
    .json({ error: "Sorry, that file couldn't be attached. Please try again." });
};

module.exports = {
  cloudinary,
  avatarUpload,
  updateUpload,
  taskAttachmentUpload,
  vaultBlobUpload,
  destroyCloudinaryAssets,
  handleUploadError,
};
