const mongoose = require('mongoose');
const TaskGroup = require('../models/TaskGroup');
const {
  destroyLogos,
  logoUpload,
  LOGO_MAX_BYTES,
} = require('../config/cloudinary');
const {
  loadBoardContext,
  loadOrgContext,
  requireCapability,
} = require('../utils/boardContext');
const rateLimit = require('../middleware/rateLimit');

// A person trying a few candidate logos is a handful of uploads; the ceiling
// is there to stop a runaway client filling the Cloudinary account.
const logoLimit = rateLimit({
  bucket: 'logo:upload',
  windowMs: 60_000,
  max: 20,
  message: 'Too many logo uploads. Please wait a moment.',
});

/**
 * Logos for workspaces, boards and groups — ONE controller for all three.
 *
 * The three differ only in who may change the logo, so each is described by an
 * `authorize(req)` that loads the document and answers that question. Upload
 * and removal are otherwise identical, and identical on purpose: a logo is a
 * logo wherever it hangs.
 *
 * ---- WHY THE CHECK RUNS BEFORE MULTER --------------------------------------
 *
 * multer-storage-cloudinary uploads WHILE it parses the request. Mounted as
 * route middleware ahead of the permission check, it would put a viewer's file
 * into our Cloudinary account and only then refuse them. So the request is
 * authorized first and multer is invoked by hand afterwards.
 *
 * Who may do it re-uses the capability that already governs the NAME beside
 * the logo — `org.manage_settings`, `board.rename`, `group.manage` — because a
 * logo is part of the same identity, and a fresh capability would need a
 * migration to grant it to everyone who can already rename the thing.
 */

const isId = (id) => mongoose.Types.ObjectId.isValid(id);

const TARGETS = {
  org: {
    folder: 'orgs',
    authorize: async (req) => {
      if (!isId(req.params.id)) return { status: 400, error: 'Invalid workspace id' };
      const ctx = await loadOrgContext(req.params.id, req.user.userId);
      if (ctx.error) return ctx;
      if (!ctx.can('org.manage_settings')) {
        return { status: 403, error: "You do not have permission to change this workspace's logo" };
      }
      return { doc: ctx.org };
    },
  },
  board: {
    folder: 'boards',
    authorize: async (req) => {
      if (!isId(req.params.id)) return { status: 400, error: 'Invalid board id' };
      const ctx = await loadBoardContext(req.params.id, req.user.userId);
      if (ctx.error) return ctx;
      const denied = requireCapability(
        ctx,
        'board.rename',
        "You do not have permission to change this board's logo"
      );
      return denied || { doc: ctx.board };
    },
  },
  group: {
    folder: 'groups',
    authorize: async (req) => {
      if (!isId(req.params.id)) return { status: 400, error: 'Invalid group id' };
      const group = await TaskGroup.findById(req.params.id);
      if (!group) return { status: 404, error: 'Group not found' };
      const ctx = await loadBoardContext(group.board, req.user.userId);
      if (ctx.error) return ctx;
      const denied = requireCapability(
        ctx,
        'group.manage',
        "You do not have permission to change this group's logo"
      );
      return denied || { doc: group };
    },
  },
};

const runUpload = (req, res) =>
  new Promise((resolve, reject) => {
    logoUpload.single('logo')(req, res, (err) => (err ? reject(err) : resolve()));
  });

const destroyLogo = (publicId) => destroyLogos([{ logoPublicId: publicId }]);

const uploadErrorMessage = (err) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return `That logo is too big. Please use an image under ${Math.round(LOGO_MAX_BYTES / 1024 / 1024)}MB.`;
  }
  if (err?.code === 'LOGO_BAD_TYPE') return err.message;
  return "Sorry, that logo couldn't be uploaded. Please try another image.";
};

const makeHandlers = (kind) => {
  const target = TARGETS[kind];

  // POST /…/:id/logo — multipart, field `logo`. Replaces any existing logo.
  const upload = async (req, res) => {
    try {
      const auth = await target.authorize(req);
      if (auth.error) return res.status(auth.status).json({ error: auth.error });

      req.logoFolder = target.folder;
      try {
        await runUpload(req, res);
      } catch (err) {
        if (err?.code !== 'LIMIT_FILE_SIZE' && err?.code !== 'LOGO_BAD_TYPE') {
          console.error(`${kind} logo upload error:`, err);
        }
        return res.status(400).json({ error: uploadErrorMessage(err) });
      }
      if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

      const { doc } = auth;
      const previous = doc.logoPublicId;
      doc.logo = req.file.path || req.file.secure_url;
      doc.logoPublicId = req.file.filename || '';
      await doc.save();
      // After the save, never before: if the save fails the old logo is still
      // the one on record and must still exist.
      if (previous && previous !== doc.logoPublicId) destroyLogo(previous);

      return res.json({ logo: doc.logo });
    } catch (err) {
      console.error(`${kind} logo upload error:`, err);
      return res.status(500).json({ error: 'Server error' });
    }
  };

  // DELETE /…/:id/logo — back to the lettered tile.
  const remove = async (req, res) => {
    try {
      const auth = await target.authorize(req);
      if (auth.error) return res.status(auth.status).json({ error: auth.error });
      const { doc } = auth;
      const previous = doc.logoPublicId;
      doc.logo = '';
      doc.logoPublicId = '';
      await doc.save();
      destroyLogo(previous);
      return res.json({ logo: '' });
    } catch (err) {
      console.error(`${kind} logo remove error:`, err);
      return res.status(500).json({ error: 'Server error' });
    }
  };

  return { upload, remove };
};

module.exports = {
  logoLimit,
  orgLogo: makeHandlers('org'),
  boardLogo: makeHandlers('board'),
  groupLogo: makeHandlers('group'),
};
