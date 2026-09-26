import { useState } from 'react';
import { Wallet } from 'lucide-react';

import Switch from '../../ui/Switch';
import { SelectField } from '../../ui/FormControls';
import useToastStore from '../../../store/toastStore';
import useOrgStore, { selectBaseCurrency } from '../../../store/orgStore';
import useBoardStore from '../../../store/boardStore';
import { setAdsBudgetSettings } from '../../../services/adsBudgetService';
import { boardCurrencyOf, currencyByCode, currencyOptions } from '../../../utils/money';

/**
 * The Ads Budget add-on's switch.
 *
 * ---- Why this is a per-board switch and not a board-type feature ------------
 *
 * Delivery and Goals appear on every tracker board with no switch at all,
 * because a month-partitioned board always has commitments and targets. A board
 * that runs no advertising has no budgets, and a permanently empty tab is worse
 * than an absent one — so this one is opted into.
 *
 * It is equally NOT a per-user Extra Feature. Those are personal preferences
 * (`User.features`); this is a fact about the board, and the whole team has to
 * agree on it or one person's tab would be full of numbers nobody else could
 * see. `utils/extraFeatures.js` records the same conclusion being reached about
 * the Delivery view, which used to live there and was removed for exactly this
 * reason.
 *
 * ---- The currency ----------------------------------------------------------
 *
 * One per board, chosen here, because every figure on the tab is a SUM across
 * rows and rows in mixed currencies cannot be added. Kept next to the switch
 * rather than buried in the tab, since it is a decision made once at setup and
 * changing it later reinterprets every number already entered — which the
 * warning below says out loud rather than leaving to be discovered.
 *
 * It is the ADS BUDGET's currency, and the card calls it that. A board also
 * has its own currency (its money columns — Amount, Deal value), and two
 * controls both labelled "Currency" on one board made "the board is CAD" mean
 * two different things. They usually agree, which is why the board's is the
 * default here; when they do not, the card says so.
 *
 * ---- The default is the BOARD's currency, never a literal ------------------
 *
 * `adsBudget.currency` is null until somebody chooses (the schema default was
 * 'USD', which made the workspace fallback here dead code and put a dollar
 * sign on every rupee and CAD board). Unset, the tab shows the board's own
 * currency, else the workspace's — `boardCurrencyOf`, the same chain every
 * other money surface on the board resolves. Switching the add-on on stamps
 * that default onto a board with a currency of its OWN, so the stored value
 * and what the tab showed can never disagree afterwards. A board that FOLLOWS
 * the workspace leaves it unset: its Ads Budget then follows too, and a
 * workspace currency change relabels it along with the board's columns.
 */

/**
 * The codes offered, which is not the same as the codes ACCEPTED — the server
 * takes any valid ISO 4217 three-letter code. This list is the common ones, so
 * the usual case is a click; it is not a limit.
 *
 * Read from `utils/money.js` rather than written out here. This card used to
 * carry its own list of eight, which disagreed with the number-column picker's
 * five in both directions — AUD/CAD/SGD existed only here, and CAD only here in
 * the entire product. One catalog means a board and a column can no longer be
 * denominated in currencies the other has never heard of.
 */
const CURRENCIES = currencyOptions();

const AdsBudgetAddonCard = ({ boardId, adsBudget, canManage, onChanged }) => {
  const orgBase = useOrgStore(selectBaseCurrency);
  const board = useBoardStore((s) => s.boards.find((b) => b._id === boardId) || null);
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  const enabled = !!adsBudget?.enabled;
  // The board's own money unit (its currency, else its first money column,
  // else the workspace's) — what its money columns are in.
  const boardCurrency = boardCurrencyOf(board, orgBase);
  // Whether the board FOLLOWS the workspace (no currency of its own). An Ads
  // Budget nobody gave a unit reads the board's own currency, else the
  // workspace's — the server's `adsBudgetCurrencyOf` — so on a following
  // board it moves with a workspace currency change, like the columns do.
  const boardOwn = currencyByCode(board?.currency)?.code || null;
  const followsWorkspace = !!board && !boardOwn;
  const unchosenUnit = boardOwn || currencyByCode(orgBase)?.code || boardCurrency || null;
  const chosen = currencyByCode(adsBudget?.currency)?.code || adsBudget?.currency || null;
  const currency = chosen || unchosenUnit || '';
  const differsFromBoard =
    !!chosen && !!boardCurrency && currencyByCode(chosen)?.code !== boardCurrency;
  const [busy, setBusy] = useState(false);

  const save = async (settings, message) => {
    setBusy(true);
    try {
      const next = await setAdsBudgetSettings(boardId, settings);
      onChanged?.(next);
      if (message) toastSuccess(message);
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not change that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-bg-surface)',
        overflow: 'hidden',
      }}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <span
          className="inline-flex items-center justify-center shrink-0"
          style={{
            width: 32,
            height: 32,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-accent-light)',
            color: 'var(--color-accent-text)',
          }}
        >
          <Wallet size={16} aria-hidden="true" />
        </span>

        <div className="flex-1 min-w-0">
          <p
            className="font-body font-medium"
            style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
          >
            Ads Budget tracker
          </p>
          <p
            className="font-body mt-0.5"
            style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}
          >
            Adds an <strong>Ads Budget</strong> tab: planned spend, actual spend and pacing for
            every client on this board, by platform and campaign. Figures are entered by hand —
            nothing is fetched from an advertising account and no quota is spent.
          </p>
        </div>

        <Switch
          checked={enabled}
          disabled={!canManage || busy}
          label="Ads Budget tracker"
          onChange={(next) =>
            save(
              // First switch-on with no currency chosen, on a board with a
              // currency of its own: stamp the default the tab would show
              // anyway, so what is stored and what was shown are the same unit
              // from the first figure onwards. A board that follows the
              // workspace sends none, and its Ads Budget follows along with it
              // (the server leaves it unset there too).
              next && !chosen && currency && !followsWorkspace
                ? { enabled: next, currency }
                : { enabled: next },
              next ? 'Ads Budget tracker switched on for this board.' : 'Ads Budget tracker switched off.'
            )
          }
        />
      </div>

      {enabled ? (
        <div
          className="px-4 py-3 flex flex-wrap items-end gap-4"
          style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-subtle)' }}
        >
          <div style={{ minWidth: 220 }}>
            <SelectField
              label="Ads Budget currency"
              value={currency}
              disabled={!canManage || busy}
              onChange={(e) =>
                save({ currency: e.target.value }, `Ads Budget amounts are now in ${e.target.value}.`)}
              options={
                // A board already set to something outside the common list keeps
                // its own code as an option rather than silently switching to
                // whatever happens to be first.
                !currency || CURRENCIES.some((c) => c.value === currency)
                  ? CURRENCIES
                  : [{ value: currency, label: currency }, ...CURRENCIES]
              }
            />
          </div>
          <div className="flex-1 min-w-[220px] flex flex-col gap-1.5">
            <p
              className="font-body"
              style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}
            >
              What budgets and spend on the Ads Budget tab are entered in — one currency for every
              client, because the tab&rsquo;s totals add them up. Changing it relabels figures
              already entered; it does not convert them.
            </p>
            {!chosen && currency ? (
              <p
                className="font-body"
                style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}
              >
                {followsWorkspace
                  ? `Not chosen, so it follows this board — which follows the workspace currency (${currency}) — and is relabelled with it if that changes.`
                  : `Not chosen yet, so it follows this board’s currency (${currency}).`}
              </p>
            ) : differsFromBoard ? (
              <p
                className="font-body"
                style={{ fontSize: 12, color: 'var(--color-status-working)', lineHeight: 1.5 }}
              >
                This board&rsquo;s own money columns are in {boardCurrency}; the Ads Budget tab
                uses {chosen}.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
};

export default AdsBudgetAddonCard;
