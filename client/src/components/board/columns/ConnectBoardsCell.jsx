import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, Search, ExternalLink, AlertTriangle } from 'lucide-react';
import { cellWrapperStyle, optionSorted, findOption, formatDate } from './cellShared';
import useBoardStore from '../../../store/boardStore';
import useTaskStore from '../../../store/taskStore';
import useToastStore from '../../../store/toastStore';
import * as taskService from '../../../services/taskService';

/**
 * ConnectBoardsCell — links a row to one or more rows on a target board.
 *
 * Renders the linked rows as chips; a "+" opens a typeahead over the target
 * board(s), filtered by `restrictTo`. Clicking a linked chip opens a read-only
 * side drawer (the CommentPanel slide-out pattern) previewing the target row.
 *
 * Writes go through the dedicated link/unlink endpoints (boardStore), not the
 * generic columnValues PUT — so `onChange` from the grid is intentionally
 * unused here. The local task cache is patched directly so sibling mirror
 * cells re-read.
 */

/** Format a single column value for the read-only preview drawer. */
const formatValueForColumn = (column, value) => {
  if (value == null || value === '') return '—';
  switch (column.type) {
    case 'status':
    case 'dropdown': {
      const opt = findOption(optionSorted(column.settings && column.settings.options), value);
      return opt ? opt.label : String(value);
    }
    case 'tags': {
      const opts = optionSorted(column.settings && column.settings.options);
      return Array.isArray(value)
        ? value.map((id) => (findOption(opts, id) || {}).label || id).join(', ')
        : '—';
    }
    case 'person':
      return Array.isArray(value) ? `${value.length} ${value.length === 1 ? 'person' : 'people'}` : '—';
    case 'date':
      return formatDate(value) || '—';
    case 'checkbox':
      return value ? 'Yes' : 'No';
    case 'link':
      return typeof value === 'object' ? value.label || value.url || '—' : String(value);
    case 'location':
      return typeof value === 'object' ? value.label || '—' : String(value);
    case 'connect_boards':
      return value && Array.isArray(value.links) ? `${value.links.length} linked` : '—';
    case 'mirror':
      return value && typeof value === 'object' && value.__mirror ? String(value.value ?? '—') : String(value);
    default:
      return typeof value === 'object' ? '—' : String(value);
  }
};

const ConnectBoardsCell = ({ value, column, task, readOnly }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState([]);
  const [rowsLoaded, setRowsLoaded] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [restrictWarning, setRestrictWarning] = useState(false);
  const [connectableByBoard, setConnectableByBoard] = useState(() => new Map());
  const [drawerRow, setDrawerRow] = useState(null);
  const wrapperRef = useRef(null);

  const fetchConnectable = useBoardStore((s) => s.fetchConnectable);
  const linkTaskAction = useBoardStore((s) => s.linkTask);
  const unlinkTaskAction = useBoardStore((s) => s.unlinkTask);
  const updateTaskLocal = useTaskStore((s) => s.updateTask);
  const toastError = useToastStore((s) => s.error);

  const settings = column.settings || {};
  const targetBoardIds = useMemo(
    () => (Array.isArray(settings.targetBoardIds) ? settings.targetBoardIds.map((b) => b.toString()) : []),
    [settings.targetBoardIds]
  );
  const allowMultiple = !!settings.allowMultiple;
  const restrictTo = settings.restrictTo || null;
  const sourceBoardId = task && task.board ? task.board.toString() : null;
  const links = Array.isArray(value && value.links) ? value.links : [];

  useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (e) => {
      if (wrapperRef.current && wrapperRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // Load target-board rows (for both chip names and the typeahead). Runs when
  // the picker opens, or on mount if there are links to resolve names for.
  const loadData = async () => {
    if (loadingRows || rowsLoaded) return;
    setLoadingRows(true);
    try {
      const connectable = await fetchConnectable(sourceBoardId);
      const byBoard = new Map();
      for (const entry of connectable || []) byBoard.set(entry.board._id.toString(), entry);
      setConnectableByBoard(byBoard);

      const lists = await Promise.all(
        // `month: 'all'` because a link target may be a tracker board, where
        // the task read is month-scoped and refuses an unscoped request. A
        // connect picker wants every candidate row, not just this month's.
        targetBoardIds.map((bid) =>
          taskService.getTasks(bid, { month: 'all' }).catch(() => [])
        )
      );
      const flat = [];
      targetBoardIds.forEach((bid, i) => {
        for (const r of lists[i] || []) flat.push({ ...r, __boardId: bid });
      });
      setRows(flat);

      // restrictTo: if its column no longer exists on any target board, drop
      // the filter and surface a warning (Acceptance #5 — never 500).
      if (restrictTo && restrictTo.columnId) {
        let exists = false;
        for (const bid of targetBoardIds) {
          const cols = (byBoard.get(bid)?.board?.columns) || [];
          if (cols.some((c) => c._id.toString() === restrictTo.columnId.toString())) {
            exists = true;
            break;
          }
        }
        setRestrictWarning(!exists);
      }
      setRowsLoaded(true);
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not load linkable rows');
    } finally {
      setLoadingRows(false);
    }
  };

  useEffect(() => {
    if (links.length > 0 && !rowsLoaded && sourceBoardId) loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links.length, sourceBoardId]);

  const rowsById = useMemo(() => {
    const m = new Map();
    for (const r of rows) m.set(r._id.toString(), r);
    return m;
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const linkedIds = new Set(links.map((l) => l.taskId.toString()));
    return rows.filter((r) => {
      if (task && r._id.toString() === task._id.toString()) return false;
      if (linkedIds.has(r._id.toString())) return false;
      if (q && !(r.name || '').toLowerCase().includes(q)) return false;
      if (!restrictWarning && restrictTo && restrictTo.columnId) {
        const v = r.columnValues ? r.columnValues[restrictTo.columnId.toString()] : undefined;
        if (v == null || (restrictTo.value != null && v.toString() !== restrictTo.value.toString())) {
          return false;
        }
      }
      return true;
    });
  }, [rows, query, links, restrictWarning, restrictTo, task]);

  const patchTaskLinks = (linksValue) => {
    if (!task) return;
    updateTaskLocal({
      ...task,
      columnValues: { ...(task.columnValues || {}), [column._id.toString()]: linksValue },
    });
  };

  const handleSelect = async (row) => {
    try {
      const { value: nextValue } = await linkTaskAction(task._id, column._id, {
        targetTaskId: row._id,
        targetBoardId: row.__boardId || row.board,
      });
      patchTaskLinks(nextValue);
      setQuery('');
      if (!allowMultiple) setOpen(false);
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not link row');
    }
  };

  const handleRemove = async (targetTaskId) => {
    try {
      const { value: nextValue } = await unlinkTaskAction(task._id, column._id, targetTaskId);
      patchTaskLinks(nextValue);
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not remove link');
    }
  };

  const canAdd = !readOnly && (allowMultiple || links.length === 0);

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%' }}>
      <div style={{ ...cellWrapperStyle, gap: 4, flexWrap: 'wrap', cursor: 'default' }}>
        {links.length === 0 && !canAdd && (
          <span style={{ color: 'var(--color-text-muted)' }}>—</span>
        )}
        {links.map((link) => {
          const row = rowsById.get(link.taskId.toString());
          const label = row ? row.name : 'Linked row';
          return (
            <span
              key={link.taskId}
              onClick={() => row && setDrawerRow(row)}
              title={row ? `Open ${row.name}` : 'Linked row'}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 4px 2px 8px',
                fontSize: 12,
                maxWidth: '100%',
                background: 'var(--color-accent-light, rgba(37,99,235,0.1))',
                color: 'var(--color-accent, #2563EB)',
                borderRadius: 'var(--radius-full)',
                cursor: 'pointer',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {label}
              </span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemove(link.taskId);
                  }}
                  aria-label="Remove link"
                  style={{
                    width: 14,
                    height: 14,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: 0,
                    opacity: 0.7,
                  }}
                >
                  <X size={10} />
                </button>
              )}
            </span>
          );
        })}
        {canAdd && (
          <button
            type="button"
            onClick={() => {
              setOpen((v) => !v);
              loadData();
            }}
            aria-label="Link a row"
            style={{
              width: 22,
              height: 22,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: '1px dashed var(--color-border-strong)',
              borderRadius: '50%',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
            }}
          >
            <Plus size={12} />
          </button>
        )}
      </div>

      {open && !readOnly && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            zIndex: 50,
            width: 'min(280px, calc(100vw - 24px))',
            maxHeight: 320,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-md)',
            padding: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <Search size={13} color="var(--color-text-muted)" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search rows…"
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                fontSize: 13,
                background: 'transparent',
                color: 'var(--color-text-primary)',
              }}
            />
          </div>
          {restrictWarning && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: '#B45309',
                background: '#FEF3C7',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 8px',
                marginBottom: 6,
              }}
            >
              <AlertTriangle size={12} />
              This column&apos;s filter references a deleted column — showing all rows.
            </div>
          )}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loadingRows ? (
              <div style={{ padding: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>Loading…</div>
            ) : filteredRows.length === 0 ? (
              <div style={{ padding: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>
                No matching rows
              </div>
            ) : (
              filteredRows.map((row) => (
                <button
                  key={row._id}
                  type="button"
                  onClick={() => handleSelect(row)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 8px',
                    fontSize: 13,
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--color-text-primary)',
                  }}
                >
                  {row.name || 'Untitled'}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {drawerRow && (
        <LinkedRowDrawer
          row={drawerRow}
          board={connectableByBoard.get((drawerRow.__boardId || drawerRow.board || '').toString())?.board}
          onClose={() => setDrawerRow(null)}
        />
      )}
    </div>
  );
};

/**
 * LinkedRowDrawer — read-only right-edge slide-out previewing a linked row.
 * Reuses the CommentPanel slide-out pattern (portal + backdrop + ESC close).
 */
const LinkedRowDrawer = ({ row, board, onClose }) => {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const columns = (board && Array.isArray(board.columns) ? board.columns : [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const primary = columns.find((c) => c.isPrimary);
  const title = (primary && row.columnValues && row.columnValues[primary._id.toString()]) || row.name || 'Linked row';

  const panel = (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.15)', zIndex: 199 }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Linked row: ${title}`}
        className="bg-white flex flex-col"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 420,
          maxWidth: '100vw',
          zIndex: 200,
          borderLeft: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 20px',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 30,
              height: 30,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <X size={18} color="var(--color-text-secondary)" />
          </button>
        </div>
        <div style={{ padding: '16px 20px', overflowY: 'auto' }}>
          {columns.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              <ExternalLink size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Open the source board to see this row&apos;s full details.
            </p>
          ) : (
            <dl style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: 0 }}>
              {columns.map((col) => (
                <div key={col._id} style={{ display: 'flex', gap: 12 }}>
                  <dt
                    style={{
                      width: 120,
                      flexShrink: 0,
                      fontSize: 12,
                      fontWeight: 500,
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    {col.name}
                  </dt>
                  <dd style={{ flex: 1, margin: 0, fontSize: 13, color: 'var(--color-text-primary)' }}>
                    {formatValueForColumn(col, row.columnValues ? row.columnValues[col._id.toString()] : null)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </aside>
    </>
  );

  return createPortal(panel, document.body);
};

export default ConnectBoardsCell;
