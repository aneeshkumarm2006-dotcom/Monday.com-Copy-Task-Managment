import { useEffect, useMemo, useState } from 'react';
import { Check, Globe, KeyRound, MapPin, Plus, Rocket, Users } from 'lucide-react';

import Modal from '../../../ui/Modal';
import Button from '../../../ui/Button';
import Input from '../../../ui/Input';
import Dropdown from '../../../ui/Dropdown';
import MarketPicker from './MarketPicker';
import KeywordEditor from './KeywordEditor';
import { keywordsWithOperators } from '../../../../utils/keywordList';
import {
  createConnectorSiteDraft,
  saveConnectorSiteStep,
  launchConnectorSite,
  setConnectorProjectGroup,
} from '../../../../services/connectorService';

/**
 * SETTING UP A SITE, one decision at a time.
 *
 * ---- What this replaces and why --------------------------------------------
 *
 * One dialog with eight fields in it, all visible at once, all optional-looking,
 * ending in a Save that could fail on any of them. It asked for a raw integer
 * location code in a number field, and it lost everything typed into it if the
 * tab was closed to go and look one up.
 *
 * The failure was not that the dialog was ugly. It was that THE ORDER OF THE
 * DECISIONS WAS INVISIBLE, and they are not independent: the markets multiply
 * the keywords, and both are meaningless until the scope says what "the site"
 * even is. A form that shows them side by side is a form that lets somebody
 * paste two hundred keywords before finding out they will be bought four times.
 *
 * So the flow is staged, and each stage is one question:
 *
 *   1. THE SITE      - which domain, and how much of it counts as ours.
 *   2. THE MARKETS   - where it is searched from. THE COST MULTIPLIER.
 *   3. THE KEYWORDS  - what to track. THE COST BASE.
 *   4. COMPETITORS   - free, and said to be free.
 *   5. REVIEW        - what this will buy, and which client it feeds.
 *
 * ---- Why each step SAVES ---------------------------------------------------
 *
 * Step 1 creates a real row, in `status: 'draft'`, and every step after it
 * patches that row. So closing the tab in the middle of pasting keywords loses
 * nothing, and coming back is "Resume setup" rather than starting again.
 *
 * A DRAFT IS INERT AND THAT IS ENFORCED TWICE, server-side: it is refused a
 * group binding, and the collection scheduler filters it out. So a half-built
 * site can sit for a month without costing a cent. See `ConnectorProject.status`.
 *
 * ---- Why the last step binds the group -------------------------------------
 *
 * Because binding is what starts the money, and it is the one decision that was
 * previously made in a dropdown on a list, three screens away from the keyword
 * list whose size it was authorising. Putting it beside the estimate is the
 * whole point: "824 results per collection, feeding Acme Ltd" is one sentence,
 * and it is the sentence somebody should read before pressing the button.
 *
 * It stays optional. An agency sets up a prospect's site before the client
 * exists as a group, and that has to keep working.
 */

const emptyMarket = () => ({
  locationCode: '',
  languageCode: 'en',
  device: 'desktop',
  label: '',
});

/** A comma-or-newline list, for competitors. */
const listOf = (text) =>
  String(text || '')
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const STEPS = [
  { key: 'site', label: 'Site', icon: Globe },
  { key: 'markets', label: 'Markets', icon: MapPin },
  { key: 'keywords', label: 'Keywords', icon: KeyRound },
  { key: 'competitors', label: 'Competitors', icon: Users },
  { key: 'review', label: 'Review', icon: Rocket },
];

const Label = ({ children, hint }) => (
  <div className="flex items-baseline justify-between gap-2 mb-1">
    <span
      className="font-body"
      style={{
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--color-text-muted)',
      }}
    >
      {children}
    </span>
    {hint ? (
      <span className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
        {hint}
      </span>
    ) : null}
  </div>
);

/**
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {Function} props.onClose
 * @param {string} props.boardId
 * @param {string} props.provider
 * @param {Object} props.authoring - the descriptor's `projectAuthoring` block
 * @param {Array} props.accounts
 * @param {Array} props.groups - this board's groups, for the binding
 * @param {Array} props.projects - the provider's other projects, for taken groups
 * @param {Object|null} props.project - a draft being resumed, or a live site
 *   being edited, or null to start fresh
 * @param {Function} props.onSaved
 */
const SiteSetupWizard = ({
  isOpen,
  onClose,
  boardId,
  provider,
  authoring,
  accounts = [],
  groups = [],
  projects = [],
  project = null,
  onSaved,
}) => {
  /**
   * The row this wizard is writing to, once it exists.
   *
   * Distinct from the `project` prop: that is what we opened with, this is what
   * we have made. Resuming a draft starts them equal; starting fresh leaves this
   * null until step 1 saves.
   */
  const [saved, setSaved] = useState(project);
  const [stepIndex, setStepIndex] = useState(0);

  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [scope, setScope] = useState('domain');
  const [scopePath, setScopePath] = useState('');
  const [account, setAccount] = useState('');
  const [markets, setMarkets] = useState([emptyMarket()]);
  const [keywords, setKeywords] = useState([]);
  const [competitorText, setCompetitorText] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [group, setGroup] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Reset from the project every time the dialog opens, so cancelling and
  // reopening never shows an abandoned draft of a draft.
  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setBusy(false);
    setSaved(project);
    /**
     * A LIVE site opens on Review; a draft opens where it was left.
     *
     * Editing a finished site is almost always "change one thing", and starting
     * that four screens from the summary is four clicks of nothing. A draft is
     * the opposite: it is unfinished, and the first incomplete step is the one
     * worth landing on.
     */
    if (project?.status === 'live') {
      setStepIndex(STEPS.length - 1);
    } else if (project) {
      const hasMarkets = !!project.targets?.length;
      const hasKeywords = !!project.trackedKeywords?.length;
      setStepIndex(!hasMarkets ? 1 : !hasKeywords ? 2 : 3);
    } else {
      setStepIndex(0);
    }

    setName(project?.name && project.name !== project.domain ? project.name : '');
    setDomain(project?.domain || '');
    setScope(project?.scope || 'domain');
    setScopePath(project?.scopePath || '');
    setAccount(project?.account ? String(project.account) : accounts[0]?._id || '');
    setMarkets(
      project?.targets?.length
        ? project.targets.map((t) => ({
            locationCode: t.locationCode ?? '',
            languageCode: t.languageCode || 'en',
            device: t.device || 'desktop',
            label: t.label || '',
          }))
        : [emptyMarket()]
    );
    setKeywords(project?.trackedKeywords || []);
    setCompetitorText((project?.competitors || []).join('\n'));
    setBusinessName(project?.businessName || '');
    setGroup(
      project?.group && String(project.board) === String(boardId) ? String(project.group) : ''
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, project?._id]);

  const competitors = useMemo(() => listOf(competitorText), [competitorText]);

  const maxKeywords = authoring?.maxKeywords ?? 200;
  const maxTargets = authoring?.maxTargets ?? 4;
  const maxCompetitors = authoring?.maxCompetitors ?? 10;
  const devices = authoring?.devices?.length ? authoring.devices : ['desktop', 'mobile'];
  const scopes = authoring?.scopes?.length ? authoring.scopes : [];
  const scopeMeta = scopes.find((s) => s.key === scope) || null;

  /** Markets with a location actually chosen. An empty row is not a market. */
  const filledMarkets = useMemo(
    () => markets.filter((m) => Number(m.locationCode) > 0),
    [markets]
  );

  /**
   * What one collection of this site buys.
   *
   * A COUNT, not a price, and deliberately. The real cost comes from the
   * account's own price book, which lives on the server and moves — the provider
   * changed its rates by about 20% in one go — so a dollar figure quoted from a
   * hardcoded rate would be wrong at exactly the moment somebody relied on it.
   * "Two hundred keywords in four markets is eight hundred results, every time"
   * is the fact that changes a decision, and it does not go stale.
   */
  const perCollection = keywords.length * filledMarkets.length;

  const step = STEPS[stepIndex];
  /** A finished site being edited, rather than a draft being built. */
  const editingLive = saved?.status === 'live';

  /** Which groups another project of this provider already feeds. */
  const takenGroupIds = useMemo(
    () =>
      new Set(
        projects
          .filter((p) => p.group && String(p._id) !== String(saved?._id))
          .map((p) => String(p.group))
      ),
    [projects, saved?._id]
  );

  /**
   * Keywords the server is CERTAIN to refuse.
   *
   * A search operator costs five times a plain keyword at the provider and they
   * stack, so `readKeywords` rejects the whole save. Knowing that here and
   * still letting somebody finish two more steps before saying so is a worse
   * version of the same refusal — so this blocks Continue, and the editor names
   * the offending keyword.
   *
   * It is a WARNING-GRADE list, not the authority: the server owns the real
   * check. If this list falls behind, the failure is a save that fails with the
   * server's own sentence, which is exactly what happened before.
   */
  const refusedKeywords = useMemo(() => keywordsWithOperators(keywords), [keywords]);

  const stepValid = () => {
    if (step.key === 'site') {
      if (!domain.trim()) return false;
      if (scopeMeta?.needsPath && !scopePath.trim()) return false;
      return true;
    }
    if (step.key === 'markets') return filledMarkets.length > 0;
    if (step.key === 'keywords') {
      return keywords.length > 0 && keywords.length <= maxKeywords && !refusedKeywords.length;
    }
    return true;
  };

  const marketPayload = () =>
    filledMarkets.map((m) => ({
      locationCode: Number(m.locationCode),
      languageCode: String(m.languageCode || 'en').trim(),
      device: m.device || 'desktop',
      label: m.label?.trim() || undefined,
    }));

  /**
   * What THIS step owns, and nothing else.
   *
   * The patch is deliberately narrow. The server reads a draft as a patch, so a
   * request carrying every field would let a step somebody has not reached yet
   * overwrite one they have — the wizard's own local defaults ("one empty
   * market") would be written over a market list saved five minutes ago.
   */
  const patchForStep = (key) => {
    if (key === 'site') {
      return {
        domain: domain.trim(),
        name: name.trim() || undefined,
        scope,
        scopePath: scopeMeta?.needsPath ? scopePath.trim() : '',
      };
    }
    if (key === 'markets') return { targets: marketPayload() };
    if (key === 'keywords') return { trackedKeywords: keywords };
    if (key === 'competitors') return { competitors, businessName: businessName.trim() };
    return {};
  };

  /**
   * Save this step and move on.
   *
   * Step 1 CREATES the row when there is not one yet; every other step patches.
   * The failure is always reported as the server's own sentence — it is the one
   * that knows why ("that is 240 keywords", "site:example.com is a search
   * operator and multiplies the cost by five", "acme.com is already set up
   * here"), and a generic message here would be a worse version of it.
   */
  const advance = async () => {
    /**
     * A LIVE SITE IS NOT SAVED STEP BY STEP.
     *
     * The server reads a live row as a FULL REPLACEMENT — deliberately, so that
     * an edit dropping four keywords can say so — and a per-step patch carrying
     * only `targets` would be read as a site with no domain and no keywords and
     * refused. Only the draft path saves as it goes; editing a finished site
     * collects every change locally and writes them all at Save.
     */
    if (editingLive) {
      setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      let row = saved;

      if (!row) {
        row = await createConnectorSiteDraft(boardId, provider, {
          ...patchForStep('site'),
          ...(account ? { account } : {}),
        });
      } else {
        row = await saveConnectorSiteStep(boardId, provider, row._id, patchForStep(step.key));
      }

      setSaved(row);
      onSaved?.(row);
      setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
    } catch (err) {
      setError(err?.response?.data?.error || 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Finish: validate the whole site at once, then bind the group if one was
   * picked.
   *
   * TWO REQUESTS, IN THIS ORDER, and the order is the safety. Launch is what
   * turns a draft into something collectable; binding is what makes the
   * scheduler pick it up. Binding first would be refused anyway — the server
   * will not map a draft — but doing it in this order means a failure at the
   * launch step leaves a draft that is still inert, rather than a live site
   * bound to a client before anybody checked it.
   */
  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      let row = await launchConnectorSite(boardId, provider, saved._id, {
        ...patchForStep('site'),
        ...patchForStep('markets'),
        ...patchForStep('keywords'),
        ...patchForStep('competitors'),
      });

      const currentGroup =
        row.group && String(row.board) === String(boardId) ? String(row.group) : '';
      if (group !== currentGroup) {
        row = await setConnectorProjectGroup(boardId, provider, row._id, group || null);
      }

      onSaved?.(row);
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error || 'That site could not be started.');
    } finally {
      setBusy(false);
    }
  };

  const setMarket = (index, patch) =>
    setMarkets((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)));

  const isLast = stepIndex === STEPS.length - 1;

  return (
    <Modal
      isOpen={isOpen}
      onClose={busy ? () => {} : onClose}
      title={
        saved
          ? editingLive
            ? `Edit ${saved.name || saved.domain}`
            : `Set up ${saved.name || saved.domain}`
          : `Add a ${(authoring?.label || 'site').toLowerCase()}`
      }
      maxWidth={780}
      footer={
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-body flex-1" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
            {/*
              THE RUNNING COST, once there is one to state — and nothing at all
              before that. On the first step there are no keywords and no
              markets by definition, so "add at least one of each" there reads as
              a validation failure against a form nobody has filled in yet.
            */}
            {perCollection > 0
              ? `${keywords.length} keyword${keywords.length === 1 ? '' : 's'} × ${filledMarkets.length} market${filledMarkets.length === 1 ? '' : 's'} = ${perCollection} result${perCollection === 1 ? '' : 's'} bought per collection.`
              : stepIndex === 0
                ? ''
                : 'Add at least one market and one keyword.'}
          </p>
          {stepIndex > 0 && (
            <Button variant="secondary" onClick={() => setStepIndex((i) => i - 1)} disabled={busy}>
              Back
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {saved && !editingLive ? 'Finish later' : 'Cancel'}
          </Button>
          {isLast ? (
            <Button onClick={finish} disabled={busy || !saved || perCollection === 0}>
              {busy ? 'Starting…' : editingLive ? 'Save changes' : 'Start tracking'}
            </Button>
          ) : (
            <Button onClick={advance} disabled={busy || !stepValid()}>
              {busy ? 'Saving…' : 'Continue'}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-wrap gap-5" style={{ alignItems: 'flex-start' }}>
        {/* ---- The step rail ------------------------------------------------ */}
        <ol className="flex flex-col gap-0.5 shrink-0" style={{ width: 148 }}>
          {STEPS.map((entry, index) => {
            const done = index < stepIndex;
            const current = index === stepIndex;
            const Icon = entry.icon;
            /**
             * A step is reachable once its row exists. Jumping BACK is always
             * fine — everything behind is saved — and jumping forward past an
             * unfinished step is not, because the next one would be authoring
             * against a site that does not have a domain yet.
             */
            const reachable = !!saved && index <= Math.max(stepIndex, editingLive ? 99 : stepIndex);
            return (
              <li key={entry.key}>
                <button
                  type="button"
                  onClick={() => reachable && !busy && setStepIndex(index)}
                  disabled={!reachable || busy}
                  className="flex items-center gap-2 w-full text-left font-body"
                  style={{
                    padding: '7px 9px',
                    borderRadius: 'var(--radius-md)',
                    border: 'none',
                    background: current ? 'var(--color-bg-subtle)' : 'transparent',
                    color: current
                      ? 'var(--color-text-primary)'
                      : done
                        ? 'var(--color-text-secondary)'
                        : 'var(--color-text-muted)',
                    fontSize: 12.5,
                    fontWeight: current ? 600 : 400,
                    cursor: reachable && !busy ? 'pointer' : 'default',
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="inline-flex items-center justify-center shrink-0"
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 999,
                      background: done
                        ? 'var(--color-accent)'
                        : current
                          ? 'var(--color-bg-surface)'
                          : 'transparent',
                      border: `1px solid ${current || done ? 'var(--color-accent)' : 'var(--color-border)'}`,
                      color: done ? '#fff' : current ? 'var(--color-accent)' : 'var(--color-text-muted)',
                    }}
                  >
                    {done ? <Check size={11} /> : <Icon size={11} />}
                  </span>
                  {entry.label}
                </button>
              </li>
            );
          })}
        </ol>

        {/* ---- The step ------------------------------------------------------ */}
        <div className="flex-1 flex flex-col gap-4" style={{ minWidth: 340 }}>
          {error && (
            <p
              className="font-body px-3 py-2.5"
              style={{
                fontSize: 12.5,
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-danger-light, #FEE2E2)',
                color: 'var(--color-danger-text, #991B1B)',
              }}
            >
              {error}
            </p>
          )}

          {step.key === 'site' && (
            <>
              <StepHead
                title="Which site is this?"
                blurb={
                  authoring?.help ||
                  'The domain, and how much of it counts as this client’s.'
                }
              />

              <div className="flex flex-wrap gap-3">
                <div style={{ flex: '1 1 240px' }}>
                  <Label>Domain</Label>
                  <Input
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="acme.com"
                    disabled={busy}
                  />
                  <p
                    className="font-body mt-1"
                    style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                  >
                    {/* Not a nicety: for a rank tracker `www.acme.com` and
                        `acme.com` are different targets, and the server keeps
                        them apart on purpose. */}
                    Exactly as it appears in the results — <code>www.</code> counts.
                  </p>
                </div>
                <div style={{ flex: '1 1 180px' }}>
                  <Label hint="optional">Name</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Defaults to the domain"
                    disabled={busy}
                  />
                </div>
              </div>

              {!saved && accounts.length > 1 && (
                <div style={{ maxWidth: 300 }}>
                  <Dropdown
                    label="Connected account"
                    size="sm"
                    options={accounts.map((a) => ({ value: String(a._id), label: a.label }))}
                    value={account}
                    onChange={setAccount}
                  />
                </div>
              )}

              {scopes.length > 0 && (
                <div>
                  <Label>What counts as this site</Label>
                  <ul className="flex flex-col gap-1.5">
                    {scopes.map((entry) => {
                      const active = scope === entry.key;
                      return (
                        <li key={entry.key}>
                          <button
                            type="button"
                            onClick={() => setScope(entry.key)}
                            disabled={busy}
                            className="flex items-start gap-2.5 w-full text-left"
                            style={{
                              padding: '9px 11px',
                              borderRadius: 'var(--radius-md)',
                              border: `1.5px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
                              background: active
                                ? 'var(--color-accent-light, var(--color-bg-subtle))'
                                : 'transparent',
                              cursor: busy ? 'default' : 'pointer',
                            }}
                          >
                            <span
                              aria-hidden="true"
                              className="shrink-0"
                              style={{
                                marginTop: 3,
                                width: 12,
                                height: 12,
                                borderRadius: 999,
                                border: `1.5px solid ${active ? 'var(--color-accent)' : 'var(--color-border-strong)'}`,
                                background: active ? 'var(--color-accent)' : 'transparent',
                                boxShadow: active ? 'inset 0 0 0 2px var(--color-bg-surface)' : 'none',
                              }}
                            />
                            <span className="min-w-0">
                              <span
                                className="font-body block"
                                style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                              >
                                {entry.label}
                              </span>
                              <span
                                className="font-body block mt-0.5"
                                style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                              >
                                {entry.hint}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>

                  {scopeMeta?.needsPath && (
                    <div className="mt-2.5" style={{ maxWidth: 320 }}>
                      <Label>
                        {scope === 'subfolder' ? 'Folder' : 'Page'}
                      </Label>
                      <Input
                        value={scopePath}
                        onChange={(e) => setScopePath(e.target.value)}
                        placeholder={scopeMeta.pathPlaceholder || '/uk/'}
                        disabled={busy}
                      />
                      <p
                        className="font-body mt-1"
                        style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                      >
                        {/* Refused rather than defaulted, server-side: an empty
                            folder would match the whole domain under a name
                            that says otherwise. */}
                        Required. Without it this would track the whole domain.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {step.key === 'markets' && (
            <>
              <StepHead
                title="Where is it searched from?"
                blurb="Every market buys every keyword again. Two markets is twice the bill, not twice the detail."
              />

              <ul className="flex flex-col gap-2">
                {markets.map((market, index) => (
                  <MarketPicker
                    key={index}
                    value={market}
                    onChange={(patch) => setMarket(index, patch)}
                    onRemove={
                      markets.length > 1
                        ? () => setMarkets((prev) => prev.filter((_, i) => i !== index))
                        : null
                    }
                    countries={authoring?.locations || []}
                    languages={authoring?.languages || []}
                    devices={devices}
                    canSearchCities={!!authoring?.locationSearch && accounts.length > 0}
                    boardId={boardId}
                    provider={provider}
                    disabled={busy}
                  />
                ))}
              </ul>

              {markets.length < maxTargets && (
                <div>
                  <Button
                    variant="secondary"
                    icon={Plus}
                    onClick={() => setMarkets((prev) => [...prev, emptyMarket()])}
                    disabled={busy}
                  >
                    Add a market
                  </Button>
                  <p
                    className="font-body mt-2"
                    style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                  >
                    {filledMarkets.length} of {maxTargets} used.
                    {keywords.length > 0
                      ? ` Adding one takes this site from ${keywords.length * filledMarkets.length} to ${keywords.length * (filledMarkets.length + 1)} results per collection.`
                      : ''}
                  </p>
                </div>
              )}
            </>
          )}

          {step.key === 'keywords' && (
            <>
              <StepHead
                title="What should it track?"
                blurb={`Each keyword is bought again in every market, on every collection. ${filledMarkets.length} market${filledMarkets.length === 1 ? '' : 's'} selected.`}
              />
              <KeywordEditor
                keywords={keywords}
                onChange={setKeywords}
                max={maxKeywords}
                markets={filledMarkets.length}
                disabled={busy}
              />
            </>
          )}

          {step.key === 'competitors' && (
            <>
              <StepHead
                title="Who is it up against?"
                blurb="Optional, and free: competitors are picked out of the results already bought, never collected separately."
              />

              <div>
                <Label hint={`${competitors.length} of ${maxCompetitors}`}>Competitor domains</Label>
                <textarea
                  value={competitorText}
                  onChange={(e) => setCompetitorText(e.target.value)}
                  placeholder={'competitor-one.com\ncompetitor-two.com'}
                  disabled={busy}
                  rows={4}
                  className="font-body"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: 13,
                    lineHeight: 1.6,
                    borderRadius: 'var(--radius-md)',
                    border: '1.5px solid var(--color-border-strong)',
                    background: 'var(--color-bg-input, var(--color-bg-surface))',
                    color: 'var(--color-text-primary)',
                    resize: 'vertical',
                  }}
                />
              </div>

              <div>
                <Label hint="optional">Google Business Profile</Label>
                <Input
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="Acme Plumbing, Leeds — or cid:12345"
                  disabled={busy}
                />
                <p
                  className="font-body mt-1"
                  style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                >
                  {/*
                    This box is a SWITCH and the empty state is what it switches
                    off — it is the one `requires` gate in this provider that
                    genuinely stops a purchase, because an empty string is falsy
                    where an empty array is not. Left blank, no Maps lookup is
                    ever bought.

                    Deliberately not defaulted to the domain: Maps fuzzy-matches
                    a text query, so a domain returns a card for whichever
                    business Google thinks is closest, and a confident card for
                    the wrong business is worse than none.
                  */}
                  Leave blank and nothing local is collected — no call, no charge. A name, or a{' '}
                  <code>cid:</code> / <code>place_id:</code> value copied off the listing. A domain
                  is not enough: Maps would match whichever business it thought was closest.
                </p>
              </div>
            </>
          )}

          {step.key === 'review' && (
            <>
              <StepHead
                title={editingLive ? 'Review the changes' : 'Ready to start'}
                blurb={
                  editingLive
                    ? 'Saving replaces the whole list. Every reading already collected is kept.'
                    : 'Nothing has been bought yet. Collection starts on the next scheduled pass.'
                }
              />

              <dl
                className="flex flex-col gap-0"
                style={{
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border)',
                  overflow: 'hidden',
                }}
              >
                <SummaryRow label="Site">
                  {domain || '—'}
                  {scopeMeta && scope !== 'domain' ? (
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      {' '}
                      · {scopeMeta.label}
                      {scopeMeta.needsPath && scopePath ? ` ${scopePath}` : ''}
                    </span>
                  ) : null}
                </SummaryRow>
                <SummaryRow label="Markets">
                  {filledMarkets.length
                    ? filledMarkets
                        .map(
                          (m) =>
                            `${m.label || m.locationCode} · ${m.languageCode} · ${m.device}`
                        )
                        .join('  |  ')
                    : 'None'}
                </SummaryRow>
                <SummaryRow label="Keywords">{keywords.length}</SummaryRow>
                <SummaryRow label="Competitors">
                  {competitors.length ? competitors.join(', ') : 'None'}
                </SummaryRow>
                <SummaryRow label="Local">
                  {businessName || (
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      Not collected — no business named
                    </span>
                  )}
                </SummaryRow>
                <SummaryRow label="Per collection">
                  <strong>{perCollection}</strong> result{perCollection === 1 ? '' : 's'}
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {' '}
                    ({keywords.length} × {filledMarkets.length})
                  </span>
                </SummaryRow>
              </dl>

              <div>
                <Label hint="optional">Which client does this feed?</Label>
                <Dropdown
                  size="sm"
                  options={[
                    { value: '', label: 'Not mapped yet' },
                    ...groups.map((g) => ({
                      value: String(g._id),
                      label: takenGroupIds.has(String(g._id))
                        ? `${g.name} (already mapped)`
                        : g.name,
                      disabled: takenGroupIds.has(String(g._id)),
                    })),
                  ]}
                  value={group}
                  onChange={setGroup}
                  disabled={busy}
                  ariaLabel="Group this site feeds"
                />
                <p
                  className="font-body mt-1.5"
                  style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                >
                  {/*
                    Said here rather than on the list screen it used to live on,
                    because this is the decision that starts the money and it
                    should be read next to the number above it.
                  */}
                  {group
                    ? 'Mapping starts collection on the next scheduled pass. Unmapping later stops it and keeps every reading.'
                    : 'A site with no group is never collected for. You can map it any time from the Add-ons tab.'}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};

const StepHead = ({ title, blurb }) => (
  <div>
    <h4
      className="font-body font-semibold"
      style={{ fontSize: 15, color: 'var(--color-text-primary)' }}
    >
      {title}
    </h4>
    <p className="font-body mt-1" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
      {blurb}
    </p>
  </div>
);

const SummaryRow = ({ label, children }) => (
  <div
    className="flex flex-wrap gap-3 px-3 py-2.5"
    // Separators BETWEEN rows only. A borderTop on the first one would double
    // up against the container's own border.
    style={{ borderTop: '1px solid var(--color-border)', marginTop: -1 }}
  >
    <dt
      className="font-body shrink-0"
      style={{ width: 110, fontSize: 12, color: 'var(--color-text-muted)' }}
    >
      {label}
    </dt>
    <dd
      className="font-body flex-1 min-w-0"
      style={{ fontSize: 12.5, color: 'var(--color-text-primary)', wordBreak: 'break-word' }}
    >
      {children}
    </dd>
  </div>
);

export default SiteSetupWizard;
