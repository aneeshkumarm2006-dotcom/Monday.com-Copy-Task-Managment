import { useState } from 'react';
import { Languages } from 'lucide-react';

import Dropdown from '../../ui/Dropdown';
import useToastStore from '../../../store/toastStore';
import { updateBoard } from '../../../services/boardService';

/**
 * Which WORDING this board's Goals tab uses.
 *
 * ---- What this changes, and what it cannot ---------------------------------
 *
 * Labels and examples on the "what kind of goal is this?" cards, and nothing
 * else. The seven kinds, how each is set up, and how each is scored are
 * identical across every vocabulary — `goalTypes.test.js` asserts that rather
 * than trusting it. So switching a board over never re-scores a goal that
 * already exists, and never strands one: a goal created as "Move a number"
 * is the same goal, shown as "Target".
 *
 * That is the whole reason this is safe to put behind a plain dropdown with no
 * confirmation step. If it could change scoring it would need one.
 *
 * ---- Why the BOARD OWNER, not an org admin ---------------------------------
 *
 * Goal COLUMNS gate on `org.manage_settings`, because a column is a reporting
 * field an agency compares clients across — one org-wide vocabulary is the
 * point of it. Wording is the opposite: an Ads board calling a type "Target"
 * while an SEO board calls it "Move a number" IS the feature, so making the org
 * sign off on it puts the decision in the wrong place. It is equally not
 * `goal.manage`, which every member at the `edit` rung holds — any of them
 * could then rename the type cards under everyone else on the board.
 *
 * `canManageAccess` is the board's creator, anyone the creator granted full
 * access, and the matrix overrides that resolve to owner-equivalent. The server
 * enforces exactly the same test; this only decides whether to offer the
 * control, because hiding a button is a courtesy and never a control.
 */

/**
 * The default is deliberately NOT called "SEO". It is the wording every board
 * has had since before vocabularies existed, it reads correctly for SEO, client
 * work and internal ops alike, and labelling it for one trade would imply the
 * other trades need their own entry before they can use it.
 */
const OPTIONS = [
  { value: '', label: 'Standard — Move a number, Tick off a list…' },
  { value: 'ads', label: 'Ads — Target, Limit, Count…' },
];

const GoalVocabularyCard = ({ boardId, goalVocabulary, canManage, onChanged }) => {
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  const [busy, setBusy] = useState(false);
  const value = goalVocabulary || '';

  const save = async (next) => {
    if (next === value) return;
    setBusy(true);
    try {
      // '' is the default wording. The server stores it as null so there is one
      // representation of "default" rather than two that both have to be
      // checked for; it is sent as an empty string because that is what the
      // <select> holds, and the server is the place that normalises.
      const board = await updateBoard(boardId, { goalVocabulary: next });
      onChanged?.(board);
      toastSuccess(
        next === 'ads'
          ? 'Goals on this board now use the Ads wording.'
          : 'Goals on this board are back to the standard wording.'
      );
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not change that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex flex-col gap-3 p-4"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--color-bg-surface)',
      }}
    >
      <div className="flex items-start gap-3">
        <Languages size={18} aria-hidden="true" style={{ color: 'var(--color-text-secondary)', flexShrink: 0, marginTop: 2 }} />
        <div className="min-w-0">
          <p
            className="font-body font-semibold"
            style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
          >
            Goal wording
          </p>
          <p
            className="font-body mt-1"
            style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}
          >
            What the seven kinds of goal are called on this board. Only the names
            and examples change — how a goal is set up and scored is the same
            either way, so goals you have already written keep their meaning.
          </p>
        </div>
      </div>

      <Dropdown
        options={OPTIONS}
        value={value}
        onChange={save}
        disabled={!canManage || busy}
        ariaLabel="Goal wording for this board"
      />

      {!canManage && (
        <p
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          Only the board’s owner can change this.
        </p>
      )}
    </div>
  );
};

export default GoalVocabularyCard;
