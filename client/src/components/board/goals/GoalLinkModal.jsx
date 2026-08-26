import { useEffect, useMemo, useState } from 'react';
import { Link2Off, Search, TriangleAlert } from 'lucide-react';

import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import Dropdown from '../../ui/Dropdown';
import Switch from '../../ui/Switch';

/**
 * "What is this goal actually about?"
 *
 * ---- Why a goal has to say which keyword, when its group already says which
 *      project ------------------------------------------------------------
 *
 * The group's project is one DOMAIN, and that is enough for a fact about the
 * whole domain — organic traffic, domain authority, the health score. It is not
 * enough for a rank: "Current rank" is a fact about one phrase, and the project
 * tracks two hundred of them.
 *
 * The tempting shortcut is to match the goal's NAME against the keyword list.
 * It is also the single worst thing this feature could do: a fuzzy match that is
 * wrong produces an entirely plausible number in the wrong row, on a report
 * somebody sends a client. So the phrase is chosen once, by a person, and stored.
 *
 * ---- Why the list is picked from a stored snapshot -------------------------
 *
 * Every keyword here came out of the newest rank report we already hold. The
 * picker therefore opens instantly, spends no quota, and works during a provider
 * outage. The cost is real and is stated on screen: a keyword added at the
 * provider since the last collection is not in the list yet, so the field also
 * accepts a phrase typed by hand rather than refusing one.
 */

const norm = (s) => (s || '').trim().toLowerCase();

const GoalLinkModal = ({
  open,
  goal,
  groupName,
  monthLabel,
  /** The link this goal already has, or null. */
  link = null,
  /** One entry per (group, provider) — see `keywordSourcesFor` on the server. */
  sources = [],
  /** What a link will actually fill on this board, from the field mappings. */
  mappedFields = [],
  saving = false,
  error = null,
  onClose,
  onSave,
  onUnlink,
}) => {
  /** The sources that belong to THIS goal's group. Usually exactly one. */
  const groupSources = useMemo(
    () => sources.filter((s) => String(s.group) === String(goal?.group)),
    [sources, goal?.group]
  );

  const [provider, setProvider] = useState(
    link?.provider || groupSources[0]?.provider || ''
  );
  const [keyword, setKeyword] = useState(link?.keyword || '');
  const [variant, setVariant] = useState(link?.variant || '');
  const [autoFill, setAutoFill] = useState(link?.autoFill !== false);
  const [filter, setFilter] = useState('');

  // Re-seed when the modal is opened on a different goal. Keying the whole
  // modal on the goal id would work too, but the parent renders it once and
  // swaps `goal`, so the state has to follow.
  useEffect(() => {
    if (!open) return;
    setProvider(link?.provider || groupSources[0]?.provider || '');
    setKeyword(link?.keyword || '');
    setVariant(link?.variant || '');
    setAutoFill(link?.autoFill !== false);
    setFilter('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, goal?._id]);

  const source = groupSources.find((s) => s.provider === provider) || groupSources[0] || null;

  const visibleKeywords = useMemo(() => {
    const all = source?.keywords || [];
    const needle = norm(filter);
    if (!needle) return all.slice(0, 300);
    return all.filter((k) => k.toLowerCase().includes(needle)).slice(0, 300);
  }, [source, filter]);

  /**
   * What this link will fill, split by scope — because the two answers are
   * genuinely different and somebody about to make twenty links should know
   * which one they are getting.
   */
  const fills = useMemo(() => {
    const mine = mappedFields.filter((f) => !provider || f.provider === provider);
    return {
      keyword: mine.filter((f) => f.scope === 'keyword'),
      project: mine.filter((f) => f.scope === 'project'),
    };
  }, [mappedFields, provider]);

  if (!open || !goal) return null;

  const chosen = keyword.trim();
  const typedFreehand =
    !!chosen && !(source?.keywords || []).some((k) => norm(k) === norm(chosen));

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={`What is “${goal.name}” about?`}
      maxWidth={560}
      footer={
        <div className="flex items-center justify-between gap-2 w-full">
          {link ? (
            <Button variant="ghost" icon={Link2Off} onClick={onUnlink} disabled={saving}>
              Unlink
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={() => onSave({ provider, keyword: chosen || null, variant: variant || null, autoFill })}
              disabled={saving || !source}
            >
              {saving ? 'Saving…' : link ? 'Update link' : 'Link this goal'}
            </Button>
          </div>
        </div>
      }
    >
      {!groupSources.length ? (
        <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          {groupName ? `“${groupName}”` : 'This group'} is not mapped to a connector
          project yet. Map one under <strong>Add-ons</strong> first — a goal can only be
          about a keyword the connector is actually tracking for this client.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {groupSources.length > 1 && (
            <Dropdown
              label="Connector"
              options={groupSources.map((s) => ({
                value: s.provider,
                label: `${s.provider} · ${s.projectName || s.domain}`,
              }))}
              value={provider}
              onChange={setProvider}
            />
          )}

          <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
            Reading <strong>{source?.projectName || source?.domain}</strong>
            {source?.collectedOn ? ` · rankings last collected ${source.collectedOn}` : ''}
            {monthLabel ? ` · filling ${monthLabel}` : ''}
          </p>

          {source?.missing && (
            <p
              className="font-body flex items-start gap-1.5"
              style={{ fontSize: 12, color: 'var(--color-warning-text, #92400E)' }}
            >
              <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              This project no longer exists at the provider. Its history is kept, but
              nothing new will arrive for it.
            </p>
          )}

          {/* ---- The keyword ------------------------------------------------ */}
          <div>
            <Input
              label="Keyword"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Leave blank to link the whole project"
            />
            {typedFreehand && (
              <p
                className="font-body mt-1"
                style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
              >
                Not in the last collection. That is normal for a keyword added recently —
                it will start filling once the next rank report includes it.
              </p>
            )}
          </div>

          {(source?.keywords || []).length > 0 && (
            <div>
              <div className="relative">
                <Search
                  size={13}
                  aria-hidden="true"
                  className="absolute left-2.5 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--color-text-muted)' }}
                />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={`Search ${source.keywords.length} tracked keyword${source.keywords.length === 1 ? '' : 's'}`}
                  aria-label="Search the tracked keywords"
                  className="w-full font-body"
                  style={{
                    fontSize: 13,
                    height: 34,
                    paddingLeft: 28,
                    paddingRight: 10,
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--color-border)',
                    background: 'var(--color-bg-input)',
                    color: 'var(--color-text-primary)',
                  }}
                />
              </div>
              <ul
                className="mt-2 overflow-y-auto"
                style={{
                  maxHeight: 180,
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                {visibleKeywords.length === 0 ? (
                  <li
                    className="font-body px-3 py-3"
                    style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
                  >
                    Nothing matches “{filter}”. You can still type it above.
                  </li>
                ) : (
                  visibleKeywords.map((k) => {
                    const active = norm(k) === norm(keyword);
                    return (
                      <li key={k}>
                        <button
                          type="button"
                          onClick={() => setKeyword(k)}
                          className="w-full text-left font-body px-3 py-2"
                          style={{
                            fontSize: 13,
                            background: active ? 'var(--color-bg-subtle)' : 'transparent',
                            color: active
                              ? 'var(--color-accent)'
                              : 'var(--color-text-primary)',
                            fontWeight: active ? 600 : 400,
                          }}
                        >
                          {k}
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
          )}

          {/* ---- The market -------------------------------------------------- */}
          {(source?.variants || []).length > 1 && (
            <Dropdown
              label="Market"
              // A US rank and a UK rank for the same keyword on the same day are
              // two facts. Left on "newest", a project tracking both would flip
              // between them week to week.
              options={[
                { value: '', label: 'Whichever was collected most recently' },
                ...source.variants.map((v) => ({ value: v, label: v })),
              ]}
              value={variant}
              onChange={setVariant}
            />
          )}

          {/* ---- What it will fill ------------------------------------------- */}
          <div
            className="px-3 py-3"
            style={{
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-bg-subtle)',
            }}
          >
            <p
              className="font-body font-medium"
              style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
            >
              What this will fill
            </p>
            {fills.keyword.length === 0 && fills.project.length === 0 ? (
              <p
                className="font-body mt-1"
                style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
              >
                Nothing yet — no connector value is mapped to a goal cell on this board.
                Set that up under <strong>Add-ons → Field mapping</strong>, then come back.
              </p>
            ) : (
              <ul className="mt-1 flex flex-col gap-0.5">
                {(chosen ? fills.keyword : []).concat(fills.project).map((f) => (
                  <li
                    key={f.key}
                    className="font-body"
                    style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                  >
                    {f.label} → {f.targetLabel}
                    {f.autoFill ? '' : ' · only offered, never filled automatically'}
                  </li>
                ))}
                {!chosen && fills.keyword.length > 0 && (
                  <li
                    className="font-body"
                    style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                  >
                    {fills.keyword.length} more need a keyword — they are facts about one
                    phrase, not about the whole site.
                  </li>
                )}
              </ul>
            )}
          </div>

          {/* `Switch`'s own `label` is the ACCESSIBLE name only — it renders no
              text. In a toolbar that is right; in a form it would be a toggle
              with nothing beside it, so the visible label is spelled out here. */}
          <div className="flex items-center gap-2">
            <Switch
              checked={autoFill}
              onChange={setAutoFill}
              label="Let the weekly sync fill this row by itself"
            />
            <span
              className="font-body"
              style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
            >
              Let the weekly sync fill this row by itself
            </span>
          </div>
          <p
            className="font-body -mt-2"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
          >
            {autoFill
              ? 'The first sync claims whatever is in these cells today. After that, anything you edit by hand stays yours — the connector offers its number instead of overwriting you.'
              : 'Nothing on this row fills itself. The connector still shows what it would say, and you accept it row by row.'}
          </p>

          {error && (
            <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-status-stuck)' }}>
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
};

export default GoalLinkModal;
