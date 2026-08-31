import { useState } from 'react';
import { Wallet } from 'lucide-react';

import Switch from '../../ui/Switch';
import { SelectField } from '../../ui/FormControls';
import useToastStore from '../../../store/toastStore';
import { setAdsBudgetSettings } from '../../../services/adsBudgetService';

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
 */

/**
 * The codes offered, which is not the same as the codes ACCEPTED — the server
 * takes any valid ISO 4217 three-letter code. This list is the common ones, so
 * the usual case is a click; it is not a limit.
 */
const CURRENCIES = [
  { value: 'USD', label: 'USD — US dollar' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'GBP', label: 'GBP — Pound sterling' },
  { value: 'AUD', label: 'AUD — Australian dollar' },
  { value: 'CAD', label: 'CAD — Canadian dollar' },
  { value: 'INR', label: 'INR — Indian rupee' },
  { value: 'AED', label: 'AED — UAE dirham' },
  { value: 'SGD', label: 'SGD — Singapore dollar' },
];

const AdsBudgetAddonCard = ({ boardId, adsBudget, canManage, onChanged }) => {
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  const enabled = !!adsBudget?.enabled;
  const currency = adsBudget?.currency || 'USD';
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
              { enabled: next },
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
              label="Currency"
              value={currency}
              disabled={!canManage || busy}
              onChange={(e) => save({ currency: e.target.value }, 'Currency updated.')}
              options={
                // A board already set to something outside the common list keeps
                // its own code as an option rather than silently switching to
                // whatever happens to be first.
                CURRENCIES.some((c) => c.value === currency)
                  ? CURRENCIES
                  : [{ value: currency, label: currency }, ...CURRENCIES]
              }
            />
          </div>
          <p
            className="font-body flex-1 min-w-[220px]"
            style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}
          >
            One currency for the whole board — every total on the tab is a sum across clients, and
            amounts in different currencies cannot be added. Changing it re-labels figures already
            entered rather than converting them.
          </p>
        </div>
      ) : null}
    </section>
  );
};

export default AdsBudgetAddonCard;
