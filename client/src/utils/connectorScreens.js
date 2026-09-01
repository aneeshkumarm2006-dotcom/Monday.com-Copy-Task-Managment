/**
 * Turning a provider's KIND catalog into the screens a dashboard rail draws.
 *
 * ---- Why this exists at all -------------------------------------------------
 *
 * One of the two connector tabs is driven by `provider.screens` — a list the
 * server sends, already grouped, already narrowed. The other has no such list:
 * its provider declares KINDS (what it can collect) and nothing about how to
 * lay them out. That tab used to render one section per kind, stacked, and the
 * result was a page with five headings, no hierarchy and no answer to the first
 * question anybody opening it has — WHICH SITE AM I LOOKING AT.
 *
 * Rather than give that provider a hand-written screen list on the server — a
 * second catalog to keep in step with the first, and one that would decide the
 * layout of a provider it does not otherwise describe — the rail is DERIVED
 * from the kinds. The rules that derivation needs are the three below, and each
 * of them is a rule this codebase has already got wrong somewhere else, which
 * is why they are here, pure, and under test rather than inline in a component.
 *
 * ---- Rule 1: an empty selection means EVERYTHING ---------------------------
 *
 * `BoardConnector.kinds` defaults to `[]`, and a board that has just switched a
 * connector on has expressed no opinion. Reading that as "render nothing" blanks
 * the tab with no error to explain it. Same sentence as `resolveKinds` on the
 * server and `selectedScreens` in the SEO tab; stated a third time because the
 * client must not re-derive it from a shorter one.
 *
 * ---- Rule 2: a kind with a READING is rendered even if unselected -----------
 *
 * Narrowing `kinds` stops future collection; it does not delete the weeks
 * already stored. A board that switched Backlinks off last month still holds
 * three months of backlink readings, and hiding the screen would present that
 * data as gone when it is merely frozen — and per-keyword rank history in
 * particular is the ONLY copy that will ever exist, because the provider has no
 * history API to re-fetch it from.
 *
 * ---- Rule 3: the grouping is DATA, not a list of names ---------------------
 *
 * The rail's headings come off `kind.subject`, which the descriptor already
 * carries because the runner needs it — 'project' is asked about the tracked
 * project, 'domain' about the whole domain. That distinction is exactly the one
 * a reader needs: "Rank tracking" answers for a keyword set somebody chose, and
 * "Backlinks" answers for the site as a whole, and a rail that mixed them
 * invites reading a domain-wide number as a project one. A subject this file has
 * no phrase for is filed under "More" rather than dropped, and a catalog whose
 * kinds all share one subject gets no headings at all.
 *
 * Nothing here names a provider. A second kind-shaped connector gets the same
 * rail for free.
 */

/**
 * The synthetic first screen. Not a kind — it has no snapshot of its own and
 * collects nothing; it reads the snapshots the other screens already hold.
 */
export const OVERVIEW_KEY = 'overview';

/**
 * `kind.subject` → the heading it sits under.
 *
 * A map rather than a switch so an unmapped subject falls through to "More"
 * (see rule 3) instead of throwing or vanishing. The phrase "Whole domain" is
 * the one `connectorFormat.marketLabel` already prints for the domain-wide
 * variant key, kept identical on purpose.
 */
const SUBJECT_LABELS = {
  project: 'This project',
  domain: 'Whole domain',
};

const ORPHAN_GROUP = { key: '__more', label: 'More' };

/**
 * The screens and headings a kind-driven dashboard rail should draw.
 *
 * @param {Object} input
 * @param {Array<{key: string, label: string, blurb?: string, subject?: string}>} [input.kinds]
 *   the provider's catalog, in the order it declares it
 * @param {string[]} [input.selectedKinds] - `BoardConnector.kinds`; `[]` means all
 * @param {Object} [input.snapshots] - kind key → the latest reading, or null
 * @returns {{screens: Array<Object>, groups: Array<{key: string, label: string}>}}
 */
export const screensFromKinds = ({
  kinds = [],
  selectedKinds = [],
  snapshots = {},
} = {}) => {
  const catalog = Array.isArray(kinds) ? kinds : [];
  const wanted = new Set(Array.isArray(selectedKinds) ? selectedKinds : []);

  const rendered = catalog.filter(
    (kind) =>
      // Rule 1, then rule 2.
      wanted.size === 0 || wanted.has(kind.key) || !!snapshots?.[kind.key]
  );

  // Rule 3. Subjects in the order the catalog introduces them, so the rail
  // follows the descriptor rather than this file's opinion of which comes first.
  const subjects = [];
  for (const kind of rendered) {
    const subject = kind.subject || '';
    if (!subjects.includes(subject)) subjects.push(subject);
  }

  const grouped = subjects.length > 1;

  const groupKeyFor = (kind) => {
    if (!grouped) return null;
    const subject = kind.subject || '';
    return SUBJECT_LABELS[subject] ? subject : ORPHAN_GROUP.key;
  };

  const groups = grouped
    ? subjects
        .map((subject) =>
          SUBJECT_LABELS[subject]
            ? { key: subject, label: SUBJECT_LABELS[subject] }
            : ORPHAN_GROUP
        )
        // A catalog with two unmapped subjects must not produce "More" twice.
        .filter((g, i, all) => all.findIndex((o) => o.key === g.key) === i)
    : [];

  const screens = rendered.map((kind) => ({
    key: kind.key,
    label: kind.label || kind.key,
    blurb: kind.blurb || '',
    group: groupKeyFor(kind),
  }));

  /**
   * The overview goes in front, ungrouped — and only when there is more than
   * one screen to summarise. On a board collecting a single kind it would be a
   * second, worse copy of the only screen there is.
   *
   * Skipped outright if the provider declares a kind of its own by that key, on
   * the principle that a real collected reading outranks a derived summary.
   */
  const hasOwnOverview = rendered.some((k) => k.key === OVERVIEW_KEY);
  if (screens.length > 1 && !hasOwnOverview) {
    screens.unshift({
      key: OVERVIEW_KEY,
      label: 'Overview',
      blurb:
        'Where this site stands and what moved since the previous collection. ' +
        'Every number below is also on a screen of its own.',
      group: null,
    });
  }

  return { screens, groups };
};

export default screensFromKinds;
