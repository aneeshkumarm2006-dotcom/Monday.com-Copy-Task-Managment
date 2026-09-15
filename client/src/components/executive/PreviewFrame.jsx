import { createElement, useMemo } from 'react';
import {
  Activity,
  BarChart3,
  CheckSquare,
  Eye,
  Folder,
  Home,
  Info,
  LayoutGrid,
  MessageCircle,
  Settings,
  Users,
} from 'lucide-react';

import SectionFrame, { SECTION_GRID_CLASS } from './SectionFrame';
import { sectionComponentFor } from './sectionRegistry';
import { applyNavSwitches } from '../../utils/executiveNav';

/**
 * PREVIEW FRAME — somebody else's screen, drawn on an admin's.
 *
 * The configurator's last step. `GET /orgs/:orgId/executive-views/:userId/preview`
 * composes the target's home and resolves their view SERVER-SIDE, AS THEM, and
 * hands back `{ profile, skipped, sections, nav, capabilities }`. This component
 * draws that answer and nothing else — it fetches nothing, computes no number,
 * and asks no question about the person looking at it.
 *
 * ---- WHY IT RENDERS THROUGH THE SAME RENDERERS THE REAL HOME USES ----------
 *
 * THIS IS THE ENTIRE POINT OF THE STEP AND THE ONLY THING THAT MAKES IT WORTH
 * HAVING. A preview built out of its own summary widgets is a second drawing of
 * the same data, and the two drift the first week somebody changes one of them:
 * the admin is then shown a picture that is confidently wrong about a screen
 * they cannot otherwise see, which is worse than no preview at all — it is a
 * check that reports a pass it did not perform.
 *
 * So the sections come out of `sectionRegistry` by type, exactly as
 * `ExecutiveHomePage` looks them up, laid out with the grid class
 * `SectionFrame` exports for that page, and every three-state envelope
 * (`ok` / `empty` / `unavailable`) is handled by `SectionFrame` itself. A
 * section that says "You no longer have access to this board" here says it
 * because the SERVER said it, about the TARGET, in the same words that person
 * will read. Adding a section type changes this file not at all.
 *
 * The rail is the same argument one rung weaker, and the comment on
 * `RAIL_ROWS` below says where the seam is and why it cannot be closed from
 * this file.
 *
 * ---- WHY IT IS INERT, THREE TIMES OVER ------------------------------------
 *
 * Everything in the frame is a control that belongs to somebody else's account:
 * a board tile that opens a board, a "Open My Work" link, a task row. A preview
 * whose buttons work is a footgun — the admin reads a tile as a picture, clicks
 * it the way they would click a picture, and the app navigates away from a
 * half-finished configuration into a board. Worse, the preview is composed AS
 * THE TARGET, so some of those links point at boards the ADMIN cannot open, and
 * the reward for pressing one is a 403 that looks like the preview being broken.
 *
 * Three mechanisms, because each one covers a gap the others leave:
 *
 *  1. `inert` on the frame. The platform's own answer, and the one that is
 *     actually a guarantee rather than a style: no pointer events, no focus, no
 *     tab stops, no activation, for the whole subtree and anything added to it
 *     later. Without it a keyboard user tabs through fifteen dead controls to
 *     get past the preview.
 *  2. `pointer-events: none`. Redundant with `inert` by the spec, and kept
 *     because it is the VISIBLE half: hover states never light up, so the frame
 *     does not invite the press it would then refuse. It also covers a browser
 *     old enough not to implement `inert`.
 *  3. A capture-phase click handler that stops the event and refuses its
 *     default. This is the one that covers a section renderer nobody has
 *     written yet: a control that ACTS rather than navigates (an inline editor,
 *     a toggle) would otherwise only be stopped by `inert`. React dispatches
 *     capture listeners from the outside in, so stopping here means the target's
 *     own `onClick` is never dispatched at all — and for a `<Link>`, which
 *     checks `event.defaultPrevented` before it navigates, the `preventDefault`
 *     is a second refusal after that one.
 *
 * ---- AND WHY THERE IS NO `MemoryRouter` AROUND IT -------------------------
 *
 * It is the obvious fourth idea — give the frame a throwaway history so that a
 * `<Link>` or a `useNavigate()` inside it moves a stack nobody renders — and it
 * is not available: react-router v6's `Router` asserts `!useInRouterContext()`
 * and THROWS ("You cannot render a <Router> inside another <Router>"), so the
 * app's own router makes a nested one a crash rather than a sandbox. Written
 * down because the idea is good enough that somebody will try it.
 *
 * `inert` hides the subtree from assistive technology, which is a real cost and
 * the reason everything an admin must ACT on is stated OUTSIDE the frame: the
 * caption says whose screen it is, and `skipped[]` — the one thing on this step
 * that needs doing something about — is a list above it, in ordinary readable
 * markup, not a detail inside the picture.
 *
 * ---- WHAT A PREVIEW CANNOT SHOW, AND SAYS SO ------------------------------
 *
 * Numbers move. This is one compose, at one moment, in the board's timezone —
 * a goal section showing 40% will show something else tomorrow, and an admin who
 * reads the preview as a report rather than as a layout will come back and say
 * the numbers changed on their own. The footnote says it once.
 */

/**
 * The rail, mirrored from `components/layout/SideRail.jsx`.
 *
 * A MIRROR, and deliberately not an import, because there is nothing to import:
 * the rail's rows are two array literals written INSIDE that component, built
 * from `can(...)` off the live session's permission store. Exporting them would
 * mean exporting a function of the current user's capabilities, and the current
 * user is exactly who this preview must not consult — the whole value of the
 * step is that it is drawn from the TARGET's capabilities, which arrive over the
 * wire from a server that resolved them for the target.
 *
 * So the coupling is named rather than hidden. `capability: null` is a row
 * everybody gets; the other three carry the same capability strings the rail
 * gates them on. A row that drifts out of step here shows an admin one row too
 * many or too few in a picture — bad, but not a permission: the real rail is
 * still gated by the real capabilities on the real session, and
 * `applyNavSwitches` can only ever subtract from whatever list it is handed.
 *
 * Order and `size` match the rail: four primary destinations, then the
 * "how you run it" group pinned to the bottom at a smaller weight.
 */
const RAIL_ROWS = [
  { to: '/dashboard', label: 'Dashboard', icon: Home, capability: null, size: 'primary' },
  { to: '/boards', label: 'My Boards', icon: Folder, capability: null, size: 'primary' },
  { to: '/my-tasks', label: 'My Work', icon: CheckSquare, capability: null, size: 'primary' },
  { to: '/chat', label: 'Chat', icon: MessageCircle, capability: null, size: 'primary' },
  {
    to: '/members',
    label: 'Members',
    icon: Users,
    capability: 'org.view_members',
    size: 'secondary',
  },
  {
    to: '/analytics',
    label: 'Analytics',
    icon: BarChart3,
    capability: 'analytics.view',
    size: 'secondary',
  },
  {
    to: '/productivity',
    label: 'Productivity',
    icon: Activity,
    capability: 'productivity.view_others',
    size: 'secondary',
  },
  { to: '/settings', label: 'Settings', icon: Settings, capability: null, size: 'secondary' },
];

/**
 * What a section type this build cannot draw says, inside a preview.
 *
 * The same fact `ExecutiveHomePage` reports for the same case — this bundle has
 * no renderer for a type the server composed happily — but a DIFFERENT sentence,
 * because the reader is different. "Reload the page to see it" is advice for the
 * person whose page it is; an admin needs to know that the section is fine and
 * that their own browser is the thing that is behind, so that they do not go and
 * delete a working section off somebody's home page.
 *
 * Spelled out here rather than imported: that page keeps its copy private, and
 * a shared constant with two meanings would end up with one sentence that fits
 * neither reader.
 */
const UNKNOWN_SECTION =
  'This section is on their home page, but this browser has an older copy of the app and cannot draw it. Reload to see it — nothing is wrong with the section.';

/** One rail row, in the rail's own idiom at preview scale. */
const PreviewRailRow = ({ label, icon, size }) => {
  const primary = size === 'primary';
  // Capitalised, because JSX reads a lowercase tag name as an HTML element.
  const Icon = icon;
  return (
    <li
      className="flex items-center"
      style={{
        height: primary ? 30 : 28,
        padding: '0 8px',
        gap: 9,
        borderRadius: 7,
      }}
    >
      <Icon
        size={primary ? 15 : 14}
        strokeWidth={1.7}
        aria-hidden="true"
        color="var(--color-text-muted)"
        className="shrink-0"
      />
      <span
        className="min-w-0 truncate font-body"
        style={{
          fontSize: primary ? 12.5 : 12,
          fontWeight: 500,
          color: primary
            ? 'var(--color-text-primary)'
            : 'var(--color-text-secondary)',
        }}
      >
        {label}
      </span>
    </li>
  );
};

/**
 * The rail as the target will see it: their capabilities first, then their
 * switches.
 *
 * THE ORDER IS THE SAFETY ARGUMENT, and it is the rail's own (spec invariant 6).
 * A row must survive the capability it asks for, and only then is the profile's
 * switch consulted — so `applyNavSwitches` is a filter over a list a capability
 * gate has already shortened, and a switch can never put a row back. Reversing
 * the two here would draw a preview in which switching Analytics on appears to
 * grant Analytics, which is the exact misunderstanding the real rail is built to
 * make impossible.
 *
 * Dashboard and Settings are never switchable — `ALWAYS_VISIBLE_ROUTES` inside
 * the helper protects them, and this component does not restate the rule.
 */
const PreviewRail = ({ nav, capabilities }) => {
  const rows = useMemo(() => {
    const held = new Set(capabilities || []);
    const gated = RAIL_ROWS.filter(
      (row) => !row.capability || held.has(row.capability)
    );
    // Both groups pass through the helper in one call — it preserves order and
    // returns the SAME array when there is no profile, so a target with no nav
    // object gets the rail everybody else gets.
    const kept = applyNavSwitches(gated, nav);
    return {
      primary: kept.filter((row) => row.size === 'primary'),
      secondary: kept.filter((row) => row.size === 'secondary'),
    };
  }, [nav, capabilities]);

  return (
    <div
      className="shrink-0 flex flex-col"
      style={{
        width: 168,
        borderRight: '1px solid var(--color-border)',
        background: 'var(--color-bg-surface)',
        padding: '10px 6px',
      }}
    >
      <ul className="flex flex-col" style={{ gap: 1 }}>
        {rows.primary.map((row) => (
          <PreviewRailRow key={row.to} {...row} />
        ))}
      </ul>
      <div className="flex-1" style={{ minHeight: 16 }} />
      <ul
        className="flex flex-col"
        style={{
          gap: 1,
          borderTop: '1px solid var(--color-border)',
          paddingTop: 6,
        }}
      >
        {rows.secondary.map((row) => (
          <PreviewRailRow key={row.to} {...row} />
        ))}
      </ul>
    </div>
  );
};

/**
 * One composed envelope, drawn by the renderer registered for its type.
 *
 * The same two lines `ExecutiveHomePage`'s `ComposedSection` runs, for the same
 * reason and with the same fallback shape — an unknown type gets a frame that
 * explains itself rather than vanishing or taking the pane down. It is written
 * out again rather than imported because that component is private to the page
 * and this file does not own it; the thing that MUST be shared is the registry
 * lookup, and it is.
 *
 * `createElement` rather than a JSX tag whose name is a local variable: the
 * component comes out of a module-level table and is not created here, and the
 * JSX form reads — to a person skimming, and to React's lint rules — as a
 * component being defined during render.
 */
const PreviewSection = ({ section }) => {
  const renderer = sectionComponentFor(section?.type);
  if (renderer) return createElement(renderer, { section });
  return (
    <SectionFrame
      // A COPY, never a mutation of the fetched envelope.
      section={{ ...section, state: 'unavailable', error: UNKNOWN_SECTION }}
      title={section?.type || 'Section'}
    />
  );
};

/**
 * The boards on the list that this person cannot open.
 *
 * SHOWN HERE AS WELL AS ON THE BOARDS STEP, and that repetition is deliberate.
 * This is the last screen before an admin walks away believing the view is
 * finished, and "these boards are on the list but this person cannot open them"
 * is the one fact that makes the picture below incomplete rather than wrong —
 * the entries are simply absent from it, which looks exactly like a shorter
 * list somebody chose. Outside the frame, in real markup, because it is the
 * only thing on this step anybody can act on.
 */
const SkippedNotice = ({ skipped, name }) => (
  <div
    className="font-body"
    style={{
      padding: '12px 14px',
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-status-stuck-bg)',
      color: 'var(--color-status-stuck)',
      fontSize: 13,
    }}
  >
    <p style={{ fontWeight: 600 }}>
      {skipped.length} {skipped.length === 1 ? 'board is' : 'boards are'} on this
      view that {name} cannot open.
    </p>
    <ul className="mt-1.5 space-y-0.5 list-disc pl-5">
      {skipped.map((entry, index) => (
        <li key={String(entry?.board || index)}>
          <strong>{entry?.name || 'A board with no name left'}</strong>
          {entry?.reason === 'deleted'
            ? ' — deleted. Take it off the list on the Boards step.'
            : ' — their share was revoked somewhere else. Add it again on the Boards step to give the access back.'}
        </li>
      ))}
    </ul>
    <p className="mt-1.5">
      {skipped.length === 1 ? 'It is' : 'They are'} not in the picture below,
      because {skipped.length === 1 ? 'it is' : 'they are'} not part of what{' '}
      {name} sees.
    </p>
  </div>
);

/**
 * What the content column shows when the profile has no sections.
 *
 * A HOME PAGE WITH NO SECTIONS IS NOT A BLANK SCREEN. `ExecutiveHomePage` falls
 * back to the person's board tiles plus a line inviting them to arrange the
 * page — so a preview that drew nothing here would be the one thing this step
 * exists to prevent: a confident picture of a screen that does not exist.
 *
 * It is DESCRIBED rather than drawn. Reproducing that fallback would mean a
 * second copy of a layout the home page keeps private, which is exactly the
 * drift the rest of this file is built to avoid — and the boards it tiles are
 * ids on the resolved profile, not board documents, so this side could not name
 * them without a second request that the endpoint deliberately does not make.
 */
const ImplicitHomeNote = ({ boards, name }) => (
  <div
    className="flex items-start gap-2.5"
    style={{
      padding: '16px 18px',
      borderRadius: 'var(--radius-md)',
      border: '1px dashed var(--color-border)',
      background: 'var(--color-bg-surface)',
    }}
  >
    <LayoutGrid
      size={16}
      aria-hidden="true"
      color="var(--color-text-muted)"
      className="shrink-0"
      style={{ marginTop: 1 }}
    />
    <div className="min-w-0">
      <p
        className="font-body font-semibold text-[13px]"
        style={{ color: 'var(--color-text-primary)' }}
      >
        No sections on their home page.
      </p>
      <p
        className="font-body text-[12.5px] mt-0.5"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        {boards === 0
          ? `${name} lands on an empty home page with nothing on it. Add boards on the Boards step, then compose the page on the Home step.`
          : `${name} lands on ${boards} board ${
              boards === 1 ? 'tile' : 'tiles'
            } — the boards on their list — and a line inviting them to arrange the page. Compose it for them on the Home step.`}
      </p>
    </div>
  </div>
);

/**
 * @param {Object} props
 * @param {string} props.name - the target, in the admin's words. Every sentence
 *   on this screen is about somebody who is not reading it, so nothing here says
 *   "you".
 * @param {Array}  props.sections - the composed envelopes, already ordered by
 *   the server.
 * @param {Array}  [props.skipped] - `{ board, name, reason }`, resolved AS THE
 *   TARGET.
 * @param {Object} [props.nav] - the target's eight rail switches.
 * @param {Array}  [props.capabilities] - the capability strings the TARGET's
 *   role holds, as the server resolved them. Never the admin's.
 * @param {number} [props.boardCount] - how many boards survived the resolve,
 *   for the empty-home note.
 */
const PreviewFrame = ({
  name,
  sections = [],
  skipped = [],
  nav = null,
  capabilities = [],
  boardCount = 0,
}) => (
  <div>
    {/* The caption. Outside the frame, so it is readable by everything that
        cannot read an `inert` subtree, and phrased as a statement about whose
        screen this is rather than as an instruction. */}
    <div
      className="flex items-start gap-2.5 mb-3"
      style={{
        padding: '10px 12px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-bg-subtle)',
      }}
    >
      <Eye
        size={15}
        aria-hidden="true"
        color="var(--color-text-muted)"
        className="shrink-0"
        style={{ marginTop: 2 }}
      />
      <p
        className="font-body min-w-0"
        style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}
      >
        Composed on the server <strong>as {name}</strong> — their boards, their
        role, their switches — so your own wider reach cannot leak into it.
        Nothing below works: it is a picture of their screen, not a way into it.
      </p>
    </div>

    {skipped.length > 0 && (
      <div className="mb-3">
        <SkippedNotice skipped={skipped} name={name} />
      </div>
    )}

    {/**
     * THE FRAME. See the header for why all three of `inert`,
     * `pointer-events: none` and the click refusal are here rather than
     * whichever one of them seems sufficient on its own.
     *
     * `onClickCapture` is the one that still fires when the other two have done
     * their job — a keyboard activation in a browser without `inert` — which is
     * the case it is actually for.
     */}
    <div
      inert
      onClickCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className="overflow-hidden"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--color-bg-subtle)',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      {/* Window chrome. Three dots and a route — the cheapest way to say
          "this is a picture of an application" before anybody reads a word
          of it, and the reason the caption above does not have to shout. */}
      <div
        className="flex items-center gap-2"
        style={{
          height: 32,
          padding: '0 12px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-bg-surface)',
        }}
      >
        <span aria-hidden="true" className="flex items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 7,
                height: 7,
                borderRadius: 9999,
                background: 'var(--color-border)',
                display: 'block',
              }}
            />
          ))}
        </span>
        <span
          className="font-body truncate"
          style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
        >
          {name} · /dashboard
        </span>
      </div>

      <div className="flex items-stretch" style={{ minHeight: 280 }}>
        <PreviewRail nav={nav} capabilities={capabilities} />

        <div className="flex-1 min-w-0" style={{ padding: 16 }}>
          {sections.length === 0 ? (
            <ImplicitHomeNote boards={boardCount} name={name} />
          ) : (
            /**
             * THE SAME GRID CLASS THE REAL HOME PAGE LAYS SECTIONS OUT WITH,
             * exported by `SectionFrame` beside the `lg:col-span-2` it has to
             * agree with. It is breakpoint-driven rather than container-driven,
             * so in this narrower pane a two-column row is tighter than it will
             * be on their screen — the RELATIVE widths, which are the thing
             * being previewed, are exact.
             */
            <div className={SECTION_GRID_CLASS}>
              {sections.map((section) => (
                <PreviewSection key={section.id} section={section} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>

    <p
      className="font-body mt-3 flex items-start gap-1.5"
      style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
    >
      <Info size={13} aria-hidden="true" className="shrink-0" style={{ marginTop: 1.5 }} />
      <span>
        {/* Said once, plainly. An admin who reads a preview as a report comes
            back a week later convinced the numbers moved on their own. */}
        The numbers are this moment's, scored by the same code their board pages
        use — a month's goals and this month's delivery change as the work does.
        The layout is what is being previewed.
      </span>
    </p>
  </div>
);

export default PreviewFrame;
