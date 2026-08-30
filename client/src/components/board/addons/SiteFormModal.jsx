import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import Dropdown from '../../ui/Dropdown';
import { SegmentedControl } from '../../ui/FormControls';
import {
  createConnectorSite,
  updateConnectorSite,
} from '../../../services/connectorService';

/**
 * Authoring a "site" — the client half of a provider that has no projects.
 *
 * ---- Why this form exists at all -------------------------------------------
 *
 * The first connector mirrors projects a person created at the provider, so the
 * only thing to do here is bind one to a group. This one is a stateless billing
 * API: it takes a keyword, a location, a language and a device on every call and
 * remembers nothing. There is no project to mirror, so the `ConnectorProject`
 * row is the ORIGINAL, and until now it could only be created with a POST from
 * a terminal.
 *
 * ---- The one thing this form is really doing -------------------------------
 *
 * IT IS SETTING THE SIZE OF THE BILL. Keywords x markets is the whole cost
 * model: every target buys every keyword again, on every collection, forever. So
 * the estimate below is not decoration — it is the number the person filling
 * this in needs before they paste two hundred keywords into a site with four
 * markets and quietly multiply a month's spend by eight.
 *
 * ---- Validation lives on the server and is not duplicated here -------------
 *
 * The caps come from the descriptor (`projectAuthoring` on the catalog entry) so
 * the form renders the server's own limits rather than numbers copied out of a
 * constants file. Everything else — the domain shape, the language codes, the
 * per-keyword length, and the refusal of search operators, which are a x5 cost
 * multiplier each and STACK — is checked in `readSiteForm` and rendered here as
 * whatever sentence the server sent back. Two implementations of a rule agree
 * until they quietly do not, and the one that matters is the one holding the
 * money.
 */

/** A textarea's worth of lines, as a list. */
const linesOf = (text) =>
  String(text || '')
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** A comma-or-newline list, for competitors. */
const listOf = (text) =>
  String(text || '')
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const emptyTarget = () => ({
  locationCode: '',
  languageCode: 'en',
  device: 'desktop',
  label: '',
});

const field = {
  height: 34,
  width: '100%',
  padding: '0 10px',
  fontSize: 13,
  borderRadius: 'var(--radius-md)',
  border: '1.5px solid var(--color-border-strong)',
  background: 'var(--color-bg-input, var(--color-bg-surface))',
  color: 'var(--color-text-primary)',
};

const area = { ...field, height: 120, padding: '8px 10px', lineHeight: 1.5 };

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
 * @param {Array} props.accounts   - the org's connected accounts for this provider
 * @param {Object|null} props.project - the site being edited, or null to create
 * @param {Function} props.onSaved
 */
const SiteFormModal = ({
  isOpen,
  onClose,
  boardId,
  provider,
  authoring,
  accounts = [],
  project = null,
  onSaved,
}) => {
  const editing = !!project;

  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [account, setAccount] = useState('');
  const [targets, setTargets] = useState([emptyTarget()]);
  const [keywordText, setKeywordText] = useState('');
  const [competitorText, setCompetitorText] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Reset from the project every time the dialog opens, so cancelling an edit
  // and reopening it does not show the abandoned draft.
  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setName(project?.name || '');
    setDomain(project?.domain || '');
    setAccount(project?.account ? String(project.account) : accounts[0]?._id || '');
    setTargets(
      project?.targets?.length
        ? project.targets.map((t) => ({
            locationCode: String(t.locationCode ?? ''),
            languageCode: t.languageCode || 'en',
            device: t.device || 'desktop',
            label: t.label || '',
          }))
        : [emptyTarget()]
    );
    setKeywordText((project?.trackedKeywords || []).join('\n'));
    setCompetitorText((project?.competitors || []).join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, project?._id]);

  const keywords = useMemo(() => linesOf(keywordText), [keywordText]);
  const competitors = useMemo(() => listOf(competitorText), [competitorText]);

  const maxKeywords = authoring?.maxKeywords ?? 200;
  const maxTargets = authoring?.maxTargets ?? 4;
  const maxCompetitors = authoring?.maxCompetitors ?? 10;
  const devices = authoring?.devices?.length ? authoring.devices : ['desktop', 'mobile'];

  /**
   * What one collection of this site buys.
   *
   * Deliberately expressed as a COUNT rather than a price. The real cost comes
   * from the account's own price book, which lives on the server and moves — the
   * provider changed its rates by ~20% in one go — and a dollar figure quoted
   * here from a hardcoded rate would be wrong at exactly the moment somebody
   * relied on it. "Two hundred keywords times four markets is eight hundred
   * collections, every time" is the fact that actually changes a decision, and
   * it does not go stale.
   */
  const perCollection = keywords.length * targets.length;

  const save = async () => {
    setSaving(true);
    setError(null);
    const payload = {
      name: name.trim() || undefined,
      domain: domain.trim(),
      trackedKeywords: keywords,
      targets: targets.map((t) => ({
        locationCode: Number(t.locationCode),
        languageCode: t.languageCode.trim(),
        device: t.device,
        label: t.label.trim() || undefined,
      })),
      competitors,
      businessName: businessName.trim(),
      ...(account && !editing ? { account } : {}),
    };
    try {
      const saved = editing
        ? await updateConnectorSite(boardId, provider, project._id, payload)
        : await createConnectorSite(boardId, provider, payload);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      // The server's own sentence, verbatim. It is the one that knows why —
      // "that is 240 keywords", "site:example.com is a search operator and
      // multiplies the cost by five", "acme.com is already set up here".
      setError(
        err?.response?.data?.error || 'That site could not be saved.'
      );
    } finally {
      setSaving(false);
    }
  };

  const setTarget = (index, patch) =>
    setTargets((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));

  return (
    <Modal
      isOpen={isOpen}
      onClose={saving ? () => {} : onClose}
      title={editing ? `Edit ${project.name || project.domain}` : 'Add a site'}
      maxWidth={620}
      footer={
        <div className="flex items-center gap-3">
          <p
            className="font-body flex-1"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
          >
            {perCollection > 0
              ? `${keywords.length} keyword${keywords.length === 1 ? '' : 's'} × ${targets.length} market${targets.length === 1 ? '' : 's'} = ${perCollection} result${perCollection === 1 ? '' : 's'} bought per collection.`
              : 'Add at least one keyword and one market.'}
          </p>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !domain.trim() || !keywords.length}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add site'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {authoring?.help && (
          <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
            {authoring.help}
          </p>
        )}

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

        <div className="flex flex-wrap gap-3">
          <div style={{ flex: '1 1 220px' }}>
            <Label>Domain</Label>
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="acme.com"
              disabled={saving}
            />
            <p
              className="font-body mt-1"
              style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
            >
              {/* Not a nicety: for a rank tracker `www.acme.com` and `acme.com`
                  are different targets, and the server keeps them apart. */}
              Exactly as it appears in the results — <code>www.</code> counts.
            </p>
          </div>
          <div style={{ flex: '1 1 180px' }}>
            <Label hint="optional">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Defaults to the domain"
              disabled={saving}
            />
          </div>
        </div>

        {!editing && accounts.length > 1 && (
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

        {/* ---- Markets ------------------------------------------------------- */}
        <div>
          <Label hint={`${targets.length} of ${maxTargets}`}>Markets</Label>
          <p
            className="font-body mb-2"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
          >
            {/* The single biggest cost lever on this form, said before the
                fields rather than after them. */}
            Every market buys every keyword again. Two markets is twice the bill,
            not twice the detail.
          </p>

          <ul className="flex flex-col gap-2">
            {targets.map((target, index) => (
              <li key={index} className="flex flex-wrap items-end gap-2">
                <div style={{ flex: '0 0 130px' }}>
                  <Label>Location code</Label>
                  <input
                    type="number"
                    value={target.locationCode}
                    onChange={(e) => setTarget(index, { locationCode: e.target.value })}
                    placeholder="2840"
                    disabled={saving}
                    style={field}
                  />
                </div>
                <div style={{ flex: '0 0 90px' }}>
                  <Label>Language</Label>
                  <input
                    value={target.languageCode}
                    onChange={(e) => setTarget(index, { languageCode: e.target.value })}
                    placeholder="en"
                    disabled={saving}
                    style={field}
                  />
                </div>
                <div className="shrink-0">
                  <Label>Device</Label>
                  <SegmentedControl
                    options={devices.map((d) => ({
                      value: d,
                      label: d.charAt(0).toUpperCase() + d.slice(1),
                    }))}
                    value={target.device}
                    onChange={(value) => setTarget(index, { device: value })}
                    disabled={saving}
                  />
                </div>
                <div style={{ flex: '1 1 120px', minWidth: 120 }}>
                  <Label hint="optional">Label</Label>
                  <input
                    value={target.label}
                    onChange={(e) => setTarget(index, { label: e.target.value })}
                    placeholder="United States"
                    disabled={saving}
                    style={field}
                  />
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setTargets((prev) => prev.filter((_, i) => i !== index))
                  }
                  disabled={saving || targets.length <= 1}
                  aria-label="Remove this market"
                  className="inline-flex items-center justify-center shrink-0"
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--color-border)',
                    background: 'transparent',
                    color: 'var(--color-text-muted)',
                    cursor: targets.length <= 1 ? 'default' : 'pointer',
                    opacity: targets.length <= 1 ? 0.4 : 1,
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>

          {targets.length < maxTargets && (
            <Button
              variant="secondary"
              icon={Plus}
              onClick={() => setTargets((prev) => [...prev, emptyTarget()])}
              disabled={saving}
              className="mt-2"
            >
              Add a market
            </Button>
          )}

          <p
            className="font-body mt-2"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
          >
            A location code is the provider&rsquo;s own number for a country or
            city — 2840 is the United States, 2826 the United Kingdom. The
            language is a code like <code>en</code> or <code>en-GB</code>.
          </p>
        </div>

        {/* ---- Keywords ------------------------------------------------------ */}
        <div>
          <Label
            hint={`${keywords.length} of ${maxKeywords}`}
          >
            Tracked keywords
          </Label>
          <textarea
            value={keywordText}
            onChange={(e) => setKeywordText(e.target.value)}
            placeholder={'luxury lingerie\nbridal corset\nsilk robe'}
            disabled={saving}
            style={area}
            className="font-body"
          />
          <p
            className="font-body mt-1"
            style={{
              fontSize: 11.5,
              color:
                keywords.length > maxKeywords
                  ? 'var(--color-danger, #DC2626)'
                  : 'var(--color-text-muted)',
            }}
          >
            {keywords.length > maxKeywords
              ? `That is ${keywords.length}. The cap is ${maxKeywords}, because every one is bought again on every collection.`
              : 'One per line. Search operators like site: or intitle: are refused — each one multiplies the cost by five, and they stack.'}
          </p>
        </div>

        {/* ---- Competitors --------------------------------------------------- */}
        <div>
          <Label hint={`${competitors.length} of ${maxCompetitors}`}>
            Competitors
          </Label>
          <textarea
            value={competitorText}
            onChange={(e) => setCompetitorText(e.target.value)}
            placeholder={'competitor-one.com\ncompetitor-two.com'}
            disabled={saving}
            style={{ ...area, height: 76 }}
            className="font-body"
          />
          <p
            className="font-body mt-1"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
          >
            {/* Free, and worth saying so — otherwise this reads like another
                cost multiplier next to the two that are. */}
            Optional, and free: competitors are picked out of the results already
            bought, not collected separately.
          </p>
        </div>

        {/* ---- Google Business Profile --------------------------------------- */}
        <div>
          <Label hint="optional">Google Business Profile</Label>
          <Input
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="Acme Plumbing, Leeds — or cid:12345"
            disabled={saving}
          />
          <p
            className="font-body mt-1"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
          >
            {/*
              This box is a SWITCH, and the empty state is what it switches off.
              Left blank, nothing is ever collected for the Local screen — no
              call, no charge. Filled in, one Google Maps lookup is bought each
              week.

              And it is deliberately not defaulted to the domain: Maps
              fuzzy-matches a text query, so a domain returns a card for whichever
              business Google thinks is closest, and a confident card for the
              wrong business is worse than none at all.
            */}
            Leave blank and nothing local is collected. A name, or a{' '}
            <code>cid:</code> / <code>place_id:</code> value copied off the
            listing — a domain is not enough, because Maps would match whichever
            business it thought was closest.
          </p>
        </div>
      </div>
    </Modal>
  );
};

export default SiteFormModal;
