import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Search, X, CornerDownLeft } from 'lucide-react';
import { cellWrapperStyle, boardIdOf } from './cellShared';
import AnchoredPopover from '../../ui/AnchoredPopover';
import EntityLogo from '../../ui/EntityLogo';
import useBoardStore from '../../../store/boardStore';
import useOrgStore from '../../../store/orgStore';
import * as boardService from '../../../services/boardService';

/**
 * ClientCell — which CLIENT a row is for, picked from the workspace's client
 * boards.
 *
 * ---- Why a board and not a row --------------------------------------------
 *
 * A Client Portal board (`boardType: 'client'`) IS one client: its groups are
 * that client's services, its portal is that client's login, its logo is that
 * client's logo. So "which client is this invoice for" is a choice among
 * BOARDS, and the Connect Boards column the billing template used to seed for
 * it could never answer: that column links ROWS, it needed a target board
 * configured before it did anything, and there is no row on a client board
 * that stands for the client. This is the picker the question actually needed.
 *
 * ---- The value ---------------------------------------------------------------
 *
 *   null | { boardId: string | null, name: string }
 *
 * `name` is a SNAPSHOT, stored beside the id on purpose:
 *   - a private client board is invisible to most of the people who read an
 *     invoice, and they must still see who it is for — so a reader the board is
 *     hidden from renders `name`, never "Unknown";
 *   - an agency bills clients who have no portal board at all, so `boardId:
 *     null` with a typed name is a first-class answer ("Use 'Acme'"), not an
 *     error.
 * The server re-checks a non-null `boardId` (a client board in the SAME
 * workspace) and overwrites `name` with that board's current display name, so
 * the snapshot is refreshed on every write and cannot be forged into saying
 * one client while pointing at another.
 *
 * ---- Where the list comes from ---------------------------------------------
 *
 * `useBoardStore().boards` — the workspace's boards THIS viewer can see, as the
 * server filtered them (`GET /api/boards`). Visibility is the server's call
 * (the two-layer AND in utils/permissions.js); re-deriving it here from
 * `memberAccess` would be the drift that model exists to remove. When the list
 * has not been loaded for this row's workspace, opening the picker loads it —
 * through the store when it IS the current workspace (so every other surface
 * benefits), and locally otherwise, because `fetchBoards` REPLACES the list and
 * a cross-workspace deep link keeps its board in that list.
 *
 * Display name: `portalClientName`, the label the client sees on their own
 * portal, else the board's name — the same fallback the portal itself uses.
 */

/** The name a client board goes by — what its portal header shows the client. */
const clientBoardName = (board) =>
  (typeof board?.portalClientName === 'string' && board.portalClientName.trim()) ||
  board?.name ||
  '';

/**
 * A stored cell as `{ boardId, name }`, or null for "no client".
 *
 * Fail-soft on shapes the type never writes but a converted column might hold:
 * a bare string reads as a typed name rather than rendering nothing.
 */
const clientValueOf = (value) => {
  if (value == null) return null;
  if (typeof value === 'string') {
    const name = value.trim();
    return name ? { boardId: null, name } : null;
  }
  if (typeof value !== 'object') return null;
  const boardId = value.boardId != null && value.boardId !== '' ? String(value.boardId) : null;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!boardId && !name) return null;
  return { boardId, name };
};

/** Mirrors the server's cap on a typed client name. */
const MAX_NAME = 120;

const orgIdOf = (board) => {
  const o = board?.organisation;
  if (!o) return null;
  return String(typeof o === 'object' ? o._id ?? '' : o) || null;
};

const optionStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '6px 8px',
  fontSize: 13,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--color-text-primary)',
  textAlign: 'left',
};

const ClientCell = ({ value, column, task, readOnly, onChange }) => {
  const [anchor, setAnchor] = useState(null);
  const wrapperRef = useRef(null);
  const editable = !readOnly && typeof onChange === 'function';

  const boards = useBoardStore((s) => s.boards);
  const storeLoading = useBoardStore((s) => s.loading);
  const fetchBoards = useBoardStore((s) => s.fetchBoards);
  const currentOrgId = useOrgStore((s) => (s.currentOrg?._id ? String(s.currentOrg._id) : null));

  // The workspace this row lives in: its own board's, else the selected one.
  const hostBoardId = boardIdOf(task);
  const hostBoard = useMemo(
    () => (hostBoardId ? boards.find((b) => String(b._id) === hostBoardId) || null : null),
    [boards, hostBoardId]
  );
  const orgId = orgIdOf(hostBoard) || currentOrgId;

  // A list fetched here for a workspace that is NOT the selected one — see the
  // header on why that one must not go through the store.
  const [localBoards, setLocalBoards] = useState(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const source = localBoards || boards;
  const clientBoards = useMemo(
    () =>
      source
        .filter((b) => b && b.boardType === 'client' && (!orgId || orgIdOf(b) === orgId))
        .slice()
        .sort((a, b) => clientBoardName(a).localeCompare(clientBoardName(b))),
    [source, orgId]
  );

  const current = clientValueOf(value);
  // The linked board as THIS viewer sees it now — null when it is private to
  // them or has been deleted, and then the snapshot name is the whole answer.
  const linked = current?.boardId
    ? source.find((b) => String(b._id) === current.boardId) ||
      boards.find((b) => String(b._id) === current.boardId) ||
      null
    : null;
  const shownName = (linked && clientBoardName(linked)) || current?.name || '';
  const label = column?.name || 'Client';

  // Load the workspace's boards when the picker OPENS, once per mount, if none
  // of them are here. "None other than this row's own" is the test: a list
  // holding only the host board is what a deep link leaves behind. Started
  // from the click rather than an effect, so nothing is fetched for the
  // hundreds of cells a board renders and nobody opens.
  //
  // Not cancelled when the popover closes: the list is still wanted the next
  // time it opens, and a request abandoned there would never be made again.
  const requestedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const ensureWorkspaceBoards = () => {
    if (requestedRef.current || !orgId) return;
    const haveWorkspace = boards.some(
      (b) => orgIdOf(b) === orgId && String(b._id) !== hostBoardId
    );
    if (haveWorkspace) return;
    requestedRef.current = true;
    if (orgId === currentOrgId) {
      fetchBoards(orgId).catch(() => {
        if (mountedRef.current) setLoadError('Could not load the client boards.');
      });
      return;
    }
    setLocalLoading(true);
    boardService
      .getBoards(orgId)
      .then((list) => {
        if (mountedRef.current) setLocalBoards(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (mountedRef.current) setLoadError('Could not load the client boards.');
      })
      .finally(() => {
        if (mountedRef.current) setLocalLoading(false);
      });
  };

  const pick = (next) => {
    setAnchor(null);
    // The popover held focus (its search box) and is about to unmount; hand it
    // back to the cell, as Escape does, rather than dropping it on <body>.
    wrapperRef.current?.querySelector('button')?.focus();
    if (!editable) return;
    if (next === null) {
      if (current) onChange(null);
      return;
    }
    // Re-picking the client already chosen is not a write.
    if (next.boardId && current?.boardId === next.boardId) return;
    if (!next.boardId && !current?.boardId && current?.name === next.name) return;
    onChange(next);
  };

  const face = current ? (
    <span className="inline-flex items-center min-w-0" style={{ gap: 6, maxWidth: '100%' }}>
      {linked?.logo ? (
        <EntityLogo src={linked.logo} name={shownName} size={18} radius={4} fallback={null} />
      ) : null}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {shownName}
      </span>
    </span>
  ) : (
    <span style={{ color: 'var(--color-text-muted)' }}>{editable ? 'Choose…' : '—'}</span>
  );

  // Says which kind of answer this is, since the face alone cannot: a typed
  // name looks exactly like a linked board that has no logo.
  const title = current
    ? current.boardId
      ? `${shownName} — client board`
      : `${shownName} — typed name, not linked to a client board`
    : undefined;
  const summary = current ? shownName : 'none';

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      {editable ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (anchor) {
              setAnchor(null);
              return;
            }
            ensureWorkspaceBoards();
            setAnchor(wrapperRef.current);
          }}
          aria-haspopup="dialog"
          aria-expanded={!!anchor}
          aria-label={`${label}: ${summary} — change`}
          title={title}
          className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)] focus-visible:outline-offset-[-2px]"
          style={{
            ...cellWrapperStyle,
            gap: 6,
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            textAlign: 'left',
            minWidth: 0,
          }}
        >
          {face}
        </button>
      ) : (
        <div
          style={{ ...cellWrapperStyle, gap: 6, minWidth: 0 }}
          aria-label={`${label}: ${summary}`}
          title={title}
        >
          {face}
        </div>
      )}

      {anchor && editable && (
        <AnchoredPopover
          anchorEl={anchor}
          onClose={() => setAnchor(null)}
          width={280}
          maxHeight={360}
          padding={6}
          ariaLabel={`Choose ${label.toLowerCase()}`}
          initialFocus
        >
          <ClientPicker
            clientBoards={clientBoards}
            current={current}
            loading={(storeLoading || localLoading) && clientBoards.length === 0}
            error={loadError}
            onPick={pick}
          />
        </AnchoredPopover>
      )}
    </div>
  );
};

/**
 * The popover's body: a search box driving a listbox (the combobox pattern —
 * arrows move, Enter picks, focus stays in the box), the typed-name fallback,
 * and Clear.
 */
const ClientPicker = ({ clientBoards, current, loading, error, onPick }) => {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const optionId = (i) => `${listId}-opt-${i}`;

  const typed = query.trim().slice(0, MAX_NAME);
  const q = typed.toLowerCase();
  const matches = q
    ? clientBoards.filter((b) => {
        const shown = clientBoardName(b).toLowerCase();
        const own = (b.name || '').toLowerCase();
        return shown.includes(q) || own.includes(q);
      })
    : clientBoards;
  // Offer the typed name only when it is not already one of the boards: a
  // client who HAS a board should be linked to it, not duplicated as text.
  const exact = q && clientBoards.some((b) => clientBoardName(b).toLowerCase() === q);
  const options = [
    ...matches.map((b) => ({
      kind: 'board',
      key: String(b._id),
      value: { boardId: String(b._id), name: clientBoardName(b) },
      board: b,
    })),
    ...(typed && !exact ? [{ kind: 'typed', key: '__typed', value: { boardId: null, name: typed } }] : []),
    ...(current ? [{ kind: 'clear', key: '__clear', value: null }] : []),
  ];
  const activeIndex = options.length ? Math.min(active, options.length - 1) : -1;

  // Keep the highlighted option in view as the arrows walk a long list.
  useEffect(() => {
    if (activeIndex < 0 || typeof document === 'undefined') return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (options.length) setActive((i) => (Math.min(i, options.length - 1) + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (options.length) setActive((i) => (Math.min(i, options.length - 1) - 1 + options.length) % options.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0) onPick(options[activeIndex].value);
    }
  };

  const isSelected = (opt) =>
    opt.kind === 'board'
      ? current?.boardId === opt.key
      : opt.kind === 'typed'
        ? !current?.boardId && current?.name?.toLowerCase() === q
        : false;

  return (
    <div>
      <div
        className="flex items-center"
        style={{
          gap: 6,
          padding: '4px 6px',
          marginBottom: 4,
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <Search size={13} color="var(--color-text-muted)" aria-hidden="true" />
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-label="Search clients, or type a name"
          value={query}
          maxLength={MAX_NAME}
          onChange={(e) => {
            setQuery(e.target.value);
            // A new query starts the highlight at the top again.
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search or type a client…"
          data-autofocus
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            outline: 'none',
            fontSize: 13,
            padding: '4px 0',
            background: 'transparent',
            color: 'var(--color-text-primary)',
          }}
        />
      </div>

      {error && (
        <p role="alert" style={{ margin: '4px 6px', fontSize: 12, color: 'var(--color-status-stuck)' }}>
          {error}
        </p>
      )}

      {/* Status lines sit OUTSIDE the listbox: a listbox may hold options only. */}
      <div aria-live="polite">
        {loading ? (
          <div style={{ padding: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>Loading clients…</div>
        ) : clientBoards.length === 0 && !typed ? (
          <div style={{ padding: 8, fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.45 }}>
            No client boards you can see in this workspace. Type a name to use it anyway.
          </div>
        ) : q && matches.length === 0 ? (
          <div style={{ padding: '4px 8px 6px', fontSize: 12, color: 'var(--color-text-muted)' }}>
            No client board matches.
          </div>
        ) : null}
      </div>

      <div id={listId} role="listbox" aria-label="Clients">
        {options.map((opt, i) => {
          const selected = isSelected(opt);
          const highlighted = i === activeIndex;
          const common = {
            id: optionId(i),
            role: 'option',
            'aria-selected': selected,
            // Options are picked with the mouse or from the search box; they
            // are not tab stops of their own (the combobox owns focus).
            tabIndex: -1,
            onMouseEnter: () => setActive(i),
            onMouseDown: (e) => e.preventDefault(),
            onClick: () => onPick(opt.value),
            className: 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]',
            style: {
              ...optionStyle,
              background: highlighted ? 'var(--color-bg-subtle)' : 'transparent',
            },
          };
          if (opt.kind === 'board') {
            const name = clientBoardName(opt.board);
            return (
              <button key={opt.key} type="button" {...common}>
                <EntityLogo src={opt.board.logo || ''} name={name} size={20} radius={5} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {name}
                </span>
                {selected && <Check size={14} aria-hidden="true" />}
              </button>
            );
          }
          if (opt.kind === 'typed') {
            return (
              <button
                key={opt.key}
                type="button"
                {...common}
                style={{
                  ...common.style,
                  borderTop: matches.length ? '1px solid var(--color-border)' : 'none',
                  borderRadius: matches.length ? 0 : 'var(--radius-sm)',
                  marginTop: matches.length ? 4 : 0,
                }}
              >
                <CornerDownLeft size={14} color="var(--color-text-muted)" aria-hidden="true" />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Use &lsquo;{opt.value.name}&rsquo;
                </span>
                {selected && <Check size={14} aria-hidden="true" />}
              </button>
            );
          }
          return (
            <button
              key={opt.key}
              type="button"
              {...common}
              style={{
                ...common.style,
                color: 'var(--color-text-secondary)',
                borderTop: i > 0 ? '1px solid var(--color-border)' : 'none',
                borderRadius: i > 0 ? 0 : 'var(--radius-sm)',
                marginTop: i > 0 ? 4 : 0,
              }}
            >
              <X size={14} aria-hidden="true" />
              <span style={{ flex: 1 }}>Clear</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ClientCell;
