import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Coins } from 'lucide-react';

import OptionMenu from '../ui/OptionMenu';
import useBoardStore from '../../store/boardStore';
import useOrgStore, { selectBaseCurrency } from '../../store/orgStore';
import useToastStore from '../../store/toastStore';
import { boardCurrencyState, currencyByCode, currencyOptions } from '../../utils/money';

/**
 * The menu value that means "follow the workspace" — sent to the server as
 * `currency: null`. A sentinel rather than null because the menu drops null
 * from its selection set, and the row has to be able to show as chosen.
 */
const WORKSPACE = '__workspace__';

/** "CA$ · CAD", or just "AED" where the symbol IS the code. */
const unitOf = (cur) => (cur ? (cur.symbol === cur.code ? cur.code : `${cur.symbol} · ${cur.code}`) : null);

/**
 * BOARD CURRENCY — the unit this board's money is in, said out loud.
 *
 * Until this existed a board's currency lived only in a column header menu, in
 * Table view, behind `column.manage`. The billing board opens on the Ledger,
 * whose four big figures never said what unit they were in, so a board whose
 * Amount column was still stamped INR read "₹" to a team billing in dollars
 * and nothing on screen said why or how to change it.
 *
 * ---- It FOLLOWS the workspace unless it is given its own --------------------
 *
 * A board with no currency of its own (`Board.currency` null — every board,
 * unless somebody chose otherwise) follows the workspace currency in Settings →
 * Currency, and moves with it: change the workspace from INR to CAD and every
 * following board reads CAD. The menu's first row, "Workspace currency (CAD)",
 * is that state; the catalog below it gives the board its OWN currency, which a
 * workspace change leaves alone. Picking the first row again puts an
 * overridden board back to following.
 *
 * The chip says which of the two it is — a muted "workspace" or "board
 * currency" beside the unit — because "CA$ · CAD" alone cannot tell an admin
 * whether the next workspace change will move this board or not.
 *
 * ---- It RELABELS, and says so before it does -------------------------------
 *
 * Changing the currency changes what the stored numbers MEAN, not the numbers.
 * An invoice typed as 1,000 while the board said INR still reads 1,000 after the
 * board says CAD. That is the right behaviour — the usual reason to change it
 * is that the figures were always dollars and the label was wrong — but it is
 * the opposite of what a currency switch does everywhere else, so the confirm
 * spells it out in capitals rather than trusting the word "relabel".
 *
 * Props:
 *   board      the board (reads `currency` and `columns`)
 *   canManage  shows the Change control — pass `column.manage` on this board,
 *              the same gate the server enforces
 *   compact    one small chip rather than a line of text, for a toolbar
 */
const BoardCurrencyControl = ({ board, canManage = false, compact = false }) => {
  const orgBase = useOrgStore(selectBaseCurrency);
  const toastSuccess = useToastStore((s) => s.success);
  const toastError = useToastStore((s) => s.error);
  const [anchor, setAnchor] = useState(null);
  const [saving, setSaving] = useState(false);
  const triggerRef = useRef(null);

  /**
   * following / code / workspace / stored / mixed / outOfStep — see
   * `boardCurrencyState`. `code` is the unit the figures are IN (the board's
   * columns), not the workspace's: on a following board the two agree once
   * the server's relabel has landed, and until then the label must name what
   * the cells actually print.
   *
   * `mixed` — possible on a board older than the board-level currency, where
   * one column was switched by hand. The label can only name one unit, so it
   * says when that is not the whole story; choosing a currency here puts every
   * column back in step.
   *
   * `outOfStep` — a following board whose money is not (yet) in the workspace
   * unit: an open board in the moment between a workspace change and its
   * refresh, or one the workspace relabel could not reach. Re-picking
   * "Workspace currency" is the fix, so it is never a no-op here.
   */
  const { following, code, workspace, stored, mixed, outOfStep } = useMemo(
    () => boardCurrencyState(board, orgBase),
    [board, orgBase]
  );
  const cur = currencyByCode(code);
  const unit = unitOf(cur);
  const flagged = mixed || outOfStep;

  /**
   * Out of step is also what a STALE workspace currency looks like. After an
   * admin moves the workspace to CAD, this tab refetches the board (the
   * server pings it) and its columns say CAD while the cached base still says
   * INR. Re-reading the base settles which it is — throttled in the store, so
   * a board that really is behind asks once per window, not per render.
   */
  const orgId = useOrgStore((s) => s.currentOrg?._id || null);
  useEffect(() => {
    if (outOfStep && orgId) useOrgStore.getState().recheckCurrency(orgId);
    // `code` too: a board whose columns moved again is a new question.
  }, [outOfStep, orgId, code]);

  /**
   * Is picking `next` a no-op? Only when the board ALREADY IS in that state and
   * nothing disagrees with it: following and in step for the workspace row, or
   * the same stored override for a code.
   *
   * Not "is it the code on the label". A board whose columns disagree shows a
   * code that a person picks precisely to make it true everywhere; skipping it
   * left the one control that fixes a mixed board unable to fix it without a
   * detour through some other currency first.
   */
  const isNoop = (next) =>
    next === WORKSPACE ? following && !flagged : next === stored && !mixed;

  const marker = following ? 'workspace' : 'board currency';
  const describe = unit
    ? `Amounts on this board are in ${cur.name} (${cur.code}), ${
        following ? 'the workspace currency' : "this board's own currency"
      }${
        outOfStep
          ? `. The workspace currency is ${workspace}; this board has not been relabelled to it yet`
          : mixed
            ? '. Some money columns use a different currency'
            : ''
      }`
    : 'This board has no currency set';

  const close = () => {
    setAnchor(null);
    // Hand focus back to the trigger when the menu took it with it (Escape, or
    // a pick) — but not when the person clicked somewhere that took focus.
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) triggerRef.current?.focus();
    });
  };

  const choose = async (next) => {
    if (!next || isNoop(next) || saving || !board?._id) return;
    const toWorkspace = next === WORKSPACE;
    const wsLabel = workspace ? ` (${workspace})` : '';
    // Re-picking the unit already on the label is "make it true everywhere",
    // and "Change this board's currency to CAD?" under a label reading CAD
    // would read as a mistake — so that case asks the question it is asking.
    const reapply = !toWorkspace && !following && next === code;
    const question = toWorkspace
      ? `This board will follow the workspace currency${wsLabel}. Amounts already entered are NOT converted.`
      : reapply
        ? `Put every money column on this board in ${next}? Columns in another currency are relabelled — amounts already entered are NOT converted.`
        : following
          ? `Give this board its own currency, ${next}? Every money column is relabelled ${next} and stays ${next} when the workspace currency changes. Amounts already entered are NOT converted.`
          : `Change this board's currency to ${next}? This relabels every money column on the board — amounts already entered are NOT converted.`;
    if (!window.confirm(question)) return;
    setSaving(true);
    try {
      const result = await useBoardStore
        .getState()
        .setBoardCurrency(board._id, toWorkspace ? null : next);
      const effective = result?.effective || (toWorkspace ? workspace : next);
      toastSuccess(
        toWorkspace
          ? `This board now follows the workspace currency${effective ? ` (${effective})` : ''}.`
          : reapply
            ? `Every money column on this board is now in ${next}.`
            : `Amounts on this board are now in ${next}, its own currency.`
      );
    } catch (err) {
      /**
       * `api.js` has already toasted a 5xx ("Something went wrong on our end")
       * and a request that got no answer at all ("Network error") — saying it a
       * second time here stacks two toasts for one failure. What is left to say
       * is a 4xx, whose reason the server puts in `error` (never `message`):
       * an invalid code, or no `column.manage` on this board.
       */
      const status = err?.response?.status;
      const toastedGlobally = status ? status >= 500 : !!err?.request;
      if (!toastedGlobally) {
        toastError(err?.response?.data?.error || "Couldn't change the board's currency");
      }
    } finally {
      setSaving(false);
    }
  };

  /**
   * The workspace row first — it is the default and what most boards should
   * be — then the catalog, each entry an explicit override. The catalog entry
   * that matches the workspace code is still offered: it is how a board is
   * pinned to CAD so that a later workspace change leaves it in CAD.
   */
  const options = useMemo(
    () => [
      {
        value: WORKSPACE,
        label: workspace ? `Workspace currency (${workspace})` : 'Workspace currency',
      },
      ...currencyOptions(),
    ],
    [workspace]
  );

  const menu = anchor ? (
    <OptionMenu
      anchorEl={anchor}
      title="Board currency"
      options={options}
      value={following ? WORKSPACE : stored}
      // Deferred a tick so the menu has closed before the confirm dialog
      // blocks the page — otherwise it sits open, frozen, under the question.
      onSelect={(v) => setTimeout(() => choose(v), 0)}
      onClose={close}
      width={260}
      ariaLabel="Board currency"
    />
  ) : null;

  // The element is read NOW, not inside the updater: React may run the updater
  // later, after the event has finished and `currentTarget` has been nulled,
  // which left every second click opening a menu with no anchor.
  const toggle = (e) => {
    const el = e.currentTarget;
    setAnchor((a) => (a ? null : el));
  };

  // The "workspace" / "board currency" marker: muted, and after the unit, so
  // the unit stays the first thing read.
  const markerEl = unit ? (
    <span
      style={{
        fontWeight: 500,
        color: 'var(--color-text-muted)',
      }}
    >
      {marker}
    </span>
  ) : null;

  if (compact) {
    const chipStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 8px',
      borderRadius: 9999,
      border: '1px solid var(--color-border)',
      background: 'var(--color-bg-subtle)',
      color: 'var(--color-text-secondary)',
      fontSize: 11.5,
      fontWeight: 600,
      lineHeight: 1.6,
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
      // A mixed or out-of-step board says so ON the chip, not only in its
      // tooltip: the Ledger strip and the Table both render this compact
      // form, and "CA$ · CAD" above figures printed in ₹ is exactly the
      // mislabelling this control exists to end. The Change menu stays one
      // click away — re-picking puts every money column back in step.
      ...(flagged && {
        border: '1px solid var(--color-status-working)',
        background: 'var(--color-status-working-bg)',
        color: 'var(--color-text-primary)',
      }),
    };
    const text = unit
      ? outOfStep
        ? `${unit} · workspace is ${workspace}`
        : mixed
          ? `${unit} · mixed`
          : unit
      : 'No currency';

    const body = (
      <>
        <Coins size={12} aria-hidden="true" />
        {text}
        {!outOfStep && markerEl}
      </>
    );

    if (!canManage) {
      return (
        <span className="font-body" style={chipStyle} title={describe}>
          {body}
        </span>
      );
    }
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          disabled={saving}
          aria-haspopup="listbox"
          aria-expanded={!!anchor}
          aria-label={`${describe}. Change currency`}
          title={describe}
          className="font-body transition-colors hover:border-[color:var(--color-border-strong)]"
          style={{ ...chipStyle, cursor: saving ? 'progress' : 'pointer', opacity: saving ? 0.6 : 1 }}
        >
          {body}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        {menu}
      </>
    );
  }

  return (
    <div
      className="font-body inline-flex flex-wrap items-center"
      style={{ gap: 6, fontSize: 12, color: 'var(--color-text-muted)' }}
    >
      <Coins size={13} aria-hidden="true" className="shrink-0" />
      <span title={describe}>
        {unit ? (
          <>
            Amounts in{' '}
            <strong style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>{unit}</strong>
            {' · '}
            {following ? 'follows the workspace' : "this board's own currency"}
            {outOfStep
              ? ` (not yet relabelled to ${workspace})`
              : mixed
                ? ' (some columns differ)'
                : ''}
          </>
        ) : (
          'No currency set'
        )}
      </span>
      {canManage && (
        <>
          <button
            ref={triggerRef}
            type="button"
            onClick={toggle}
            disabled={saving}
            aria-haspopup="listbox"
            aria-expanded={!!anchor}
            aria-label={
              unit
                ? `Change board currency, currently ${cur.code}${following ? ', following the workspace' : ''}`
                : 'Set board currency'
            }
            className="inline-flex items-center rounded hover:underline"
            style={{
              gap: 2,
              padding: '1px 2px',
              border: 'none',
              background: 'transparent',
              color: 'var(--color-accent-text)',
              fontSize: 12,
              fontWeight: 600,
              cursor: saving ? 'progress' : 'pointer',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : unit ? 'Change' : 'Set'}
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {menu}
        </>
      )}
    </div>
  );
};

export default BoardCurrencyControl;
