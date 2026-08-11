import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

import { OptionList, OptionRow } from '../../ui/FilterControls';
import { Toggle } from '../../ui/FormControls';

/**
 * "Which clients does this tracker watch?"
 *
 * AutomationsModal gets away with a single `<select>` because it picks one
 * group. Twenty clients need search, All/None, and a scrolling checkbox list —
 * so this reuses OptionRow/OptionList from FilterControls verbatim, giving it
 * the same checkbox, the same role="option" and the same keyboard behaviour as
 * every filter in the app.
 *
 * The switch on top matters more than it looks: `groups: []` means EVERY group
 * on the server, including ones added later. For an agency whose client list
 * grows monthly, that is the setting they actually want, and picking twenty
 * checkboxes silently excludes client twenty-one.
 */

const GroupMultiSelect = ({ groups, value, allGroups, onChange, onAllGroupsChange, disabled }) => {
  const [query, setQuery] = useState('');
  const selected = new Set((value || []).map(String));

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(needle));
  }, [groups, query]);

  return (
    <div>
      <label
        className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        Which clients
      </label>

      <div className="flex items-baseline gap-2 mb-2 flex-wrap">
        <Toggle
          checked={allGroups}
          onChange={onAllGroupsChange}
          disabled={disabled}
          label="Track every client on this board"
        />
        <span className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
          — including ones added later
        </span>
      </div>

      <div
        style={{
          border: '1.5px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-bg-input)',
          opacity: allGroups ? 0.5 : 1,
          pointerEvents: allGroups ? 'none' : 'auto',
        }}
      >
        <div
          className="flex items-center gap-2 px-2"
          style={{ height: 38, borderBottom: '1px solid var(--color-border)' }}
        >
          <Search size={13} color="var(--color-text-muted)" aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${groups.length} clients…`}
            disabled={disabled}
            aria-label="Search clients"
            className="flex-1 min-w-0 font-body bg-transparent focus:outline-none"
            style={{ fontSize: 13, color: 'var(--color-text-primary)', border: 'none' }}
          />
          <button
            type="button"
            onClick={() => onChange(groups.map((g) => String(g._id)))}
            className="font-body"
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--color-accent)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => onChange([])}
            className="font-body"
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--color-text-muted)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            None
          </button>
        </div>

        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label="Clients this tracker watches"
          style={{ maxHeight: 200, overflowY: 'auto', padding: 4 }}
        >
          <OptionList emptyLabel="No client matches that name">
            {filtered.map((g) => (
              <OptionRow
                key={g._id}
                checked={selected.has(String(g._id))}
                onToggle={() => {
                  const next = new Set(selected);
                  if (next.has(String(g._id))) next.delete(String(g._id));
                  else next.add(String(g._id));
                  onChange(Array.from(next));
                }}
              >
                <span className="font-body truncate block" style={{ fontSize: 13 }}>
                  {g.name}
                </span>
              </OptionRow>
            ))}
          </OptionList>
        </div>
      </div>

      <p className="font-body mt-1.5" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
        {allGroups
          ? `All ${groups.length} clients, now and in future`
          : `${selected.size} of ${groups.length} selected`}
      </p>
    </div>
  );
};

export default GroupMultiSelect;
