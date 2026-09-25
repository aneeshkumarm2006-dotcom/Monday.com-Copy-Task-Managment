import { useCallback, useMemo, useRef, useState } from 'react';
import { FileText, Upload, AlertTriangle, Loader2, MoreHorizontal } from 'lucide-react';
import Avatar from '../../ui/Avatar';
import FilePreviewModal from '../FilePreviewModal';
import { formatIn } from '../../../utils/money';
import useMoney from '../../../hooks/useMoney';
import { columnValue } from '../../../utils/columnValues';
import {
  ledgerColumns,
  ledgerTotals,
  invoiceState,
  issuedDayOf,
  notified,
} from '../../../utils/ledger';
import { timeAgo } from '../../../utils/dateUtils';

/**
 * LEDGER — a billing board drawn as the documents it is made of.
 *
 * A row that reads `INV-2026-013.pdf` makes you open it to know what it is. A
 * tile that shows the number, the amount and a status stamp identifies itself
 * before you have finished reading it, and the overdue one does not need a
 * status column to shout — it is the tile with the red stamp on it.
 *
 * ---- THE TWO STATES NOBODY ELSE SHOWS --------------------------------------
 *
 * An invoice that EXISTS and an invoice somebody is CHASING are different
 * things, and no billing board anywhere distinguishes them. The strip under
 * each tile does: who was told, and when — or "Nobody told" in amber. That gap
 * is exactly how an invoice quietly goes 39 days late.
 *
 * `notifiedUsers` is stamped on the task only when an update genuinely
 * @mentions somebody, so the strip cannot be satisfied by a note written to
 * oneself. See the field's comment on the Task model.
 *
 * ---- WHAT THE TILE DOES NOT SHOW -------------------------------------------
 *
 * NOT the first page of the PDF. Macan stores PDFs as Cloudinary `raw` on
 * purpose — so they download as `application/pdf` rather than being sniffed as
 * images — and `raw` assets cannot be transformed, so there is no page render
 * to fetch. Drawing a generic document mark is honest; faking a preview is not.
 * Image invoices (a photographed bill) do get their real thumbnail, because
 * those are stored as images and already have one.
 */

/** The stamp in the corner of a tile. */
const STAMP = {
  paid: { bg: 'var(--color-status-done-light, #F0FDF4)', fg: 'var(--color-status-done, #16A34A)' },
  sent: { bg: 'var(--color-status-working-light, #FFF8ED)', fg: 'var(--color-status-working)' },
  overdue: { bg: 'var(--color-status-stuck)', fg: '#FFFFFF' },
  draft: { bg: 'var(--color-bg-subtle)', fg: 'var(--color-text-secondary)' },
};

const isImage = (f) => typeof f?.mime === 'string' && f.mime.startsWith('image/');

const Figure = ({ label, display, tone }) => (
  <div
    style={{
      flex: '1 1 130px',
      padding: '10px 12px',
      border: `1px solid ${tone === 'bad' ? 'var(--color-status-stuck)' : 'var(--color-border)'}`,
      borderRadius: 'var(--radius-md)',
      background: tone === 'bad' ? 'var(--color-status-stuck-light, #FEF2F2)' : 'var(--color-bg-subtle)',
    }}
  >
    <span
      className="font-body block"
      style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}
    >
      {label}
    </span>
    <span
      className="font-body block"
      style={{
        fontSize: 19,
        fontWeight: 700,
        marginTop: 2,
        fontVariantNumeric: 'tabular-nums',
        color:
          tone === 'bad'
            ? 'var(--color-status-stuck)'
            : tone === 'good'
              ? 'var(--color-status-done, #16A34A)'
              : 'var(--color-text-primary)',
      }}
    >
      {display}
    </span>
  </div>
);

const InvoiceTile = ({ task, board, cols, onOpen, onNotify, onMenu, onPreview, onStatus }) => {
  // Its own hook rather than a prop from the grid. The value is memoized per
  // render in `useMoney`, so this costs nothing, and threading a formatter
  // through the tile list would be plumbing for a fact that is the same on
  // every tile.
  const money = useMoney();
  const state = invoiceState(task, board, cols);
  const stamp = STAMP[state.key] || STAMP.draft;
  const files = cols.file ? columnValue(task, cols.file) : null;
  const file = Array.isArray(files) ? files[0] : null;
  const amount = cols.amount ? columnValue(task, cols.amount) : null;
  const due = cols.due ? columnValue(task, cols.due) : null;
  const told = notified(task);

  return (
    <div
      style={{
        border: `1px solid ${state.key === 'overdue' ? 'var(--color-status-stuck)' : 'var(--color-border)'}`,
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        background: 'var(--color-bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {/* A SIBLING of the open-button below, not a child of it.
          The whole tile face is one big button so that clicking anywhere on the
          document opens the row — and a button inside a button is invalid HTML
          that browsers resolve by dropping one of them, so this sits over the
          top instead. It opens the SAME menu as the table's row `⋯`, which is
          how Delete, Pin and Share reach a view that has no rows to hang them
          on. Without it a file dropped by mistake could not be removed at all
          without switching to the table. */}
      {/* THE STAMP IS A CONTROL, not a label.
          Marking an invoice paid is the most common thing anybody does on a
          billing board, and sending them to the row panel for it made the
          gallery a place you can only look at. Opens the board's own status
          menu — the same one the table's status chip opens — so the four names
          come from the board and cannot drift. A sibling of the face button
          rather than a child, for the same button-in-button reason as the ⋯. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onStatus?.(task, e);
        }}
        disabled={!onStatus}
        aria-label={`Status: ${state.label}. Change it`}
        aria-haspopup={onStatus ? 'menu' : undefined}
        className="font-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent)]"
        style={{
          position: 'absolute',
          right: 7,
          top: 66,
          zIndex: 2,
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.08em',
          padding: '3px 7px',
          borderRadius: 3,
          border: 'none',
          background: stamp.bg,
          color: stamp.fg,
          textTransform: 'uppercase',
          cursor: onStatus ? 'pointer' : 'default',
        }}
      >
        {state.key === 'overdue' && state.daysLate > 0
          ? `${state.daysLate} days late`
          : state.label}
      </button>

      {onMenu && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMenu(task, e.currentTarget);
          }}
          aria-label={`Actions for ${task.name}`}
          aria-haspopup="menu"
          className="flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            zIndex: 2,
            width: 24,
            height: 24,
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg-surface)',
            color: 'var(--color-text-secondary)',
            cursor: 'pointer',
            boxShadow: '0 1px 2px rgba(0,0,0,0.12)',
          }}
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      )}
      {/* THE DOCUMENT FACE OPENS THE DOCUMENT.
          Clicking a picture of an invoice and getting a task panel is the wrong
          answer twice over: it is not what the thing you clicked looks like,
          and the file is not visible from that panel either — it lives in a
          column, so the panel's Files tab reads 0. The face previews; the
          details strip below opens the row. */}
      <button
        type="button"
        onClick={() => (file ? onPreview?.(task) : onOpen?.(task))}
        className="text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
        style={{ display: 'block', border: 'none', padding: 0, background: 'transparent', cursor: file ? 'zoom-in' : 'pointer' }}
        aria-label={file ? `Preview ${file.name || task.name}` : `Open ${task.name}`}
        title={file ? 'Preview the document' : 'No file on this invoice yet'}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            height: 92,
            background: 'var(--color-bg-input)',
            borderBottom: '1px solid var(--color-border)',
            overflow: 'hidden',
          }}
        >
          {isImage(file) ? (
            <img
              src={file.url}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              loading="lazy"
            />
          ) : (
            <FileText
              size={26}
              aria-hidden="true"
              color={file ? 'var(--color-text-muted)' : 'var(--color-border-strong)'}
            />
          )}
        </span>

      </button>

      {/* The details strip opens the ROW — owner, due date, updates, checklist. */}
      <button
        type="button"
        onClick={() => onOpen?.(task)}
        className="text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
        style={{ display: 'block', border: 'none', padding: 0, background: 'transparent', cursor: 'pointer', width: '100%' }}
        aria-label={`Open ${task.name}`}
        title="Open the invoice row"
      >
        <span style={{ display: 'block', padding: '8px 10px' }}>
          <span
            className="font-body block"
            style={{
              fontSize: 11,
              color: 'var(--color-text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {task.name}
          </span>
          <span
            className="font-body block"
            style={{
              fontSize: 14,
              fontWeight: 700,
              marginTop: 2,
              fontVariantNumeric: 'tabular-nums',
              color: state.key === 'overdue' ? 'var(--color-status-stuck)' : 'var(--color-text-primary)',
            }}
          >
            {amount == null || amount === '' ? '—' : money.column(amount, cols.amount?.settings, issuedDayOf(task, cols))}
          </span>
          <span
            className="font-body block"
            style={{
              fontSize: 10.5,
              color: 'var(--color-text-muted)',
              marginTop: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {due ? `Due ${new Date(due).toLocaleDateString()}` : 'No due date'}
          </span>
        </span>
      </button>

      {/* Told, or not. The whole reason this view exists rather than a gallery. */}
      <button
        type="button"
        onClick={() => onNotify?.(task)}
        className="w-full text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderTop: '1px solid var(--color-border)',
          background: told.told ? 'var(--color-bg-subtle)' : 'var(--color-status-working-light, #FFF8ED)',
          color: told.told ? 'var(--color-text-muted)' : 'var(--color-status-working)',
          fontSize: 10,
          fontWeight: told.told ? 400 : 700,
          border: 'none',
          cursor: 'pointer',
        }}
        title={told.told ? 'Tell someone else' : 'Nobody has been told about this invoice'}
      >
        {told.told ? (
          <>
            <span className="flex" aria-hidden="true">
              {told.people.slice(0, 3).map((p) => (
                <Avatar key={p._id || p} user={p} size={15} />
              ))}
            </span>
            <span className="font-body">Told {told.at ? timeAgo(told.at) : ''}</span>
          </>
        ) : (
          <>
            <AlertTriangle size={11} aria-hidden="true" />
            <span className="font-body">Nobody told</span>
          </>
        )}
      </button>
    </div>
  );
};

const LedgerView = ({
  board,
  tasks = [],
  canEdit = false,
  uploads = [],
  onOpenTask,
  onNotifyTask,
  onMenuTask,
  onStatusTask,
  onDropFiles,
}) => {
  const cols = useMemo(() => ledgerColumns(board), [board]);
  const money = useMoney();

  /**
   * The source currency for every figure on this board.
   *
   * ONE code for the whole ledger: `ledgerColumns` finds the amount column by
   * format and there is only ever one, so every row is denominated the same
   * way. Only the DATES differ, which is why conversion is still per row.
   */
  const sourceCurrency = cols.amount?.settings?.currency || null;

  /**
   * Can EVERY row convert? All or nothing, deliberately.
   *
   * If some invoices had a rate for their month and others did not, the strip
   * would add converted dollars to unconverted rupees — the exact thing
   * `Board.js` calls out: "adding numbers that do not share a unit is a bug".
   * A partly-converted total is worse than an unconverted one, because it looks
   * just as authoritative.
   *
   * So the moment one row cannot be valued, the whole strip stays in the
   * source currency and the note disappears with it. Running the backfill
   * script is what fixes that for a board with history.
   */
  const convertible = useMemo(() => {
    if (!money.active || !sourceCurrency) return false;
    // `.converted`, not a null check on the value: `resolve` deliberately hands
    // back the ORIGINAL number when it cannot convert, so a value test would
    // say yes to every row.
    return (tasks || []).every(
      (t) => money.resolve(1, sourceCurrency, issuedDayOf(t, cols)).converted
    );
  }, [tasks, cols, money, sourceCurrency]);

  const totals = useMemo(
    () =>
      ledgerTotals(tasks, board, cols, {
        convert: convertible
          ? (amount, task) => money.value(amount, sourceCurrency, issuedDayOf(task, cols))
          : null,
      }),
    [tasks, board, cols, money, sourceCurrency, convertible]
  );

  /**
   * One of the four figures, already converted (or deliberately not).
   *
   * `formatIn` rather than the hook, because `totals` has been through the
   * conversion already — asking the hook again would convert a second time.
   * Decimals follow the destination: a converted figure takes them from its own
   * magnitude, an unconverted one keeps whatever the column's author chose.
   */
  const stripFigure = (n) =>
    convertible
      ? formatIn(n, money.display)
      : formatIn(n, sourceCurrency, { decimals: cols.amount?.settings?.decimals ?? 0 });

  // Said ONCE, under the strip, rather than with a marker on every figure —
  // this codebase's own rule, and it keeps the tabular-nums columns scanning.
  const conversionNote = convertible ? money.note(sourceCurrency) : null;
  const [dragging, setDragging] = useState(false);
  /**
   * The document being read, as `{ attachments, index }`.
   *
   * Held HERE rather than lifted to the page: the ledger already holds every
   * file descriptor, and the viewer walks the list with ← / →, so the natural
   * list is "every invoice on this board that has a file" — which only this
   * component knows.
   */
  const [preview, setPreview] = useState(null);
  const inputRef = useRef(null);
  // A dragenter on a child fires a dragleave on the parent, so a plain boolean
  // flickers the whole grid while the pointer crosses a tile. Counting the
  // enters and leaves is what makes the highlight hold steady.
  const dragDepth = useRef(0);


  /**
   * Every invoice that actually has a file, in the order they are on screen.
   *
   * The viewer's ← / → walk this, so opening one invoice lets you read through
   * the lot without going back to the grid — which is most of the point of a
   * gallery. Rows with no file are skipped rather than shown as blanks.
   */
  const previewable = useMemo(() => {
    if (!cols.file) return [];
    const out = [];
    for (const task of tasks) {
      const files = columnValue(task, cols.file);
      const file = Array.isArray(files) ? files[0] : null;
      if (file?.url) out.push({ ...file, taskId: task._id });
    }
    return out;
  }, [tasks, cols.file]);

  const openPreview = useCallback(
    (task) => {
      const idx = previewable.findIndex((f) => f.taskId === task._id);
      if (idx >= 0) setPreview(idx);
    },
    [previewable]
  );

  const handleFiles = useCallback(
    (fileList) => {
      const files = Array.from(fileList || []);
      if (files.length > 0) onDropFiles?.(files);
    },
    [onDropFiles]
  );

  const onDrop = (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!canEdit) return;
    handleFiles(e.dataTransfer?.files);
  };

  return (
    <div
      onDragEnter={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => canEdit && e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
      style={{
        borderRadius: 'var(--radius-md)',
        outline: dragging ? '2px dashed var(--color-accent)' : 'none',
        outlineOffset: 6,
        background: dragging ? 'var(--color-accent-light)' : 'transparent',
        transition: 'background 120ms ease',
      }}
    >
      <div className="flex gap-2.5 flex-wrap" style={{ marginBottom: conversionNote ? 4 : 14 }}>
        <Figure label="Billed" display={stripFigure(totals.billed)} />
        <Figure label="Paid" display={stripFigure(totals.paid)} tone="good" />
        <Figure label="Outstanding" display={stripFigure(totals.outstanding)} />
        <Figure
          label={totals.overdueCount > 0 ? `Overdue · ${totals.overdueCount}` : 'Overdue'}
          display={stripFigure(totals.overdue)}
          tone={totals.overdue > 0 ? 'bad' : undefined}
        />
      </div>

      {conversionNote ? (
        <p
          className="font-body"
          style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 12 }}
        >
          {conversionNote}
        </p>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: 10,
        }}
      >
        {tasks.map((task) => (
          <InvoiceTile
            key={task._id}
            task={task}
            board={board}
            cols={cols}
            onOpen={onOpenTask}
            onNotify={onNotifyTask}
            onMenu={onMenuTask}
            onPreview={openPreview}
            onStatus={onStatusTask}
          />
        ))}

        {/* In-flight uploads sit where their tile will be, so the grid does not
            jump when they land. A failure removes its own placeholder — no row
            is ever created, which is the point of uploading first. */}
        {uploads.map((u) => (
          <div
            key={u.id}
            style={{
              border: `1px solid ${u.error ? 'var(--color-status-stuck)' : 'var(--color-border)'}`,
              borderRadius: 'var(--radius-md)',
              background: u.error ? 'var(--color-status-stuck-light, #FEF2F2)' : 'var(--color-bg-subtle)',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              justifyContent: 'center',
              minHeight: 150,
            }}
          >
            {u.error ? (
              <AlertTriangle size={16} color="var(--color-status-stuck)" aria-hidden="true" />
            ) : (
              <Loader2 size={16} className="animate-spin" color="var(--color-text-muted)" aria-hidden="true" />
            )}
            <span
              className="font-body"
              style={{ fontSize: 10.5, color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}
            >
              {u.name}
            </span>
            <span
              className="font-body"
              style={{ fontSize: 10, color: u.error ? 'var(--color-status-stuck)' : 'var(--color-text-muted)' }}
            >
              {u.error || 'Uploading…'}
            </span>
          </div>
        ))}

        {canEdit && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              border: '2px dashed var(--color-accent)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-accent-light)',
              color: 'var(--color-accent)',
              minHeight: 150,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              padding: 12,
              fontSize: 11.5,
              fontWeight: 600,
              cursor: 'pointer',
              textAlign: 'center',
            }}
          >
            <Upload size={20} aria-hidden="true" />
            Drop invoice files here
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                handleFiles(e.target.files);
                // Cleared so re-picking the SAME file fires change again.
                e.target.value = '';
              }}
            />
          </button>
        )}
      </div>

      {preview !== null && previewable[preview] && (
        <FilePreviewModal
          attachments={previewable}
          index={preview}
          onIndexChange={setPreview}
          onClose={() => setPreview(null)}
        />
      )}

      {tasks.length === 0 && uploads.length === 0 && !canEdit && (
        <p
          className="font-body text-center"
          style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '36px 0' }}
        >
          No invoices on this board yet.
        </p>
      )}
    </div>
  );
};

export default LedgerView;
