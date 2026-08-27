import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link2, TriangleAlert, Check } from 'lucide-react';

import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Spinner from '../../ui/Spinner';
import {
  getGoalLinkMatches,
  bulkSetGoalLinks,
  runConnectorWriteback,
} from '../../../services/connectorService';

/**
 * "Point this whole month at the keywords it is obviously about."
 *
 * ---- Why this exists next to `GoalLinkModal` and does not replace it -------
 *
 * That modal is the right shape for the question it asks — WHICH of two hundred
 * phrases is this one row about — and it is deliberately careful, because a
 * wrong answer puts an entirely plausible number in the wrong row on a report
 * somebody sends a client. The careful shape is also twenty-six dialogs for a
 * board whose goals are already NAMED after the keywords they track, which is
 * the normal case, and twenty-six dialogs is how a person ends up not linking
 * any of them.
 *
 * So this screen asks the same question once, for every row at a time, and
 * keeps the part that was actually load-bearing: a person reads the pairs and
 * confirms them. The server proposes and cannot write; a second call writes and
 * cannot propose. Nothing here is a fuzzy match — the rule is exact, ignoring
 * only case and repeated spaces, and a goal matching two keywords is reported
 * as ambiguous rather than resolved for you.
 *
 * ---- Why it fills immediately afterwards -----------------------------------
 *
 * Linking writes nothing to a goal by itself, so a person who linked twenty-six
 * rows and saw twenty-six unchanged cells would reasonably conclude it had not
 * worked. The writeback that follows spends no quota — it reads snapshots we
 * already hold — and runs with THIS person as its principal, which is what lets
 * a starting point land for somebody who may set one.
 */

const REASON_TEXT = {
  ambiguous:
    'matches more than one tracked keyword — pick the right one on the row itself',
  'no-match': 'no tracked keyword has this name',
  'linked-elsewhere': 'already pointed at a different keyword',
};

/** "12 → 9" for a rank that moved, "—" for one that is not in the top 100. */
const positionText = (proposal) => {
  if (proposal.position === null) return 'not ranking';
  if (proposal.previousPosition === null) return `#${proposal.position}`;
  if (proposal.previousPosition === proposal.position) return `#${proposal.position}`;
  return `#${proposal.previousPosition} → #${proposal.position}`;
};

const GoalBulkLinkModal = ({
  open,
  boardId,
  monthKey,
  monthLabel,
  /** groupId → its name, so this screen does not refetch what the tab has. */
  groupNames = new Map(),
  onClose,
  /** Called once anything actually changed, so the tab re-reads goals + links. */
  onLinked,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setLoading(true);
    setError(null);
    setResult(null);

    getGoalLinkMatches(boardId, monthKey)
      .then((payload) => {
        if (!alive) return;
        setData(payload);
        // Ticked by default: a fresh, unambiguous match. NOT a row already
        // pointed somewhere else — taking that one replaces a choice somebody
        // made by hand, and it must be a deliberate click.
        setChecked(
          new Set(
            payload.groups
              .flatMap((g) => g.proposals)
              .filter((p) => !p.alreadyLinked && !p.relinkFrom)
              .map((p) => p.goal)
          )
        );
      })
      .catch((err) => {
        if (!alive) return;
        setError(err?.response?.data?.error || 'Could not read this month’s keywords.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [open, boardId, monthKey]);

  const toggle = useCallback((goalId) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(goalId)) next.delete(goalId);
      else next.add(goalId);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((group, on) => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const p of group.proposals) {
        if (on) next.add(p.goal);
        else next.delete(p.goal);
      }
      return next;
    });
  }, []);

  /**
   * The chosen pairs, grouped by provider — the write endpoint is per connector
   * because a link names one, and a board may have two.
   */
  const chosenByProvider = useMemo(() => {
    const out = new Map();
    // A link is UNIQUE per goal, so a row offered under two connectors — a
    // group mapped to a project on each — must be sent to one of them, not to
    // both in sequence where the second silently undoes the first.
    const claimed = new Set();
    for (const group of data?.groups || []) {
      for (const p of group.proposals) {
        if (!checked.has(p.goal) || claimed.has(p.goal)) continue;
        claimed.add(p.goal);
        if (!out.has(group.provider)) out.set(group.provider, []);
        out.get(group.provider).push({ goal: p.goal, keyword: p.keyword });
      }
    }
    return out;
  }, [data, checked]);

  const chosenCount = useMemo(
    () => [...chosenByProvider.values()].reduce((n, rows) => n + rows.length, 0),
    [chosenByProvider]
  );

  /**
   * Which cells a link will actually fill. A board with projects mapped, links
   * made and NO field mapping fills nothing at all, and that is worth saying
   * before twenty-six links are made rather than after.
   */
  const keywordFills = useMemo(
    () => (data?.mappedFields || []).filter((f) => f.scope === 'keyword'),
    [data]
  );

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const linked = [];
      const skipped = [];
      const reports = [];

      for (const [provider, rows] of chosenByProvider) {
        const res = await bulkSetGoalLinks(boardId, provider, rows);
        linked.push(...(res.linked || []));
        skipped.push(...(res.skipped || []));

        // Fill from what we already hold. Spends no quota, and runs with this
        // person as the principal.
        try {
          reports.push(await runConnectorWriteback(boardId, provider, { month: monthKey }));
        } catch {
          // The links are real either way. A writeback that failed is worth
          // saying, not worth undoing twenty-six links over.
          reports.push(null);
        }
      }

      setResult({
        linked: linked.length,
        skipped,
        written: reports.reduce((n, r) => n + (r?.written || 0), 0),
        suggested: reports.reduce((n, r) => n + (r?.suggested || 0), 0),
        fillFailed: reports.some((r) => r === null),
        notes: [...new Set(reports.flatMap((r) => r?.notes || []))],
      });
      onLinked?.();
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not link those goals.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const groups = data?.groups || [];
  const totalProposals = groups.reduce((n, g) => n + g.proposals.length, 0);

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={`Link ${monthLabel || 'this month'}’s goals to their keywords`}
      maxWidth={720}
      footer={
        <div className="flex items-center justify-end gap-2 w-full">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {result ? 'Done' : 'Cancel'}
          </Button>
          {!result && (
            <Button icon={Link2} onClick={submit} disabled={saving || !chosenCount}>
              {saving
                ? 'Linking…'
                : `Link ${chosenCount} goal${chosenCount === 1 ? '' : 's'} and fill now`}
            </Button>
          )}
        </div>
      }
    >
      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : result ? (
        <div className="flex flex-col gap-3">
          <p
            className="font-body flex items-start gap-2"
            style={{ fontSize: 13.5, color: 'var(--color-text-primary)' }}
          >
            <Check size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              Linked <strong>{result.linked}</strong> goal
              {result.linked === 1 ? '' : 's'}
              {result.fillFailed
                ? '. The links are saved, but filling them did not run — press Fill goals now under Add-ons.'
                : ` and filled ${result.written} cell${result.written === 1 ? '' : 's'}.`}
            </span>
          </p>
          {result.suggested > 0 && (
            <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
              {result.suggested} value{result.suggested === 1 ? ' was' : 's were'} offered
              rather than written — those cells are either edited by hand or need
              permission to change what was promised. They appear as an amber pill on the
              row.
            </p>
          )}
          {result.notes.map((note) => (
            <p
              key={note}
              className="font-body"
              style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
            >
              {note}
            </p>
          ))}
          {result.skipped.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {result.skipped.map((s) => (
                <li
                  key={s.goal}
                  className="font-body"
                  style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                >
                  {s.name ? `“${s.name}”` : s.goal} — {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : groups.length === 0 ? (
        <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          No group on this board is mapped to a connector project yet. Map one under{' '}
          <strong>Add-ons</strong> first — a goal can only be about a keyword the connector
          is actually tracking for this client.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
            Matched by name — exactly, ignoring only capitals and extra spaces. Read the
            pairs before you take them: a keyword on the wrong row produces a number that
            looks entirely plausible.
          </p>

          {keywordFills.length === 0 ? (
            <p
              className="font-body flex items-start gap-1.5 px-3 py-2.5"
              style={{
                fontSize: 12.5,
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-bg-subtle)',
                color: 'var(--color-warning-text, #92400E)',
              }}
            >
              <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                Linking will fill nothing yet — no connector value is mapped to a goal cell
                on this board. Map <strong>Current rank → Result</strong> under{' '}
                <strong>Add-ons → Field mapping</strong>, then the rows fill themselves
                here and on every sync after.
              </span>
            </p>
          ) : (
            <p
              className="font-body px-3 py-2.5"
              style={{
                fontSize: 12.5,
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-bg-subtle)',
                color: 'var(--color-text-muted)',
              }}
            >
              Each linked row will fill:{' '}
              {keywordFills.map((f) => `${f.label} → ${f.targetLabel}`).join(' · ')}
            </p>
          )}

          {groups.map((group) => {
            const allOn =
              group.proposals.length > 0 &&
              group.proposals.every((p) => checked.has(p.goal));
            return (
              <div key={group.group}>
                <div className="flex items-baseline justify-between gap-3">
                  <p
                    className="font-body font-medium truncate"
                    style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                  >
                    {groupNames.get(String(group.group)) || group.projectName || 'Group'}
                  </p>
                  {group.proposals.length > 0 && (
                    <button
                      type="button"
                      onClick={() => toggleGroup(group, !allOn)}
                      className="font-body shrink-0"
                      style={{ fontSize: 12, color: 'var(--color-accent)' }}
                    >
                      {allOn ? 'Clear all' : 'Select all'}
                    </button>
                  )}
                </div>
                <p
                  className="font-body mt-0.5"
                  style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                >
                  {group.projectName || group.domain}
                  {group.collectedOn ? ` · rankings collected ${group.collectedOn}` : ''}
                  {` · ${group.keywordCount} tracked keyword${group.keywordCount === 1 ? '' : 's'}`}
                </p>

                {group.missing && (
                  <p
                    className="font-body flex items-start gap-1.5 mt-1.5"
                    style={{ fontSize: 12, color: 'var(--color-warning-text, #92400E)' }}
                  >
                    <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                    This project no longer exists at the provider. Its history is kept, but
                    nothing new will arrive for it.
                  </p>
                )}

                {group.proposals.length > 0 && (
                  <ul
                    className="mt-2 overflow-y-auto"
                    style={{
                      maxHeight: 260,
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                    }}
                  >
                    {group.proposals.map((p) => (
                      <li key={p.goal}>
                        <label
                          className="flex items-center gap-2.5 px-3 py-2 cursor-pointer font-body"
                          style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                        >
                          <input
                            type="checkbox"
                            checked={checked.has(p.goal)}
                            onChange={() => toggle(p.goal)}
                            disabled={saving}
                          />
                          <span className="truncate" style={{ flex: '1 1 40%' }}>
                            {p.name}
                          </span>
                          <span
                            className="truncate"
                            style={{ flex: '1 1 40%', color: 'var(--color-text-secondary)' }}
                          >
                            → {p.keyword}
                          </span>
                          <span
                            className="shrink-0 tabular-nums"
                            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                          >
                            {positionText(p)}
                          </span>
                        </label>
                        {(p.alreadyLinked || p.relinkFrom) && (
                          <p
                            className="font-body px-3 pb-1.5"
                            style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                          >
                            {p.alreadyLinked
                              ? 'Already linked to this keyword — re-linking would discard what the connector remembers about these cells.'
                              : `Currently linked to “${p.relinkFrom}”. Taking this replaces that choice.`}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {group.unmatched.length > 0 && (
                  <details className="mt-2">
                    <summary
                      className="font-body cursor-pointer"
                      style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                    >
                      {group.unmatched.length} goal
                      {group.unmatched.length === 1 ? '' : 's'} left for you to link by hand
                    </summary>
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {group.unmatched.map((u) => (
                        <li
                          key={u.goal}
                          className="font-body"
                          style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                        >
                          “{u.name}” — {REASON_TEXT[u.reason] || u.reason}
                          {u.linkedTo ? ` (“${u.linkedTo}”)` : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          })}

          {totalProposals === 0 && (
            <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              Nothing matched by name. Link these rows one at a time from the chain icon on
              each goal — the keyword picker there takes a phrase typed by hand too.
            </p>
          )}

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

export default GoalBulkLinkModal;
