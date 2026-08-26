import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleHelp, CircleOff, Plus, Sparkles, TriangleAlert, Wand2 } from 'lucide-react';

import Button from '../../ui/Button';
import Dropdown from '../../ui/Dropdown';
import Spinner from '../../ui/Spinner';
import useToastStore from '../../../store/toastStore';
import GoalColumnsModal from '../goals/GoalColumnsModal';
import { listGoalColumns } from '../../../services/goalService';
import {
  getConnectorFields,
  setConnectorFieldMapping,
  clearConnectorFieldMapping,
  runConnectorWriteback,
} from '../../../services/connectorService';

/**
 * Field mapping — which connector value fills which goal cell.
 *
 * ---- Why this screen exists at all -----------------------------------------
 *
 * The obvious version of the whole feature has no screen: a writeback service
 * that says `goal.actual = position` and `columnValues[volume] = volume`. That
 * works exactly once, on one board, for one trade. The three SEO boards in this
 * workspace already disagree with each other — disjoint goal-column ids, and the
 * difficulty column spelled `keyword_difficultly` on one and `keyword_difficulty`
 * on the other two — so a hardcoded binding would fill one board and silently
 * skip two, and the skip is indistinguishable from "the sync has not run yet".
 *
 * So the binding is data a person makes here, and the Ads boards get the same
 * machinery with their own vocabulary rather than a second implementation.
 *
 * ---- Nothing here decides anything ------------------------------------------
 *
 * Every rule on this screen came from the server. Which targets exist, which are
 * compatible, and the SENTENCE explaining a refusal are all computed by
 * `checkCompatibility` on the way out — the same function the save path runs. A
 * greyed-out option and a rejected save are one decision made once. If you are
 * tempted to add `if (field.type !== column.type)` here, that is the reason not
 * to: two implementations of a rule agree until the day they quietly do not.
 *
 * ---- Why an incompatible option is SHOWN, not hidden ------------------------
 *
 * Same reasoning as the already-mapped groups in the project list next door. A
 * choice that vanishes leaves somebody wondering where their column went; a
 * choice that is present, disabled, and carries "Search intent is text, and
 * “Volume” holds a number" tells them which half they got wrong.
 */

/**
 * Fixed copy. Never the provider's own error text, which is uncontrolled.
 *
 * A mapping alone still fills nothing, and that is the sentence people need:
 * the other half of the wiring is per ROW — which keyword each goal is about —
 * and it is made on the Goals tab. Somebody who maps six fields here and then
 * watches a month go by with empty cells has been failed by this paragraph.
 */
const HOW_IT_FILLS =
  'A mapping says WHERE a value lands. Which keyword each goal is about is said ' +
  'on the Goals tab, one row at a time — link a goal there and these cells start ' +
  'filling themselves.';

/**
 * A column type for a source type, for the "Add a column for this" shortcut.
 * The server refuses anything else, so this is the shape that will be accepted
 * rather than a guess the user then has to correct.
 */
const COLUMN_TYPE_FOR = {
  number: 'number',
  text: 'text',
  date: 'date',
  link: 'link',
};

const FieldMappingPanel = ({
  boardId,
  provider,
  providerLabel,
  canManage = false,
  canManageColumns = false,
  /** Called after a goal column is created here, so the tab can refresh. */
  onColumnsChanged,
}) => {
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Per-field, so one row saving never freezes the rest of the panel.
  const [savingField, setSavingField] = useState(null);
  /**
   * The "Add a column for this" flow: which field asked for it, and the board's
   * real column list to hand the modal.
   *
   * The columns are fetched HERE rather than reconstructed from `targets`,
   * because the modal also renders each column's `required` toggle and its
   * archive state — neither of which belongs on a connector payload, and both of
   * which would be wrong if guessed. One request, only when the button is
   * pressed.
   */
  const [columnFor, setColumnFor] = useState(null);
  const [goalColumns, setGoalColumns] = useState([]);
  /** The last "Fill goals now" report, rendered under the blurb. */
  const [writeback, setWriteback] = useState(null);
  const [filling, setFilling] = useState(false);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!boardId || !provider) return;
      if (!quiet) setLoading(true);
      try {
        setData(await getConnectorFields(boardId, provider));
        setError(null);
      } catch (err) {
        setError(
          err?.response?.data?.error ||
            'Could not load the field list for this connector.'
        );
      } finally {
        setLoading(false);
      }
    },
    [boardId, provider]
  );

  useEffect(() => {
    load();
  }, [load]);

  /** sourceField → the mapping row, so a row can find its own binding. */
  const mappingByField = useMemo(
    () => new Map((data?.mappings || []).map((m) => [m.sourceField, m])),
    [data]
  );

  /** targetId → the resolved target, for naming what a mapping points at. */
  const targetById = useMemo(
    () => new Map((data?.targets || []).map((t) => [t.id, t])),
    [data]
  );

  /**
   * Fields grouped by the snapshot kind that carries them, in the catalog's own
   * order. A flat list of two dozen fields is a wall; grouped by "Rank
   * tracking", "Keywords", "Traffic" it reads like the tab it feeds.
   */
  const groups = useMemo(() => {
    const kinds = data?.provider?.kinds || [];
    const byKind = new Map(kinds.map((k) => [k.key, { kind: k, fields: [] }]));
    for (const field of data?.fields || []) {
      if (!byKind.has(field.kind)) {
        // A field naming a kind the catalog did not send. Listed under its own
        // key rather than dropped — an invisible field is a mapping nobody can
        // make and nobody can see is missing.
        byKind.set(field.kind, {
          kind: { key: field.kind, label: field.kind, blurb: '' },
          fields: [],
        });
      }
      byKind.get(field.kind).fields.push(field);
    }
    return [...byKind.values()].filter((g) => g.fields.length > 0);
  }, [data]);

  const mappedCount = data?.mappings?.length || 0;

  /**
   * Fill the linked goals from the snapshots we already hold.
   *
   * Reports rather than toasts, because the interesting number is the one it
   * did NOT write: a run that filled eleven cells and offered three is telling
   * you that three rows have been edited by hand since the connector last owned
   * them, and that sentence is worth leaving on screen rather than sliding away
   * after four seconds.
   */
  const fillGoalsNow = async () => {
    setFilling(true);
    try {
      const report = await runConnectorWriteback(boardId, provider);
      setWriteback(report);
      if (report.written > 0) {
        toastSuccess(
          `${report.written} goal cell${report.written === 1 ? '' : 's'} filled.`
        );
      }
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not fill the goals.');
    } finally {
      setFilling(false);
    }
  };

  const save = async (field, targetId) => {
    setSavingField(field.key);
    try {
      if (!targetId) {
        await clearConnectorFieldMapping(boardId, provider, field.key);
      } else {
        await setConnectorFieldMapping(boardId, provider, field.key, { targetId });
      }
      await load({ quiet: true });
    } catch (err) {
      // The server's own sentence, in place. A refusal here is INFORMATION —
      // "Search intent is text, and “Volume” holds a number" — and it is the
      // whole reason the check runs at configuration time rather than at 3am.
      toastError(err?.response?.data?.error || 'Could not save that mapping.');
    } finally {
      setSavingField(null);
    }
  };

  /**
   * A column created through the shortcut is bound immediately.
   *
   * Creating a column and then hunting for it in a dropdown is two screens for
   * one intention. The modal hands the new column back, so this is one flow.
   */
  const bindNewColumn = async (field, column) => {
    onColumnsChanged?.();
    await save(field, `column:${column._id}`);
    toastSuccess(`“${column.name}” created and mapped to ${field.label}.`);
  };

  /** Open the shortcut, with the board's real columns behind it. */
  const openColumnShortcut = async (field) => {
    try {
      const { columns } = await listGoalColumns(boardId);
      setGoalColumns(columns || []);
    } catch {
      // The modal is still usable for ADDING one, which is what was asked for.
      setGoalColumns([]);
    }
    setColumnFor(field);
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <p
        className="font-body px-4 py-4"
        style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
      >
        {error}
      </p>
    );
  }

  return (
    <div style={{ borderTop: '1px solid var(--color-border)' }}>
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <p className="font-body text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Field mapping
          </p>
          <p
            className="font-body mt-0.5"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            Say where each {providerLabel || 'connector'} value should land on a
            goal. {mappedCount === 0 ? 'Nothing is mapped yet. ' : ''}
            {HOW_IT_FILLS}
          </p>
          {writeback && (
            <p
              className="font-body mt-1"
              style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
            >
              {writeback.linked === 0
                ? 'No goal on this board is linked to a keyword yet, so there was nothing to fill.'
                : `${writeback.written} cell${writeback.written === 1 ? '' : 's'} filled across ` +
                  `${writeback.linked} linked goal${writeback.linked === 1 ? '' : 's'}` +
                  (writeback.suggested
                    ? `, ${writeback.suggested} offered on rows somebody has edited by hand.`
                    : '.')}
              {writeback.notes?.length ? ` ${writeback.notes[0]}` : ''}
            </p>
          )}
        </div>
        {/* Fills the goals from data we ALREADY HOLD — it reads stored snapshots
            and never calls the provider, which is what makes it a materially
            cheaper button than Refresh at the top of this card. It also runs
            with YOU as the principal, so a starting point the weekly pass could
            only offer (nobody is behind a schedule) actually lands. */}
        {canManage && mappedCount > 0 && (
          <Button
            variant="secondary"
            icon={Wand2}
            onClick={fillGoalsNow}
            disabled={filling}
          >
            {filling ? 'Filling…' : 'Fill goals now'}
          </Button>
        )}
      </div>

      {groups.map(({ kind, fields }) => (
        <section key={kind.key} style={{ borderTop: '1px solid var(--color-border)' }}>
          <div
            className="px-4 py-2"
            style={{ background: 'var(--color-bg-subtle)' }}
          >
            <h4
              className="font-body font-medium"
              style={{
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--color-text-secondary)',
              }}
            >
              {kind.label}
            </h4>
          </div>

          <ul>
            {fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                targets={data.targets}
                targetById={targetById}
                mapping={mappingByField.get(field.key) || null}
                canManage={canManage}
                canManageColumns={canManageColumns}
                saving={savingField === field.key}
                onChange={(targetId) => save(field, targetId)}
                onAddColumn={() => openColumnShortcut(field)}
              />
            ))}
          </ul>
        </section>
      ))}

      {columnFor && (
        <GoalColumnsModal
          boardId={boardId}
          columns={goalColumns}
          // Named and typed to match the field, so the created column is one the
          // server will accept rather than one the user has to correct.
          prefill={{
            name: columnFor.label,
            type: COLUMN_TYPE_FOR[columnFor.type] || 'text',
          }}
          onAdded={(column) => {
            setColumnFor(null);
            bindNewColumn(columnFor, column);
          }}
          onChanged={() => onColumnsChanged?.()}
          onClose={() => {
            setColumnFor(null);
            load({ quiet: true });
          }}
        />
      )}
    </div>
  );
};

/**
 * One provider field and where it goes.
 *
 * Four things this row has to keep distinguishable, because collapsing any of
 * them is what makes a mapping screen confusing:
 *
 *   - a target that is INCOMPATIBLE   — shown, disabled, reason attached
 *   - a target already TAKEN by another field — the server refuses it; the row
 *     says so on save rather than pre-empting, because two panels open at once
 *     would disagree
 *   - a field whose kind this board does not COLLECT — mappable, but it will not
 *     fill, and the row says which
 *   - a field that needs a KEYWORD — mappable, but it fills only once a goal is
 *     linked to a tracked keyword, which is a later phase
 */
const FieldRow = ({
  field,
  targets,
  targetById,
  mapping,
  canManage,
  canManageColumns,
  saving,
  onChange,
  onAddColumn,
}) => {
  const current = mapping?.targetId || '';
  const currentTarget = current ? targetById.get(current) : null;
  const [refusalsOpen, setRefusalsOpen] = useState(false);

  const options = useMemo(() => {
    const rows = [{ value: '', label: 'Not mapped' }];
    for (const target of targets) {
      const refusal = field.refusals?.[target.id];
      // An archived column is offered only when this field is ALREADY on it —
      // otherwise a new binding would fill a cell nobody can see.
      if (target.archived && target.id !== current) continue;
      rows.push({
        value: target.id,
        label: [
          target.label,
          target.archived ? '(hidden)' : null,
          // The permission the mapping implies, on the option itself. Choosing
          // `config.target` changes what was PROMISED rather than recording what
          // happened, which is a materially bigger act than choosing `Result` —
          // and it should not be discovered when the sync refuses.
          target.capability === 'goal.manage' ? '· changes the promise' : null,
        ]
          .filter(Boolean)
          .join(' '),
        disabled: !!refusal,
      });
    }
    return rows;
  }, [targets, field, current]);

  return (
    <li
      className="flex flex-wrap items-start gap-3 px-4 py-3"
      style={{ borderTop: '1px solid var(--color-border)' }}
    >
      <div className="flex-1 min-w-[200px]">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-body text-[13.5px] font-medium text-[color:var(--color-text-primary)]">
            {field.label}
          </p>
          {field.scope === 'keyword' && (
            <Chip
              icon={<Sparkles size={11} aria-hidden="true" />}
              title="Fills once a goal is linked to a tracked keyword."
            >
              per keyword
            </Chip>
          )}
          {!field.collected && (
            <Chip
              icon={<CircleOff size={11} aria-hidden="true" />}
              title="This board does not collect that data, so the cell would stay empty."
            >
              not collected
            </Chip>
          )}
        </div>
        <p
          className="font-body mt-0.5"
          style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          {field.blurb}
        </p>
        {/* A null that is an ANSWER rather than a gap. Said once, here, so the
            eventual cell is not mistaken for a failed sync. */}
        {field.nullMeans && (
          <p
            className="font-body mt-0.5"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
          >
            Empty means: {field.nullMeans}
          </p>
        )}
        {currentTarget?.archived && (
          <p
            className="font-body mt-1 flex items-start gap-1.5"
            style={{ fontSize: 11.5, color: 'var(--color-warning-text, #92400E)' }}
          >
            <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            “{currentTarget.label}” is hidden on this board, so nothing would see
            what lands in it.
          </p>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-1" style={{ width: 296 }}>
        {canManage ? (
          <Dropdown
            size="sm"
            options={options}
            value={current}
            disabled={saving}
            onChange={(value) => onChange(value || null)}
            // Not `label` — a visible heading above every trigger would repeat
            // the same word two dozen times down the list. The row already names
            // the field.
            ariaLabel={`Where ${field.label} goes`}
          />
        ) : (
          <p
            className="font-body"
            style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}
          >
            {currentTarget?.label || 'Not mapped'}
          </p>
        )}

        {/* Both trailing slots keep their width whether or not they render, so
            two dozen dropdowns down the list share one right edge. A control
            that shifts the row it is in is how a long settings list starts
            looking broken. */}
        <span className="shrink-0 flex items-center justify-center" style={{ width: 24 }}>
          {canManage && Object.keys(field.refusals || {}).length > 0 && (
            <RefusalNote
              fieldLabel={field.label}
              refusals={field.refusals}
              targetById={targetById}
              open={refusalsOpen}
              onToggle={() => setRefusalsOpen((v) => !v)}
            />
          )}
        </span>
        <span className="shrink-0 flex items-center justify-center" style={{ width: 32 }}>
          {canManage && canManageColumns && !current && (
            <Button
              variant="ghost"
              size="sm"
              icon={Plus}
              onClick={onAddColumn}
              title={`Create a goal column for ${field.label}`}
              aria-label={`Create a goal column for ${field.label}`}
            />
          )}
        </span>
      </div>

      {refusalsOpen && (
        <RefusalList
          fieldLabel={field.label}
          refusals={field.refusals}
          targetById={targetById}
        />
      )}
    </li>
  );
};

/**
 * Archived columns are not offered in the dropdown, so explaining why they would
 * have been refused is an answer to a question nobody asked.
 */
const visibleRefusals = (refusals, targetById) =>
  Object.entries(refusals || {}).filter(
    ([id]) => targetById.has(id) && !targetById.get(id).archived
  );

/**
 * "Why is that option greyed out?"
 *
 * A single icon rather than a sentence, and it sits next to the dropdown rather
 * than under the row. Most fields on this panel are numbers with the same three
 * refusals, so a full sentence per row would print the same line two dozen times
 * down the list — noise that trains people to stop reading it. The question only
 * arises once somebody has opened the dropdown and found a column greyed, and
 * the answer belongs next to the control that raised it.
 */
const RefusalNote = ({ fieldLabel, refusals, targetById, open, onToggle }) => {
  if (!visibleRefusals(refusals, targetById).length) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title={`Why some columns are unavailable for ${fieldLabel}`}
      aria-label={`Why some columns are unavailable for ${fieldLabel}`}
      className="flex items-center justify-center"
      style={{
        width: 22,
        height: 22,
        borderRadius: 999,
        color: open ? 'var(--color-accent)' : 'var(--color-text-muted)',
      }}
    >
      <CircleHelp size={14} aria-hidden="true" />
    </button>
  );
};

/**
 * The refusals themselves — the server's own sentences, unedited. The panel has
 * no opinion about compatibility and must not acquire one; see the header.
 */
const RefusalList = ({ fieldLabel, refusals, targetById }) => {
  const entries = visibleRefusals(refusals, targetById);
  if (!entries.length) return null;
  return (
    <div
      className="w-full mt-1 px-3 py-2"
      style={{
        background: 'var(--color-bg-subtle)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <p
        className="font-body font-medium mb-1"
        style={{ fontSize: 11.5, color: 'var(--color-text-secondary)' }}
      >
        Where {fieldLabel} cannot go
      </p>
      <ul className="flex flex-col gap-1">
        {entries.map(([id, reason]) => (
          <li
            key={id}
            className="font-body"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
          >
            {reason}
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * A small state label. `icon` is an ELEMENT rather than a component, so the row
 * that uses it reads as one line and the chip has no opinion about sizing.
 */
const Chip = ({ icon, children, title }) => (
  <span
    title={title}
    className="inline-flex items-center gap-1 font-body shrink-0"
    style={{
      fontSize: 11,
      padding: '2px 7px',
      borderRadius: 999,
      background: 'var(--color-bg-subtle)',
      color: 'var(--color-text-muted)',
    }}
  >
    {icon}
    {children}
  </span>
);

export default FieldMappingPanel;
