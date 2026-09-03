import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Folder, FolderOpen, ArrowRight, Lock, Globe } from 'lucide-react';
import { timeAgo } from '../../utils/dateUtils';
import { loadBoardVisits, sortByRecentlyVisited } from '../../utils/boardVisits';

/**
 * RecentBoards — dashboard card listing the boards you opened most recently.
 * See Macan_Design.md Section 7.3.
 *
 * "Recent" means YOUR last visit, not the board's `updatedAt`. The visit log is
 * device-local (see `utils/boardVisits.js`); boards you have never opened fall
 * in behind, keeping the server's `order asc, updatedAt desc` — which is also
 * exactly what the card shows before you have visited anything.
 *
 * The log is read at render rather than watched: this card lives on its own
 * route, so navigating back from a board remounts it with the visit already
 * written.
 *
 * Props:
 *   boards — array of Board objects, in the order the API returned them
 *   orgId  — organisation the boards belong to; picks the visit-log bucket
 *   limit  — max rows to render (default 5)
 */

const PrivacyBadge = ({ visibility }) => {
  const isPrivate = visibility === 'private';
  const Icon = isPrivate ? Lock : Globe;
  const bg = isPrivate ? '#FFF0F0' : 'var(--color-accent-light)';
  const color = isPrivate ? '#DC2626' : 'var(--color-accent-text)';

  return (
    <span
      className="inline-flex items-center gap-1 font-body font-medium"
      style={{
        fontSize: 11,
        background: bg,
        color,
        padding: '2px 8px',
        borderRadius: 'var(--radius-full)',
      }}
    >
      <Icon size={11} aria-hidden="true" />
      {isPrivate ? 'private' : 'public'}
    </span>
  );
};

const BoardRow = ({ board, onClick, isLast }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full flex items-center gap-3 text-left transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
    style={{
      height: 56,
      padding: '0 8px',
      borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
      borderRadius: 'var(--radius-sm)',
    }}
  >
    {/* Blue folder chip */}
    <div
      className="flex items-center justify-center shrink-0"
      style={{
        width: 32,
        height: 32,
        borderRadius: 'var(--radius-md)',
        background: 'rgba(37, 99, 235, 0.10)',
      }}
      aria-hidden="true"
    >
      <Folder size={16} color="var(--color-accent)" />
    </div>

    {/* Middle — name, then when it moved and how far along it is. The
        timestamp alone says a board was touched; the count says whether it
        needs you. Same two numbers the board card already shows. */}
    <div className="min-w-0 flex-1">
      <p
        className="font-body font-semibold truncate"
        style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
      >
        {board.name}
      </p>
      <p
        className="font-body truncate"
        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
      >
        Updated {timeAgo(board.updatedAt || board.createdAt)}
        {(board.taskCount ?? 0) > 0
          ? ` · ${board.doneCount ?? 0} / ${board.taskCount} done`
          : ''}
      </p>
    </div>

    {/* Right — progress, privacy badge, arrow */}
    <div className="flex items-center gap-2.5 shrink-0">
      <BoardProgress
        done={board.doneCount ?? 0}
        total={board.taskCount ?? 0}
      />
      <PrivacyBadge visibility={board.visibility} />
      <ArrowRight
        size={16}
        color="var(--color-text-muted)"
        aria-hidden="true"
      />
    </div>
  </button>
);

/**
 * A board's month at a glance: a slim bar plus the percentage. Green once the
 * board is mostly clear, amber while it isn't — the same reading the board
 * cards use, so a board looks the same wherever you meet it. Renders nothing
 * for a board with no tasks: 0/0 is not 0%, it is "nothing to say yet".
 */
const BoardProgress = ({ done, total }) => {
  if (!total) return null;
  const pct = Math.round((done / total) * 100);
  const healthy = pct >= 75;
  return (
    <div className="hidden sm:block shrink-0" style={{ width: 86 }} aria-hidden="true">
      <div
        style={{
          height: 5,
          borderRadius: 3,
          background: 'var(--color-bg-subtle)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: 5,
            borderRadius: 3,
            background: healthy
              ? 'var(--color-status-done)'
              : 'var(--color-status-working)',
            transition: 'width 240ms ease-out',
          }}
        />
      </div>
      <p
        className="font-body tabular-nums"
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          color: 'var(--color-text-secondary)',
          textAlign: 'right',
          marginTop: 4,
        }}
      >
        {pct}%
      </p>
    </div>
  );
};

const EmptyBoards = () => (
  <div
    className="flex flex-col items-center justify-center text-center"
    style={{ padding: '32px 16px' }}
  >
    <FolderOpen
      size={36}
      color="var(--color-text-muted)"
      aria-hidden="true"
    />
    <p
      className="font-body font-medium mt-3"
      style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
    >
      No boards yet
    </p>
    <p
      className="font-body mt-1"
      style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
    >
      Create your first board to get started.
    </p>
  </div>
);

const RecentBoards = ({ boards = [], orgId = null, limit = 5 }) => {
  const navigate = useNavigate();
  const visible = useMemo(
    () => sortByRecentlyVisited(boards, loadBoardVisits(orgId)).slice(0, limit),
    [boards, orgId, limit]
  );
  const total = boards.length;

  return (
    <section
      className="bg-surface h-full"
      style={{
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        padding: 24,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Folder size={20} color="#7C3AED" aria-hidden="true" />
          <div className="min-w-0">
            <h2
              className="font-display font-bold"
              style={{
                fontSize: 16,
                color: 'var(--color-text-primary)',
                lineHeight: 1.2,
              }}
            >
              Recent Boards
            </h2>
            <p
              className="font-body"
              style={{
                fontSize: 12,
                color: 'var(--color-text-muted)',
                marginTop: 2,
              }}
            >
              {total === 0
                ? 'No boards yet'
                : `${total} ${total === 1 ? 'board' : 'boards'}`}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => navigate('/boards')}
          className="font-body font-semibold transition-colors duration-150 hover:text-[color:var(--color-accent-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            fontSize: 13,
            color: 'var(--color-accent)',
            padding: '4px 8px',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          View All →
        </button>
      </div>

      {/* List */}
      <div className="mt-4">
        {visible.length === 0 ? (
          <EmptyBoards />
        ) : (
          visible.map((b, i) => (
            <BoardRow
              key={b._id}
              board={b}
              isLast={i === visible.length - 1}
              onClick={() => navigate(`/boards/${b._id}`)}
            />
          ))
        )}
      </div>
    </section>
  );
};

export default RecentBoards;
