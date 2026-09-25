import { useEffect, useRef, useState } from 'react';
import {
  Folder,
  Calendar,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import { timeAgo } from '../../utils/dateUtils';
import BoardTypePill from './BoardTypePill';
import EntityLogo from '../ui/EntityLogo';

/**
 * BoardCard — single card in the My Boards grid.
 * See Macan_Design.md Section 6.11.
 *
 * Props:
 *   board       — { _id, name, description, visibility, updatedAt, createdAt }
 *   label       — optional NICKNAME to title the card with instead of the
 *                 board's own name (see below)
 *   accentColor — CSS color for the top accent bar (cycled by parent)
 *   onOpen      — called when the card body is clicked
 *   canManage   — if true, show the ⋯ menu with Edit/Delete
 *   onEdit, onDelete — options menu handlers
 *   showProgress — if true (default), render the completion-percentage bar
 *
 * ---- WHY `label` IS A PROP AND NOT A STORE READ ----------------------------
 *
 * An executive view can give one person a private nickname for a board — "Q4
 * Retainer" over a real name of "Acme Digital — 2026" — and the card is one of
 * the two places that nickname shows (the other is the board page breadcrumb;
 * its <h1> deliberately keeps the real name).
 *
 * This card renders on several surfaces, drags inside a sortable wrapper, and
 * is used by people who have no executive view at all. Reaching into a store
 * from here to ask "does this viewer have a nickname for this board" would
 * couple every one of those surfaces to a feature none of them knows about, and
 * would make the card impossible to render from a payload — which is exactly
 * what the home page's board tiles do. So the caller, which already resolved
 * the label (`displayName` in `utils/executiveBoards.js`), passes it in.
 *
 * ---- AND WHY THE REAL NAME SURVIVES ----------------------------------------
 *
 * The nickname titles the card; the `title` attribute then carries BOTH names,
 * so hovering answers "which board am I actually opening". A card that shows
 * only a name nobody else uses is how somebody opens the wrong board and tells
 * a colleague about a board that colleague has never heard of.
 *
 * The real name is deliberately NOT given a second visible line: only some
 * cards in a grid carry a nickname, and a line that appears on some cards and
 * not others makes the row heights disagree. The title attribute is the whole
 * of the treatment.
 */
/** Height of the card's top accent stripe, in px. */
const ACCENT_HEIGHT = 4;

const BoardCard = ({
  board,
  label = '',
  accentColor = 'var(--color-card-blue)',
  onOpen,
  canManage = false,
  onEdit,
  onDelete,
  showProgress = true,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return undefined;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    const keyHandler = (e) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [menuOpen]);


  /**
   * What this card is titled, and what the hover says.
   *
   * An empty label MEANS "use the board's own name" (the model stores '' and
   * documents it that way), and a label equal to the name is not a nickname at
   * all — both fall through to the plain treatment rather than rendering a
   * blank title or repeating one name twice in the tooltip.
   */
  const nickname = label && label !== board.name ? label : '';
  const shownName = nickname || board.name;
  const nameTitle = nickname
    ? `${nickname} — the board's own name is “${board.name}”`
    : board.name;

  // Completion stats shipped by GET /api/boards; default to 0 for older
  // cached boards that predate the progress payload.
  const taskCount = board.taskCount ?? 0;
  const doneCount = board.doneCount ?? 0;
  const progress = board.progress ?? 0;

  const handleCardClick = () => {
    if (menuOpen) return;
    onOpen?.(board);
  };

  const handleCardKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen?.(board);
    }
  };

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      className="relative flex flex-col bg-surface cursor-pointer group focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
      style={{
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        // Accent stripe is painted as a background layer rather than a 4px
        // child: a child that short can't carry the card's 14px corner radius
        // (CSS scales it down to the box height), so its square corners poked
        // out past the card's curve. As a background it's clipped by the
        // card's own radius, and the ⋯ menu stays unclipped (no overflow:hidden).
        background: `linear-gradient(${accentColor}, ${accentColor}) top / 100% ${ACCENT_HEIGHT}px no-repeat, var(--color-bg-surface)`,
        transition: 'box-shadow 150ms ease, transform 150ms ease',
        zIndex: menuOpen ? 30 : 'auto',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = 'var(--shadow-md)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = 'var(--shadow-card)';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      <div
        className="px-4 pb-4 flex flex-col flex-1"
        style={{ paddingTop: 16 + ACCENT_HEIGHT }}
      >
        {/* Folder icon + privacy badge */}
        <div className="flex items-start justify-between">
          {/* The board's logo when it has one — a grid of client boards reads
              at a glance by their marks — else the folder glyph as before. */}
          {board.logo ? (
            <EntityLogo src={board.logo} name={board.name} size={36} radius={9} />
          ) : (
            <div
              className="flex items-center justify-center"
              style={{
                width: 32,
                height: 32,
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-accent-light)',
              }}
              aria-hidden="true"
            >
              <Folder size={18} color="var(--color-accent)" />
            </div>
          )}

          <BoardTypePill board={board} size={10} />
        </div>

        {/* Name */}
        <h3
          className="mt-3 font-display font-bold truncate"
          style={{
            fontSize: 16,
            color: 'var(--color-text-primary)',
          }}
          title={nameTitle}
        >
          {shownName}
        </h3>

        {/* Description */}
        <p
          className="mt-1 font-body"
          style={{
            fontSize: 13,
            color: board.description
              ? 'var(--color-text-secondary)'
              : 'var(--color-text-muted)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            minHeight: 36,
          }}
        >
          {board.description || 'No description'}
        </p>

        {/* Progress — percentage of tasks done on this board */}
        {showProgress && (
        <div className="mt-4">
          <div
            className="flex items-center justify-between font-body"
            style={{ marginBottom: 6 }}
          >
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              {taskCount > 0
                ? `${doneCount}/${taskCount} done`
                : 'No tasks yet'}
            </span>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
              }}
            >
              {progress}%
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${progress}% of tasks done`}
            style={{
              height: 6,
              borderRadius: 'var(--radius-full)',
              background: 'var(--color-bg-subtle)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: '100%',
                background: 'var(--color-status-done)',
                borderRadius: 'var(--radius-full)',
                transition: 'width 300ms ease',
              }}
            />
          </div>
        </div>
        )}

        {/* Divider */}
        <div
          className="mt-4"
          style={{ borderTop: '1px solid var(--color-border)' }}
        />

        {/* Footer: updated + options */}
        <div className="mt-3 flex items-center justify-between">
          <div
            className="flex items-center gap-1.5 font-body"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            <Calendar size={12} aria-hidden="true" />
            <span>
              Updated {timeAgo(board.updatedAt || board.createdAt)}
            </span>
          </div>

          {canManage && (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                aria-label="Board options"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((m) => !m);
                }}
                className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{ width: 28, height: 28 }}
              >
                <MoreHorizontal
                  size={16}
                  color="var(--color-text-secondary)"
                  aria-hidden="true"
                />
              </button>

              {menuOpen && (
                <div
                  role="menu"
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-0 z-20 mt-1 bg-surface"
                  style={{
                    minWidth: 140,
                    borderRadius: 'var(--radius-md)',
                    boxShadow: 'var(--shadow-md)',
                    border: '1px solid var(--color-border)',
                    padding: 4,
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onEdit?.(board);
                    }}
                    className="w-full flex items-center gap-2 font-body text-left hover:bg-[color:var(--color-bg-subtle)] transition-colors duration-150"
                    style={{
                      fontSize: 13,
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--color-text-primary)',
                    }}
                  >
                    <Pencil size={14} aria-hidden="true" />
                    Edit
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete?.(board);
                    }}
                    className="w-full flex items-center gap-2 font-body text-left hover:bg-[color:var(--color-bg-subtle)] transition-colors duration-150"
                    style={{
                      fontSize: 13,
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--color-status-stuck)',
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
};

export default BoardCard;
