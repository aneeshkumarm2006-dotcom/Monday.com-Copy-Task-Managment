import { Link } from 'react-router-dom';
import { ChevronRight, Info } from 'lucide-react';

import { Panel, PanelHead } from '../board/addons/seo/LabsBits';
import { openLinkFor } from './sectionLinks';

/**
 * SectionFrame — the shell every composed home section is drawn inside.
 *
 * `GET /api/me/executive-home` answers with a list of ENVELOPES, fixed by the
 * shared contract and built by `server/src/services/executiveHome.js`:
 *
 *   { id, type, order, width, config, state: 'ok'|'empty'|'unavailable', data, error }
 *
 * Seven renderers live in `sections/`, one per type, and every one of them
 * draws `data` and nothing else. Everything the envelope says ABOUT a section
 * rather than about its subject — how wide it is, which of the three states it
 * is in, and where "open this properly" goes — is decided here, once.
 *
 * ---- WHY THE THREE STATES ARE NOT THE RENDERERS' PROBLEM -------------------
 *
 * `empty` and `unavailable` are the states that get written badly when each
 * tile handles them itself, because they are the states nobody is looking at
 * while they build a tile. Seven renderers would produce seven dialects of "no
 * data", at least one of them alarming, and the alarming one would be shown to
 * the person least able to do anything about it.
 *
 * They are also genuinely different sentences and must never collapse into one:
 *
 *   empty        the section works, its board is reachable, and there is
 *                nothing in it this month. "No goals set for September" is a
 *                fact about a client, and it is the tile's whole content.
 *   unavailable  the section cannot be drawn at all — usually because a board
 *                left this person's reach after somebody edited its sharing.
 *
 * The composer is careful to distinguish them (`empty(data)` vs
 * `unavailable(error)`), so throwing that away in the renderer would waste the
 * one thing the server went out of its way to tell us.
 *
 * ---- WHY `unavailable` IS QUIET -------------------------------------------
 *
 * This is the front door of the app for the person it belongs to, and the most
 * common cause of it is entirely routine: an admin narrowed a board's sharing
 * this morning. The person reading the tile did nothing, can fix nothing, and
 * is not owed an apology — they are owed a sentence. So: no red, no warning
 * triangle, no border wash, no "Error". A muted info glyph and the server's own
 * words, which `MESSAGES` in `executiveHome.js` wrote for a reader rather than
 * for a log ("You no longer have access to this board.").
 *
 * The Open link is withheld in that state for the same reason, by
 * `openLinkFor` — see `sectionLinks.js`.
 *
 * ---- WHY `children` IS A FUNCTION -----------------------------------------
 *
 * `data` is `null` on every `unavailable` envelope. JSX evaluates its children
 * eagerly, so a frame that took a node would force all seven renderers to guard
 * every field they read against a null that only happens in a state the frame
 * was supposed to be handling for them — and the guard that gets forgotten
 * crashes the home page rather than the tile. Passing a function means the body
 * is only ever BUILT in the `ok` state, so a renderer may read `section.data`
 * directly. A plain node still works (some bodies have nothing to guard), but
 * the seven in `sections/` all use the function form so there is one pattern.
 *
 * ---- WHY THE FRAME IS NOT A NEW CARD --------------------------------------
 *
 * `Panel` and `PanelHead` are the app's existing bordered-surface card and its
 * heading row with a right-hand slot — exactly this, minus the three states,
 * the width and the link. They are reused rather than restyled so a section on
 * this page and a panel anywhere else cannot drift apart by a pixel.
 *
 * They live in `components/board/addons/seo/LabsBits.jsx` today, which is a
 * worse address than they deserve: nothing in either component knows anything
 * about SEO. Moving them to `components/ui/Panel.jsx` means editing that file
 * and its eleven importers, which is a commit that owns those files; until then
 * importing them from where they are beats a second card.
 */

/**
 * The grid a page must lay composed sections out in.
 *
 * Exported HERE, beside the component that consumes it, because the two halves
 * of this decision are inseparable: `SectionFrame` writes `lg:col-span-2` for a
 * `full` section, which is a statement about a two-column grid and means
 * nothing outside one. Split across two files they would drift the first time
 * somebody made the page three columns wide and every "full" section quietly
 * became two-thirds of a row.
 *
 * One column below `lg` is not a fallback, it is the requirement: a half-width
 * section on a phone would be a 180px-wide tile with four stat cards in it.
 *
 * A CONSTANT beside a component is the one export this file may carry — the
 * repo's `react-refresh/only-export-components` rule permits constants and
 * refuses functions, which is why the two link builders this frame uses live in
 * `sectionLinks.js` and this string does not.
 */
export const SECTION_GRID_CLASS = 'grid grid-cols-1 lg:grid-cols-2 gap-5';

/** The header link. A `Link`, not an `<a>`: this never leaves the app. */
const OpenLink = ({ to, label }) => (
  <Link
    to={to}
    className="inline-flex items-center gap-0.5 font-body shrink-0 transition-colors duration-150 hover:text-[color:var(--color-accent-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--color-accent)' }}
  >
    {label}
    <ChevronRight size={14} aria-hidden="true" />
  </Link>
);

/**
 * The `empty` body. Quiet and small, deliberately NOT `ui/EmptyState`.
 *
 * `EmptyState` is page furniture — a 48px icon, a heading and an optional
 * primary button, sized to fill a screen that has nothing on it. Eight of them
 * down a dashboard would turn an ordinary month (three clients have not set
 * goals yet) into a page of billboards announcing absence. The tile is the
 * statement; this is one line inside it.
 */
const EmptyLine = ({ text }) => (
  <p
    className="font-body text-center"
    style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '18px 0' }}
  >
    {text}
  </p>
);

/**
 * The `unavailable` body — information, never an alarm. See the header.
 *
 * `role="status"` rather than `role="alert"`: a screen reader should meet this
 * in reading order like any other content, not have it announced over whatever
 * the person was doing. It is not urgent and there is nothing to act on.
 */
const UnavailableLine = ({ text }) => (
  <div
    role="status"
    className="flex items-start gap-2 justify-center text-center"
    style={{ padding: '18px 0' }}
  >
    <Info
      size={15}
      color="var(--color-text-muted)"
      aria-hidden="true"
      className="shrink-0 mt-px"
    />
    <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
      {text}
    </p>
  </div>
);

/**
 * @param {Object}   props
 * @param {Object}   props.section       the composed envelope. `width`, `state`
 *   and `error` are read here; `data` is the renderer's business.
 * @param {string}   props.title         what this section is, in the person's
 *   words — "Goal scores", not "goalScores".
 * @param {string}   [props.subtitle]    the one line of context under it,
 *   usually the board and the month.
 * @param {string}   [props.emptyMessage] what to say in the `empty` state.
 *   Per-type and often per-month, because the composer ships `data` alongside
 *   `empty` precisely so the tile can name the month it found nothing in.
 * @param {boolean}  [props.flush]       render the body edge to edge, for a
 *   list whose rows carry their own dividers. Padded otherwise.
 * @param {Function|React.ReactNode} props.children - called (or rendered) ONLY
 *   in the `ok` state. See the header.
 */
const SectionFrame = ({
  section,
  title,
  subtitle,
  emptyMessage = 'Nothing to show here yet.',
  flush = false,
  children,
}) => {
  // An envelope with no state at all is treated as `ok`: the renderer was given
  // something to draw and a missing field should not blank it. The server
  // always sends one; a fixture or a preview might not.
  const state = section?.state || 'ok';
  const link = openLinkFor(section);

  return (
    /**
     * `width: 'full'` spans the page's two-column grid and `half` takes one —
     * which only says anything inside a grid that HAS two columns, so the page
     * must lay these out with `SECTION_GRID_CLASS` above.
     *
     * `full` is the default for anything not explicitly `half`, matching the
     * model's own enum default — an unrecognised width is a wide section rather
     * than a broken layout.
     */
    <div className={section?.width === 'half' ? '' : 'lg:col-span-2'}>
      <Panel>
        <PanelHead
          title={title}
          sub={subtitle}
          right={link ? <OpenLink to={link.to} label={link.label} /> : null}
        />
        <div className={flush ? '' : 'p-4'}>
          {state === 'unavailable' ? (
            // The server's sentence, with a last-resort of our own: `error` is
            // always present on an unavailable envelope, but a tile that
            // rendered nothing at all because one field was missing would be
            // the same failure this whole file exists to prevent.
            <UnavailableLine text={section?.error || 'This section is not available right now.'} />
          ) : state === 'empty' ? (
            <EmptyLine text={emptyMessage} />
          ) : typeof children === 'function' ? (
            children()
          ) : (
            children
          )}
        </div>
      </Panel>
    </div>
  );
};

export default SectionFrame;
