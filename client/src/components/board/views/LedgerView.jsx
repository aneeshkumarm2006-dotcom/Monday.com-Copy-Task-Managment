import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileText,
  Loader2,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react';

import Button from '../../ui/Button';
import Dropdown from '../../ui/Dropdown';
import EntityLogo from '../../ui/EntityLogo';
import { SkeletonBlock } from '../../ui/Skeleton';
import FilePreviewModal from '../FilePreviewModal';
import BoardCurrencyControl from '../BoardCurrencyControl';
import { formatDate } from '../columns/cellShared';
import useMoney from '../../../hooks/useMoney';
import useBoardMembers from '../../../hooks/useBoardMembers';
import useBoardStore from '../../../store/boardStore';
import useToastStore from '../../../store/toastStore';
import { columnValue } from '../../../utils/columnValues';
import { boardCurrencyOf, canonicalCurrency, formatIn } from '../../../utils/money';
import { todayKey } from '../../../utils/payments';
import { getInitial } from '../../../utils/avatar';
import { timeAgo } from '../../../utils/dateUtils';
import {
  INVOICE_SORTS,
  clientOf,
  dueDayOf,
  invoiceState,
  issuedDayOf,
  ledgerColumns,
  ledgerTotals,
  notified,
  sortInvoices,
  statePill,
} from '../../../utils/ledger';
import {
  LEDGER_PERIODS,
  LEDGER_QUICK_FILTERS,
  downloadLedgerCsv,
  inLedgerPeriod,
} from '../../../utils/ledgerExport';
// What the file picker offers — the same list the server's board-file upload
// and the ledger's drop accept, so a .docx or .xlsx invoice is not filtered
// out of the OS dialog while dragging the very same file works.
import { BOARD_UPLOAD_ACCEPT } from '../../../utils/boardRowCreation';

/**
 * LEDGER — a billing board drawn as the documents it is made of.
 *
 * A row that reads `INV-2026-013.pdf` makes you open it to know what it is. A
 * tile that shows the number, the client, the amount and a status stamp
 * identifies itself before you have finished reading it, and the overdue one
 * does not need a status column to shout — it is the tile with the red stamp.
 *
 * ---- THE TWO STATES NOBODY ELSE SHOWS --------------------------------------
 *
 * An invoice that EXISTS and an invoice somebody is CHASING are different
 * things, and no billing board anywhere distinguishes them. The strip under
 * each tile does: who was told, and when — or "Nobody told" in amber. That gap
 * is exactly how an invoice quietly goes 39 days late. A PAID invoice has
 * nobody left to chase, so it has no strip: amber on a settled bill is noise
 * that teaches people to ignore the amber on the ones that matter.
 *
 * `notifiedUsers` is stamped on the task only when an update genuinely
 * @mentions somebody, so the strip cannot be satisfied by a note written to
 * oneself. See the field's comment on the Task model.
 *
 * ---- EVERY NUMBER COMES FROM `ledger.js` -------------------------------------
 *
 * What is a draft, what is overdue, what "received" means on a row marked Paid
 * with no receipts — all of it is decided in `utils/ledger.js` and only DRAWN
 * here. The stamp is `invoiceState(...).label` (the board's own status names),
 * the line under the amount is `statePill` (the same words the sheet uses, so
 * "1 day late" is pluralised once, in one place), and the strip is
 * `ledgerTotals`. A second opinion about any of those in this file is how the
 * tile and the sheet would come to describe one invoice two ways.
 *
 * ---- SCOPE, THEN SLICE -------------------------------------------------------
 *
 * The rows arrive already filtered by the page's filter bar. On top of that:
 *
 *   SCOPE  the issued PERIOD and the CLIENT. They answer "which ledger am I
 *          looking at" — this quarter, Kredoo's — so they scope the strip too:
 *          "Outstanding" under "Kredoo · This quarter" is what Kredoo owes for
 *          this quarter.
 *   SLICE  the quick chips (Unpaid, Overdue, …). They answer "which of these
 *          do I want to see" and deliberately do NOT move the strip; a chip
 *          that zeroed Outstanding the moment you clicked Paid would make the
 *          strip useless as the thing the chips are counted against.
 *
 * What each chip and period MEANS lives in `utils/ledgerExport.js`, beside the
 * CSV, because Export writes exactly the invoices shown and names the file
 * after the period — one definition, so the file and the screen cannot differ.
 *
 * ---- WHAT THE TILE DOES NOT SHOW -------------------------------------------
 *
 * NOT the first page of the PDF. Macan stores PDFs as Cloudinary `raw` on
 * purpose — so they download as `application/pdf` rather than being sniffed as
 * images — and `raw` assets cannot be transformed, so there is no page render
 * to fetch. Drawing a generic document mark is honest; faking a preview is not.
 * Image invoices (a photographed bill) do get their real thumbnail, because
 * those are stored as images and already have one.
 *
 * Props (all but `board` optional; a missing handler hides its control):
 *   board, tasks, canEdit, canCreate (falls back to canEdit),
 *   canManageColumns (the currency chip's Change), canChangeStatus,
 *   uploads [{ id, name, error }],
 *   onOpenTask(task), onNotifyTask(task), onMenuTask(task, anchorEl),
 *   onStatusTask(task, event), onDropFiles(files), onNewInvoice(),
 *   onDismissUpload(id), onRetryUpload(id)
 */

/**
 * The stamp in the corner of a tile, one tone per `invoiceState` key.
 *
 * `partial` is the accent — money is moving, nothing is wrong yet — rather than
 * falling through to the grey Draft stamp, which is what it did before part
 * payments existed and made a half-paid invoice look like one nobody had sent.
 */
const STAMP = {
  paid: { bg: 'var(--color-status-done-bg)', fg: 'var(--color-status-done)', edge: 'transparent' },
  sent: { bg: 'var(--color-status-working-bg)', fg: 'var(--color-status-working)', edge: 'transparent' },
  partial: { bg: 'var(--color-accent-light)', fg: 'var(--color-accent-text)', edge: 'transparent' },
  overdue: { bg: 'var(--color-status-stuck)', fg: '#FFFFFF', edge: 'transparent' },
  // Grey on the grey document face needs an edge to read as a stamp at all.
  draft: { bg: 'var(--color-bg-surface)', fg: 'var(--color-text-secondary)', edge: 'var(--color-border)' },
};

/** The line under the amount: red when late, amber when an unsent draft is past due. */
const PILL_COLOR = {
  bad: 'var(--color-status-stuck)',
  warn: 'var(--color-status-working)',
  muted: 'var(--color-text-muted)',
};

const pillToneOf = (state) => {
  if (state.key === 'overdue') return 'bad';
  if (state.key === 'draft' && state.pastDue) return 'warn';
  return 'muted';
};

/** "Paid X of Y": red while late, green once settled, the accent in between. */
const barColorOf = (state) =>
  state.key === 'overdue'
    ? 'var(--color-status-stuck)'
    : state.key === 'paid'
      ? 'var(--color-status-done)'
      : 'var(--color-accent)';

const DEFAULT_SORT = 'overdue';
const SORT_VALUES = new Set(INVOICE_SORTS.map((s) => s.value));
const PERIOD_VALUES = new Set(LEDGER_PERIODS.map((p) => p.value));

/**
 * The sort and the period, remembered per board and per browser.
 *
 * A per-viewer convenience and nothing more — the person who always reads this
 * quarter, most-overdue first, should not have to pick it again every visit.
 * Storage can be absent or throw (a private window, blocked site data), and
 * every path here falls back to the defaults rather than failing the view.
 * The quick chip and the client are deliberately NOT remembered: coming back to
 * a board that silently hides most of its invoices is how people decide
 * invoices went missing.
 */
const prefsKey = (boardId) => `ledger:view:${boardId}`;

const readPrefs = (boardId) => {
  const out = { sort: DEFAULT_SORT, period: 'all' };
  if (!boardId) return out;
  try {
    const raw = window.localStorage.getItem(prefsKey(boardId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && SORT_VALUES.has(parsed.sort)) out.sort = parsed.sort;
    if (parsed && PERIOD_VALUES.has(parsed.period)) out.period = parsed.period;
  } catch {
    // Unreadable or unavailable — the defaults are a fine answer.
  }
  return out;
};

const writePrefs = (boardId, { sort, period }) => {
  if (!boardId) return;
  try {
    window.localStorage.setItem(prefsKey(boardId), JSON.stringify({ sort, period }));
  } catch {
    // Not remembered this time; nothing else depends on it.
  }
};

const freshView = (boardId) => ({ boardId, quick: 'all', client: 'all', ...readPrefs(boardId) });

/**
 * The filter key a client is grouped under: the client BOARD when the cell
 * points at one (so a renamed client stays one entry), else the typed name,
 * case-folded (so "kredoo" and "Kredoo" are one client, not two).
 */
const clientKeyOf = (client) =>
  client ? (client.boardId ? `b:${client.boardId}` : `n:${client.name.toLowerCase()}`) : 'none';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const initialsOf = (name) =>
  String(name || '?')
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';

const isImage = (f) => typeof f?.mime === 'string' && f.mime.startsWith('image/');

/**
 * The client's mark: their board's logo when there is one, else their initials.
 *
 * Span-only, because it is drawn inside the tile's open button and the client
 * menu — a `<div>` there is invalid inside a button.
 */
const ClientMark = ({ name, logo, size = 16 }) =>
  logo ? (
    <EntityLogo src={logo} name={name} size={size} radius={4} />
  ) : (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center font-body"
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-subtle)',
        color: 'var(--color-text-secondary)',
        fontSize: Math.max(8, Math.round(size * 0.46)),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {initialsOf(name)}
    </span>
  );

/**
 * One person as a small flat circle — `ui/Avatar`'s exact treatment, drawn in
 * spans because it sits inside a button (Avatar's fallback is a `<div>`). The
 * picture is decorative: the button around it says who, in words.
 */
const PersonDot = ({ person, size = 18 }) => {
  const [brokenSrc, setBrokenSrc] = useState('');
  const src = person?.profilePic || person?.avatar || '';
  const ring = {
    width: size,
    height: size,
    borderRadius: 9999,
    flexShrink: 0,
    boxShadow: '0 0 0 1.5px var(--color-bg-surface)',
  };
  if (src && brokenSrc !== src) {
    return (
      <img src={src} alt="" className="object-cover" style={ring} onError={() => setBrokenSrc(src)} />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center font-display font-semibold"
      style={{
        ...ring,
        background: 'var(--color-accent-light)',
        color: 'var(--color-accent-text)',
        fontSize: Math.round(size * 0.45),
        lineHeight: 1,
      }}
    >
      {getInitial(person?.name)}
    </span>
  );
};

/** A shimmer the size of a figure, in a span so it can sit inside a button. */
const InlineSkeleton = ({ width = 72, height = 14 }) => (
  <span
    aria-hidden="true"
    className="skeleton inline-block align-middle"
    style={{ width, height, borderRadius: 'var(--radius-sm)' }}
  />
);

/** One figure of the strip. `sub` is a quieter second line; `pending` a skeleton. */
const Figure = ({ label, display, tone, sub, pending = false }) => (
  <div
    style={{
      flex: '1 1 140px',
      minWidth: 0,
      padding: '10px 12px',
      border: `1px solid ${tone === 'bad' ? 'var(--color-status-stuck)' : 'var(--color-border)'}`,
      borderRadius: 'var(--radius-md)',
      background: tone === 'bad' ? 'var(--color-status-stuck-bg)' : 'var(--color-bg-subtle)',
    }}
  >
    <span
      className="font-body block truncate"
      style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}
    >
      {label}
    </span>
    {pending ? (
      <SkeletonBlock width="70%" height={20} style={{ marginTop: 4 }} />
    ) : (
      <span
        className="font-body block truncate text-[16px] sm:text-[19px]"
        title={typeof display === 'string' ? display : undefined}
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
      >
        {display}
      </span>
    )}
    {sub ? (
      <span className="font-body block truncate" style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 1 }}>
        {sub}
      </span>
    ) : null}
  </div>
);

/** A quick chip: a filter you can see the size of before you click it. */
const QuickChip = ({ label, count, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    aria-label={`${label}: ${plural(count, 'invoice', 'invoices')}`}
    className="inline-flex items-center gap-1.5 font-body transition-colors hover:border-[color:var(--color-border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      height: 30,
      padding: '0 10px',
      borderRadius: 9999,
      border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
      background: active ? 'var(--color-accent-light)' : 'var(--color-bg-surface)',
      color: active ? 'var(--color-accent-text)' : 'var(--color-text-secondary)',
      fontSize: 12.5,
      fontWeight: 600,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }}
  >
    {label}
    <span
      aria-hidden="true"
      style={{
        fontWeight: 500,
        fontVariantNumeric: 'tabular-nums',
        color: active ? 'var(--color-accent-text)' : 'var(--color-text-muted)',
      }}
    >
      {count}
    </span>
  </button>
);

const tileActionClass =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent)]';

const InvoiceTile = ({
  row,
  cols,
  client,
  owners,
  sourceCurrency,
  onOpen,
  onNotify,
  onMenu,
  onPreview,
  onStatus,
}) => {
  // Its own hook rather than a prop from the grid. The value is memoized per
  // render in `useMoney`, so this costs nothing, and threading a formatter
  // through the tile list would be plumbing for a fact that is the same on
  // every tile.
  const money = useMoney();
  const { task, state, issued } = row;
  const stamp = STAMP[state.key] || STAMP.draft;
  const files = cols.file ? columnValue(task, cols.file) : null;
  const file = Array.isArray(files) ? files[0] : null;
  const told = notified(task);
  const dueKey = dueDayOf(task, cols);

  /**
   * Each tile converts on its OWN issue date, exactly as `money.column` does in
   * the table. A tile whose date has no rate stays in the board's currency and
   * carries that currency's symbol, so it is labelled rather than wrong — the
   * note under the strip says how many did.
   */
  const show = (n) => money.column(n, cols.amount?.settings, issued, sourceCurrency);
  const rawAmount = cols.amount ? columnValue(task, cols.amount) : null;
  const priced =
    rawAmount !== null && rawAmount !== undefined && rawAmount !== '' && Number.isFinite(Number(rawAmount));
  const amountText = priced ? show(Number(rawAmount)) : '—';

  // The derived line. A stamp that already says it ("Overdue" twice, or
  // "Part-paid" twice) falls back to the due date instead.
  const derived = statePill(state);
  const pill = derived && derived !== state.label ? derived : null;
  // A settled invoice's due date is history, not a prompt.
  const dueLine =
    pill || (state.key === 'paid' ? null : dueKey ? `Due ${formatDate(dueKey)}` : 'No due date');
  const dueTone = pill ? pillToneOf(state) : 'muted';

  const showBar = state.amount > 0 && state.recorded > 0;
  const received = Math.min(state.received, state.amount);
  const pct = showBar ? Math.min(100, (received / state.amount) * 100) : 0;
  const paidLine = showBar ? `Paid ${show(received)} of ${show(state.amount)}` : null;

  const openLabel = [
    `Open ${task.name || 'invoice'}`,
    client?.name ? `for ${client.name}` : null,
    priced ? amountText : null,
    state.label,
    pill,
  ]
    .filter(Boolean)
    .join(', ');

  const stampStyle = {
    position: 'absolute',
    right: 7,
    top: 64,
    zIndex: 2,
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: '0.07em',
    lineHeight: 1.3,
    padding: '3px 7px',
    borderRadius: 3,
    border: `1px solid ${stamp.edge}`,
    background: stamp.bg,
    color: stamp.fg,
    textTransform: 'uppercase',
    maxWidth: 'calc(100% - 14px)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

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
        minWidth: 0,
      }}
    >
      {/* THE STAMP IS A CONTROL when the reader may change the status, and a
          plain label when they may not — a disabled button that looks exactly
          like a live one is a control that silently does nothing. It opens the
          board's own status menu, the same one the table's chip opens, so the
          names come from the board and cannot drift. A SIBLING of the face
          button rather than a child: a button inside a button is invalid HTML
          that browsers resolve by dropping one of them. */}
      {onStatus ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onStatus(task, e);
          }}
          aria-label={`Status: ${state.label}. Change it`}
          aria-haspopup="menu"
          title="Change the status"
          className={`font-body ${tileActionClass}`}
          style={{ ...stampStyle, cursor: 'pointer' }}
        >
          {state.label}
        </button>
      ) : (
        <span aria-hidden="true" className="font-body" style={stampStyle}>
          {state.label}
        </span>
      )}

      {/* The same menu as the table's row `⋯` — Pin, Share, Edit, Delete — so
          a file dropped by mistake can be removed without leaving the ledger.
          Only drawn when the page hands a menu over: a viewer gets none. */}
      {onMenu && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMenu(task, e.currentTarget);
          }}
          aria-label={`Actions for ${task.name || 'invoice'}`}
          aria-haspopup="menu"
          className={`flex items-center justify-center ${tileActionClass}`}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            zIndex: 2,
            width: 26,
            height: 26,
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

      {/* THE DOCUMENT FACE OPENS THE DOCUMENT; the details below open the
          invoice. Clicking a picture of an invoice and getting a form is the
          wrong answer — it is not what the thing you clicked looks like.
          With no document it opens the invoice too, for the mouse — and is
          skipped by the keyboard, since the details button right after it is
          the same action with a fuller name. */}
      <button
        type="button"
        tabIndex={file?.url ? undefined : -1}
        aria-hidden={file?.url ? undefined : true}
        onClick={() => (file?.url ? onPreview?.(task) : onOpen?.(task))}
        className="text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
        style={{
          display: 'block',
          border: 'none',
          padding: 0,
          background: 'transparent',
          cursor: file?.url ? 'zoom-in' : 'pointer',
        }}
        aria-label={file?.url ? `Preview ${file.name || task.name || 'the document'}` : `Open ${task.name || 'invoice'}`}
        title={file?.url ? 'Preview the document' : 'No file on this invoice yet'}
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
          {isImage(file) && file.url ? (
            <img src={file.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
          ) : (
            <FileText
              size={26}
              aria-hidden="true"
              color={file ? 'var(--color-text-muted)' : 'var(--color-border-strong)'}
            />
          )}
        </span>
      </button>

      {/* The details open the INVOICE — the sheet, where every field is edited. */}
      <button
        type="button"
        onClick={() => onOpen?.(task)}
        className="flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
        style={{ display: 'block', border: 'none', padding: 0, background: 'transparent', cursor: 'pointer', width: '100%' }}
        aria-label={openLabel}
        title="Open the invoice"
      >
        <span className="flex flex-col" style={{ padding: '8px 10px 9px', gap: 2 }}>
          <span
            className="font-body block truncate"
            style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}
          >
            {task.name || 'Untitled invoice'}
          </span>

          {client && (
            <span className="flex min-w-0 items-center gap-1.5">
              <ClientMark name={client.name} logo={client.logo} size={15} />
              <span className="font-body truncate" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {client.name}
              </span>
            </span>
          )}

          <span
            className="font-body block truncate"
            style={{
              fontSize: 15,
              fontWeight: 700,
              marginTop: 2,
              fontVariantNumeric: 'tabular-nums',
              color: state.key === 'overdue' ? 'var(--color-status-stuck)' : 'var(--color-text-primary)',
            }}
          >
            {priced && money.pending ? <InlineSkeleton width={84} height={16} /> : amountText}
          </span>

          {dueLine && (
            <span
              className="font-body block truncate"
              style={{
                fontSize: 11,
                fontWeight: pill && dueTone !== 'muted' ? 600 : 400,
                color: PILL_COLOR[dueTone],
              }}
            >
              {dueLine}
            </span>
          )}

          {showBar && (
            <span className="block" style={{ marginTop: 4 }}>
              <span
                className="font-body block truncate"
                style={{ fontSize: 10.5, color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}
              >
                {money.pending ? <InlineSkeleton width={100} height={11} /> : paidLine}
              </span>
              <span
                aria-hidden="true"
                className="block overflow-hidden"
                style={{ height: 4, marginTop: 3, borderRadius: 9999, background: 'var(--color-bg-subtle)' }}
              >
                <span
                  className="block"
                  style={{ width: `${pct}%`, height: '100%', background: barColorOf(state), transition: 'width 200ms ease' }}
                />
              </span>
            </span>
          )}

          {(issued || owners.length > 0) && (
            <span className="flex min-w-0 items-center gap-2" style={{ marginTop: 4 }}>
              <span
                className="font-body min-w-0 flex-1 truncate"
                style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}
              >
                {issued ? `Issued ${formatDate(issued)}` : ''}
              </span>
              {owners.length > 0 && (
                <span
                  className="flex shrink-0 items-center"
                  title={owners.map((p) => p.name).filter(Boolean).join(', ')}
                  style={{ gap: 0 }}
                >
                  {owners.slice(0, 2).map((p, i) => (
                    <span key={p._id || i} style={{ marginLeft: i === 0 ? 0 : -5, display: 'inline-flex' }}>
                      <PersonDot person={p} size={18} />
                    </span>
                  ))}
                  {owners.length > 2 && (
                    <span className="font-body" style={{ fontSize: 10, marginLeft: 3, color: 'var(--color-text-muted)' }}>
                      +{owners.length - 2}
                    </span>
                  )}
                </span>
              )}
            </span>
          )}
        </span>
      </button>

      {/* Told, or not — the whole reason this view exists rather than a
          gallery. Not on a paid invoice: there is nobody left to chase. */}
      {state.key !== 'paid' &&
        (onNotify ? (
          <button
            type="button"
            onClick={() => onNotify(task)}
            className="w-full text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
            style={toldStyle(told.told)}
            aria-label={
              told.told
                ? `Told ${told.people.map((p) => p?.name).filter(Boolean).join(', ') || 'someone'}${
                    told.at ? ` ${timeAgo(told.at)}` : ''
                  }. Tell someone else`
                : 'Nobody has been told about this invoice. Tell someone'
            }
            title={told.told ? 'Tell someone else' : 'Nobody has been told about this invoice'}
          >
            <ToldContent told={told} />
          </button>
        ) : (
          <div style={toldStyle(told.told, false)}>
            <ToldContent told={told} />
          </div>
        ))}
    </div>
  );
};

/**
 * The Told strip. `border: none` comes BEFORE `borderTop` on purpose: the
 * shorthand written after the longhand reset it, so the strip lost its top rule
 * and ran into the details above it.
 */
const toldStyle = (isTold, interactive = true) => ({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  padding: '6px 10px',
  border: 'none',
  borderTop: '1px solid var(--color-border)',
  background: isTold ? 'var(--color-bg-subtle)' : 'var(--color-status-working-bg)',
  color: isTold ? 'var(--color-text-muted)' : 'var(--color-status-working)',
  fontSize: 10.5,
  fontWeight: isTold ? 400 : 700,
  cursor: interactive ? 'pointer' : 'default',
  minWidth: 0,
});

const ToldContent = ({ told }) =>
  told.told ? (
    <>
      <span className="flex" aria-hidden="true">
        {told.people.slice(0, 3).map((p, i) => (
          <span
            key={(p && typeof p === 'object' ? p._id : p) || i}
            style={{ marginLeft: i === 0 ? 0 : -4, display: 'inline-flex' }}
          >
            <PersonDot person={typeof p === 'object' ? p : null} size={15} />
          </span>
        ))}
      </span>
      <span className="font-body truncate">Told {told.at ? timeAgo(told.at) : ''}</span>
    </>
  ) : (
    <>
      <AlertTriangle size={11} aria-hidden="true" />
      <span className="font-body">Nobody told</span>
    </>
  );

/**
 * A file on its way up. It sits in the grid where the eye already is, so a
 * drop visibly did something; a failure keeps its card — with the reason, a
 * Retry and a Dismiss — because no row is ever created for a file that did not
 * land, and the card is the only trace of it.
 */
const UploadCard = ({ upload, onDismiss, onRetry }) => {
  const failed = !!upload.error;
  const smallButton =
    'inline-flex items-center gap-1 font-body transition-colors hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent)]';
  const smallButtonStyle = {
    height: 26,
    padding: '0 8px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--color-border-strong)',
    background: 'var(--color-bg-surface)',
    color: 'var(--color-text-primary)',
    fontSize: 11.5,
    fontWeight: 600,
    cursor: 'pointer',
  };
  return (
    <div
      aria-busy={failed ? undefined : true}
      style={{
        border: `1px solid ${failed ? 'var(--color-status-stuck)' : 'var(--color-border)'}`,
        borderRadius: 'var(--radius-md)',
        background: failed ? 'var(--color-status-stuck-bg)' : 'var(--color-bg-subtle)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        justifyContent: 'center',
        minHeight: 150,
        minWidth: 0,
      }}
    >
      {failed ? (
        <AlertTriangle size={16} color="var(--color-status-stuck)" aria-hidden="true" />
      ) : (
        <Loader2 size={16} className="animate-spin" color="var(--color-text-muted)" aria-hidden="true" />
      )}
      <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>
        {upload.name}
      </span>
      <span
        className="font-body"
        style={{ fontSize: 11, color: failed ? 'var(--color-status-stuck)' : 'var(--color-text-muted)' }}
      >
        {upload.error || 'Uploading…'}
      </span>
      {failed && (onRetry || onDismiss) && (
        <span className="flex flex-wrap items-center gap-1.5" style={{ marginTop: 2 }}>
          {onRetry && (
            <button
              type="button"
              onClick={() => onRetry(upload.id)}
              aria-label={`Retry uploading ${upload.name}`}
              className={smallButton}
              style={smallButtonStyle}
            >
              <RotateCcw size={12} aria-hidden="true" />
              Retry
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={() => onDismiss(upload.id)}
              aria-label={`Dismiss the failed upload of ${upload.name}`}
              className={smallButton}
              style={smallButtonStyle}
            >
              <X size={12} aria-hidden="true" />
              Dismiss
            </button>
          )}
        </span>
      )}
    </div>
  );
};

const LedgerView = ({
  board,
  tasks = [],
  canEdit = false,
  canCreate,
  canManageColumns = false,
  canChangeStatus = true,
  uploads = [],
  onOpenTask,
  onNotifyTask,
  onMenuTask,
  onStatusTask,
  onDropFiles,
  onNewInvoice,
  onDismissUpload,
  onRetryUpload,
  // Set by the page while ITS filter bar (owner, status, due…) is narrowing
  // `tasks`: clears it. With it, an empty ledger says the filters hid the
  // invoices instead of claiming the board has none.
  onClearPageFilters,
}) => {
  const cols = useMemo(() => ledgerColumns(board), [board]);
  const money = useMoney();
  const toastError = useToastStore((s) => s.error);

  // Adding invoices is CREATING rows. A page that predates the split passes
  // only `canEdit`, and gets the old behaviour.
  const mayCreate = canCreate === undefined ? !!canEdit : !!canCreate;
  const statusControl = onStatusTask && canChangeStatus !== false ? onStatusTask : null;
  const uploadList = Array.isArray(uploads) ? uploads : [];

  // ---- toolbar state -----------------------------------------------------------

  const boardId = board?._id ? String(board._id) : null;
  const [view, setView] = useState(() => freshView(boardId));
  // The page can swap boards under a mounted view. Chips, client and the
  // remembered sort all belong to ONE board, so a new board starts from its own
  // (React's "reset state when a prop changes" pattern — no effect, no flash).
  if (view.boardId !== boardId) setView(freshView(boardId));

  const change = (patch) => {
    const next = { ...view, ...patch };
    setView(next);
    if ('sort' in patch || 'period' in patch) writePrefs(boardId, next);
  };

  // ---- currency ------------------------------------------------------------------

  /**
   * The unit every figure on this board is in: the Amount column's own code,
   * else the BOARD's (`boardCurrencyOf` — its `currency`, else its first money
   * column's, else the workspace's). The same resolution as the sheet and the
   * table, so a CAD board reads CA$ on all three.
   *
   * It used to be the Amount column's code or NOTHING, which is how a board
   * whose column carried no code printed bare numbers in the strip while its
   * tiles borrowed the workspace's symbol.
   */
  const sourceCurrency = cols.amount?.settings?.currency || boardCurrencyOf(board, money.baseCurrency);
  const source = canonicalCurrency(sourceCurrency);

  // ---- who: client boards and the board roster ------------------------------------

  const allBoards = useBoardStore((s) => s.boards);
  const clientBoards = useMemo(() => {
    const map = new Map();
    for (const b of Array.isArray(allBoards) ? allBoards : []) {
      if (b && b._id && b.boardType === 'client') map.set(String(b._id), b);
    }
    return map;
  }, [allBoards]);

  /**
   * A client as drawn: the client board's CURRENT display name and logo when
   * this reader can see that board, else the name the cell carries — which the
   * server re-snapshots on every write, so a reader without access to the
   * client's board still sees who the invoice is for.
   */
  const clientInfo = useCallback(
    (client) => {
      if (!client) return null;
      const live = client.boardId ? clientBoards.get(client.boardId) : null;
      const name = (live && (live.portalClientName || live.name)) || client.name || 'Client';
      return { name, logo: live?.logo || '' };
    },
    [clientBoards]
  );

  // Owners come off the board's OWN roster — never the workspace's, which
  // would put names on a private board's tiles that its readers cannot see.
  const members = useBoardMembers(boardId, { enabled: !!cols.owner });
  const memberById = useMemo(() => {
    const map = new Map();
    for (const m of members) {
      const id = m?._id || m?.id;
      if (id) map.set(String(id), m);
    }
    return map;
  }, [members]);

  const ownersOf = (task) => {
    if (!cols.owner) return [];
    const ids = columnValue(task, cols.owner);
    if (!Array.isArray(ids)) return [];
    return ids.map((id) => memberById.get(String(id?._id || id))).filter(Boolean);
  };

  // ---- rows: state once per invoice ------------------------------------------------

  /**
   * Every invoice's state, computed ONCE per render of the list and handed to
   * its tile, the filters, the counts and the sort.
   *
   * `today` is a dependency on purpose, though nothing reads it here: overdue
   * is judged by the day, so a ledger left open past midnight must re-judge
   * every invoice when the day turns, not when some unrelated row changes.
   */
  const today = todayKey();
  const rows = useMemo(
    () => {
      const now = Date.now();
      return (Array.isArray(tasks) ? tasks : []).filter(Boolean).map((task) => ({
        task,
        state: invoiceState(task, board, cols, now),
        issued: issuedDayOf(task, cols),
        client: clientOf(task, cols),
      }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, board, cols, today]
  );

  // ---- scope: period and client ------------------------------------------------------

  /**
   * The client menu: every client these invoices are for, A–Z, plus "No
   * client" when some are for nobody. Built from the rows rather than from the
   * workspace's client boards — a filter offering a client with no invoices
   * here is a filter that can only ever show nothing.
   */
  const clientOptions = useMemo(() => {
    if (cols.client?.type !== 'client') return [];
    const seen = new Map();
    let unassigned = 0;
    for (const r of rows) {
      if (!r.client) {
        unassigned += 1;
        continue;
      }
      const key = clientKeyOf(r.client);
      if (!seen.has(key)) seen.set(key, clientInfo(r.client));
    }
    if (seen.size === 0) return [];
    const named = [...seen.entries()]
      .map(([value, info]) => ({
        value,
        label: info.name,
        icon: <ClientMark name={info.name} logo={info.logo} size={16} />,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    return [
      { value: 'all', label: 'All clients' },
      ...named,
      ...(unassigned > 0 ? [{ value: 'none', label: 'No client' }] : []),
    ];
  }, [rows, cols.client, clientInfo]);

  // A remembered client that no longer has an invoice here reads as "all"
  // rather than as an empty ledger with a blank menu.
  const clientFilter = clientOptions.some((o) => o.value === view.client) ? view.client : 'all';
  const inClient = useCallback(
    (r) => clientFilter === 'all' || clientKeyOf(r.client) === clientFilter,
    [clientFilter]
  );

  const scoped = useMemo(
    () => rows.filter((r) => inClient(r) && inLedgerPeriod(r.issued, view.period, today)),
    [rows, inClient, view.period, today]
  );

  // An invoice with no issue date belongs to no period. Said, not silently dropped.
  const undatedLeftOut =
    view.period === 'all' ? 0 : rows.filter((r) => inClient(r) && !r.issued).length;

  // ---- slice: quick chips, then sort ----------------------------------------------------

  const counts = useMemo(() => {
    const out = {};
    for (const f of LEDGER_QUICK_FILTERS) out[f.value] = scoped.filter((r) => f.test(r.state)).length;
    return out;
  }, [scoped]);

  const quick = LEDGER_QUICK_FILTERS.find((f) => f.value === view.quick) || LEDGER_QUICK_FILTERS[0];

  const visible = useMemo(() => {
    const matching = scoped.filter((r) => quick.test(r.state));
    const byTask = new Map(matching.map((r) => [r.task, r]));
    return sortInvoices(
      matching.map((r) => r.task),
      view.sort,
      board,
      cols
    )
      .map((t) => byTask.get(t))
      .filter(Boolean);
  }, [scoped, quick, view.sort, board, cols]);

  const filtersActive = quick.value !== 'all' || clientFilter !== 'all' || view.period !== 'all';
  const resetFilters = () => change({ quick: 'all', client: 'all', period: 'all' });

  // ---- the strip ----------------------------------------------------------------------

  /**
   * Can every invoice in scope be valued in the reader's currency?
   *
   * The STRIP stays all-or-nothing, deliberately: adding converted dollars to
   * unconverted rupees is the exact thing `Board.js` calls out — "adding
   * numbers that do not share a unit is a bug" — and a partly-converted total
   * looks just as authoritative as a right one. The TILES do not have that
   * problem: each carries its own symbol, so each converts on its own date and
   * a tile with no rate stays in the board's currency, labelled as such.
   *
   * What changed is that the gap is now SAID. The strip used to drop to the
   * source currency and go quiet; the note below now counts the invoices that
   * could not convert and names both currencies.
   */
  const conversion = useMemo(() => {
    const asked = money.active && !!source && source !== money.display;
    if (!asked) return { asked: false, all: false, converted: 0, missing: 0, from: null, to: null };
    let converted = 0;
    let missing = 0;
    let from = null;
    let to = null;
    for (const r of scoped) {
      // `.converted`, not a null check on the value: `resolve` deliberately
      // hands back the ORIGINAL number when it cannot convert.
      const res = money.resolve(1, sourceCurrency, r.issued);
      if (res.converted) {
        converted += 1;
        if (!from || res.asOf < from) from = res.asOf;
        if (!to || res.asOf > to) to = res.asOf;
      } else {
        missing += 1;
      }
    }
    return { asked: true, all: converted > 0 && missing === 0, converted, missing, from, to };
  }, [money, source, sourceCurrency, scoped]);

  const totals = useMemo(
    () =>
      ledgerTotals(
        scoped.map((r) => r.task),
        board,
        cols,
        {
          convert: conversion.all
            ? (amount, task) => money.value(amount, sourceCurrency, issuedDayOf(task, cols))
            : null,
        }
      ),
    [scoped, board, cols, conversion.all, money, sourceCurrency]
  );

  /**
   * A strip figure, already converted (or deliberately not).
   *
   * `formatIn` rather than the hook, because `totals` has been through the
   * conversion already — asking the hook again would convert a second time.
   * Unconverted, the decimals are the column author's, else 'auto' (whole
   * stays whole, anything else shows its cents) — the same rule the tiles use,
   * so the strip never rounds away the cents its own tiles show.
   */
  const stripFigure = (n) =>
    conversion.all
      ? // Zero has no cents to show; the magnitude rule would print "$0.00"
        // beside "$1,157" and make the empty figure the loudest one.
        formatIn(n, money.display, n === 0 ? { decimals: 0 } : {})
      : formatIn(n, sourceCurrency, { decimals: cols.amount?.settings?.decimals ?? 'auto' });

  /**
   * The ONE line that says what unit the strip is in, when that is not simply
   * what was typed. Said once, under the strip, never as a marker on each
   * figure — this codebase's rule, and it keeps the tabular figures scanning.
   */
  let conversionNote = null;
  if (!money.pending && conversion.asked && scoped.length > 0) {
    const display = money.display;
    const theirDates = conversion.missing === 1 ? 'its date' : 'their dates';
    if (conversion.all) {
      conversionNote =
        conversion.from === conversion.to
          ? money.surfaceNote(sourceCurrency, conversion.from)
          : `Shown in ${display} · entered in ${source} · each invoice at the rate of its issue date (${conversion.from} to ${conversion.to})`;
    } else if (conversion.converted > 0) {
      conversionNote = `Totals shown as entered (${source}) · ${plural(
        conversion.missing,
        'invoice',
        'invoices'
      )} shown in ${source} — no ${display} rate for ${theirDates}`;
    } else if (money.resolve(1, sourceCurrency).converted) {
      // Rates exist, just none old enough for these invoices.
      conversionNote = `${plural(conversion.missing, 'invoice', 'invoices')} shown in ${source} — no ${display} rate for ${theirDates}`;
    } else {
      // No rate at all yet — the hook's own words for that.
      conversionNote = money.surfaceNote(sourceCurrency);
    }
  }

  const periodLabel = (LEDGER_PERIODS.find((p) => p.value === view.period)?.label || '').toLowerCase();
  const notes = [
    conversionNote,
    totals.overpaid > 0 ? `${stripFigure(totals.overpaid)} recorded beyond invoice amounts` : null,
    undatedLeftOut > 0
      ? `${plural(undatedLeftOut, 'invoice', 'invoices')} with no issue date ${
          undatedLeftOut === 1 ? 'is' : 'are'
        } left out of ${periodLabel}`
      : null,
  ].filter(Boolean);

  // ---- documents ------------------------------------------------------------------------

  /**
   * The document being read, as an index into `previewable`.
   *
   * Held HERE rather than lifted to the page: the viewer walks the list with
   * ← / →, and the natural list is "every invoice on screen that has a file",
   * in the order on screen — which only this component knows.
   */
  const [preview, setPreview] = useState(null);
  const previewable = useMemo(() => {
    if (!cols.file) return [];
    const out = [];
    for (const { task } of visible) {
      const files = columnValue(task, cols.file);
      const file = Array.isArray(files) ? files[0] : null;
      if (file?.url) out.push({ ...file, taskId: task._id });
    }
    return out;
  }, [visible, cols.file]);

  const openPreview = useCallback(
    (task) => {
      const idx = previewable.findIndex((f) => f.taskId === task._id);
      if (idx >= 0) setPreview(idx);
    },
    [previewable]
  );

  // ---- dropping files --------------------------------------------------------------------

  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  // A dragenter on a child fires a dragleave on the parent, so a plain boolean
  // flickers the whole grid while the pointer crosses a tile. Counting the
  // enters and leaves is what makes the highlight hold steady.
  const dragDepth = useRef(0);
  const acceptsDrops = mayCreate && !!onDropFiles;
  // Only a drag carrying FILES lights the ledger up — not a selection of text
  // or a tile's own thumbnail being dragged across it.
  const carriesFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  const handleFiles = useCallback(
    (fileList) => {
      const files = Array.from(fileList || []);
      if (files.length > 0) onDropFiles?.(files);
    },
    [onDropFiles]
  );

  const openPicker = () => inputRef.current?.click();

  const onDrop = (e) => {
    if (!acceptsDrops || !carriesFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    handleFiles(e.dataTransfer?.files);
  };

  // ---- export --------------------------------------------------------------------------------

  const exportCsv = () => {
    try {
      downloadLedgerCsv(
        visible.map((r) => r.task),
        board,
        cols,
        {
          currency: sourceCurrency,
          period: view.period,
          clientName: (client) => clientInfo(client)?.name || client.name,
        }
      );
    } catch (err) {
      console.error('Ledger export failed:', err);
      toastError("Couldn't export the ledger.");
    }
  };

  // ---- upload announcements ----------------------------------------------------------------

  // Read by screen readers as it changes; the cards say the same thing visually.
  const uploading = uploadList.filter((u) => !u.error).length;
  const failed = uploadList.filter((u) => u.error).length;
  const liveText =
    uploading > 0
      ? `Uploading ${plural(uploading, 'file', 'files')}…`
      : failed > 0
        ? `${plural(failed, 'upload', 'uploads')} failed`
        : '';

  const boardEmpty = rows.length === 0 && uploadList.length === 0;
  const dropdownBox = 'min-w-[132px] flex-1 sm:w-[168px] sm:flex-none';

  return (
    <div
      onDragEnter={(e) => {
        if (!acceptsDrops || !carriesFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (acceptsDrops && carriesFiles(e)) e.preventDefault();
      }}
      onDragLeave={() => {
        if (!acceptsDrops) return;
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
        minWidth: 0,
      }}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {liveText}
      </p>

      {/* ---- scope + actions ----
          The period and the client decide which invoices the strip adds up,
          so they sit ABOVE it; the unit it adds them up in sits beside them. */}
      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 10 }}>
        {/* Full width on a phone, so the actions wrap onto their own line
            rather than being overlapped by filters that cannot shrink. */}
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:flex-1">
          <div className={dropdownBox}>
            <Dropdown
              size="sm"
              ariaLabel="Issued period"
              options={LEDGER_PERIODS}
              value={view.period}
              onChange={(v) => change({ period: v })}
            />
          </div>
          {clientOptions.length > 0 && (
            <div className={dropdownBox}>
              <Dropdown
                size="sm"
                ariaLabel="Client"
                options={clientOptions}
                value={clientFilter}
                onChange={(v) => change({ client: v })}
              />
            </div>
          )}
          <BoardCurrencyControl board={board} canManage={canManageColumns} compact />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={Download}
            onClick={exportCsv}
            disabled={visible.length === 0}
            title={`Download the invoices shown as a spreadsheet — amounts as entered${source ? `, in ${source}` : ''}`}
          >
            Export CSV
          </Button>
          {onNewInvoice && mayCreate && (
            <Button size="sm" icon={Plus} onClick={() => onNewInvoice()}>
              New invoice
            </Button>
          )}
        </div>
      </div>

      {/* ---- the strip ---- */}
      <section aria-label="Totals" className="flex flex-wrap gap-2.5">
        <Figure label="Billed" display={stripFigure(totals.billed)} pending={money.pending} />
        <Figure
          label="Received"
          display={stripFigure(totals.received)}
          tone={totals.received > 0 ? 'good' : undefined}
          sub={counts.partial > 0 ? `${counts.partial} part-paid` : null}
          pending={money.pending}
        />
        <Figure label="Outstanding" display={stripFigure(totals.outstanding)} pending={money.pending} />
        <Figure
          label={totals.overdueCount > 0 ? `Overdue · ${totals.overdueCount}` : 'Overdue'}
          display={stripFigure(totals.overdue)}
          tone={totals.overdueCount > 0 ? 'bad' : undefined}
          pending={money.pending}
        />
        {totals.drafts.count > 0 && (
          <Figure
            label={`Drafts · ${totals.drafts.count}`}
            display={stripFigure(totals.drafts.amount)}
            sub="Not sent yet"
            pending={money.pending}
          />
        )}
      </section>

      {notes.length > 0 && (
        <div className="flex flex-col" style={{ gap: 2, marginTop: 6 }}>
          {notes.map((n) => (
            <p key={n} className="font-body" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {n}
            </p>
          ))}
        </div>
      )}

      {/* ---- slice + sort ---- */}
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 14, marginBottom: 12 }}>
          <div role="group" aria-label="Show invoices" className="flex min-w-0 flex-wrap items-center gap-1.5">
            {LEDGER_QUICK_FILTERS.map((f) => (
              <QuickChip
                key={f.value}
                label={f.label}
                count={counts[f.value] || 0}
                active={quick.value === f.value}
                onClick={() => change({ quick: f.value })}
              />
            ))}
          </div>
          <div className="w-full sm:ml-auto sm:w-[176px]">
            <Dropdown
              size="sm"
              ariaLabel="Sort invoices"
              options={INVOICE_SORTS}
              value={view.sort}
              onChange={(v) => change({ sort: v })}
            />
          </div>
        </div>
      )}

      {boardEmpty && onClearPageFilters ? (
        // The board filter bar above hid every invoice. The first-run "Drop a
        // PDF" panel (or "No invoices on this board yet") would be a lie here,
        // and the reset below only knows about the ledger's own chips.
        <div
          className="flex flex-wrap items-center justify-center gap-2 text-center"
          style={{ padding: '36px 8px' }}
        >
          <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
            No invoices match the board filters.
          </p>
          <Button variant="ghost" size="sm" onClick={() => onClearPageFilters()}>
            Clear filters
          </Button>
        </div>
      ) : boardEmpty ? (
        mayCreate ? (
          <div
            className="flex flex-col items-center text-center"
            style={{
              marginTop: 14,
              gap: 10,
              padding: '36px 16px',
              border: '2px dashed var(--color-border-strong)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-bg-subtle)',
            }}
          >
            <Upload size={28} color="var(--color-accent)" aria-hidden="true" />
            <h3 className="font-display" style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              Drop a PDF or add an invoice
            </h3>
            <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 380 }}>
              {onDropFiles
                ? 'Drop invoice files anywhere here — each one becomes an invoice you can fill in and track until it is paid.'
                : 'Add an invoice to start tracking what you have billed and what has come in.'}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {onDropFiles && (
                <Button variant="secondary" size="sm" icon={Upload} onClick={openPicker}>
                  Choose files
                </Button>
              )}
              {onNewInvoice && (
                <Button size="sm" icon={Plus} onClick={() => onNewInvoice()}>
                  New invoice
                </Button>
              )}
            </div>
          </div>
        ) : (
          <p
            className="font-body text-center"
            style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '36px 0' }}
          >
            No invoices on this board yet.
          </p>
        )
      ) : (
        <>
          {visible.length === 0 && filtersActive && (
            <div
              className="flex flex-wrap items-center justify-center gap-2 text-center"
              style={{ padding: '20px 8px', marginBottom: 10 }}
            >
              <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                No invoices match these filters.
              </p>
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                Show all invoices
              </Button>
            </div>
          )}

          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(184px,1fr))]">
            {/* In-flight uploads lead the grid, where the eye already is. */}
            {uploadList.map((u) => (
              <UploadCard key={u.id} upload={u} onDismiss={onDismissUpload} onRetry={onRetryUpload} />
            ))}

            {visible.map((row) => (
              <InvoiceTile
                key={row.task._id}
                row={row}
                cols={cols}
                client={clientInfo(row.client)}
                owners={ownersOf(row.task)}
                sourceCurrency={sourceCurrency}
                onOpen={onOpenTask}
                onNotify={onNotifyTask}
                onMenu={onMenuTask}
                onPreview={openPreview}
                onStatus={statusControl}
              />
            ))}

            {acceptsDrops && (
              <button
                type="button"
                onClick={openPicker}
                className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{
                  border: '2px dashed var(--color-accent)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-accent-light)',
                  color: 'var(--color-accent-text)',
                  minHeight: 150,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: 12,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  textAlign: 'center',
                }}
              >
                <Upload size={20} aria-hidden="true" />
                <span className="font-body">Drop invoice files here</span>
                <span className="font-body" style={{ fontSize: 11, fontWeight: 500 }}>
                  or click to choose
                </span>
              </button>
            )}
          </div>
        </>
      )}

      {/* The picker, OUTSIDE every button: an input nested in a button is
          invalid, and some screen readers announced the pair as one control
          with two names. Hidden inputs are not focusable. */}
      {acceptsDrops && (
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={BOARD_UPLOAD_ACCEPT}
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            handleFiles(e.target.files);
            // Cleared so re-picking the SAME file fires change again.
            e.target.value = '';
          }}
        />
      )}

      {preview !== null && previewable[preview] && (
        <FilePreviewModal
          attachments={previewable}
          index={preview}
          onIndexChange={setPreview}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
};

export default LedgerView;
