import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, Coins, KeyRound, Layers, Loader2, RefreshCw, Trash2,
} from 'lucide-react';

import useOrgStore from '../../store/orgStore';
import useBoardStore from '../../store/boardStore';
import useFxStore from '../../store/fxStore';
import { refreshRates } from '../../services/fxService';
import { listMoneyBoards } from '../../services/orgService';
import useToastStore from '../../store/toastStore';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import { SelectField } from '../ui/FormControls';
import { currencyByCode, currencyOptions, DISPLAY_CURRENCIES } from '../../utils/money';

/**
 * WHAT THIS WORKSPACE'S MONEY IS IN, AND WHERE ITS RATES COME FROM.
 *
 * Three settings that look like one and are not:
 *
 *   `baseCurrency` is a fact about the BUSINESS — "we bill in CAD". Every
 *   board FOLLOWS it unless it has been given a currency of its own
 *   (`Board.currency` null), and following boards move with it: change the
 *   workspace from INR to CAD and the server relabels every following board's
 *   money columns CAD in the same save. New boards are born following.
 *
 *   A board's OWN currency is an explicit override — the agency's one client
 *   who pays in USD. A workspace change leaves it alone. It is set from the
 *   board's currency control, and undone ("Follow workspace") from either that
 *   control or the list on this screen.
 *
 *   What somebody READS amounts in is a personal choice, made from the menu
 *   under their avatar. It converts what they see and changes nothing stored.
 *
 * The FX block is plumbing: who we ask about exchange rates, how often, and
 * with whose credential.
 *
 * ---- Relabel, never convert -------------------------------------------------
 *
 * Every currency change in this product RELABELS: a figure typed as 1,000
 * reads 1,000 afterwards, only its currency changes. That is what an admin
 * switching the workspace to CAD almost always means — the figures were always
 * dollars and only the label was wrong — but it is the opposite of what a
 * currency switch does everywhere else, so every confirm on this screen says
 * so in plain words before anything is saved.
 *
 * ---- Why the manual bulk relabel is gone -----------------------------------
 *
 * This screen used to list every board "still in another currency" after a
 * workspace change and offer to relabel the ones an admin ticked. Following
 * boards are relabelled automatically now, so that list would only ever show
 * the boards that deliberately kept their own currency — and offering to
 * relabel THOSE to the workspace's code would have pinned them to it rather
 * than putting them back to following. What remains is the honest version: the
 * boards with their own currency, each with "Follow workspace".
 */

const PROVIDERS = [
  {
    value: 'frankfurter',
    label: 'Frankfurter — free, no key needed',
    blurb:
      'Published by central banks, updated every business day. No account, no quota, no key. This is the default and it is enough for almost everyone.',
    needsKey: false,
  },
  {
    value: 'exchangerate-api',
    label: 'ExchangeRate-API — needs your key',
    blurb:
      'Use this if you already pay for an ExchangeRate-API account and would rather rates came from it. Paste the key below.',
    needsKey: true,
  },
];

const CADENCES = [
  { value: 'monthly', label: 'Monthly — one rate per month' },
  { value: 'daily', label: 'Daily — follow the market' },
];

/**
 * "CA$ · CAD", or just "AED" where the catalog's symbol IS the code, or the
 * bare stored code for one the catalog does not carry — never a borrowed
 * symbol. The same rule `BoardCurrencyControl` labels a board with, so a board
 * reads the same here as it does on its own page.
 */
const unitLabel = (code) => {
  const cur = currencyByCode(code);
  if (!cur) return code ? String(code).toUpperCase() : 'No currency';
  return cur.symbol === cur.code ? cur.code : `${cur.symbol} · ${cur.code}`;
};

/** Canonical code, so a legacy 'cad' is not listed as "different from CAD". */
const canonical = (code) => currencyByCode(code)?.code || (code ? String(code).toUpperCase() : null);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A listed board's unit and whether it follows. `effective` is the contract's
 * name for the resolved unit and `currency` the older one; `following` is
 * trusted only when the server actually said so, so a server too old to send
 * it lists every board as having its own currency — the conservative reading,
 * since it offers "Follow workspace" rather than claiming a board already does.
 */
const unitOfRow = (b) => canonical(b.effective || b.currency);
const followsOfRow = (b) => b.following === true;

const SectionTitle = ({ icon: Icon, children, hint }) => (
  <div style={{ marginBottom: 12 }}>
    <h3
      className="font-body flex items-center gap-2"
      style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}
    >
      {Icon ? <Icon size={15} style={{ color: 'var(--color-text-muted)' }} /> : null}
      {children}
    </h3>
    {hint ? (
      <p
        className="font-body"
        style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4, lineHeight: 1.55 }}
      >
        {hint}
      </p>
    ) : null}
  </div>
);

const Card = ({ children }) => (
  <div
    style={{
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-bg-elevated, var(--color-bg))',
      padding: 16,
      marginBottom: 16,
    }}
  >
    {children}
  </div>
);

const Muted = ({ children, style }) => (
  <p
    className="font-body"
    style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.55, ...style }}
  >
    {children}
  </p>
);

/** The accent-tinted status line — what a save just did, said once. */
const StatusNote = ({ children, tone = 'accent' }) => (
  <div
    className="font-body"
    role="status"
    style={{
      fontSize: 12.5,
      lineHeight: 1.55,
      color: tone === 'warn' ? 'var(--color-text-primary)' : 'var(--color-accent-text)',
      background: tone === 'warn' ? 'var(--color-status-working-bg)' : 'var(--color-accent-light)',
      borderRadius: 'var(--radius-sm)',
      padding: '8px 10px',
      marginBottom: 12,
    }}
  >
    {children}
  </div>
);

/** The "relabels, does not convert" paragraph every confirm here carries. */
const RelabelNotConvert = ({ code }) => (
  <p>
    This <strong style={{ color: 'var(--color-text-primary)' }}>relabels</strong>; it does{' '}
    <strong style={{ color: 'var(--color-text-primary)' }}>not convert</strong>. A figure typed as
    1,000 still reads 1,000 afterwards — only its currency changes
    {code ? <> to {code}</> : null}.
  </p>
);

/**
 * The boards in this workspace that hold money, and how each relates to the
 * workspace currency.
 *
 *   following, in step     counted in one line — nothing to do, which is the
 *                          point of following
 *   following, NOT in step listed as a warning with "Relabel to CAD": the
 *                          workspace relabel could not reach it (it failed on
 *                          the server, or the board changed underneath it).
 *                          Never expected; there so it is never invisible
 *   own currency           listed, each with "Follow workspace" — the only
 *                          way a board comes back to following from here
 *
 * ---- Why the run is SEQUENTIAL, one board at a time ------------------------
 *
 * Each board is its own `PATCH /api/boards/:id/currency` (`currency: null`),
 * gated on `column.manage` on THAT board. A bulk endpoint would have to answer
 * "some of these you may change and some you may not" in one response; one
 * call per board makes each result the server's own verdict on that board,
 * which is exactly what the per-row status shows. Sequential so a workspace
 * with forty boards does not fire forty writes at once, and so the rows tick
 * over in the order the admin reads them.
 *
 * ---- Why a board that now follows stays on the list ------------------------
 *
 * A strict filter would drop it the instant it succeeded, leaving the admin a
 * shorter list and no record of what just happened. It stays, marked, until
 * the list is next loaded.
 */
const WorkspaceBoards = ({ orgId, base }) => {
  const toastSuccess = useToastStore((s) => s.success);
  const toastError = useToastStore((s) => s.error);

  const [boards, setBoards] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [results, setResults] = useState({});
  const [running, setRunning] = useState(false);
  /** The boards a confirm is open for, or null. */
  const [confirming, setConfirming] = useState(null);
  const ticket = useRef(0);

  const load = useCallback(async () => {
    if (!orgId) return;
    const mine = ++ticket.current;
    setLoadError(null);
    try {
      const list = await listMoneyBoards(orgId);
      if (mine !== ticket.current) return;
      setBoards(list);
    } catch (err) {
      if (mine !== ticket.current) return;
      setBoards([]);
      setLoadError(err?.response?.data?.error || 'Could not load the boards that hold money.');
    }
  }, [orgId]);

  // A new base currency moves every following board, so the list is re-read;
  // a finished row's "now follows" mark belongs to the list it was made on.
  // `base` changes only once the save has answered — the server relabels the
  // following boards inside that request — so this read sees them relabelled.
  useEffect(() => {
    setResults({});
    load();
  }, [load, base]);

  const baseCode = canonical(base);

  // Sections are decided by what the server said `following` was when the list
  // was read — a row changed from here keeps its `following` as loaded (see
  // `run`), so it stays in the section it was actioned in until the next load.
  const { inStep, behind, own } = useMemo(() => {
    const list = boards || [];
    const following = list.filter(followsOfRow);
    const isBehind = (b) => (baseCode && unitOfRow(b) !== baseCode) || !!b.mixed;
    return {
      inStep: following.filter((b) => !isBehind(b) && !results[b._id]),
      behind: following.filter((b) => isBehind(b) || results[b._id]),
      own: list.filter((b) => !followsOfRow(b)),
    };
  }, [boards, baseCode, results]);

  /** What "Follow workspace on all" would run: own-currency boards you may change, not yet done. */
  const actionable = own.filter((b) => b.canManage && !results[b._id]?.ok && !results[b._id]?.pending);

  const run = async (queue) => {
    setConfirming(null);
    if (!queue?.length) return;
    setRunning(true);
    let ok = 0;
    for (const board of queue) {
      const from = unitOfRow(board);
      setResults((r) => ({ ...r, [board._id]: { pending: true, from } }));
      try {
        const res = await useBoardStore.getState().setBoardCurrency(board._id, null);
        const now = canonical(res?.effective) || baseCode;
        ok += 1;
        setResults((r) => ({ ...r, [board._id]: { ok: true, from } }));
        setBoards((list) =>
          (list || []).map((b) =>
            // `following` is left as loaded on purpose — it decides the
            // section, and a row must not jump sections under the admin's eye.
            b._id === board._id ? { ...b, effective: now, currency: now, mixed: false } : b
          )
        );
      } catch (err) {
        setResults((r) => ({
          ...r,
          [board._id]: {
            ok: false,
            from,
            error:
              err?.response?.data?.error
              || err?.response?.data?.message
              || 'Could not change this board.',
          },
        }));
      }
    }
    setRunning(false);

    const failed = queue.length - ok;
    if (failed === 0) {
      toastSuccess(
        queue.length === 1
          ? `${queue[0].name} now follows the workspace currency (${baseCode}).`
          : `${plural(ok, 'board')} now follow the workspace currency (${baseCode}).`
      );
    } else if (ok === 0) {
      toastError(
        queue.length === 1
          ? `${queue[0].name} could not be changed — see the list.`
          : `None of the ${plural(queue.length, 'board')} could be changed — see the list.`
      );
    } else {
      toastError(`${ok} of ${queue.length} boards now follow the workspace. ${failed} could not be changed — see the list.`);
    }
  };

  const rowStatus = (b, doneLabel) => {
    const result = results[b._id];
    if (result?.pending) {
      return (
        <span className="shrink-0 inline-flex items-center gap-1" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          Relabelling…
        </span>
      );
    }
    if (result?.ok) {
      return (
        <span className="shrink-0 inline-flex items-center gap-1" style={{ fontSize: 11.5, color: 'var(--color-status-done)' }}>
          <Check size={12} aria-hidden="true" />
          {doneLabel}
        </span>
      );
    }
    return null;
  };

  const rowAction = (b, label) => {
    const result = results[b._id];
    if (result?.pending || result?.ok) return null;
    return (
      <Button
        variant="secondary"
        size="sm"
        disabled={running || !b.canManage || !baseCode}
        onClick={() => setConfirming([b])}
        // The reason sits in the tooltip AND the accessible name: a disabled
        // button fires no mouse events in some browsers, so a tooltip alone
        // would never reach the person it is for.
        title={
          !b.canManage
            ? "You can't change this board's columns. Ask its owner, or someone who manages it."
            : undefined
        }
        aria-label={
          b.canManage
            ? `${label}: ${b.name}`
            : `${label}: ${b.name} — you can't change this board`
        }
      >
        {label}
      </Button>
    );
  };

  const renderRow = (b, i, { label, doneLabel, warn = false }) => {
    const result = results[b._id];
    const done = !!result?.ok;
    return (
      <li
        key={b._id}
        className="flex items-center flex-wrap gap-x-3 gap-y-1 px-3 py-2 font-body"
        style={{
          borderTop: i === 0 ? 'none' : '1px solid var(--color-border)',
          fontSize: 13,
          color: 'var(--color-text-primary)',
        }}
      >
        <span className="min-w-0 truncate" style={{ flex: '1 1 160px', fontWeight: 500 }}>
          {b.name}
        </span>
        <span
          className="shrink-0 tabular-nums"
          style={{ fontSize: 12, color: warn ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}
        >
          {done ? (
            <>
              {unitLabel(result.from)} → <strong style={{ fontWeight: 600 }}>{unitLabel(unitOfRow(b))}</strong>
            </>
          ) : (
            <>
              {unitLabel(unitOfRow(b))}
              {b.mixed ? ' · some columns differ' : ''}
            </>
          )}
        </span>
        <span className="shrink-0" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
          {plural(b.moneyColumns, 'money column')}
        </span>
        {rowStatus(b, doneLabel)}
        {rowAction(b, label)}
        {result && result.ok === false ? (
          <span
            className="inline-flex items-center gap-1"
            style={{ fontSize: 11.5, color: 'var(--color-status-stuck)', flexBasis: '100%' }}
          >
            <AlertTriangle size={12} aria-hidden="true" />
            {result.error}
          </span>
        ) : null}
      </li>
    );
  };

  const listStyle = {
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    overflow: 'hidden',
  };

  const subheading = (text) => (
    <h4
      className="font-body"
      style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', margin: '14px 0 6px' }}
    >
      {text}
    </h4>
  );

  const confirmTitle = confirming
    ? confirming.length === 1
      ? `Make “${confirming[0].name}” follow the workspace?`
      : `Make ${plural(confirming.length, 'board')} follow the workspace?`
    : '';
  const confirmAction = confirming
    ? confirming.length === 1
      ? 'Follow workspace'
      : `Make ${plural(confirming.length, 'board')} follow`
    : '';

  return (
    <Card>
      <SectionTitle
        icon={Layers}
        hint={`Every board follows the workspace currency (${baseCode || '…'}) unless it has been given its own. Following boards change with it automatically; boards with their own currency keep it.`}
      >
        Boards and the workspace currency
      </SectionTitle>

      {boards === null ? (
        <div className="flex items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          <span className="font-body" style={{ fontSize: 12.5 }}>Looking for boards…</span>
        </div>
      ) : loadError ? (
        <div className="flex items-center gap-3 flex-wrap">
          <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-status-stuck)' }}>
            {loadError}
          </p>
          <Button variant="secondary" size="sm" onClick={load}>
            Try again
          </Button>
        </div>
      ) : boards.length === 0 ? (
        <Muted>No board in this workspace holds money yet.</Muted>
      ) : (
        <>
          <p
            className="font-body flex items-center gap-2"
            style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}
          >
            <Check size={14} aria-hidden="true" style={{ color: 'var(--color-status-done)' }} />
            {inStep.length === 0
              ? 'No board with money on it follows the workspace right now.'
              : `${plural(inStep.length, 'board')} with money on ${inStep.length === 1 ? 'it follows' : 'them follow'} the workspace and ${inStep.length === 1 ? 'reads' : 'read'} ${unitLabel(baseCode)}.`}
          </p>

          {behind.length > 0 ? (
            <>
              {subheading('Following, but not relabelled yet')}
              <Muted style={{ marginBottom: 6 }}>
                These follow the workspace but still show another currency — the automatic relabel
                could not reach them. Relabel them to {baseCode}; amounts are not converted.
              </Muted>
              <ul style={listStyle}>
                {behind.map((b, i) =>
                  renderRow(b, i, { label: `Relabel to ${baseCode}`, doneLabel: 'Relabelled', warn: true })
                )}
              </ul>
            </>
          ) : null}

          {subheading('Boards with their own currency')}
          {own.length === 0 ? (
            <Muted>
              None — every board with money follows the workspace currency.
            </Muted>
          ) : (
            <>
              <ul style={listStyle}>
                {own.map((b, i) =>
                  renderRow(b, i, { label: 'Follow workspace', doneLabel: 'Follows the workspace' })
                )}
              </ul>
              <div className="flex items-center gap-3 flex-wrap" style={{ marginTop: 12 }}>
                {actionable.length > 1 ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={running || !baseCode}
                    onClick={() => setConfirming(actionable)}
                  >
                    {running ? 'Relabelling…' : `Make all ${actionable.length} follow the workspace`}
                  </Button>
                ) : null}
                <Muted>
                  A workspace change leaves these alone. &ldquo;Follow workspace&rdquo; relabels a
                  board to {baseCode || 'the workspace currency'} and keeps it in step from then on.
                  Amounts are not converted.
                </Muted>
              </div>
            </>
          )}
        </>
      )}

      <Modal
        isOpen={!!confirming}
        onClose={() => setConfirming(null)}
        title={confirmTitle}
        maxWidth={480}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button onClick={() => run(confirming)}>{confirmAction}</Button>
          </>
        }
      >
        <div className="font-body flex flex-col gap-3" style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--color-text-secondary)' }}>
          <p>
            Every money column on {confirming?.length === 1 ? 'this board' : 'these boards'} will be
            marked as <strong style={{ color: 'var(--color-text-primary)' }}>{unitLabel(baseCode)}</strong>,
            and {confirming?.length === 1 ? 'it' : 'they'} will change with the workspace currency
            from now on.
          </p>
          <RelabelNotConvert code={baseCode} />
          {confirming && confirming.length > 1 ? (
            <ul style={{ paddingLeft: 18, listStyle: 'disc', color: 'var(--color-text-primary)' }}>
              {confirming.slice(0, 6).map((b) => (
                <li key={b._id}>
                  {b.name}{' '}
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    ({unitLabel(unitOfRow(b))} → {baseCode})
                  </span>
                </li>
              ))}
              {confirming.length > 6 ? (
                <li style={{ color: 'var(--color-text-muted)' }}>
                  and {plural(confirming.length - 6, 'more board')}
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      </Modal>
    </Card>
  );
};

const CurrencyTab = () => {
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const currency = useOrgStore((s) => s.currency);
  const ensureCurrency = useOrgStore((s) => s.ensureCurrency);
  const saveCurrency = useOrgStore((s) => s.saveCurrency);
  // `fetchCurrency`, not `ensureCurrency` — the latter is a no-op once loaded,
  // so it would never pick up the new `lastFetchAt` after a manual refresh.
  const fetchCurrency = useOrgStore((s) => s.fetchCurrency);
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);
  const reloadRates = useFxStore((s) => s.reload);

  const orgId = currentOrg?._id || null;
  const [busy, setBusy] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  /** The workspace currency waiting on the confirm, or null. */
  const [pendingBase, setPendingBase] = useState(null);
  /**
   * What the last base-currency save did, from the server's reply:
   * `{ code, from, count, failed }` — so the screen can say it ("3 boards that
   * follow the workspace now read CAD") rather than leave the admin to infer
   * it. `count` null means the server said nothing about boards.
   */
  const [lastChange, setLastChange] = useState(null);

  useEffect(() => {
    if (orgId) ensureCurrency(orgId);
  }, [orgId, ensureCurrency]);

  // A note about the previous workspace is not about this one.
  useEffect(() => {
    setLastChange(null);
    setPendingBase(null);
  }, [orgId]);

  // One writer for every control on the screen, so the busy state, the error
  // toast and the store replacement cannot drift apart between them. Resolves
  // to the store's `{ currency, relabelled }`, or null when the save failed.
  const save = async (patch, field, message) => {
    if (!orgId) return null;
    setBusy(field);
    try {
      const result = await saveCurrency(orgId, patch);
      if (message) toastSuccess(typeof message === 'function' ? message(result) : message);
      return result || {};
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not save that.');
      return null;
    } finally {
      setBusy('');
    }
  };

  const changeBase = async () => {
    const next = pendingBase;
    setPendingBase(null);
    if (!next) return;
    const from = canonical(currency?.baseCurrency);
    const code = canonical(next);
    const result = await save({ baseCurrency: next }, 'baseCurrency', (r) => {
      const n = r?.relabelled?.count || 0;
      return n > 0
        ? `The workspace currency is now ${code}. ${plural(n, 'board')} relabelled.`
        : `The workspace currency is now ${code}.`;
    });
    if (!result) return;
    setLastChange({
      code,
      from,
      count: result.relabelled ? result.relabelled.count : null,
      failed: result.relabelled?.failed?.length || 0,
    });
  };

  if (!currency) {
    return (
      <div className="flex items-center gap-2 py-8" style={{ color: 'var(--color-text-muted)' }}>
        <Loader2 size={15} className="animate-spin" />
        <span className="font-body" style={{ fontSize: 13 }}>
          Loading currency settings…
        </span>
      </div>
    );
  }

  const provider = PROVIDERS.find((p) => p.value === currency.provider) || PROVIDERS[0];
  const baseCode = canonical(currency.baseCurrency);
  const pendingCode = canonical(pendingBase);

  return (
    <div style={{ maxWidth: 620 }}>
      <Card>
        <SectionTitle
          icon={Coins}
          hint="The currency every board follows unless it has been given its own. Changing it relabels every following board to the new currency — amounts already entered are kept exactly as typed, never converted. New boards follow it too."
        >
          Workspace currency
        </SectionTitle>

        {lastChange && lastChange.code === baseCode ? (
          <StatusNote>
            {lastChange.count === null
              ? `The workspace currency is now ${lastChange.code}. Boards that follow the workspace now read ${lastChange.code}.`
              : lastChange.count > 0
                ? `${plural(lastChange.count, 'board')} that ${lastChange.count === 1 ? 'follows' : 'follow'} the workspace now ${lastChange.count === 1 ? 'reads' : 'read'} ${lastChange.code}${lastChange.from ? ` instead of ${lastChange.from}` : ''}. Their amounts were relabelled, not converted — a figure typed as 1,000 still reads 1,000.`
                : `The workspace currency is now ${lastChange.code}. No following board needed relabelling.`}
          </StatusNote>
        ) : null}
        {lastChange && lastChange.code === baseCode && lastChange.failed > 0 ? (
          <StatusNote tone="warn">
            {`${plural(lastChange.failed, 'following board')} could not be relabelled to ${lastChange.code}. Any you can see are listed below under “Following, but not relabelled yet” — relabel ${
              lastChange.failed === 1 ? 'it' : 'them'
            } from there.`}
          </StatusNote>
        ) : null}

        <div style={{ maxWidth: 300 }}>
          <SelectField
            label="Workspace currency"
            value={currency.baseCurrency}
            disabled={busy === 'baseCurrency'}
            onChange={(e) => {
              const next = e.target.value;
              if (!next || canonical(next) === baseCode) return;
              // Not saved yet: this relabels every following board, which
              // deserves a question before it happens, not a toast after.
              setPendingBase(next);
            }}
            options={currencyOptions()}
          />
        </div>

        <Muted style={{ marginTop: 10 }}>
          What each person READS amounts in is their own choice, from the menu under their avatar:
          anyone can have figures converted to {DISPLAY_CURRENCIES.join(', ')} for themselves. That
          converts what they see; it never changes a board&rsquo;s currency or this setting.
        </Muted>
      </Card>

      <Modal
        isOpen={!!pendingBase}
        onClose={() => setPendingBase(null)}
        title={`Change the workspace currency to ${pendingCode || '…'}?`}
        maxWidth={480}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingBase(null)}>
              Cancel
            </Button>
            <Button onClick={changeBase}>{`Change to ${pendingCode || '…'}`}</Button>
          </>
        }
      >
        <div className="font-body flex flex-col gap-3" style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--color-text-secondary)' }}>
          <p>
            Every board that follows the workspace currency will be relabelled from{' '}
            <strong style={{ color: 'var(--color-text-primary)' }}>{unitLabel(baseCode)}</strong> to{' '}
            <strong style={{ color: 'var(--color-text-primary)' }}>{unitLabel(pendingCode)}</strong>,
            and new boards will start in {pendingCode}. Boards with their own currency keep it.
          </p>
          <RelabelNotConvert code={pendingCode} />
          <p>
            Do this when the amounts were always in {pendingCode} and the label was wrong. Anyone who
            wants to see figures converted can choose a reading currency from the menu under their
            avatar instead.
          </p>
        </div>
      </Modal>

      <WorkspaceBoards orgId={orgId} base={currency.baseCurrency} />

      <Card>
        <SectionTitle
          icon={KeyRound}
          hint="Exchange rates are fetched on a schedule and stored with the date they applied, so an invoice keeps the rate that was in force when it was raised rather than drifting with the market."
        >
          Exchange rates
        </SectionTitle>

        <div className="flex flex-wrap gap-4">
          <div style={{ minWidth: 260, flex: 1 }}>
            <SelectField
              label="Rates from"
              value={currency.provider}
              disabled={busy === 'provider'}
              onChange={(e) => save({ provider: e.target.value }, 'provider', 'Provider updated.')}
              options={PROVIDERS.map(({ value, label }) => ({ value, label }))}
            />
          </div>
          <div style={{ minWidth: 220, flex: 1 }}>
            <SelectField
              label="Check for new rates"
              value={currency.cadence}
              disabled={busy === 'cadence'}
              onChange={(e) => save({ cadence: e.target.value }, 'cadence', 'Schedule updated.')}
              options={CADENCES}
            />
          </div>
        </div>

        <Muted style={{ marginTop: 10 }}>{provider.blurb}</Muted>

        {provider.needsKey ? (
          <div style={{ marginTop: 16 }}>
            {currency.hasApiKey ? (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
                  Key installed
                  <span style={{ color: 'var(--color-text-muted)', marginLeft: 6 }}>
                    {currency.keyPreview}
                  </span>
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Trash2}
                  disabled={busy === 'apiKey'}
                  onClick={() => save({ apiKey: null }, 'apiKey', 'Key removed.')}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <div className="flex items-end gap-2 flex-wrap">
                <div style={{ flex: 1, minWidth: 240 }}>
                  {/*
                    `masked`, never `type="password"` — Input's own documented
                    rule. A password-typed field is what makes Chrome offer to
                    save a WORKSPACE credential into somebody's personal
                    password manager.
                  */}
                  <Input
                    label="API key"
                    masked
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    placeholder="Paste your ExchangeRate-API key"
                    helperText="Stored encrypted. It is never sent back to this screen — only the last four characters are."
                    disabled={busy === 'apiKey'}
                  />
                </div>
                <Button
                  size="sm"
                  disabled={!keyDraft.trim() || busy === 'apiKey'}
                  onClick={async () => {
                    const ok = await save({ apiKey: keyDraft.trim() }, 'apiKey', 'Key saved.');
                    if (ok) setKeyDraft('');
                  }}
                >
                  Save key
                </Button>
              </div>
            )}
          </div>
        ) : null}

        {/*
          The manual counterpart to the hourly runner. Somebody who has just
          pasted an API key wants to know it works NOW, not at seventeen past —
          and "nothing happened" is a useless answer to "does my key work", so
          this deliberately bypasses the cadence check the runner applies.

          `force: true` on the re-read: a plain fetch shares any request already
          in flight, and one that started before the refresh would hand back
          the OLD `lastFetchAt` / `lastError` — the line below would then say
          the refresh never happened.
        */}
        <div style={{ marginTop: 14 }}>
          <Button
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            disabled={busy === 'refresh'}
            onClick={async () => {
              if (!orgId) return;
              setBusy('refresh');
              try {
                const r = await refreshRates(orgId);
                // Pull the new snapshot into the store so money on other
                // screens converts with it immediately rather than next reload.
                await reloadRates();
                await fetchCurrency(orgId, { force: true });
                toastSuccess(`Fetched ${r.count} rates for ${r.dayKey}.`);
              } catch (err) {
                toastError(err?.response?.data?.error || 'Could not fetch rates.');
                await fetchCurrency(orgId, { force: true });
              } finally {
                setBusy('');
              }
            }}
          >
            {busy === 'refresh' ? 'Fetching…' : 'Fetch rates now'}
          </Button>
        </div>

        {currency.lastError ? (
          <p
            className="font-body"
            style={{ fontSize: 12, color: 'var(--color-status-stuck)', marginTop: 12 }}
          >
            Last refresh failed: {currency.lastError}
          </p>
        ) : currency.lastFetchAt ? (
          <Muted style={{ marginTop: 12 }}>
            Rates last fetched {new Date(currency.lastFetchAt).toLocaleString()}.
          </Muted>
        ) : (
          <Muted style={{ marginTop: 12 }}>
            No rates fetched yet. Until they arrive every figure shows in the currency it is
            stored in.
          </Muted>
        )}
      </Card>
    </div>
  );
};

export default CurrencyTab;
