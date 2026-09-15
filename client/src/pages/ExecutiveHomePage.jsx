import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, LayoutDashboard, Pencil, WifiOff } from 'lucide-react';
import PageWrapper from '../components/layout/PageWrapper';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonBoardCard } from '../components/ui/Skeleton';
import BoardCard from '../components/board/BoardCard';
import SectionFrame, {
  SECTION_GRID_CLASS,
} from '../components/executive/SectionFrame';
import SectionEditor from '../components/executive/SectionEditor';
import SECTION_REGISTRY, {
  sectionComponentFor,
} from '../components/executive/sectionRegistry';
import useOrgStore from '../store/orgStore';
import useBoardStore from '../store/boardStore';
import useToastStore from '../store/toastStore';
import useExecutiveViewStore from '../store/executiveViewStore';
import { getMyHome } from '../services/executiveViewService';
import { orderBoardsForProfile, displayName } from '../utils/executiveBoards';

/**
 * ExecutiveHomePage — `/dashboard` for somebody who has an executive view.
 *
 * ---- WHY THIS REPLACES THE DASHBOARD RATHER THAN EXTENDING IT --------------
 *
 * `DashboardPage` opens with a greeting and four stat cards: total boards,
 * completed tasks, pending tasks, completion rate — every one of them summed
 * across "every board you can see". Those are good questions about a workspace
 * you own. They are the wrong questions for a person whose reach is a handful
 * of curated boards, and the numbers would be actively misleading: "Total
 * Boards: 4" out of a workspace of forty reads as a workspace with four
 * boards, and a completion rate over four boards is not the company's
 * completion rate even though the card says it is. Recent Boards and Quick
 * Actions fail from the other end — they are shortcuts into a workspace this
 * person deliberately does not have.
 *
 * So the generic dashboard is not extended, hidden field by field, or gated
 * card by card. It is replaced, which is what EXECUTIVE_VIEW.md section 4.4
 * asks for.
 *
 * ---- WHAT THIS PAGE DOES, AND THE ONE THING IT MUST NOT DO ----------------
 *
 * It renders `GET /api/me/executive-home`, and it COMPUTES NOTHING (invariant
 * 5). That endpoint walks the profile's `home[]`, re-checks
 * `resolveAccess(...).canRead` for every board a section names, and calls the
 * scorers that already exist — `goalTypes.js` for goals, `deliveryReport.js`
 * for delivery, `adsBudgetPacing.js` for spend, `analyticsReport.js` for the
 * workspace numbers. Every section arrives as the envelope the shared contract
 * fixes:
 *
 *   { id, type, order, width, config, state: 'ok'|'empty'|'unavailable', data, error }
 *
 * and this page's whole job is to put each one in front of the renderer that
 * draws it, in a two-column grid, in the order the server sorted them. A number
 * derived here would be a second answer to a question the Goals tab already
 * answers, on a page whose entire value is being glanced at and believed.
 *
 * ---- WHY THE COMPOSED HOME IS RE-FETCHED AFTER A SAVE ---------------------
 *
 * The editor hands back a list of SECTIONS — types, widths and configs. The
 * page renders their COMPOSED form, which only the server can produce: a goal
 * section saved with `month: null` resolves to a month in the board's timezone,
 * an unreachable board becomes `unavailable`, an empty month becomes `empty`.
 * So saving writes the shape through `saveMine({ home })` and then asks the
 * server what that shape looks like. Rendering the editor's own list would draw
 * eight tiles with no data in them.
 *
 * ---- SKIPPED BOARDS ARE NOT AN ERROR ON THIS SCREEN -----------------------
 *
 * `GET /api/me/executive-view` answers with `skipped[]` — the profile entries
 * whose board this person can no longer open — and this page deliberately
 * never renders it. The profile it receives has already had those entries
 * removed from `boards[]`, so the board is simply absent, which is the truth:
 * it is not their board any more. Telling somebody "you have lost access to 2
 * boards" on their own home page is an alarm they can do nothing about, raised
 * about a change somebody else made on purpose. That flag belongs on the
 * admin's configurator, which is handed the same array and is the screen where
 * it can actually be acted on.
 *
 * (`GET /api/me/executive-home` carries no `skipped` at all, by design. A
 * section pointing at a board that left their reach is one `unavailable` tile
 * with the server's own sentence on it, which is the same fact told in the
 * place it matters.)
 */

/**
 * The same rotating accent palette the board grid uses (Design doc Section 2).
 * A local const rather than an import because `MyBoardsPage` keeps its own
 * copy private; if a third grid ever wants it, THAT is the moment to move it
 * somewhere shared rather than now.
 */
const ACCENT_CYCLE = [
  'var(--color-card-blue)',
  'var(--color-card-green)',
  'var(--color-card-orange)',
  'var(--color-card-purple)',
];

/**
 * What an envelope this build cannot draw says.
 *
 * The SERVER degrades a type IT no longer registers to `unavailable` with its
 * own sentence. This is the other direction and a genuinely different fact: the
 * server composed the section happily, and this bundle — a tab left open across
 * a deploy, or a rollback — has no renderer for it. Saying "no longer
 * available" there would be wrong; it exists, this copy of the app just cannot
 * draw it, and a reload is the fix.
 */
const UNKNOWN_SECTION =
  'This section needs a newer version of the app. Reload the page to see it.';

const ExecutiveHomePage = () => {
  const navigate = useNavigate();
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const boards = useBoardStore((s) => s.boards);
  const boardsLoading = useBoardStore((s) => s.loading);
  /**
   * The last `GET /api/boards` failed.
   *
   * Read rather than swallowed, because a failed board read and a person with
   * no boards produce the IDENTICAL state — an empty `boards` array — and this
   * page states that state as a fact about somebody ELSE's actions ("Your admin
   * has not added boards yet"). A dropped request must not be allowed to make
   * that claim on the front door of the app: it is specific, it names a cause,
   * it is wrong, and the person reading it can do nothing about it. An empty
   * list is not the same shape as a broken one, and the two get different
   * sentences — see `ImplicitTiles`.
   */
  const boardsFailed = useBoardStore((s) => !!s.error);
  const fetchBoards = useBoardStore((s) => s.fetchBoards);
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  // The profile is fetched once per (user, org) from App.jsx, the way holidays
  // already are — this page reads it and never loads it, so arriving here from
  // anywhere else in the app costs no extra request.
  const profile = useExecutiveViewStore((s) => s.profile);
  const profileLoading = useExecutiveViewStore((s) => s.loading);
  const saveMine = useExecutiveViewStore((s) => s.saveMine);

  const orgId = currentOrg?._id || null;

  /** `null` until the first compose lands; an array (possibly empty) after. */
  const [sections, setSections] = useState(null);
  const [homeLoading, setHomeLoading] = useState(true);
  const [homeError, setHomeError] = useState('');
  const [editing, setEditing] = useState(false);

  /**
   * Which compose is the current one.
   *
   * The same device `executiveViewStore.fetchMine` uses, for the same bug:
   * switching workspaces twice quickly leaves two requests in flight, and if
   * the FIRST lands last the page draws org A's sections under org B. A
   * superseded response is dropped rather than written.
   */
  const homeTicket = useRef(0);

  /**
   * Fetch the board list — and let the STORE remember whether that worked.
   *
   * The catch here only keeps the console honest and stops an unhandled
   * rejection; the outcome itself is `boardStore.error`, which `fetchBoards`
   * clears on the way in and sets on the way out, and which nothing else in
   * that store ever writes. So it is not a shared "something went wrong on a
   * board somewhere" field — it is exactly the result of the last
   * `GET /api/boards`, which is the question this page needs answered. A local
   * copy of it would be a second source for one fact, and one of the two would
   * eventually be stale.
   *
   * `boards` is deliberately left alone on a failure: a refetch that drops
   * after a good one still has a real list on screen, and blanking it would
   * turn a network blip into "your boards are gone".
   */
  const loadBoards = useCallback(() => {
    if (!orgId) return;
    fetchBoards(orgId).catch((err) => {
      console.error('Failed to fetch boards:', err);
    });
  }, [orgId, fetchBoards]);

  useEffect(() => {
    loadBoards();
  }, [loadBoards]);

  const loadHome = useCallback(async () => {
    if (!orgId) {
      homeTicket.current += 1;
      setSections([]);
      setHomeLoading(false);
      setHomeError('');
      return;
    }
    const ticket = (homeTicket.current += 1);
    setHomeLoading(true);
    setHomeError('');
    try {
      const data = await getMyHome(orgId);
      if (ticket !== homeTicket.current) return; // superseded
      setSections(Array.isArray(data?.sections) ? data.sections : []);
      setHomeLoading(false);
    } catch (err) {
      if (ticket !== homeTicket.current) return;
      if (err?.response?.status === 404) {
        // "You have no profile in this workspace" — the same fact a null
        // profile reports, and not an error to put in front of anybody: the
        // shell above this page is already about to render the standard
        // dashboard instead.
        setSections([]);
        setHomeError('');
      } else {
        // `sections` IS LEFT ALONE. Whatever is on screen was composed by the
        // server and is still true; a dropped request does not make it wrong,
        // and blanking a page somebody was reading is a worse answer than a
        // line saying the refresh did not work. On a FIRST load it is still
        // null, so the page falls through to the board tiles under the message
        // rather than sitting on a skeleton forever.
        setHomeError(
          err?.response?.data?.error ||
            'Your home page could not be loaded just now.'
        );
        console.error('Failed to load the executive home:', err);
      }
      setHomeLoading(false);
    }
  }, [orgId]);

  // Guarded on `orgId` rather than calling straight through: with no workspace
  // there is nothing to compose, and the page's initial state already says
  // "nothing loaded". `loadHome` keeps its own no-org branch for the retry
  // button, which can outlive an org switch.
  useEffect(() => {
    if (!orgId) return;
    loadHome();
  }, [orgId, loadHome]);

  /**
   * The boards the tiles and the editor's picker may name.
   *
   * Drawn from the boards the SERVER sent rather than from the profile's ids:
   * `GET /api/boards` is already filtered on `resolveAccess(...).canRead`, so
   * intersecting the two is what makes this page obey reach without asking a
   * permission question of its own (invariant 1 — the profile never grants
   * anything). A profile entry whose board is not in that list is a board this
   * person cannot open, which is exactly the option a picker must not offer.
   */
  const listed = useMemo(
    () => orderBoardsForProfile(boards, profile).listed,
    [boards, profile]
  );

  // Skeletons while either half is still arriving. The `boards.length` guard is
  // what stops a refetch on org switch from blanking a grid already on screen.
  const tilesLoading = profileLoading || (boardsLoading && boards.length === 0);

  const openBoard = (board) => navigate(`/boards/${board._id}`);

  /**
   * Save the arranged sections, then ask the server what they look like.
   *
   * Thrown rather than caught at the end: `SectionEditor` awaits this and keeps
   * the draft (and says so) when it rejects, which is the whole reason a failed
   * save must not resolve. The toast is here because the editor's own line is
   * one small sentence in a footer.
   */
  const handleSaveHome = async (nextHome) => {
    // Sent as the editor built it. `validateSection` on the server rebuilds each
    // section out of the keys it knows, so the editor's local `key` on a section
    // that has never been stored is dropped rather than saved — and `saveMine`
    // carries `boards` and `nav` over from the loaded profile, because this PUT
    // replaces the document and a body of `{ home }` alone would delete the
    // person's board list and rail switches on the way past.
    const result = await saveMine({ home: nextHome });

    // ONE sentence for `dropped`, whatever it described. The server merges
    // board entries it would not keep and board ids it stripped out of section
    // configs into a single list, so splitting them here would be this page
    // inventing a distinction the payload does not make.
    const dropped = result?.dropped || [];
    if (dropped.length > 0) {
      toastError(
        `Saved, but ${dropped.length} ${
          dropped.length === 1
            ? 'board you cannot open was'
            : 'boards you cannot open were'
        } removed.`
      );
    } else {
      toastSuccess('Your home page was saved.');
    }

    // The composed payload is server-computed — see the header. `loadHome`
    // reports its own failures, so a refetch that fails leaves the page with a
    // message on it rather than turning a successful save into a failed one.
    await loadHome();
    // Closed only on success. The editor sets its own state after this resolves
    // and is unmounted by then, which React treats as a no-op — a failed save
    // rejects above and leaves the editor open, holding the draft.
    setEditing(false);
  };

  const composed = sections || [];
  /**
   * Has this person (or their admin) put anything on the home page?
   *
   * Read off the PROFILE rather than off the composed list, because the two
   * answer different questions and only one of them is about the person. A
   * compose that failed comes back empty, and an empty compose is not the same
   * fact as an empty `home[]` — the first must not invite somebody to "arrange
   * your home" when they already have, under a banner saying the page could not
   * be loaded.
   */
  const hasArranged = (profile?.home || []).length > 0;
  // An empty `home[]` is not an empty page — see `ImplicitTiles`.
  const arranged = composed.length > 0;

  return (
    <PageWrapper>
      {/* Page header */}
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1
            className="font-display font-bold text-[22px] md:text-[28px]"
            style={{
              color: 'var(--color-text-primary)',
              letterSpacing: '-0.02em',
            }}
          >
            Dashboard
          </h1>
          <p
            className="mt-1 font-body"
            style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}
          >
            {/* Titled after the rail entry that leads here. A page whose heading
                disagrees with the link you clicked is a small support ticket. */}
            {currentOrg?.name
              ? `Your view of ${currentOrg.name}`
              : 'The boards you asked to keep an eye on'}
          </p>
        </div>

        {/* Hidden while the editor is open: it carries its own Save and Cancel,
            and a third button that also means "stop editing" would be a race
            between two ways of leaving with unsaved work. */}
        {profile && !editing && (
          <Button
            variant="secondary"
            icon={Pencil}
            onClick={() => setEditing(true)}
          >
            Edit home
          </Button>
        )}
      </header>

      <div className="mt-6">
        {/* Said above the EDITOR as well as in the tiles below, because a board
            list that did not load empties the section pickers: every
            board-backed section would offer nothing to point at, and the editor
            has no idea why (it is handed a list and asks no questions). A
            section already pointing at a board keeps that board — the config
            form holds an id it cannot name rather than clearing it — so this is
            a warning about what can be CHOSEN, not about what is stored. */}
        {editing && boardsFailed && (
          <HomeError
            message="Your boards could not be loaded, so the board pickers below are empty. Sections you have already set up keep the board they point at."
            onRetry={loadBoards}
          />
        )}

        {editing ? (
          <SectionEditor
            // The STORED sections, not the composed envelopes: the editor edits
            // `{ type, width, config }` and the composer's `data`/`state`/
            // `error` are answers about them, not part of them.
            home={profile?.home || []}
            boards={listed}
            registry={SECTION_REGISTRY}
            onChange={handleSaveHome}
            onCancel={() => setEditing(false)}
            title="Arrange your home"
            description="Add the sections you want, drag them into order, and set how wide each one is."
          />
        ) : homeLoading && sections === null ? (
          // Only on the FIRST compose. A refetch after a save keeps the page it
          // already has on screen rather than flashing a placeholder over it.
          <LoadingHome />
        ) : (
          <>
            {homeError && <HomeError message={homeError} onRetry={loadHome} />}

            {arranged ? (
              <div className={SECTION_GRID_CLASS}>
                {composed.map((section) => (
                  <ComposedSection key={section.id} section={section} />
                ))}
              </div>
            ) : (
              <ImplicitTiles
                tiles={listed}
                loading={tilesLoading}
                failed={boardsFailed}
                onRetry={loadBoards}
                onOpen={openBoard}
                onArrange={() => setEditing(true)}
                showHint={!!profile && !hasArranged}
              />
            )}
          </>
        )}
      </div>
    </PageWrapper>
  );
};

/**
 * One composed envelope, drawn by the renderer registered for its type.
 *
 * A type with no renderer does NOT vanish and does NOT take the page down. It
 * gets the frame's `unavailable` state, which is the same treatment the server
 * gives a type it no longer registers — a tile that explains itself beats a gap
 * somebody has to work out the cause of, and beats a white screen by rather
 * more.
 *
 * The RAW TYPE is the heading, for the same reason `SectionRow` in the editor
 * uses it: there is no registry entry to take a label from (that is what makes
 * this branch happen at all), it is the only name this build has for the thing,
 * and it is the word a support conversation will be about.
 */
const ComposedSection = ({ section }) => {
  const renderer = sectionComponentFor(section?.type);
  // `createElement`, not `<Renderer section={…} />`. The component comes out of
  // a module-level TABLE and is not created here — but a JSX tag whose name is
  // a local variable reads, to a person skimming and to React's own lint rules
  // alike, as a component being defined during render, which is the thing that
  // remounts a subtree on every keystroke. Same call, no ambiguity.
  if (renderer) return createElement(renderer, { section });

  return (
    <SectionFrame
      // A COPY. The envelope belongs to the fetched list; forcing a state onto
      // the object itself would mean a re-render after a save saw a section as
      // unavailable that the server had said was fine.
      section={{ ...section, state: 'unavailable', error: UNKNOWN_SECTION }}
      title={section?.type || 'Section'}
    />
  );
};

/** The first-compose placeholder, in the app's skeleton idiom. */
const LoadingHome = () => (
  <div
    className={SECTION_GRID_CLASS}
    role="status"
    aria-live="polite"
    aria-label="Loading your home page"
  >
    {[0, 1, 2].map((i) => (
      <div key={i} className={i === 0 ? 'lg:col-span-2' : ''}>
        <div
          className="bg-surface"
          style={{
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--color-border)',
            height: i === 0 ? 180 : 148,
          }}
        />
      </div>
    ))}
  </div>
);

/**
 * A compose that failed — a line, not a wall.
 *
 * It sits ABOVE whatever the page can still show rather than replacing it: a
 * failed refetch after a save leaves the previous sections on screen, and those
 * are still true. Retry rather than "reload the page", because one request
 * failing is the likely cause and reloading costs the whole app.
 */
const HomeError = ({ message, onRetry }) => (
  <div
    role="status"
    className="flex flex-wrap items-center gap-3 mb-5"
    style={{
      padding: '12px 14px',
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-bg-subtle)',
    }}
  >
    <p
      className="font-body min-w-0"
      style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
    >
      {message}
    </p>
    <div className="flex-1" />
    <Button size="sm" variant="secondary" onClick={onRetry}>
      Try again
    </Button>
  </div>
);

/**
 * THE IMPLICIT DEFAULT — what a profile with an empty `home[]` shows.
 *
 * Most people are given an executive view before anybody composes a home page
 * for them, and a blank screen at the front door of the app is indistinguishable
 * from a broken one. So an unarranged home renders the boards on the person's
 * list, which is the one thing every profile has, plus a quiet line saying the
 * page can be arranged.
 *
 * NOTHING IS WRITTEN TO THE PROFILE TO MAKE THIS HAPPEN. Seeding a `boardTiles`
 * section behind somebody's back would mean the first time they opened the
 * editor they would find a section they never added — and worse, the admin's
 * configurator would show one too, so "this view has no home sections" would
 * stop being a thing anybody could see. `home[]` stays empty until a person
 * puts something in it.
 *
 * ---- WHY THIS IS NOT THE `boardTiles` RENDERER ---------------------------
 *
 * `BoardTilesSection` draws a COMPOSED envelope, and there is no envelope here:
 * the server composed nothing because there was nothing to compose. Fabricating
 * one — inventing an `id`, a `state` and a `data.boards` — would be this page
 * doing the composer's job, which is the one thing invariant 5 forbids, and it
 * would put a made-up server payload into a component whose contract says it
 * renders a real one. The moment somebody adds a `boardTiles` section, THAT
 * renderer draws it from real data and this block is not on screen at all.
 */
const ImplicitTiles = ({
  tiles,
  loading,
  failed,
  onRetry,
  onOpen,
  onArrange,
  showHint,
}) => {
  if (loading) {
    return (
      <div
        className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
        role="status"
        aria-live="polite"
        aria-label="Loading your boards"
      >
        {[0, 1, 2].map((i) => (
          <SkeletonBoardCard key={i} index={i} />
        ))}
      </div>
    );
  }

  if (tiles.length === 0) {
    return (
      <div
        className="bg-surface"
        style={{
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-card)',
          padding: '48px 16px',
        }}
      >
        {failed ? (
          /**
           * TWO EMPTY LISTS, TWO DIFFERENT SENTENCES.
           *
           * An empty `boards` array is what a person with no boards looks like
           * AND what a dropped `GET /api/boards` looks like, and the copy below
           * is not a description of a list — it is a claim about what somebody
           * else has or has not done. Saying "your admin has not added boards"
           * because a request timed out is a confident, specific, wrong answer
           * on the first screen of the app, and the one person who could act on
           * it is the one being told to wait. When the fetch is what failed,
           * this says so and offers the only thing that helps.
           */
          <EmptyState
            icon={WifiOff}
            title="Your boards could not be loaded"
            description="This is a problem reaching the server, not a change to your view. Try again in a moment."
            actionLabel="Try again"
            onAction={onRetry}
          />
        ) : (
          /* No action button on THIS branch: there is nothing this person can do
             about it from here. Which boards are on this list is set by whoever
             configured the view, and saying so plainly is more use than a button
             that opens a picker whose save they would not be allowed to make. */
          <EmptyState
            icon={FolderOpen}
            title="Your admin has not added boards yet"
            description="When they do, the boards you need will show up here."
          />
        )}
      </div>
    );
  }

  return (
    <>
      {/* Boards ARE on screen — a refetch failed after a good one, so the grid
          below is real but may be out of date. A line above it, not instead of
          it: the tiles are still the best answer this page has. */}
      {failed && (
        <HomeError
          message="Your boards could not be refreshed just now, so this list may be out of date."
          onRetry={onRetry}
        />
      )}

      <section aria-label="Your boards">
        <div className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {tiles.map(({ board, label }, i) => (
            <BoardCard
              key={board._id}
              // The label is a nickname applied to a COPY. `board.name` is what
              // everybody else calls this board and what the board page's own
              // heading shows; a nickname that reached the real object would be
              // one careless save from renaming the board for the whole company.
              board={
                label ? { ...board, name: displayName(board, { label }) } : board
              }
              accentColor={ACCENT_CYCLE[i % ACCENT_CYCLE.length]}
              // Phase 3 hangs `?view=<entry.defaultTab>` off this link so that a
              // tracker board can open on Goals. Until then it is the plain board
              // link, which `resolveView` already lands on the Board tab.
              onOpen={() => onOpen(board)}
              canManage={false}
              showProgress
            />
          ))}
        </div>
      </section>

      {/* Quiet, and at the bottom. This is an invitation, not a task: a person
          who is happy with four board tiles should be able to ignore it forever
          without the page nagging from the top of the screen. */}
      {showHint && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <LayoutDashboard
            size={15}
            color="var(--color-text-muted)"
            aria-hidden="true"
          />
          <p
            className="font-body min-w-0"
            style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
          >
            This page can show goal scores, delivery, ads pacing and your own
            work as well — arrange it however you want it.
          </p>
          <Button size="sm" variant="ghost" onClick={onArrange}>
            Arrange my home
          </Button>
        </div>
      )}
    </>
  );
};

export default ExecutiveHomePage;
