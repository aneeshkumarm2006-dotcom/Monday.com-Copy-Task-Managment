import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  BellRing,
  ChevronDown,
  FileText,
  Loader2,
  Maximize2,
  MessageCircle,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import Button from '../../ui/Button';
import Chip from '../../ui/Chip';
import Avatar from '../../ui/Avatar';
import StatusMenu from '../StatusMenu';
import FilePreviewModal from '../FilePreviewModal';
import { FileTypeIcon } from '../FileTypeIcon';
import { cellComponentFor, NumberCell, DateCell, PersonCell } from '../columns';
import useMoney from '../../../hooks/useMoney';
import useBoardStore from '../../../store/boardStore';
import useAuthStore from '../../../store/authStore';
import useToastStore from '../../../store/toastStore';
import * as taskService from '../../../services/taskService';
import { columnValue } from '../../../utils/columnValues';
import {
  addDaysKey,
  makePayment,
  paymentsOf,
  paymentsTotal,
  todayKey,
} from '../../../utils/payments';
import { boardCurrencyOf, currencyByCode, formatIn } from '../../../utils/money';
import { dateInputToISO, timeAgo } from '../../../utils/dateUtils';
import { fetchAttachmentBlob, formatBytes, previewKindFor } from '../../../utils/fileUrl';
import {
  dueDayOf,
  invoiceState,
  issuedDayOf,
  ledgerColumns,
  notified,
  statePill,
  statusOf,
} from '../../../utils/ledger';
// What the file picker offers — the same list the server's board-file upload
// and the ledger's drop accept, so a .docx or .xlsx invoice is not filtered
// out of the OS dialog while dragging the very same file works.
import { BOARD_UPLOAD_ACCEPT } from '../../../utils/boardRowCreation';

/**
 * INVOICE SHEET — one invoice's own screen.
 *
 * The ledger's tiles answer "which invoices need me"; this answers everything
 * about ONE of them: what it is for, who owes it, how much has come in and
 * what is left. Before it existed the only place to type an invoice's amount
 * was the Table view, and the row panel the tile opened edited a different due
 * date from the one the ledger reads — so an uploaded invoice could be looked
 * at but never filled in or paid.
 *
 * ---- It edits the board's OWN columns ----------------------------------------
 *
 * Every field here is a cell of the board — amount, issued, due, owner, the
 * document — written through the same `setColumnValue` the table uses and
 * rendered with the same cell components. There is no second copy of an
 * invoice's facts to drift from the grid, and a board whose owner renamed
 * "Amount" to "Fee" still works, because the columns are found by role and key
 * (`ledgerColumns`), never by name.
 *
 * ---- It reads the LIVE row -----------------------------------------------------
 *
 * `task` comes from the page's store on every render, and every write hands the
 * server's copy back through `onPatched`, which puts it in that store. So what
 * is on screen after a save is what the server kept, never a stale snapshot
 * taken when the sheet opened.
 *
 * ---- Payments are receipts, not a number ---------------------------------------
 *
 * A payment is appended to the row's payments cell (see `utils/payments.js`), so
 * an invoice settled in three parts shows three dated lines and a mistaken one
 * can be removed on its own. Settling the balance moves the status to the
 * board's Paid; a first part-payment moves a Draft to Sent. Both go through
 * the page's ordinary status path, so the change is logged, notified and
 * rolled back on failure exactly as a click on the stamp would be.
 *
 * ---- Opened on a fresh upload, it asks for the amount ---------------------------
 *
 * `focusAmount` is for the host that has just made the row — a dropped PDF, or
 * "New invoice". The one thing such a row is missing is what it is for, so the
 * sheet opens with the Amount cell already in edit mode instead of focusing the
 * heading: drop, type, Enter. Read once, on open; it never steals focus later.
 * Ignored without `canEdit` or without an amount column, where the heading
 * takes focus as usual.
 *
 * ---- The client is whatever kind of cell the board's client column is -----------
 *
 * A `client` column (a pick of one of the workspace's client boards, or a typed
 * name) on boards made today; a `connect_boards` column on billing boards made
 * before that type existed. The field renders the registry's cell for the
 * column's OWN type (`cellComponentFor`), so both work, and neither is
 * special-cased here.
 *
 * Mount only while the row exists: `{task && <InvoiceSheet key={task._id} …/>}`.
 * Mounting locks the page's scroll and unmounting releases it. If a host leaves
 * the sheet mounted after its row is gone, it asks to be closed (`onClose`).
 *
 * Layering: overlay 45 / sheet 46 — above the sticky navbar (40), BELOW the
 * shared Modal (50), so "Tell someone" and the delete confirm open on top of
 * it, and below the body-portaled menus (200) its own pickers open.
 */

const OVERLAY_Z = 45;
const SHEET_Z = 46;

const PAYMENT_METHODS = ['Bank transfer', 'Card', 'Cash', 'Cheque', 'UPI', 'PayPal', 'Other'];
const NET_TERMS = [7, 15, 30, 45, 60];

/** The server's message for a failed write, in whichever of its two shapes it came. */
const errorText = (err, fallback) =>
  err?.response?.data?.error ||
  err?.response?.data?.errors?.[0]?.message ||
  err?.message ||
  fallback;

/** A day key read for people: "5 Sep 2026". */
const dayLabel = (dayKey) => {
  if (!dayKey) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) return dayKey;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

/**
 * Does this viewport have room for the document beside the form?
 *
 * `useSyncExternalStore` rather than state + effect so the first paint is
 * already right — a sheet that opens single-column and then jumps to two is a
 * layout shift on the one screen people use to type numbers.
 */
const useMediaQuery = (query) => {
  const subscribe = useCallback(
    (cb) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener?.('change', cb);
      return () => mql.removeEventListener?.('change', cb);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false
  );
};

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Put the cell inside `box` into edit mode, the way a click on it would.
 *
 * A grid cell enters editing on a click of its own wrapper (NumberCell's
 * `onClick`), and that is the one entry point every cell honours — so this
 * clicks it rather than reaching into the cell's state. Returns whether there
 * was a cell to click, so a caller can fall back to focusing something else.
 */
const startCellEdit = (box, { smooth = false } = {}) => {
  const cell = box?.querySelector('div');
  if (!cell) return false;
  box.scrollIntoView?.({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  cell.click();
  return true;
};

/** The words for a failed document upload — the same ones the ledger's drop zone uses. */
const uploadErrorText = (err) =>
  err?.response?.status === 413 || err?.code === 'LIMIT_FILE_SIZE'
    ? 'That file is too large — the limit is 25 MB.'
    : errorText(err, "Couldn't attach that file.");

const InvoiceSheet = ({
  board,
  task,
  canEdit = false,
  canManageColumns = false,
  canChangeStatus = true,
  canNotify = true,
  // `task.assign`: may put OTHER people on the row. Without it (a contributor
  // editing their own invoice) the Owner picker moves only their own name —
  // the server refuses any other delta, so offering it was a dead end.
  canAssignOthers = true,
  focusAmount = false,
  onClose,
  onPatched,
  onChangeStatus,
  onOpenUpdates,
  onNotify,
  onAttachFile,
  onDelete,
}) => {
  const money = useMoney();
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);
  const currentUserId = useAuthStore((s) => s.user?._id || null);
  const wide = useMediaQuery('(min-width: 1024px)');

  const titleId = useId();
  const methodListId = useId();
  const panelRef = useRef(null);
  const headingRef = useRef(null);
  const amountFieldRef = useRef(null);
  const fileInputRef = useRef(null);
  // Where focus goes back to when the payment form closes, so it does not
  // fall out of the sheet onto <body>.
  const recordButtonRef = useRef(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  // Read ONCE, on open — see the header. A ref, so a host that re-renders with
  // `focusAmount` still true never yanks focus back to the amount mid-edit.
  const focusAmountOnOpen = useRef(!!focusAmount && !!canEdit);

  const cols = useMemo(() => ledgerColumns(board), [board]);
  const [statusAnchor, setStatusAnchor] = useState(null);
  const [titleDraft, setTitleDraft] = useState(null); // null = not editing
  const [busy, setBusy] = useState(null); // 'file' | 'payment' | null
  const [previewIndex, setPreviewIndex] = useState(null);
  const [form, setForm] = useState(null); // the "Record payment" draft, or null

  /**
   * Open / close housekeeping, once per sheet.
   *
   * Registered ONCE (the close callback is read through a ref) so this
   * listener always sits BEFORE any Modal or menu opened on top of the sheet.
   * Document listeners run in registration order, and a later one that closes
   * its own dialog would otherwise leave this one looking at an empty screen
   * and closing the sheet on the same Escape.
   */
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = window.setTimeout(() => {
      // A freshly made row opens asking for its amount; anything else opens on
      // its heading, so a screen reader announces which invoice this is.
      if (focusAmountOnOpen.current && startCellEdit(amountFieldRef.current)) return;
      headingRef.current?.focus();
    }, 10);

    const onKey = (e) => {
      const panel = panelRef.current;
      if (!panel) return;
      // Something opened ON TOP of the sheet — the notify composer, a delete
      // confirm, a linked row — owns the keyboard until it closes.
      const above = Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
        (el) => el !== panel && !!(panel.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      if (above) return;

      if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        // An open menu closes itself; a field being edited cancels its edit.
        // Either way this Escape was not meant for the whole sheet.
        if (document.querySelector('[role="listbox"], [role="menu"]')) return;
        const target = e.target;
        // A field's own Escape handler may already have swapped it out: React
        // flushes that re-render in a microtask, which runs before this
        // document listener, so the <input> is detached by now and
        // `panel.contains` says no. A target no longer in the DOM was a field
        // or popover handling its own Escape — not a request to close the
        // sheet (and drop a half-typed payment with it).
        if (target instanceof Node && !target.isConnected) return;
        if (
          target instanceof HTMLElement &&
          panel.contains(target) &&
          (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
        ) {
          return;
        }
        onCloseRef.current?.();
        return;
      }

      if (e.key === 'Tab') {
        // The same simple trap `ui/Modal` uses — `aria-modal` promises focus
        // stays inside, so it has to.
        const focusable = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
          (el) => el.getClientRects().length > 0
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!panel.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused && typeof previouslyFocused.focus === 'function' && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  /**
   * The row went away under an open sheet — deleted here, in another tab, or
   * filtered out of the store. The host should have unmounted us; if it has
   * not, ask it to, so the scroll lock above is released rather than left on a
   * page with nothing visible holding it.
   */
  const hasTask = !!task;
  useEffect(() => {
    if (!hasTask) onCloseRef.current?.();
  }, [hasTask]);

  /**
   * Write one cell and hand the server's row back to the page.
   *
   * Not optimistic, the same as the grid: a cell shows its typed value until
   * the reply lands, and a refused write says why rather than quietly snapping
   * back.
   */
  const write = useCallback(
    async (col, value) => {
      if (!task?._id || !col?._id) return null;
      try {
        const updated = await useBoardStore.getState().setColumnValue(task._id, col._id, value);
        if (updated) onPatched?.(updated);
        return updated || null;
      } catch (err) {
        console.error('Invoice update failed:', err);
        toastError(errorText(err, "Couldn't save that change."));
        return null;
      }
    },
    [task?._id, onPatched, toastError]
  );

  if (!task || !board) return null;

  const state = invoiceState(task, board, cols);
  const statuses = Array.isArray(board.statuses) ? board.statuses : [];
  const doneStatus = statuses.find((s) => s.key === 'done') || null;
  const sentStatus = statuses.find((s) => s.key === 'working_on_it') || null;
  const currentStatus = statusOf(task, board);

  /**
   * The unit every figure on this sheet is in — the Amount column's own code,
   * else the board's. Figures convert for a reader who chose another currency
   * at the rate of the day the invoice was ISSUED, the same rule the ledger
   * strip and tiles follow; typing always happens in this unit.
   */
  const sourceCurrency =
    cols.amount?.settings?.currency || boardCurrencyOf(board, money.baseCurrency);
  const issuedDay = issuedDayOf(task, cols);
  const amountSettings = cols.amount?.settings || { format: 'currency', currency: sourceCurrency };
  const shown = (n) => money.column(n, amountSettings, issuedDay, sourceCurrency);
  const asEntered = (n) => formatIn(n, sourceCurrency, { decimals: 'auto' });
  const conversionNote = money.surfaceNote(sourceCurrency, issuedDay);
  const symbol = currencyByCode(sourceCurrency)?.symbol || sourceCurrency || '';

  const files = cols.file ? paymentsSafeFiles(columnValue(task, cols.file)) : [];
  const file = files[0] || null;
  const payments = cols.payments ? paymentsOf(columnValue(task, cols.payments)) : [];
  const told = notified(task);
  const issuedKey = issuedDay;
  const dueKey = dueDayOf(task, cols);
  const hasAmount = state.amount > 0;
  const pct = hasAmount ? Math.min(100, (Math.min(state.received, state.amount) / state.amount) * 100) : 0;
  // The registry's cell for the client column's own type (see the header). A
  // module-level component per type, so its identity is stable across renders.
  const ClientField = cols.client ? cellComponentFor(cols.client.type) : null;

  // ---- status ----------------------------------------------------------------

  const changeStatus = async (target, statusId) => {
    if (!onChangeStatus || !canChangeStatus || statusId == null || !target) return null;
    if (String(target.status ?? '') === String(statusId)) return target;
    try {
      return (await onChangeStatus(target, statusId)) || null;
    } catch {
      // The page's status path has already rolled back and said why.
      return null;
    }
  };

  /**
   * After money moves, put the status where the money says it is: settled →
   * the board's Paid; a first part-payment on a Draft → Sent. Never the other
   * way on its own — un-marking something Paid is a question, asked in
   * `removePayment`.
   */
  const settleStatus = async (updated, boardNow) => {
    const st = invoiceState(updated, boardNow, ledgerColumns(boardNow));
    const now = statusOf(updated, boardNow);
    if (st.amount > 0 && st.recorded >= st.amount) {
      if (doneStatus && now?.key !== 'done') await changeStatus(updated, doneStatus._id);
    } else if (st.recorded > 0 && (!now || now.key === 'not_started') && sentStatus) {
      await changeStatus(updated, sentStatus._id);
    }
  };

  // ---- payments ----------------------------------------------------------------

  /**
   * Append one receipt. On a board that has no payments column yet — every
   * billing board made before payments existed — the first receipt switches
   * payment tracking on by adding the column, in the invoice's own currency,
   * for anyone allowed to add columns.
   */
  const appendPayment = async ({ amount, date, method = '', note = '' }, { base = task, skipStatus = false } = {}) => {
    let col = cols.payments;
    let boardNow = board;
    if (!col) {
      if (!canManageColumns) return null;
      try {
        const columns = await useBoardStore.getState().addColumn(board._id, {
          name: 'Payments',
          type: 'payments',
          settings: {
            format: 'currency',
            ...(sourceCurrency ? { currency: sourceCurrency } : {}),
            summary: 'sum',
          },
        });
        col = (Array.isArray(columns) ? columns : []).find((c) => c?.type === 'payments') || null;
        if (Array.isArray(columns)) boardNow = { ...board, columns };
      } catch (err) {
        toastError(errorText(err, "Couldn't turn on payment tracking for this board."));
        return null;
      }
      if (!col) {
        toastError("Couldn't turn on payment tracking for this board.");
        return null;
      }
    }
    const existing = paymentsOf(columnValue(base, col));
    const entry = makePayment({ amount, date, method, note, by: currentUserId });
    const updated = await write(col, [...existing, entry]);
    if (!updated) return null;
    if (!skipStatus) await settleStatus(updated, boardNow);
    return updated;
  };

  const openForm = () =>
    setForm({
      amount: state.balance > 0 ? String(Math.round(state.balance * 100) / 100) : '',
      date: todayKey(),
      method: '',
      note: '',
    });

  const submitForm = async (e) => {
    e?.preventDefault?.();
    if (!form || busy) return;
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toastError('Enter the amount received — more than zero.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date || '')) {
      toastError('Pick the day the payment arrived.');
      return;
    }
    setBusy('payment');
    const updated = await appendPayment({
      amount,
      date: form.date,
      method: form.method,
      note: form.note,
    });
    setBusy(null);
    if (updated) {
      setForm(null);
      toastSuccess(`Recorded ${asEntered(amount)} received.`);
    }
  };

  const markFullyPaid = async () => {
    if (busy) return;
    const remaining = state.amount - state.recorded;
    if (canEdit && hasAmount && remaining > 0 && (cols.payments || canManageColumns)) {
      setBusy('payment');
      const updated = await appendPayment({ amount: remaining, date: todayKey() });
      setBusy(null);
      if (updated) toastSuccess(`Recorded ${asEntered(remaining)} — paid in full.`);
      return;
    }
    // No receipts to record (no amount, or no payment tracking): the status is
    // still the whole answer, exactly as it was before payments existed.
    if (doneStatus) await changeStatus(task, doneStatus._id);
  };

  const removePayment = async (entry, index) => {
    if (!cols.payments || busy) return;
    const ok = window.confirm(
      `Remove the ${asEntered(Number(entry.amount) || 0)} payment from ${dayLabel(entry.date)}?`
    );
    if (!ok) return;
    setBusy('payment');
    const next = payments.filter((p, i) => (entry.id ? p.id !== entry.id : i !== index));
    const updated = await write(cols.payments, next);
    setBusy(null);
    if (!updated) return;
    // Still marked Paid, but no longer fully covered: ask, never flip silently
    // — "Paid" may have been set by hand for a reason this sheet cannot see.
    const st = invoiceState(updated, board, cols);
    const now = statusOf(updated, board);
    if (now?.key === 'done' && st.amount > 0 && st.recorded < st.amount && sentStatus && canChangeStatus) {
      const back = window.confirm(
        `This invoice is still marked ${now.name}, but only ${asEntered(st.recorded)} of ${asEntered(
          st.amount
        )} is recorded as received. Mark it ${sentStatus.name} again?`
      );
      if (back) await changeStatus(updated, sentStatus._id);
    }
  };

  const handleStatusPick = async (statusId) => {
    setStatusAnchor(null);
    const before = invoiceState(task, board, cols);
    const target = statuses.find((s) => String(s._id) === String(statusId));
    const updated = await changeStatus(task, statusId);
    if (!updated) return;
    // Marking Paid with money still unrecorded: offer to record it, so the
    // receipts and the status tell the same story. Offered, not done — a
    // write-off is also "Paid" to some teams.
    const remaining = before.amount - before.recorded;
    if (target?.key === 'done' && cols.payments && canEdit && before.amount > 0 && remaining > 0) {
      const record = window.confirm(`Record the remaining ${asEntered(remaining)} as received today?`);
      if (record) {
        setBusy('payment');
        await appendPayment({ amount: remaining, date: todayKey() }, { base: updated, skipStatus: true });
        setBusy(null);
      }
    }
  };

  // ---- title ------------------------------------------------------------------

  const commitTitle = async () => {
    const next = (titleDraft ?? '').trim();
    setTitleDraft(null);
    if (!next) {
      toastError('An invoice needs a name.');
      return;
    }
    if (next === task.name) return;
    // The primary cell IS the name — the server renames the row from it — so
    // the title is written where the table writes it.
    if (cols.primary && cols.primary.type === 'text') {
      await write(cols.primary, next);
      return;
    }
    try {
      const updated = await taskService.updateTask(task._id, { name: next });
      if (updated) onPatched?.(updated);
    } catch (err) {
      toastError(errorText(err, "Couldn't rename this invoice."));
    }
  };

  // ---- document -----------------------------------------------------------------

  /**
   * Hand the picked file to the host, which uploads it and writes the file cell.
   *
   * The host is asked not to reject (it owns the upload and says why it failed),
   * but the sheet does not bet on it: a rejection here used to escape as an
   * unhandled promise with the button stuck on "Uploading…" and nothing said.
   * Caught, it is reported once, in the drop zone's words.
   */
  const attach = async (picked) => {
    if (!picked || !cols.file || !onAttachFile) return;
    setBusy('file');
    try {
      await onAttachFile(task, picked);
    } catch (err) {
      console.error('Invoice attach failed:', err);
      toastError(uploadErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  const setNet = (n) => {
    if (!cols.due) return;
    const base = issuedKey || todayKey();
    const key = addDaysKey(base, n);
    if (key) write(cols.due, dateInputToISO(key));
  };

  // Every other column the board has, in its own order, so nothing the board
  // tracks is hidden here just because this sheet did not know its name.
  const shownIds = new Set(
    [cols.primary, cols.amount, cols.issued, cols.due, cols.owner, cols.file, cols.client, cols.payments]
      .filter(Boolean)
      .map((c) => String(c._id))
  );
  const otherColumns = (Array.isArray(board.columns) ? board.columns : [])
    .filter((c) => c && !c.isPrimary && !shownIds.has(String(c._id)))
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  const pill = statePillText(state);
  const pillTone =
    state.key === 'overdue' ? 'bad' : state.key === 'draft' && state.pastDue ? 'warn' : state.key === 'partial' ? 'accent' : 'muted';

  const paymentsByNewest = payments
    .map((p, index) => ({ p, index }))
    .sort((a, b) => {
      const da = String(a.p.date || '');
      const db = String(b.p.date || '');
      if (da !== db) return da < db ? 1 : -1;
      return b.index - a.index;
    });

  const trackingOff = !cols.payments;
  const canRecord = canEdit && (!trackingOff || canManageColumns);

  const node = (
    <>
      <div
        aria-hidden="true"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose?.();
        }}
        className="fixed inset-0"
        style={{ zIndex: OVERLAY_Z, background: 'var(--color-overlay)' }}
      />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="macan-invoice-sheet fixed inset-0 md:left-auto flex md:w-[640px] lg:w-[860px]"
        style={{
          zIndex: SHEET_Z,
          maxWidth: '100vw',
          background: 'var(--color-bg-surface)',
          borderLeft: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {wide && (
          <DocumentColumn
            file={file}
            canAttach={canEdit && !!cols.file && !!onAttachFile}
            attaching={busy === 'file'}
            onAttach={() => fileInputRef.current?.click()}
            onExpand={() => setPreviewIndex(0)}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {/* ---- header ---- */}
          <header
            className="shrink-0 px-4 md:px-6"
            style={{ paddingTop: 14, paddingBottom: 12, borderBottom: '1px solid var(--color-border)' }}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p
                  className="font-body"
                  style={{
                    fontSize: 10.5,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--color-text-muted)',
                    fontWeight: 600,
                  }}
                >
                  Invoice
                </p>
                {titleDraft !== null ? (
                  <input
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={commitTitle}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setTitleDraft(null);
                      }
                    }}
                    maxLength={500}
                    aria-label="Invoice name"
                    className="font-display w-full"
                    style={{
                      fontSize: 20,
                      fontWeight: 700,
                      marginTop: 2,
                      padding: '2px 6px',
                      marginLeft: -6,
                      border: '1px solid var(--color-accent)',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--color-bg-input)',
                      color: 'var(--color-text-primary)',
                      outline: 'none',
                    }}
                  />
                ) : (
                  <div className="flex items-center gap-1.5 min-w-0" style={{ marginTop: 2 }}>
                    <h2
                      id={titleId}
                      ref={headingRef}
                      tabIndex={-1}
                      className="font-display truncate outline-none"
                      style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}
                      title={task.name}
                    >
                      {task.name || 'Untitled invoice'}
                    </h2>
                    {canEdit && (
                      <IconButton label="Rename invoice" onClick={() => setTitleDraft(task.name || '')}>
                        <Pencil size={14} aria-hidden="true" />
                      </IconButton>
                    )}
                  </div>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {canChangeStatus && onChangeStatus ? (
                    <button
                      type="button"
                      onClick={(e) => setStatusAnchor(statusAnchor ? null : e.currentTarget)}
                      aria-haspopup="listbox"
                      aria-expanded={!!statusAnchor}
                      aria-label={`Status: ${currentStatus?.name || 'None'}. Change it`}
                      className="inline-flex items-center gap-1 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                      style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
                    >
                      <Chip type="status" value={task.status} board={board} />
                      <ChevronDown size={13} aria-hidden="true" color="var(--color-text-muted)" />
                    </button>
                  ) : (
                    <Chip type="status" value={task.status} board={board} />
                  )}
                  {pill && <Pill tone={pillTone}>{pill}</Pill>}
                </div>
              </div>
              <IconButton label="Close invoice" onClick={() => onClose?.()} size={34}>
                <X size={18} aria-hidden="true" />
              </IconButton>
            </div>
          </header>

          {/* ---- body ---- */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6" style={{ paddingTop: 16, paddingBottom: 24 }}>
            {/* Money first: it is the question the sheet was opened to answer. */}
            <section aria-label="Amounts">
              <div className="grid grid-cols-3 gap-2">
                <Figure label="Amount" value={hasAmount ? shown(state.amount) : '—'} />
                <Figure label="Received" value={hasAmount || state.recorded > 0 ? shown(state.received) : '—'} tone={state.received > 0 ? 'good' : undefined} />
                <Figure
                  label="Balance"
                  value={hasAmount ? shown(state.balance) : '—'}
                  tone={state.key === 'overdue' && state.balance > 0 ? 'bad' : undefined}
                />
              </div>
              {hasAmount && (
                <div
                  role="progressbar"
                  aria-label="Received so far"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(pct)}
                  className="mt-2.5 overflow-hidden"
                  style={{ height: 4, borderRadius: 9999, background: 'var(--color-bg-subtle)' }}
                >
                  <div style={{ width: `${pct}%`, height: '100%', background: 'var(--color-accent)', transition: 'width 200ms ease' }} />
                </div>
              )}
              {!hasAmount && cols.amount && (
                <p className="font-body mt-2" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
                  No amount yet.{' '}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => startCellEdit(amountFieldRef.current, { smooth: true })}
                      className="font-semibold hover:underline"
                      style={{ color: 'var(--color-accent-text)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                    >
                      Add the amount
                    </button>
                  )}
                </p>
              )}
              {state.overpaid > 0 && (
                <p className="font-body mt-2" style={{ fontSize: 12, color: 'var(--color-status-working)' }}>
                  {asEntered(state.overpaid)} more than the invoice amount has been recorded.
                </p>
              )}
              {conversionNote && (
                <p className="font-body mt-1.5" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                  {conversionNote}
                </p>
              )}
            </section>

            {/* ---- details ---- */}
            <section aria-label="Invoice details" className="mt-6">
              <SectionTitle>Details</SectionTitle>
              <dl className="mt-2 flex flex-col gap-2">
                {cols.client && ClientField && (
                  <Field label={cols.client.name || 'Client'}>
                    <CellBox editable={canEdit}>
                      {/* The cell for the column's OWN type — a client pick,
                          or a legacy connect column that writes through the
                          link endpoints and ignores onChange. */}
                      <ClientField
                        value={columnValue(task, cols.client) ?? null}
                        column={cols.client}
                        task={task}
                        columns={board.columns}
                        readOnly={!canEdit}
                        canManage={canManageColumns}
                        onChange={(v) => write(cols.client, v)}
                      />
                    </CellBox>
                  </Field>
                )}
                {cols.amount && (
                  <Field label={`${cols.amount.name || 'Amount'}${sourceCurrency ? ` (${sourceCurrency})` : ''}`}>
                    <CellBox editable={canEdit} ref={amountFieldRef}>
                      <NumberCell
                        value={columnValue(task, cols.amount) ?? null}
                        column={cols.amount}
                        task={task}
                        readOnly={!canEdit}
                        on={issuedDay}
                        currency={sourceCurrency}
                        onChange={(v) => write(cols.amount, v)}
                      />
                    </CellBox>
                  </Field>
                )}
                {cols.issued && (
                  <Field label={cols.issued.name || 'Issued'}>
                    <CellBox editable={canEdit}>
                      <DateCell
                        value={columnValue(task, cols.issued) ?? null}
                        column={cols.issued}
                        task={task}
                        readOnly={!canEdit}
                        onChange={(v) => write(cols.issued, v)}
                      />
                    </CellBox>
                  </Field>
                )}
                {cols.due && (
                  <Field label={cols.due.name || 'Due'}>
                    <CellBox editable={canEdit}>
                      <DateCell
                        value={columnValue(task, cols.due) ?? null}
                        column={cols.due}
                        task={task}
                        readOnly={!canEdit}
                        onChange={(v) => write(cols.due, v)}
                      />
                    </CellBox>
                    {canEdit && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1" role="group" aria-label="Payment terms">
                        <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-muted)', marginRight: 2 }}>
                          Terms from {issuedKey ? 'issue date' : 'today'}:
                        </span>
                        {NET_TERMS.map((n) => {
                          const active = !!dueKey && dueKey === addDaysKey(issuedKey || todayKey(), n);
                          return (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setNet(n)}
                              aria-pressed={active}
                              title={`Due ${n} days after ${issuedKey ? 'the issue date' : 'today'}`}
                              className="font-body transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent)]"
                              style={{
                                fontSize: 11.5,
                                fontWeight: 600,
                                padding: '2px 8px',
                                borderRadius: 9999,
                                border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
                                background: active ? 'var(--color-accent-light)' : 'transparent',
                                color: active ? 'var(--color-accent-text)' : 'var(--color-text-secondary)',
                                cursor: 'pointer',
                              }}
                            >
                              Net {n}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </Field>
                )}
                {cols.owner && (
                  <Field label={cols.owner.name || 'Owner'}>
                    <CellBox editable={canEdit}>
                      <PersonCell
                        value={columnValue(task, cols.owner) ?? null}
                        column={cols.owner}
                        task={task}
                        readOnly={!canEdit}
                        selfOnlyId={canAssignOthers ? null : currentUserId}
                        onChange={(v) => write(cols.owner, v)}
                      />
                    </CellBox>
                  </Field>
                )}
                {cols.file && (
                  <Field label={cols.file.name || 'Document'}>
                    <div className="flex flex-wrap items-center gap-2" style={{ minHeight: 34 }}>
                      {file ? (
                        <span className="inline-flex min-w-0 items-center gap-1.5 font-body" style={{ fontSize: 13, color: 'var(--color-text-primary)', maxWidth: '100%' }}>
                          <span aria-hidden="true" style={{ color: 'var(--color-text-secondary)', lineHeight: 0 }}>
                            <FileTypeIcon mime={file.mime || ''} size={15} />
                          </span>
                          <span className="truncate" title={file.name}>{file.name || 'Invoice document'}</span>
                          {file.size > 0 && (
                            <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                              {formatBytes(file.size)}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="font-body" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                          No document attached
                        </span>
                      )}
                      {file && (
                        <Button variant="secondary" size="sm" icon={Maximize2} onClick={() => setPreviewIndex(0)}>
                          Preview
                        </Button>
                      )}
                      {canEdit && onAttachFile && (
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={busy === 'file' ? Loader2 : Upload}
                          disabled={busy === 'file'}
                          onClick={() => fileInputRef.current?.click()}
                        >
                          {busy === 'file' ? 'Uploading…' : file ? 'Replace' : 'Attach'}
                        </Button>
                      )}
                    </div>
                  </Field>
                )}
                {otherColumns.map((col) => (
                  <Field key={col._id} label={col.name || 'Field'}>
                    <GenericCell
                      col={col}
                      task={task}
                      board={board}
                      canEdit={canEdit}
                      issuedDay={issuedDay}
                      currency={sourceCurrency}
                      money={money}
                      onWrite={write}
                    />
                  </Field>
                ))}
              </dl>
            </section>

            {/* ---- payments ---- */}
            <section aria-label="Payments" className="mt-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SectionTitle>
                  Payments
                  {payments.length > 0 && (
                    <span style={{ fontWeight: 500, color: 'var(--color-text-muted)', marginLeft: 6, letterSpacing: 0, textTransform: 'none' }}>
                      {asEntered(paymentsTotal(payments))} received
                    </span>
                  )}
                </SectionTitle>
                {state.key !== 'paid' && (canRecord || (canChangeStatus && doneStatus && onChangeStatus)) && (
                  <div className="flex flex-wrap items-center gap-2">
                    {canRecord && !form && (
                      <Button ref={recordButtonRef} variant="secondary" size="sm" icon={Plus} onClick={openForm} disabled={busy === 'payment'}>
                        Record payment
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={markFullyPaid}
                      disabled={busy === 'payment'}
                      title={
                        canRecord && hasAmount
                          ? `Records ${asEntered(Math.max(0, state.amount - state.recorded))} received today`
                          : `Marks the invoice ${doneStatus?.name || 'Paid'}`
                      }
                    >
                      Mark fully paid
                    </Button>
                  </div>
                )}
              </div>

              {trackingOff && (
                <p className="font-body mt-2" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
                  {canManageColumns && canEdit
                    ? 'Payment tracking is off on this board. Recording the first payment turns it on.'
                    : 'Payment tracking is off on this board. Ask a board admin to turn on payment tracking — until then, setting the status to Paid still marks it paid.'}
                </p>
              )}

              {state.markedPaid && state.amount > state.recorded && cols.payments && (
                <div
                  className="font-body mt-2 flex flex-wrap items-center gap-2"
                  style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}
                >
                  <span>
                    Marked {currentStatus?.name || 'Paid'} — {asEntered(state.amount - state.recorded)} isn&rsquo;t recorded as a payment.
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      disabled={busy === 'payment'}
                      onClick={async () => {
                        setBusy('payment');
                        await appendPayment({ amount: state.amount - state.recorded, date: todayKey() }, { skipStatus: true });
                        setBusy(null);
                      }}
                      className="font-semibold hover:underline"
                      style={{ color: 'var(--color-accent-text)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                    >
                      Record it as received today
                    </button>
                  )}
                </div>
              )}

              {form && (
                <form
                  onSubmit={submitForm}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setForm(null);
                      requestAnimationFrame(() => recordButtonRef.current?.focus());
                    }
                  }}
                  className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2"
                  style={{
                    padding: 12,
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--color-bg-subtle)',
                  }}
                  aria-label="Record a payment"
                >
                  <FormField label={`Amount${symbol ? ` (${symbol})` : ''}`}>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      autoFocus
                      required
                      value={form.amount}
                      onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                      className={inputClass}
                      style={inputStyle}
                    />
                  </FormField>
                  <FormField label="Date received">
                    <input
                      type="date"
                      required
                      value={form.date}
                      onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                      className={inputClass}
                      style={inputStyle}
                    />
                  </FormField>
                  <FormField label="Method">
                    <input
                      type="text"
                      list={methodListId}
                      maxLength={40}
                      placeholder="Bank transfer"
                      value={form.method}
                      onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))}
                      className={inputClass}
                      style={inputStyle}
                    />
                    <datalist id={methodListId}>
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </FormField>
                  <FormField label="Note">
                    <input
                      type="text"
                      maxLength={200}
                      placeholder="Optional"
                      value={form.note}
                      onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                      className={inputClass}
                      style={inputStyle}
                    />
                  </FormField>
                  <div className="flex items-center justify-end gap-2 sm:col-span-2">
                    <Button variant="secondary" size="sm" onClick={() => setForm(null)} disabled={busy === 'payment'}>
                      Cancel
                    </Button>
                    <Button type="submit" size="sm" disabled={busy === 'payment'}>
                      {busy === 'payment' ? 'Saving…' : 'Save payment'}
                    </Button>
                  </div>
                </form>
              )}

              {paymentsByNewest.length > 0 ? (
                <ul className="mt-3 flex flex-col" style={{ borderTop: '1px solid var(--color-border)' }}>
                  {paymentsByNewest.map(({ p, index }) => (
                    <li
                      key={p.id || index}
                      className="flex items-center gap-3"
                      style={{ padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-body flex flex-wrap items-baseline gap-x-2" style={{ fontSize: 13 }}>
                          <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-primary)' }}>
                            {money.column(Number(p.amount) || 0, cols.payments?.settings || amountSettings, issuedDay, sourceCurrency)}
                          </span>
                          <span style={{ color: 'var(--color-text-secondary)' }}>{dayLabel(p.date)}</span>
                          {p.method && <span style={{ color: 'var(--color-text-muted)' }}>· {p.method}</span>}
                        </div>
                        {p.note && (
                          <p className="font-body truncate" style={{ fontSize: 12, color: 'var(--color-text-muted)' }} title={p.note}>
                            {p.note}
                          </p>
                        )}
                      </div>
                      {canEdit && (
                        <IconButton
                          label={`Remove the payment of ${asEntered(Number(p.amount) || 0)} on ${dayLabel(p.date)}`}
                          onClick={() => removePayment(p, index)}
                          disabled={busy === 'payment'}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </IconButton>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                !trackingOff &&
                !form && (
                  <p className="font-body mt-2" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
                    No payments recorded yet.
                  </p>
                )
              )}
            </section>
          </div>

          {/* ---- footer ---- */}
          <footer
            className="shrink-0 flex flex-wrap items-center gap-2 px-4 md:px-6"
            style={{ paddingTop: 10, paddingBottom: 10, borderTop: '1px solid var(--color-border)' }}
          >
            <span className="font-body mr-auto inline-flex min-w-0 items-center gap-1.5" style={{ fontSize: 12 }}>
              {told.told ? (
                <>
                  <span className="flex" aria-hidden="true">
                    {told.people.slice(0, 3).map((p) => (
                      <Avatar key={p._id || p} user={p} size={18} />
                    ))}
                  </span>
                  <span style={{ color: 'var(--color-text-muted)' }}>Told {told.at ? timeAgo(told.at) : ''}</span>
                </>
              ) : state.key !== 'paid' ? (
                <span className="inline-flex items-center gap-1" style={{ color: 'var(--color-status-working)', fontWeight: 600 }}>
                  <AlertTriangle size={12} aria-hidden="true" />
                  Nobody told yet
                </span>
              ) : null}
            </span>
            {canNotify && onNotify && (
              <Button variant="secondary" size="sm" icon={BellRing} onClick={() => onNotify(task)}>
                Tell someone
              </Button>
            )}
            {onOpenUpdates && (
              <Button variant="secondary" size="sm" icon={MessageCircle} onClick={() => onOpenUpdates(task)}>
                {task.updatesCount > 0 ? `Updates (${task.updatesCount})` : 'Updates'}
              </Button>
            )}
            {canEdit && onDelete && (
              <IconButton label="Delete invoice" onClick={() => onDelete(task)} danger>
                <Trash2 size={15} aria-hidden="true" />
              </IconButton>
            )}
            <Button variant="primary" size="sm" onClick={() => onClose?.()}>
              Done
            </Button>
          </footer>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept={BOARD_UPLOAD_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            // Cleared so re-picking the SAME file fires change again.
            e.target.value = '';
            if (picked) attach(picked);
          }}
        />

        <style>{`
          .macan-invoice-sheet { animation: macan-invoice-sheet-in 220ms cubic-bezier(0.4, 0, 0.2, 1); }
          @keyframes macan-invoice-sheet-in {
            from { opacity: 0; transform: translateX(24px); }
            to   { opacity: 1; transform: translateX(0); }
          }
          @media (prefers-reduced-motion: reduce) {
            .macan-invoice-sheet { animation: none; }
          }
        `}</style>
      </section>

      {canChangeStatus && statusAnchor && (
        <StatusMenu
          anchorEl={statusAnchor}
          board={board}
          value={task.status}
          onSelect={handleStatusPick}
          onClose={() => setStatusAnchor(null)}
        />
      )}

      {previewIndex !== null && files[previewIndex] && (
        <FilePreviewModal
          attachments={files}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </>
  );

  return createPortal(node, document.body);
};

/** The file cell as a clean list — a stray non-object never reaches the renderer. */
const paymentsSafeFiles = (value) =>
  Array.isArray(value) ? value.filter((f) => f && typeof f === 'object' && f.url) : [];

/** The derived line beside the status, with Part-paid said alongside the due date. */
const statePillText = (state) => {
  if (state.key === 'partial') {
    const due = statePill({ ...state, key: 'sent' });
    return due ? `Part-paid · ${due}` : 'Part-paid';
  }
  return statePill(state);
};

const inputClass =
  'w-full font-body text-[13px] focus:outline-none focus:border-[color:var(--color-accent)]';
const inputStyle = {
  height: 34,
  padding: '0 10px',
  border: '1.5px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--color-bg-input)',
  color: 'var(--color-text-primary)',
};

const SectionTitle = ({ children }) => (
  <h3
    className="font-body"
    style={{
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: 'var(--color-text-secondary)',
    }}
  >
    {children}
  </h3>
);

/** A label and its control: side by side from `sm`, stacked on a phone. */
const Field = ({ label, children }) => (
  <div className="grid grid-cols-1 items-start gap-1 sm:grid-cols-[132px_minmax(0,1fr)] sm:gap-3">
    <dt className="font-body truncate sm:pt-2" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }} title={label}>
      {label}
    </dt>
    <dd className="min-w-0" style={{ margin: 0 }}>
      {children}
    </dd>
  </div>
);

const FormField = ({ label, children }) => (
  <label className="flex flex-col gap-1 font-body" style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', fontWeight: 600 }}>
    {label}
    {children}
  </label>
);

/**
 * The frame a grid cell sits in here. Cells are drawn for a table row, flush
 * and borderless; on a form they need an edge to read as a field you can click.
 */
const CellBox = ({ editable, children, ref }) => (
  <div
    ref={ref}
    style={{
      position: 'relative',
      minHeight: 34,
      border: `1px solid ${editable ? 'var(--color-border)' : 'transparent'}`,
      borderRadius: 'var(--radius-md)',
      background: editable ? 'var(--color-bg-input)' : 'transparent',
    }}
  >
    {children}
  </div>
);

/** Any other column the board has, drawn with the grid's own cell for its type. */
const GenericCell = ({ col, task, board, canEdit, issuedDay, currency, money, onWrite }) => {
  const value = columnValue(task, col) ?? null;
  if (col.type === 'payments') {
    // A second payments column has no editor here — the first is the one this
    // sheet records into. Its total still shows, read-only.
    return (
      <div className="font-body" style={{ fontSize: 13, padding: '8px 0', fontVariantNumeric: 'tabular-nums' }}>
        {money.column(paymentsTotal(value), col.settings, issuedDay, currency)}
      </div>
    );
  }
  const Cell = cellComponentFor(col.type);
  const computed = col.type === 'formula' || col.type === 'mirror';
  const editable = canEdit && !computed;
  return (
    <CellBox editable={editable}>
      <Cell
        value={value}
        column={col}
        task={task}
        columns={board.columns}
        readOnly={!editable}
        on={issuedDay}
        currency={currency}
        onChange={(v) => onWrite(col, v)}
      />
    </CellBox>
  );
};

const Figure = ({ label, value, tone }) => (
  <div
    style={{
      padding: '10px 12px',
      border: `1px solid ${tone === 'bad' ? 'var(--color-status-stuck)' : 'var(--color-border)'}`,
      borderRadius: 'var(--radius-md)',
      background: tone === 'bad' ? 'var(--color-status-stuck-bg)' : 'var(--color-bg-subtle)',
      minWidth: 0,
    }}
  >
    <span
      className="font-body block"
      style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}
    >
      {label}
    </span>
    <span
      className="font-body block truncate text-[16px] sm:text-[20px]"
      style={{
        fontWeight: 700,
        marginTop: 2,
        fontVariantNumeric: 'tabular-nums',
        color:
          tone === 'bad'
            ? 'var(--color-status-stuck)'
            : tone === 'good'
              ? 'var(--color-status-done)'
              : 'var(--color-text-primary)',
      }}
      title={typeof value === 'string' ? value : undefined}
    >
      {value}
    </span>
  </div>
);

const PILL_TONES = {
  bad: { bg: 'var(--color-status-stuck-bg)', fg: 'var(--color-status-stuck)' },
  warn: { bg: 'var(--color-status-working-bg)', fg: 'var(--color-status-working)' },
  accent: { bg: 'var(--color-accent-light)', fg: 'var(--color-accent-text)' },
  muted: { bg: 'var(--color-bg-subtle)', fg: 'var(--color-text-secondary)' },
};

const Pill = ({ tone = 'muted', children }) => {
  const t = PILL_TONES[tone] || PILL_TONES.muted;
  return (
    <span
      className="font-body inline-flex items-center"
      style={{
        fontSize: 11.5,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 9999,
        background: t.bg,
        color: t.fg,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
};

const IconButton = ({ label, onClick, children, disabled = false, danger = false, size = 28 }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    title={label}
    className="inline-flex shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent)] disabled:opacity-50"
    style={{
      width: size,
      height: size,
      background: 'transparent',
      border: 'none',
      color: danger ? 'var(--color-status-stuck)' : 'var(--color-text-secondary)',
      cursor: disabled ? 'default' : 'pointer',
    }}
  >
    {children}
  </button>
);

/**
 * The invoice itself, beside the form, when there is room.
 *
 * Images come straight off their URL. A PDF is fetched through the
 * authenticated proxy and shown from a blob — `raw` uploads are not publicly
 * deliverable, the same reason `FilePreviewModal` fetches them — so the fetch
 * only happens on a screen wide enough to show the column at all.
 */
const DocumentColumn = ({ file, canAttach, attaching, onAttach, onExpand }) => {
  const kind = file ? previewKindFor(file) : null;
  const [resolved, setResolved] = useState(null); // { url, status, src? }

  useEffect(() => {
    if (kind !== 'pdf' || !file?.url) return undefined;
    let cancelled = false;
    let objectUrl = null;
    fetchAttachmentBlob(file.url, file.mime || 'application/pdf', file.name || 'invoice.pdf')
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResolved({ url: file.url, status: 'ready', src: objectUrl });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Invoice preview failed:', err);
        setResolved({ url: file.url, status: 'error' });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [kind, file?.url, file?.mime, file?.name]);

  const pdf = kind === 'pdf' && resolved && resolved.url === file?.url ? resolved : null;

  let body;
  if (!file) {
    body = (
      <div className="flex flex-col items-center gap-3 px-6 text-center">
        <FileText size={34} aria-hidden="true" color="var(--color-border-strong)" />
        <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
          No document on this invoice yet.
        </p>
        {canAttach && (
          <Button variant="secondary" size="sm" icon={attaching ? Loader2 : Upload} disabled={attaching} onClick={onAttach}>
            {attaching ? 'Uploading…' : 'Attach PDF or photo'}
          </Button>
        )}
      </div>
    );
  } else if (kind === 'image') {
    body = <img src={file.url} alt={file.name || 'Invoice'} className="h-full w-full" style={{ objectFit: 'contain' }} />;
  } else if (kind === 'pdf' && pdf?.status === 'ready') {
    body = (
      <iframe
        src={pdf.src}
        title={`Invoice document: ${file.name || 'PDF'}`}
        className="h-full w-full"
        style={{ border: 0, background: 'var(--color-bg-surface)' }}
      />
    );
  } else if (kind === 'pdf' && !pdf) {
    body = (
      <span className="font-body inline-flex items-center gap-2" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        Loading preview…
      </span>
    );
  } else {
    body = (
      <div className="flex flex-col items-center gap-2 px-6 text-center">
        <FileTypeIcon mime={file.mime || ''} size={30} />
        <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
          {pdf?.status === 'error' ? "The document couldn't be loaded here." : 'No inline preview for this file.'}
        </p>
      </div>
    );
  }

  return (
    <aside
      aria-label="Invoice document"
      className="flex shrink-0 flex-col"
      style={{ width: 320, borderRight: '1px solid var(--color-border)', background: 'var(--color-bg-subtle)' }}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">{body}</div>
      {file && (
        <div
          className="flex shrink-0 items-center gap-2 px-3"
          style={{ height: 44, borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-surface)' }}
        >
          <span className="font-body min-w-0 flex-1 truncate" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }} title={file.name}>
            {file.name || 'Invoice document'}
          </span>
          <IconButton label="Open the document full screen" onClick={onExpand}>
            <Maximize2 size={14} aria-hidden="true" />
          </IconButton>
        </div>
      )}
    </aside>
  );
};

export default InvoiceSheet;
