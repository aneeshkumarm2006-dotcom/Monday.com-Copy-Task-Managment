import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';

import Button from '../../ui/Button';
import { OptionRow } from '../../ui/FilterControls';
import useToastStore from '../../../store/toastStore';
import { setBoardConnector } from '../../../services/connectorService';

/**
 * How this board uses a connector: what it renders, how often it collects, and
 * how much of the workspace's money it may account for.
 *
 * ---- The distinction this panel exists to make visible -----------------------
 *
 * WHAT WE RENDER AND WHAT WE PAY TO COLLECT ARE DIFFERENT SWITCHES, and the
 * whole reason `BoardConnector` carries two fields is that collapsing them is a
 * bug with somebody else's name on it:
 *
 *   `kinds` — what is BOUGHT. The runner unions it across every board mapping
 *     the same project, because the project is collected once and one collection
 *     has to satisfy the board that asked for the most. So narrowing it here can
 *     take a section away from a co-tenant board, and widening it starts a
 *     purchase that every board mapping that project shares.
 *   `enabledScreens` — what is DRAWN, out of data already collected. Free,
 *     local, and reversible with no consequence anywhere else.
 *
 * So the screens are checkboxes and the collected kinds are deliberately NOT
 * offered here. Turning a screen off is tidying; turning a kind off is a
 * purchasing decision with a blast radius, and it belongs behind a conversation
 * rather than behind a checkbox that looks identical to the one above it.
 *
 * ---- The cadence, and who pays for it --------------------------------------
 *
 * `intervalHours` is resolved as a MIN across every board mapping a project, for
 * the same reason `kinds` is unioned. The consequence is named on screen because
 * it is invisible otherwise: the eager board's cadence is subsidised by the
 * frugal one. Fine while the budget is per organisation — which it is, because
 * the provider account is — and not fine the day anyone bills per board.
 */

/** How often, in hours, with the provider's own default as the empty option. */
const CADENCE_OPTIONS = [
  { value: '', label: 'Provider default' },
  { value: '24', label: 'Daily' },
  { value: '72', label: 'Every 3 days' },
  { value: '168', label: 'Weekly' },
  { value: '336', label: 'Fortnightly' },
  { value: '720', label: 'Monthly' },
];

const field = {
  height: 32,
  padding: '0 8px',
  fontSize: 13,
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-border-strong)',
  background: 'var(--color-bg-input, var(--color-bg-surface))',
  color: 'var(--color-text-primary)',
};

const ConnectorSettingsPanel = ({ boardId, connector, canManage, onSaved }) => {
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  const screens = connector.availableScreens || [];

  const [selected, setSelected] = useState(connector.enabledScreens || []);
  const [interval, setInterval] = useState(
    connector.intervalHours ? String(connector.intervalHours) : ''
  );
  const [allocation, setAllocation] = useState(
    connector.budget?.monthlyUsd ? String(connector.budget.monthlyUsd) : ''
  );
  const [alertAtPct, setAlertAtPct] = useState(
    String(connector.budget?.alertAtPct ?? 80)
  );
  const [saving, setSaving] = useState(false);

  // The server's answer wins whenever it arrives — this panel is re-rendered
  // after a quiet reload and must not keep showing an abandoned draft.
  useEffect(() => {
    setSelected(connector.enabledScreens || []);
    setInterval(connector.intervalHours ? String(connector.intervalHours) : '');
    setAllocation(
      connector.budget?.monthlyUsd ? String(connector.budget.monthlyUsd) : ''
    );
    setAlertAtPct(String(connector.budget?.alertAtPct ?? 80));
  }, [
    connector.enabledScreens,
    connector.intervalHours,
    connector.budget?.monthlyUsd,
    connector.budget?.alertAtPct,
  ]);

  /**
   * Empty means EVERYTHING, resolved server-side. So the checkboxes start ticked
   * for a board that has expressed no opinion, and unticking the first one is
   * what turns "no opinion" into a selection.
   */
  const isOn = (key) => selected.length === 0 || selected.includes(key);

  const toggle = (screen) => {
    if (screen.alwaysOn) return;
    setSelected((prev) => {
      const base = prev.length ? prev : screens.map((s) => s.key);
      return base.includes(screen.key)
        ? base.filter((k) => k !== screen.key)
        : [...base, screen.key];
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await setBoardConnector(boardId, connector.name, {
        enabled: !!connector.enabled,
        enabledScreens: selected,
        // Blank clears the override rather than meaning zero — the server
        // refuses anything under an hour outright, so the two agree.
        intervalHours: interval === '' ? null : Number(interval),
        budget: {
          monthlyUsd: allocation === '' ? null : Number(allocation),
          alertAtPct: Number(alertAtPct) || 80,
        },
      });
      toastSuccess('Saved.');
      onSaved?.();
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not save those settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--color-border)' }}>
      <div className="flex items-start gap-2 px-4 pt-4">
        <SlidersHorizontal
          size={15}
          aria-hidden="true"
          className="mt-0.5 shrink-0"
          style={{ color: 'var(--color-text-muted)' }}
        />
        <div>
          <p
            className="font-body font-semibold"
            style={{ fontSize: 13.5, color: 'var(--color-text-primary)' }}
          >
            How this board uses {connector.label}
          </p>
          <p
            className="font-body mt-0.5"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            Screens are what this board draws out of data already collected.
            Switching one off costs nothing, gives nothing back, and cannot
            affect another board.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-6 px-4 py-4">
        {/* ---- Screens ------------------------------------------------------- */}
        <div style={{ flex: '1 1 260px', minWidth: 240 }}>
          <p
            className="font-body mb-1"
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--color-text-muted)',
            }}
          >
            Screens
          </p>
          {screens.map((screen) => (
            <OptionRow
              key={screen.key}
              checked={isOn(screen.key)}
              onToggle={() => canManage && toggle(screen)}
            >
              <span className="font-body" style={{ fontSize: 13 }}>
                {screen.label}
                {screen.alwaysOn && (
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {' '}
                    · always shown
                  </span>
                )}
              </span>
            </OptionRow>
          ))}
        </div>

        {/* ---- Cadence and money --------------------------------------------- */}
        <div style={{ flex: '1 1 260px', minWidth: 240 }}>
          <label className="block">
            <span
              className="font-body block mb-1"
              style={{
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--color-text-muted)',
              }}
            >
              Collect every
            </span>
            <select
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              disabled={!canManage || saving}
              style={{ ...field, width: '100%' }}
              className="font-body"
            >
              {CADENCE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <p
            className="font-body mt-1"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
          >
            {/* The consequence, named. It is invisible from this screen
                otherwise, and it is the reason this control is not free. */}
            A project mapped on more than one board is collected once, at the
            FASTEST cadence any of them asked for — so a board choosing daily
            speeds it up for every board sharing that site, and they share the
            bill.
          </p>

          <div className="flex gap-2 mt-3">
            <label className="flex-1 min-w-0">
              <span
                className="font-body block mb-1"
                style={{
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: 'var(--color-text-muted)',
                }}
              >
                Monthly allocation
              </span>
              <input
                type="number"
                min="0"
                step="1"
                value={allocation}
                onChange={(e) => setAllocation(e.target.value)}
                placeholder="No limit"
                disabled={!canManage || saving}
                style={{ ...field, width: '100%' }}
                className="font-body"
              />
            </label>
            <label style={{ width: 96 }}>
              <span
                className="font-body block mb-1"
                style={{
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: 'var(--color-text-muted)',
                }}
              >
                Warn at
              </span>
              <input
                type="number"
                min="1"
                max="100"
                value={alertAtPct}
                onChange={(e) => setAlertAtPct(e.target.value)}
                disabled={!canManage || saving || allocation === ''}
                style={{ ...field, width: '100%' }}
                className="font-body"
              />
            </label>
          </div>
          <p
            className="font-body mt-1"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
          >
            {/* Said plainly, because "budget" reads as a ceiling and this is
                not one: the account is workspace-wide, so the number that
                actually stops a collection is the workspace cap. */}
            An allocation is this board&rsquo;s share of the workspace&rsquo;s
            money, not a second ceiling. Blank is the normal state and means
            &ldquo;bounded by the workspace cap like every other board&rdquo;.
          </p>
        </div>
      </div>

      {canManage && (
        <div className="px-4 pb-4">
          <Button onClick={save} disabled={saving} size="sm">
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      )}
    </div>
  );
};

export default ConnectorSettingsPanel;
