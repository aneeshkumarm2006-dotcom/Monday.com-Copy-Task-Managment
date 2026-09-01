import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, CopyPlus, TriangleAlert } from 'lucide-react';

import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Dropdown from '../../ui/Dropdown';
import Spinner from '../../ui/Spinner';
import { Toggle } from '../../ui/FormControls';
import { carryForwardGoals } from '../../../services/goalService';

/**
 * "Next month's goals are the same goals." — the manual carry-forward.
 *
 * ---- Why this is a screen and not a button ---------------------------------
 *
 * Copying ninety-six promises into a month nobody is looking at is exactly the
 * kind of act that should not happen on one unconfirmed click. So the flow is
 * PROPOSE then CONFIRM, the same shape as `GoalBulkLinkModal`: the server plans
 * the whole carry with `dryRun`, this screen shows the plan as the table the
 * user already recognises, and only what is still ticked is sent back.
 *
 * The preview comes from the server's own planner rather than being recomputed
 * here. That matters more than it looks: "is this goal already in October?" is
 * decided by a normalised name key, and a second implementation of that rule on
 * the client would disagree the first time somebody renamed a row — showing a
 * copy that was about to be skipped, or hiding one that was about to be made.
 *
 * ---- Why it is not automatic ------------------------------------------------
 *
 * There is deliberately no "always carry forward" switch anywhere in this
 * feature. A goal is a promise a team makes, and a promise that renews itself
 * while nobody is watching is not a promise. Somebody decides last month's
 * targets still stand, and this is where they say so.
 */

/** What a skipped row gets told about itself. */
const SKIP_TEXT = {
  exists: (s, monthLabel) => `already in ${monthLabel}`,
  'group-gone': () => 'its group is no longer on this board',
  full: () => 'that group is already full',
  required: (s) => `“${s.detail || 'a column'}” is required and this row has no value for it`,
  'bad-type': (s) => s.detail || 'this goal can no longer be scored',
};

const describeSkip = (skip, monthLabel) =>
  (SKIP_TEXT[skip.reason] || (() => skip.reason))(skip, monthLabel);

const GoalCarryForwardModal = ({
  open,
  boardId,
  /** The month being copied FROM — whatever the tab is showing. */
  fromMonth,
  fromLabel,
  /** The board's month list, from `/months`. */
  months = [],
  /** Group ids in board order, so the preview reads like the tab above it. */
  groupOrder = [],
  onClose,
  /** Called after a successful carry, with the month the rows landed in. */
  onCarried,
  /** Jump the board to the target month. Offered once, after the copy. */
  onGoToMonth,
}) => {
  // Next month is the answer nine times out of ten, and the tenth is filling in
  // a month somebody skipped — so every other month the board has is offered,
  // in both directions, rather than only the one ahead.
  const defaultTarget = useMemo(() => {
    const ordered = months.map((m) => m.key).sort();
    const idx = ordered.indexOf(fromMonth);
    return ordered[idx + 1] || ordered[idx - 1] || '';
  }, [months, fromMonth]);

  const [picked, setPicked] = useState(null);
  const toMonth = picked ?? defaultTarget;

  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  const [rollBaseline, setRollBaseline] = useState(false);
  const [carryLinks, setCarryLinks] = useState(true);
  // Which rows are still ticked. Seeded from the plan every time it reloads,
  // because a plan for a different month is a different set of rows and keeping
  // the old ticks would silently carry a selection the user cannot see.
  const [checked, setChecked] = useState(() => new Set());

  const targetLabel = useMemo(
    () => months.find((m) => m.key === toMonth)?.label || 'the next month',
    [months, toMonth]
  );

  const monthOptions = useMemo(
    () => months.filter((m) => m.key !== fromMonth).map((m) => ({ value: m.key, label: m.label })),
    [months, fromMonth]
  );

  /**
   * The plan, from the server. Deliberately re-run whenever the target month
   * changes — what already exists over there is the whole question, and it is a
   * different answer for every month.
   *
   * `rollBaseline` is NOT a dependency: it changes the numbers a copied row
   * carries, never which rows travel, so re-planning on it would be a request
   * per toggle for an identical list.
   */
  const loadPreview = useCallback(async () => {
    if (!boardId || !fromMonth || !toMonth) return;
    setLoading(true);
    setError(null);
    try {
      const data = await carryForwardGoals(boardId, {
        fromMonth,
        toMonth,
        carryLinks: true,
        dryRun: true,
      });
      setPreview(data);
      setChecked(new Set((data.plan || []).map((p) => p.sourceId)));
    } catch (err) {
      setPreview(null);
      setError(err?.response?.data?.error || 'Could not work out what to carry forward.');
    } finally {
      setLoading(false);
    }
  }, [boardId, fromMonth, toMonth]);

  useEffect(() => {
    if (open) loadPreview();
  }, [open, loadPreview]);

  const toggle = (id) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * The plan and the skips, folded into the board's own group order.
   *
   * The server sorts a month's goals by `order` across the whole board, so rows
   * from three groups interleave. Regrouping here is what makes the preview
   * read like the table it came from.
   */
  const sections = useMemo(() => {
    if (!preview) return [];
    const byGroup = new Map();
    const section = (id, name) => {
      const key = String(id);
      if (!byGroup.has(key)) {
        byGroup.set(key, { group: key, name: name || 'Group', rows: [], skipped: [] });
      }
      return byGroup.get(key);
    };
    for (const row of preview.plan || []) section(row.group, row.groupName).rows.push(row);
    for (const row of preview.skipped || []) section(row.group, row.groupName).skipped.push(row);

    const rank = new Map(groupOrder.map((id, i) => [String(id), i]));
    return [...byGroup.values()].sort(
      (a, b) => (rank.get(a.group) ?? 1e6) - (rank.get(b.group) ?? 1e6)
    );
  }, [preview, groupOrder]);

  const linkable = useMemo(
    () => (preview?.plan || []).filter((p) => p.hasLink).length,
    [preview]
  );
  const linksBlocked = !!preview?.links?.blocked;
  const chosenCount = checked.size;
  const totalSkipped = preview?.skipped?.length || 0;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await carryForwardGoals(boardId, {
        fromMonth,
        toMonth,
        goalIds: [...checked],
        rollBaseline,
        carryLinks,
      });
      setResult(data);
      onCarried?.(data);
    } catch (err) {
      setError(err?.response?.data?.error || 'Those goals did not carry forward.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={`Carry ${fromLabel || 'this month'}’s goals forward`}
      maxWidth={640}
      footer={
        <div className="flex items-center justify-end gap-2 w-full">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {result ? (
            result.copied > 0 && onGoToMonth && (
              <Button
                icon={ArrowRight}
                onClick={() => { onGoToMonth(result.toMonth); onClose(); }}
              >
                Go to {targetLabel}
              </Button>
            )
          ) : (
            <Button
              icon={CopyPlus}
              onClick={submit}
              disabled={saving || loading || !chosenCount || !toMonth}
            >
              {saving
                ? 'Carrying…'
                : `Carry ${chosenCount} goal${chosenCount === 1 ? '' : 's'} to ${targetLabel}`}
            </Button>
          )}
        </div>
      }
    >
      {result ? (
        <div className="flex flex-col gap-3">
          <p
            className="font-body flex items-start gap-2"
            style={{ fontSize: 13.5, color: 'var(--color-text-primary)' }}
          >
            <Check size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              Copied <strong>{result.copied}</strong> goal{result.copied === 1 ? '' : 's'} into{' '}
              {targetLabel}
              {result.links?.carried > 0
                ? `, with ${result.links.carried} keyword link${result.links.carried === 1 ? '' : 's'}`
                : ''}
              . Every one of them is waiting for its result — nothing was reported for you.
            </span>
          </p>
          {result.skipped?.length > 0 && (
            <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
              {result.skipped.length} row{result.skipped.length === 1 ? ' was' : 's were'} left
              behind — mostly ones already in {targetLabel}.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Dropdown
            label="Copy into"
            value={toMonth}
            options={monthOptions}
            onChange={(v) => { setPicked(v); setResult(null); }}
            placeholder="Pick a month"
            disabled={saving}
          />

          <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
            Only what was <strong>promised</strong> travels — the name, the kind of goal, the
            target, the owner and the importance. What each goal actually landed on stays in{' '}
            {fromLabel || 'this month'}, so every copied row arrives waiting for its own
            number. A goal already in {targetLabel} is left alone rather than duplicated, so
            running this twice is safe.
          </p>

          {loading ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : (
            <>
              <div className="flex flex-col gap-2.5">
                <Toggle
                  checked={rollBaseline}
                  onChange={setRollBaseline}
                  disabled={saving}
                  label={`Start from where ${fromLabel || 'this month'} finished`}
                />
                <p
                  className="font-body"
                  style={{ fontSize: 11.5, color: 'var(--color-text-muted)', marginTop: -4 }}
                >
                  For “move a number” goals only: the copy takes this month’s result as its
                  new starting point, keeping the same target. Rows with no result reported
                  keep the starting point they have.
                </p>

                {linkable > 0 && (
                  <Toggle
                    checked={carryLinks}
                    onChange={setCarryLinks}
                    disabled={saving}
                    label={`Bring the keyword links too (${linkable})`}
                  />
                )}
                {linksBlocked && (
                  <p
                    className="font-body flex items-start gap-1.5"
                    style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                  >
                    <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                    The keyword links will stay behind — moving connector wiring needs
                    permission to manage connectors on this board. The goals themselves
                    carry fine.
                  </p>
                )}
              </div>

              {sections.length === 0 ? (
                <p
                  className="font-body"
                  style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
                >
                  There is nothing in {fromLabel || 'this month'} to carry forward yet.
                </p>
              ) : (
                sections.map((section) => {
                  const allOn =
                    section.rows.length > 0 && section.rows.every((r) => checked.has(r.sourceId));
                  return (
                    <div key={section.group}>
                      <div className="flex items-baseline justify-between gap-3">
                        <p
                          className="font-body font-medium truncate"
                          style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                        >
                          {section.name}
                        </p>
                        {section.rows.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setChecked((prev) => {
                              const next = new Set(prev);
                              section.rows.forEach((r) => (
                                allOn ? next.delete(r.sourceId) : next.add(r.sourceId)
                              ));
                              return next;
                            })}
                            className="font-body shrink-0"
                            style={{ fontSize: 12, color: 'var(--color-accent)' }}
                          >
                            {allOn ? 'Clear all' : 'Select all'}
                          </button>
                        )}
                      </div>

                      {section.rows.length > 0 && (
                        <ul
                          className="mt-2 overflow-y-auto"
                          style={{
                            maxHeight: 240,
                            border: '1px solid var(--color-border)',
                            borderRadius: 'var(--radius-md)',
                          }}
                        >
                          {section.rows.map((row) => (
                            <li key={row.sourceId}>
                              <label
                                className="flex items-center gap-2.5 px-3 py-2 cursor-pointer font-body"
                                style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked.has(row.sourceId)}
                                  onChange={() => toggle(row.sourceId)}
                                  disabled={saving}
                                />
                                <span className="truncate flex-1">{row.name}</span>
                                {row.hasLink && carryLinks && !linksBlocked && (
                                  <span
                                    className="shrink-0 font-body"
                                    style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                                  >
                                    + link
                                  </span>
                                )}
                              </label>
                            </li>
                          ))}
                        </ul>
                      )}

                      {section.skipped.length > 0 && (
                        <ul className="mt-1.5 flex flex-col gap-0.5">
                          {section.skipped.map((skip) => (
                            <li
                              key={skip.goalId}
                              className="font-body"
                              style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                            >
                              “{skip.name}” — {describeSkip(skip, targetLabel)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })
              )}

              {totalSkipped > 0 && (
                <p className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
                  {totalSkipped} row{totalSkipped === 1 ? '' : 's'} will not travel, for the
                  reasons above.
                </p>
              )}
            </>
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

export default GoalCarryForwardModal;
