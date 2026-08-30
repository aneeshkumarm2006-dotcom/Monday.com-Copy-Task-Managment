import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plug, Plus, RotateCw, Trash2, TriangleAlert } from 'lucide-react';

import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import useOrgStore from '../../store/orgStore';
import useToastStore from '../../store/toastStore';
import {
  getOrgConnectors,
  startConnectorAuthorization,
  saveConnectorCredentials,
  disconnectConnectorAccount,
} from '../../services/connectorService';

/**
 * Connectors — the organisation's pool of external accounts.
 *
 * This is the ORG plane. Accounts are connected here, once, and every tracker
 * board in the workspace draws on them. Enabling a connector for a particular
 * board, and mapping its projects to groups, happens on that board's Add-ons
 * tab — a different capability and a different screen.
 *
 * The pool is deliberately PLURAL. Ubersuggest Enterprise caps one account at 15
 * projects, and the agency's clients do not fit in one, so "the connection" was
 * never going to be a single row.
 *
 * ---- Two ways in, and the server decides which ----------------------------
 *
 * Ubersuggest issues no client_credentials grant: the only way to authorise an
 * account is an interactive consent in a real browser, once, after which the
 * refresh token carries the weekly sync unattended. A key field there would look
 * friendlier and could never work, so the flow leaves rather than pretending.
 *
 * Plenty of other APIs are the reverse — a login and a password, no
 * authorization server at all, nowhere to send a browser. For those the consent
 * dialog is the thing that could never work.
 *
 * So the dialog renders from the catalog entry rather than from anything decided
 * here: `requiresBrowserConsent` picks the branch, and `credentialForm` — a
 * label and a list of `{key, label, secret}` fields, sent by the server — is the
 * form itself. Nothing in this file names a provider or knows what any
 * particular field means, which is what makes the next key-authenticated
 * connector a descriptor on the server and no change at all here.
 *
 * What both branches share: a credential goes IN and never comes back out. There
 * is no endpoint that returns one, so there is nothing to prefill on a
 * re-authorise and the fields start empty every time.
 */

/** Fixed copy for the callback's outcome. The provider's own error text is */
/** attacker-controllable and is logged server-side, never rendered. */
const CALLBACK_MESSAGES = {
  declined: 'That connection was cancelled before it finished.',
  incomplete: 'That sign-in came back incomplete. Please try again.',
  expired:
    'That connection attempt had already expired or been used. Start a new one.',
  exchange:
    'We reached the provider but could not finish the connection. Please try again.',
  server: 'Something went wrong on our end. Please try again.',
};

const STATUS_LABELS = {
  active: 'Connected',
  needs_reauth: 'Needs reconnecting',
  revoked: 'Disconnected',
};

const ConnectorsTab = () => {
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const orgId = currentOrg?._id;
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  const [searchParams, setSearchParams] = useSearchParams();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // The connect dialog. `reconnect` carries the account being re-authorised, so
  // the callback updates that row instead of creating a second one — which is
  // what keeps its project mappings and stored history attached.
  const [connectFor, setConnectFor] = useState(null);
  const [label, setLabel] = useState('');
  const [labelError, setLabelError] = useState('');
  const [starting, setStarting] = useState(false);
  // Whatever the connector's own `credentialForm` asked for, keyed by field key.
  // Never prefilled, including on a re-authorise: no endpoint returns a stored
  // credential, so an apparently populated field would be a lie.
  const [credentials, setCredentials] = useState({});

  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!orgId) return;
      if (!quiet) setLoading(true);
      try {
        setData(await getOrgConnectors(orgId));
        setError(null);
      } catch (err) {
        setError(
          err?.response?.data?.error || 'Could not load your connected accounts.'
        );
      } finally {
        setLoading(false);
      }
    },
    [orgId]
  );

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Read the outcome the OAuth callback redirected back with, then strip it from
   * the URL so a refresh does not replay the toast.
   */
  useEffect(() => {
    const outcome = searchParams.get('connector');
    if (!outcome) return;

    if (outcome === 'connected') {
      toastSuccess('Account connected.');
      load({ quiet: true });
    } else {
      const reason = searchParams.get('reason');
      toastError(CALLBACK_MESSAGES[reason] || CALLBACK_MESSAGES.server);
    }

    const next = new URLSearchParams(searchParams);
    next.delete('connector');
    next.delete('reason');
    next.delete('provider');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const openConnect = (connector, account = null) => {
    setConnectFor({ connector, account });
    setLabel(account?.label || '');
    setLabelError('');
    setCredentials({});
  };

  /** The catalog entry decides the dialog; this file decides nothing. */
  const usesCredentials =
    !!connectFor && connectFor.connector.requiresBrowserConsent === false;
  const credentialFields = connectFor?.connector?.credentialForm?.fields || [];

  const beginConsent = async () => {
    const trimmed = label.trim();
    if (!trimmed) {
      setLabelError('Give this account a name so you can tell them apart.');
      return;
    }

    setStarting(true);
    try {
      const url = await startConnectorAuthorization(
        orgId,
        connectFor.connector.name,
        {
          label: trimmed,
          returnTo: '/settings?tab=connectors',
          reconnectAccount: connectFor.account?._id || undefined,
        }
      );
      // Full navigation rather than a popup: the provider's consent screen sets
      // its own headers and a popup would be blocked as often as not.
      window.location.assign(url);
    } catch (err) {
      setStarting(false);
      setLabelError(
        err?.response?.data?.error || 'Could not start that connection.'
      );
    }
  };

  /**
   * The credential branch. Unlike a consent it finishes here — there is no
   * redirect to come back from, so the list is reloaded in place and the server's
   * own sentence renders on the form rather than as a toast the dialog outlives.
   */
  const submitCredentials = async () => {
    const trimmed = label.trim();
    if (!trimmed) {
      setLabelError('Give this account a name so you can tell them apart.');
      return;
    }
    const missing = credentialFields.find((f) => !(credentials[f.key] || '').trim());
    if (missing) {
      setLabelError(`${missing.label} is required.`);
      return;
    }

    setStarting(true);
    try {
      await saveConnectorCredentials(orgId, connectFor.connector.name, {
        label: trimmed,
        credentials: credentialFields.reduce(
          (acc, f) => ({ ...acc, [f.key]: (credentials[f.key] || '').trim() }),
          {}
        ),
        reconnectAccount: connectFor.account?._id || undefined,
      });
      setConnectFor(null);
      // Dropped from state the moment it has been sent. The values are already
      // sealed server-side and there is nothing to gain from keeping them in a
      // component that stays mounted.
      setCredentials({});
      await load({ quiet: true });
      toastSuccess('Account connected.');
    } catch (err) {
      setLabelError(
        err?.response?.data?.error || 'Could not save those credentials.'
      );
    } finally {
      setStarting(false);
    }
  };

  const confirmDisconnect = async () => {
    setDeleting(true);
    try {
      await disconnectConnectorAccount(pendingDelete._id);
      setPendingDelete(null);
      await load({ quiet: true });
      toastSuccess('Account disconnected.');
    } catch (err) {
      toastError(
        err?.response?.data?.error || 'Could not disconnect that account.'
      );
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState icon={Plug} title="Connectors" description={error} />
    );
  }

  const { accounts = [], catalog = [], canManage = false } = data || {};

  return (
    <div>
      <header className="mb-5">
        <h1
          className="font-display font-bold text-[color:var(--color-text-primary)]"
          style={{ fontSize: 22 }}
        >
          Connectors
        </h1>
        <p className="font-body text-[13px] text-[color:var(--color-text-secondary)] mt-1">
          External accounts this workspace can pull data from. Connect one here,
          then switch it on for a board from that board&rsquo;s Add-ons tab.
        </p>
      </header>

      {!canManage && (
        <p
          className="font-body text-[12.5px] mb-4 px-3 py-2"
          style={{
            background: 'var(--color-bg-subtle)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--color-text-muted)',
          }}
        >
          Only an organisation admin can connect or remove accounts. You can see
          which ones exist because boards name them when picking projects.
        </p>
      )}

      <div className="flex flex-col gap-4">
        {catalog.map((connector) => {
          const mine = accounts.filter((a) => a.provider === connector.name);
          return (
            <section
              key={connector.name}
              style={{
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                overflow: 'hidden',
              }}
            >
              <div
                className="flex items-start gap-3 px-4 py-4"
                style={{ background: 'var(--color-bg-subtle)' }}
              >
                <div
                  aria-hidden="true"
                  className="flex items-center justify-center shrink-0"
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--color-bg-surface)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  <Plug size={17} />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="font-body text-[14px] font-semibold text-[color:var(--color-text-primary)]">
                    {connector.label}
                  </p>
                  <p className="font-body text-[12.5px] text-[color:var(--color-text-muted)] mt-0.5">
                    {connector.blurb}
                  </p>
                </div>

                {canManage && (
                  <div className="shrink-0">
                    <Button
                      variant="secondary"
                      icon={Plus}
                      onClick={() => openConnect(connector)}
                    >
                      Add account
                    </Button>
                  </div>
                )}
              </div>

              {mine.length === 0 ? (
                <p
                  className="font-body text-[12.5px] px-4 py-4"
                  style={{
                    color: 'var(--color-text-muted)',
                    borderTop: '1px solid var(--color-border)',
                  }}
                >
                  No accounts connected yet.
                  {connector.requiresBrowserConsent
                    ? ' Connecting opens the provider’s sign-in page once; after that it refreshes on its own.'
                    : ' This provider issues a key instead of a sign-in page, so connecting is a form.'}
                </p>
              ) : (
                mine.map((account) => {
                  const stale = account.status === 'needs_reauth';
                  return (
                    <div
                      key={account._id}
                      className="flex items-center gap-3 px-4 py-3"
                      style={{ borderTop: '1px solid var(--color-border)' }}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-body text-[13.5px] font-semibold text-[color:var(--color-text-primary)] truncate">
                            {account.label}
                          </p>
                          {stale && (
                            <span
                              className="inline-flex items-center gap-1 font-body shrink-0"
                              style={{
                                fontSize: 11,
                                padding: '2px 7px',
                                borderRadius: 999,
                                background: 'var(--color-warning-light, #FEF3C7)',
                                color: 'var(--color-warning-text, #92400E)',
                              }}
                            >
                              <TriangleAlert size={11} aria-hidden="true" />
                              {STATUS_LABELS[account.status]}
                            </span>
                          )}
                        </div>
                        <p
                          className="font-body mt-0.5 truncate"
                          style={{
                            fontSize: 12,
                            color: 'var(--color-text-muted)',
                          }}
                        >
                          {account.externalEmail || 'Signed in'}
                          {account.tier ? ` · ${account.tier}` : ''}
                          {account.lastSyncAt
                            ? ` · last synced ${new Date(account.lastSyncAt).toLocaleDateString()}`
                            : ' · not synced yet'}
                        </p>
                      </div>

                      {canManage && (
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            icon={RotateCw}
                            onClick={() => openConnect(connector, account)}
                          >
                            {stale ? 'Reconnect' : 'Re-authorise'}
                          </Button>
                          <Button
                            variant="ghost"
                            icon={Trash2}
                            onClick={() => setPendingDelete(account)}
                            aria-label={`Disconnect ${account.label}`}
                          />
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </section>
          );
        })}
      </div>

      {/* ---- Connect / reconnect ------------------------------------------ */}
      <Modal
        isOpen={!!connectFor}
        onClose={() => setConnectFor(null)}
        title={
          connectFor?.account
            ? `Reconnect ${connectFor.account.label}`
            : 'Connect an account'
        }
        maxWidth={480}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConnectFor(null)}>
              Cancel
            </Button>
            <Button
              onClick={usesCredentials ? submitCredentials : beginConsent}
              disabled={starting}
            >
              {usesCredentials
                ? (starting ? 'Saving…' : 'Save connection')
                : (starting ? 'Opening…' : 'Continue to sign in')}
            </Button>
          </div>
        }
      >
        <p className="font-body text-[13px] text-[color:var(--color-text-secondary)] mb-4">
          {usesCredentials
            ? connectFor?.connector?.credentialForm?.help ||
              'Enter the credentials this provider issued. They are stored encrypted and are never shown again.'
            : 'You’ll be taken to the provider to sign in and approve access. That happens once — afterwards the weekly sync runs on its own.'}
        </p>
        <Input
          label="Name this account"
          placeholder="Main, Agency 2, Client logins…"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          error={usesCredentials ? '' : labelError}
          helperText="Shown wherever a board picks which projects to pull from."
          maxLength={60}
          autoFocus
          required
        />

        {/*
          The credential form, rendered from the server's own description.

          `masked` rather than `type="password"` is deliberate and is Input's own
          documented rule: a password-typed field is what makes Chrome offer to
          save the value, which would put a second, unencrypted copy of a
          workspace credential in a personal password manager. See Input.jsx.
        */}
        {usesCredentials &&
          credentialFields.map((field) => (
            <div key={field.key} className="mt-3">
              <Input
                label={field.label}
                masked={!!field.secret}
                placeholder={field.placeholder || ''}
                helperText={field.help || ''}
                value={credentials[field.key] || ''}
                onChange={(e) =>
                  setCredentials((prev) => ({ ...prev, [field.key]: e.target.value }))
                }
                required
              />
            </div>
          ))}

        {usesCredentials && labelError && (
          <p
            className="font-body mt-3"
            style={{ fontSize: 12.5, color: 'var(--color-status-stuck)' }}
          >
            {labelError}
          </p>
        )}

        {connectFor?.account && (
          <p
            className="font-body mt-3"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            {usesCredentials
              ? 'Entering the credentials again keeps this account’s project mappings and everything already collected.'
              : 'Reconnecting keeps this account’s project mappings and everything already collected.'}
          </p>
        )}
      </Modal>

      {/* ---- Disconnect --------------------------------------------------- */}
      <Modal
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title="Disconnect this account?"
        maxWidth={440}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={confirmDisconnect}
              disabled={deleting}
            >
              {deleting ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
        }
      >
        <p className="font-body text-[13px] text-[color:var(--color-text-secondary)]">
          <strong>{pendingDelete?.label}</strong> will stop syncing and its
          sign-in will be forgotten. Everything already collected stays put, so
          reconnecting later picks up where it left off.
        </p>
      </Modal>
    </div>
  );
};

export default ConnectorsTab;
