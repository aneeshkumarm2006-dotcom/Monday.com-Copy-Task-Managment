import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import SectionFrame from '../SectionFrame';
import { boardViewLink } from '../sectionLinks';
import BoardCard from '../../board/BoardCard';
import useBoardStore from '../../../store/boardStore';

/**
 * BoardTilesSection — the profile's boards, as cards.
 *
 * Payload (`executiveHome.runBoardTiles`):
 *   { boards: [{ board, name, label, defaultTab }] }
 *
 * ---- WHY THIS READS THE BOARD STORE ---------------------------------------
 *
 * The composer ships four fields per tile and deliberately no progress bar and
 * no permissions. Both of those already exist: `GET /api/boards` computes them
 * (`computeBoardProgress` and `withPermissions`, both private to
 * `boardController.js`) and the board store holds the result, which the
 * executive home has already fetched for its own board list. A second copy
 * inside the home composer would be a second answer to "how far through is this
 * board", and the two would eventually disagree on a page whose whole job is
 * being glanced at and believed.
 *
 * So the section says WHICH boards and in what order — the one question only
 * the profile can answer — and the store supplies what each board looks like.
 *
 * ---- WHY A MISSING STORE ENTRY IS NOT A GAP -------------------------------
 *
 * The store may be empty on first paint, mid-refetch after an org switch, or
 * simply behind. A tile whose board is not in it yet still renders: the
 * composer already resolved the board's real name, and every field `BoardCard`
 * needs beyond that has a sensible default. What it loses is the completion
 * bar, and `showProgress` is switched off for exactly those tiles rather than
 * letting the card draw a confident 0% over a board full of finished work.
 *
 * Reach is not in question here either way. The composer resolved every one of
 * these ids through `resolveAccess(...).canRead` before it named them, and
 * `GET /api/boards` filters on the same thing — so the store can only ever make
 * a tile prettier, never legal.
 */

/**
 * The rotating accent palette the board grids use (Design doc Section 2).
 * `MyBoardsPage` and `ExecutiveHomePage` each keep their own copy of this; a
 * third one here is the point at which it should move somewhere shared, and
 * that move belongs in a commit that owns those two pages.
 */
const ACCENT_CYCLE = [
  'var(--color-card-blue)',
  'var(--color-card-green)',
  'var(--color-card-orange)',
  'var(--color-card-purple)',
];

const BoardTilesSection = ({ section }) => {
  const navigate = useNavigate();
  const boards = useBoardStore((s) => s.boards);

  // One pass over the store per render rather than a `find` per tile: a
  // workspace has forty boards and a tile list has four, and the quadratic
  // version is the one that gets written by accident.
  const storeById = useMemo(() => {
    const map = new Map();
    for (const board of boards || []) map.set(String(board?._id || ''), board);
    return map;
  }, [boards]);

  const tiles = section?.data?.boards || [];

  return (
    <SectionFrame
      section={section}
      title="Your boards"
      subtitle={tiles.length > 0 ? `${tiles.length} board${tiles.length === 1 ? '' : 's'}` : undefined}
      emptyMessage="No boards have been added to your view yet."
    >
      {() => (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {tiles.map((tile, i) => {
            const stored = storeById.get(String(tile.board));
            return (
              <BoardCard
                key={tile.board}
                /**
                 * A COPY, always — but one carrying the board's REAL name, with
                 * the nickname handed over separately as `label`.
                 *
                 * The label is a nickname for finding this board in a list, not
                 * a rename: `board.name` is what everybody else calls it and
                 * what the board page's own heading shows. Writing the nickname
                 * into `name` would leave the card with nothing to put in the
                 * tooltip that answers "which board am I actually opening", and
                 * a nickname that reached the real store object would be one
                 * careless save away from renaming the board for the whole
                 * company — hence the copy. The id is forced back on afterwards
                 * so a stale store entry cannot hand the card a different
                 * board's identity.
                 */
                board={{
                  ...(stored || {}),
                  _id: tile.board,
                  name: tile.name || stored?.name || '',
                }}
                label={tile.label || ''}
                accentColor={ACCENT_CYCLE[i % ACCENT_CYCLE.length]}
                /**
                 * The tile's OWN target, which is what makes a default tab worth
                 * setting: a tracker board opens on Goals for this person and on
                 * Board for everybody else. No month — a board tile is about the
                 * board, not about a month of it, and the board picks its own
                 * current one.
                 */
                onOpen={() => navigate(boardViewLink(tile.board, { tab: tile.defaultTab }))}
                /**
                 * `canManage={false}`, deliberately. The options menu is Edit and
                 * Delete; this is a reading surface, and a destructive menu one
                 * click from the front door of the app — on a card that may be
                 * showing a nickname — is not worth the click it saves. The same
                 * person can rename or delete the board from My Boards or from
                 * the board itself, where the name on screen is the real one.
                 */
                canManage={false}
                showProgress={!!stored}
              />
            );
          })}
        </div>
      )}
    </SectionFrame>
  );
};

export default BoardTilesSection;
