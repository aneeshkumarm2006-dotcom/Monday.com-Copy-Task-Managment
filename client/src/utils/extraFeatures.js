import { FileDown, Tags } from 'lucide-react';

/**
 * The catalog of EXTRA FEATURES — opt-in tools that stay off until someone asks
 * for them, listed in Settings → Extra features.
 *
 * These are not permissions. `capability` says whether a feature is available to
 * you at all; the switch in the tab records that you actually want it. The two
 * are deliberately separate, and BOTH are re-checked on the server, so flipping a
 * switch can never grant anything a role did not already allow.
 *
 * A feature whose capability you lack is not listed — its switch would be a lie,
 * since the endpoint behind it would refuse you regardless of the flag. And when
 * that leaves nothing, the tab itself disappears (`hasAnyExtraFeature`).
 *
 * The table lives here, apart from the tab that renders it, because SettingsPage
 * needs it too: it decides whether to show the tab from this same list, so the
 * two cannot drift the way a hand-maintained OR of capabilities did — the tab
 * used to key off `board.export_activity` alone, which hid it from every member,
 * and therefore hid every feature a member IS allowed to use.
 *
 * To add a feature: append here, add the key to FEATURE_KEYS in
 * server/src/controllers/profileController.js, and add the field to
 * `User.features`. Everything else is generic.
 */
export const EXTRA_FEATURES = [
  {
    key: 'activityExport',
    icon: FileDown,
    capability: 'board.export_activity',
    label: 'Board activity export',
    hint:
      'Adds an Export button to boards you can open, for downloading everything ' +
      'that happened on the board over a date range as a CSV or PDF.',
  },
  {
    key: 'groupTags',
    icon: Tags,
    // Group tags are part of a board's vocabulary, like labels and statuses, so
    // they ride on the capability that governs those. Members hold it on boards
    // they can edit — which is why the tab can no longer key off the export.
    capability: 'column.manage',
    label: 'Group tags',
    hint:
      'Tags for whole groups, the way tasks already have them. Adds a tag ' +
      'button to each group header on boards you can edit. Tags set by others ' +
      'stay hidden until you turn this on.',
  },
  // `trackers` used to live here. It was removed when the Delivery view became
  // part of the MONTHLY BOARD TYPE rather than an opt-in tool: a board either is
  // organised by month — in which case Delivery is one of its three views and
  // hiding it behind a personal switch makes no sense — or it is not, in which
  // case there is nothing to switch on. The `tracker.view` / `tracker.manage`
  // capabilities are unchanged; only the per-user flag is gone.
];

/** The features this user may actually use. `can` comes from usePermissions(). */
export const availableExtraFeatures = (can) =>
  EXTRA_FEATURES.filter((f) => can(f.capability));

/** Does this user have any extra feature at all? Gates the tab's existence. */
export const hasAnyExtraFeature = (can) =>
  EXTRA_FEATURES.some((f) => can(f.capability));
