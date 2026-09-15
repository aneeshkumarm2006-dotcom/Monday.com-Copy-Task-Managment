import { useEffect, useRef } from 'react';
import { formatPct, stateMeta, barPct } from '../../../utils/adsBudgetDisplay';
import { formatMoney } from '../../../utils/connectorFormat';

/**
 * The small shared pieces of the Ads Budget tab.
 *
 * Together in one file rather than six, because each is under forty lines and
 * most are imported by both screens — the same arrangement `SectionShell` uses
 * for `Stat` / `StatRow` / `Th` / `Td`.
 */

/**
 * One headline number, as a white card.
 *
 * NOT `ui/StatCard`, which is the solid-colour tile used on the Dashboard and
 * the Delivery summary. Four saturated blocks are right for a page whose job is
 * to be glanced at across a room; they are wrong for a financial page whose
 * whole argument is restraint, where colour has to stay meaningful because it
 * is the only thing marking an overspend. Here the numbers are the emphasis and
 * the cards get out of their way.
 *
 * It is also why the figure is `font-display` at 26px rather than 36px: four of
 * these sit in a row above a page of tables, and a 36px number turns the
 * summary into the page.
 */
export const BudgetStat = ({ label, value, sub, subTone }) => (
  <div
    className="min-w-0"
    style={{
      background: 'var(--color-bg-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      padding: '16px 18px',
    }}
  >
    <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
      {label}
    </p>
    <p
      className="font-display font-bold mt-1.5 truncate"
      style={{ fontSize: 26, lineHeight: 1.15, color: 'var(--color-text-primary)' }}
      title={typeof value === 'string' ? value : undefined}
    >
      {value}
    </p>
    {sub ? (
      <p
        className="font-body mt-1.5 truncate"
        style={{ fontSize: 12, color: subTone || 'var(--color-text-muted)' }}
      >
        {sub}
      </p>
    ) : null}
  </div>
);

/**
 * The square beside a platform name.
 *
 * ---- Why it is a letter and not a logo -------------------------------------
 *
 * The brief asks for "a small platform icon/logo area, but the underlying
 * component must remain generic", and this tab must never learn the names of
 * the advertising networks it tracks. A registry of brand marks would be a
 * lookup table of vocabulary living in code — the one thing the tracker engine
 * is explicitly not allowed to grow — and every platform missing from it would
 * render as a hole. A letter works for Meta Ads, for OpenAI Ads, and for
 * whatever launches next month.
 *
 * ONE FLAT TREATMENT for every platform, not a colour hashed from the name.
 * Avatars used to hash a colour per person and it was deliberately deleted (see
 * utils/avatar.js) because it put two visual systems on one screen. A palette
 * keyed on platform names here would bring exactly that back, a few pixels from
 * the avatars that gave it up.
 */
export const PlatformMark = ({ name, size = 24 }) => {
  const letter = String(name || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      className="inline-flex items-center justify-center shrink-0 font-display font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-accent-light)',
        color: 'var(--color-accent-text)',
        fontSize: size * 0.45,
      }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
};

/**
 * A status, as coloured text rather than a pill.
 *
 * The pill is this app's usual treatment (`Chip`, `GoalOutcomeBadge`) and it is
 * deliberately not used here. A budget table is six numeric columns wide and is
 * read by scanning DOWN a column; a filled pill in the last one is a row of
 * bright rectangles that pulls the eye across instead. Plain text in the state's
 * colour says the same thing and lets the money stay the loudest thing on the
 * row — which is the whole brief.
 *
 * `stateMeta` still supplies the colour, so a status here and a chip elsewhere
 * can never disagree about what amber means.
 */
export const StatusText = ({ state, label, title }) => {
  const meta = stateMeta(state, label);
  const quiet = state === 'draft' || state === 'paused' || state === 'unset';
  return (
    <span
      className="font-body whitespace-nowrap"
      title={title}
      style={{ fontSize: 13, fontWeight: quiet ? 400 : 500, color: meta.color }}
    >
      {meta.label}
    </span>
  );
};

/**
 * The utilisation bar.
 *
 * A div, not a charting library — the house pattern, copied from
 * `GoalProgressBar`. It fills in the ACCENT rather than in the row's state
 * colour: there is exactly one bar on the page, directly under a percentage and
 * a pacing verdict that are already carrying the judgement, and a bar that
 * turns amber says the same thing a third time. Over budget is the exception —
 * a bar that has run past its own track has to look like it.
 *
 * It fills to 100 and stops. A bar overflowing its track reads as a rendering
 * fault rather than as bad news, and the figures beside it carry the overage.
 */
export const BudgetBar = ({ usedPct, state, label, height = 8, marker = null }) => {
  const meta = stateMeta(state, label);
  const filled = barPct(usedPct);
  const text =
    typeof usedPct === 'number' && Number.isFinite(usedPct)
      ? `${meta.label} — ${(usedPct * 100).toFixed(1)}% of budget used`
      : 'Nothing budgeted yet';

  // Where "today" sits on the same track (elapsed fraction of the month,
  // 0..1). Fill ahead of the tick = spending faster than the calendar; fill
  // behind it = slower. The tick is what makes the bar a PACING bar rather
  // than a spend bar. Hidden at the extreme ends, where it would just overlap
  // the track's rounded caps and say nothing.
  const markerPct =
    typeof marker === 'number' && Number.isFinite(marker) && marker > 0.02 && marker < 0.98
      ? marker * 100
      : null;

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(filled)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={text}
      title={markerPct === null ? text : `${text} · ${markerPct.toFixed(0)}% of the month elapsed`}
      style={{
        position: 'relative',
        height,
        width: '100%',
        minWidth: 48,
        background: 'var(--color-bg-subtle)',
        borderRadius: 'var(--radius-full)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${filled}%`,
          height: '100%',
          background: state === 'over' ? 'var(--color-status-stuck)' : 'var(--color-accent)',
          borderRadius: 'var(--radius-full)',
          transition: 'width 200ms ease-out',
        }}
      />
      {markerPct !== null && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${markerPct}%`,
            width: 2,
            marginLeft: -1,
            borderRadius: 1,
            background: 'var(--color-text-primary)',
            opacity: 0.55,
          }}
        />
      )}
    </div>
  );
};

/**
 * THE PACING PANEL — spend against budget for one month, as one block.
 *
 * ---- WHY IT LIVES HERE AND NOT IN `BudgetOverviewCard` --------------------
 *
 * Two surfaces draw this exact block and neither may be allowed to drift from
 * the other: the Ads Budget tab's overview card (where it is the left of two
 * panels) and the executive home page's `adsBudgetPacing` tile (where it is the
 * whole tile, because the card's RIGHT panel counts PLATFORMS and the home
 * composer ships no platform rows — four confident zeroes under "Budget health"
 * would be an absence rendered as a measurement).
 *
 * It was copied once, and one sentence had already drifted apart by a capital
 * letter before anybody noticed. That is the cheap version of the failure; the
 * expensive one is the day somebody fixes the projection wording, or the rule
 * about which colour a forecast may be painted in, on one of the two copies.
 * Both surfaces report MONEY, and two screens in one app quoting the same month
 * differently is not a cosmetic bug.
 *
 * So: one component, two callers, and the differences between them expressed as
 * props rather than as a second copy.
 *
 *   `framed`    draws the white card chrome. The tab needs it (the panel IS the
 *               card); the home tile does not — `SectionFrame` already drew one,
 *               and a card inside a card is a border nobody asked for.
 *   `note`      an extra clause in front of the days-remaining line, middot
 *               separated. The home tile says how many platforms are behind the
 *               number; the tab has a table of them directly underneath.
 *   `className` merged onto the root, so the tab keeps its grid placement
 *               (`lg:col-span-2`) without a wrapper element appearing between
 *               the grid and its child.
 *
 * ---- WHY THE PROJECTION AND THE VERDICT CAN DISAGREE ----------------------
 *
 * They measure different things and the labels say so. "Healthy pacing" is
 * about the drift SO FAR: spend is within a band of the fraction of the month
 * that has elapsed. "Over budget by X at this rate" is about the FINISH: a
 * straight-line run rate carried to month end. A month can be inside the band
 * today and still finish over, and the two lines sitting apart — projection
 * top-right, verdict bottom-left — is what keeps that legible rather than
 * contradictory.
 *
 * NOTHING HERE COMPUTES EITHER ONE. `utils/adsBudgetPacing.js` does, once, on
 * the server; this draws `rollUp(...)`'s answer and the window it measured.
 */
export const BudgetPacingPanel = ({
  totals = {},
  window: win = null,
  currency,
  note = null,
  framed = true,
  className = '',
}) => {
  const meta = stateMeta(totals.state, totals.label);
  const money = (v) => formatMoney(v, currency);

  /**
   * Over or under, at the current rate. Null when too little of the month has
   * run for a run rate to mean anything — the server returns `projected: null`
   * rather than dividing by zero elapsed days, and a month that has not started
   * must not be painted as finishing over.
   */
  const overBy =
    typeof totals.projected === 'number' && totals.allocated > 0
      ? totals.projected - totals.allocated
      : null;

  const remaining =
    win && win.remainingDays > 0
      ? `${win.remainingDays} day${win.remainingDays === 1 ? '' : 's'} remaining`
      : 'This month is over';

  return (
    <div
      className={['flex flex-col gap-4', className].filter(Boolean).join(' ')}
      style={
        framed
          ? {
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            padding: '18px 20px',
          }
          : undefined
      }
    >
      <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
        <div className="min-w-0">
          <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
            Budget utilized
          </p>
          <p
            className="font-display font-bold mt-1"
            style={{ fontSize: 28, lineHeight: 1.1, color: 'var(--color-text-primary)' }}
          >
            {formatPct(totals.usedPct)}
          </p>
          <p className="font-body mt-1 tabular-nums" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
            {money(totals.spent)} / {money(totals.allocated)}
          </p>
        </div>

        <div className="min-w-0">
          <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
            Projected month-end
          </p>
          <p
            className="font-display font-bold mt-1"
            style={{ fontSize: 28, lineHeight: 1.1, color: 'var(--color-text-primary)' }}
          >
            {/* `== null` on purpose: the server sends null, and a fixture or an
                older payload can leave the key off entirely. An em dash is the
                right answer to both. */}
            {totals.projected == null ? '—' : money(totals.projected)}
          </p>
          {/* Green under, amber over — never red. Red is reserved for money
              ALREADY spent past the budget; this is a forecast, and a forecast
              painted as a failure stops being read as a forecast. */}
          <p
            className="font-body mt-1"
            style={{
              fontSize: 12.5,
              color:
                overBy === null
                  ? 'var(--color-text-muted)'
                  : overBy > 0
                    ? 'var(--color-status-working)'
                    : 'var(--color-status-done)',
            }}
          >
            {overBy === null
              ? 'Not enough of the month has run'
              : overBy > 0
                ? `Over budget by ${money(overBy)} at this rate`
                : `Under budget by ${money(Math.abs(overBy))} at this rate`}
          </p>
        </div>
      </div>

      <BudgetBar
        usedPct={totals.usedPct}
        state={totals.state}
        label={totals.label}
        /* The tick is where "today" sits on the same track. It is what makes
           this a PACING bar rather than a spend bar: fill ahead of the tick is
           spending faster than the calendar. */
        marker={win?.elapsedPct}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-body font-medium" style={{ fontSize: 13, color: meta.color }}>
          {totals.verdict}
        </span>
        <span className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
          {[note, remaining].filter(Boolean).join(' · ')}
        </span>
      </div>
    </div>
  );
};

/**
 * A section card, with a header and optional actions.
 *
 * `SectionShell` from the connector tab is the same idea, but it is welded to a
 * snapshot: it renders its children only when `snapshot.data` exists and stamps
 * a "collected N days ago" line nobody here has an answer for. These sections
 * are hand-entered and always current, so this is the same frame with the
 * provenance furniture removed — and with the heading OUTSIDE the card, which
 * is what lets the tables sit flush to their own borders.
 */
export const Section = ({ title, description, actions, children }) => (
  <section>
    <header className="flex flex-wrap items-end gap-3 mb-3">
      <div className="flex-1 min-w-0">
        <h3
          className="font-display font-semibold"
          style={{ fontSize: 15, color: 'var(--color-text-primary)' }}
        >
          {title}
        </h3>
        {description ? (
          <p className="font-body mt-0.5" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </header>
    <div
      style={{
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  </section>
);

/** The house "outlined mini button", copied from GoalGroupSection's header. */
export const MiniButton = ({ icon: Icon, onClick, children, title, disabled = false }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    disabled={disabled}
    className="inline-flex items-center gap-1 font-body shrink-0 transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      fontSize: 12.5,
      fontWeight: 500,
      padding: '6px 11px',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--color-border-strong)',
      background: 'var(--color-bg-surface)',
      color: 'var(--color-text-secondary)',
      opacity: disabled ? 0.5 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }}
  >
    {Icon ? <Icon size={13} aria-hidden="true" /> : null}
    {children}
  </button>
);

/** A lighter in-card empty state than `EmptyState`, for one section. */
export const SectionEmpty = ({ icon: Icon, children, actionLabel, onAction }) => (
  <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
    {Icon ? <Icon size={20} color="var(--color-text-muted)" aria-hidden="true" /> : null}
    <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
      {children}
    </p>
    {actionLabel && onAction ? (
      <button
        type="button"
        onClick={onAction}
        className="font-body"
        style={{ fontSize: 13, color: 'var(--color-accent)', background: 'none', border: 'none', cursor: 'pointer' }}
      >
        {actionLabel}
      </button>
    ) : null}
  </div>
);

/**
 * The ⋯ popover in the page header.
 *
 * Click-outside and Escape close it, copied from `TaskActionsMenu` — the
 * behaviour people already expect from every other ⋯ in this app. It holds the
 * exports, which are real but not the reason anybody opens this page; leaving
 * two download buttons in the header made the one button that matters — Add
 * Budget — compete with them.
 */
export const OverflowMenu = ({ open, onClose, children }) => {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose?.();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="menu"
      className="bg-white"
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        right: 0,
        zIndex: 50,
        minWidth: 200,
        padding: 6,
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      {children}
    </div>
  );
};

export const MenuItem = ({ icon: Icon, onClick, children }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    className="w-full flex items-center gap-2 text-left font-body transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      fontSize: 13,
      padding: '7px 9px',
      borderRadius: 'var(--radius-sm)',
      background: 'transparent',
      border: 'none',
      color: 'var(--color-text-primary)',
      cursor: 'pointer',
    }}
  >
    {Icon ? <Icon size={14} aria-hidden="true" color="var(--color-text-muted)" /> : null}
    {children}
  </button>
);
