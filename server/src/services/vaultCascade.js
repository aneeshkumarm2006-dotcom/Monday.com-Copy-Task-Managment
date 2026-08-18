const Vault = require('../models/Vault');
const VaultItem = require('../models/VaultItem');
const VaultAudit = require('../models/VaultAudit');
const { cloudinary } = require('../config/cloudinary');

/**
 * Tear down the vaults belonging to one or more boards.
 *
 * ONE function rather than a copy in each cascade site, because there are two —
 * `boardController.deleteBoard` and `services/orgCascade.js` — and a vault left
 * behind is not the usual harmless orphan. Its key material would outlive the
 * board it protected, and its Cloudinary blobs would sit there indefinitely,
 * paid for and pointing at nothing. The `board` unique index also means a
 * surviving Vault row silently blocks a future board from ever having one.
 *
 * The Cloudinary destroys are best-effort and parallel: a third party being down
 * must not abort a board deletion the user asked for. What is left behind in
 * that case is undecryptable bytes under a random name, since the key material
 * goes either way.
 */
const cascadeDeleteVaults = async (boardIds) => {
  const ids = (Array.isArray(boardIds) ? boardIds : [boardIds]).filter(Boolean);
  if (ids.length === 0) return;

  // Only the file rows carry a blob; ask for nothing else.
  const blobs = await VaultItem.find({
    board: { $in: ids },
    type: 'file',
    'file.publicId': { $ne: null },
  }).select('file.publicId');

  await Promise.all(
    blobs.map((item) =>
      cloudinary.uploader
        .destroy(item.file.publicId, { resource_type: 'raw' })
        .catch((err) => console.error('Vault blob destroy failed:', err))
    )
  );

  await VaultItem.deleteMany({ board: { $in: ids } });
  await VaultAudit.deleteMany({ board: { $in: ids } });
  await Vault.deleteMany({ board: { $in: ids } });
};

module.exports = { cascadeDeleteVaults };
