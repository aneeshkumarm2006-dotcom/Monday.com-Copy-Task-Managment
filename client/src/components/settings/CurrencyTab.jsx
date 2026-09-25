import { useEffect, useState } from 'react';
import { Coins, Loader2, KeyRound, Trash2, RefreshCw } from 'lucide-react';

import useOrgStore from '../../store/orgStore';
import useFxStore from '../../store/fxStore';
import { refreshRates } from '../../services/fxService';
import useToastStore from '../../store/toastStore';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { SelectField } from '../ui/FormControls';
import { currencyOptions, DISPLAY_CURRENCIES } from '../../utils/money';

/**
 * WHAT THIS WORKSPACE BILLS IN, AND WHERE ITS RATES COME FROM.
 *
 * Two settings that look like one and are not:
 *
 *   `baseCurrency` is a fact about the BUSINESS. It decides what a new money
 *   column is born in — which is the half that matters, because every billing,
 *   budget, pipeline and expenses board used to be hardcoded to rupees — and
 *   what somebody sees before they pick a currency of their own.
 *
 *   The FX block is plumbing. Who we ask about exchange rates, how often, and
 *   with whose credential.
 *
 * ---- Why changing the base currency is not retroactive ---------------------
 *
 * Nothing here rewrites an existing column or board. A figure already stored
 * carries its own unit, and restating it would change what a number MEANS
 * without anybody touching it — a ₹1,80,000 invoice silently becoming
 * $1,80,000. Existing boards keep their currency; this changes what the next
 * one starts with. The copy on the screen says so, because somebody will
 * reasonably expect otherwise.
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

  useEffect(() => {
    if (orgId) ensureCurrency(orgId);
  }, [orgId, ensureCurrency]);

  // One writer for every control on the screen, so the busy state, the error
  // toast and the store replacement cannot drift apart between them.
  const save = async (patch, field, message) => {
    if (!orgId) return;
    setBusy(field);
    try {
      await saveCurrency(orgId, patch);
      if (message) toastSuccess(message);
      return true;
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not save that.');
      return false;
    } finally {
      setBusy('');
    }
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

  return (
    <div style={{ maxWidth: 620 }}>
      <Card>
        <SectionTitle
          icon={Coins}
          hint="What money on a new board is assumed to be in. Boards that already exist keep the currency they were made with — changing this never rewrites a figure somebody already entered."
        >
          Workspace currency
        </SectionTitle>

        <div style={{ maxWidth: 300 }}>
          <SelectField
            label="Bills are in"
            value={currency.baseCurrency}
            disabled={busy === 'baseCurrency'}
            onChange={(e) =>
              save({ baseCurrency: e.target.value }, 'baseCurrency', 'Workspace currency updated.')
            }
            options={currencyOptions()}
          />
        </div>

        <p
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 10, lineHeight: 1.55 }}
        >
          Everyone can read the whole workspace in {DISPLAY_CURRENCIES.join(', ')} from the menu
          under their avatar. That is a personal choice and does not change what anything is
          billed in.
        </p>
      </Card>

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

        <p
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 10, lineHeight: 1.55 }}
        >
          {provider.blurb}
        </p>

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
                await fetchCurrency(orgId);
                toastSuccess(`Fetched ${r.count} rates for ${r.dayKey}.`);
              } catch (err) {
                toastError(err?.response?.data?.error || 'Could not fetch rates.');
                await fetchCurrency(orgId);
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
          <p
            className="font-body"
            style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 12 }}
          >
            Rates last fetched {new Date(currency.lastFetchAt).toLocaleString()}.
          </p>
        ) : (
          <p
            className="font-body"
            style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 12 }}
          >
            No rates fetched yet. Until they arrive every figure shows in the currency it is
            stored in.
          </p>
        )}
      </Card>
    </div>
  );
};

export default CurrencyTab;
