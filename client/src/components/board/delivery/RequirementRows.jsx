import { Plus, X } from 'lucide-react';
import { REQUIREMENT_TYPES, requirementMeta } from '../../../utils/deliveryTrackers';

/**
 * The AND-list: "All of these must be true".
 *
 * Deliberately prose, not a field label — the whole point of a tracker is that
 * a period only counts when EVERY requirement holds, and "a task was created
 * but nobody wrote an update" has to read as a distinct, visible half-state
 * rather than a pass.
 *
 * Rows are driven entirely by REQUIREMENT_TYPES, so adding a requirement is one
 * row in that table plus one branch in the server's evaluator.
 */

const RequirementRows = ({ value = [], onChange, disabled }) => {
  const chosen = new Set(value);
  const available = REQUIREMENT_TYPES.filter((r) => !chosen.has(r.value));

  const setAt = (index, next) => {
    const copy = [...value];
    copy[index] = next;
    onChange(copy);
  };

  const removeAt = (index) => onChange(value.filter((_, i) => i !== index));

  return (
    <div>
      <p
        className="font-body font-medium mb-2"
        style={{ fontSize: 12.5, color: 'var(--color-text-primary)' }}
      >
        All of these must be true:
      </p>

      <div className="flex flex-col">
        {value.map((type, index) => {
          const meta = requirementMeta(type);
          const Icon = meta?.icon;
          return (
            <div key={type}>
              {index > 0 && (
                <div className="flex items-center justify-center" style={{ padding: '4px 0' }}>
                  <span
                    className="font-body"
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    AND
                  </span>
                </div>
              )}
              <div
                className="flex items-center gap-2"
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-md)',
                  border: '1.5px solid var(--color-border)',
                  background: 'var(--color-bg-input)',
                }}
              >
                {Icon && (
                  <Icon size={14} color="var(--color-text-secondary)" aria-hidden="true" className="shrink-0" />
                )}
                <select
                  value={type}
                  disabled={disabled}
                  onChange={(e) => setAt(index, e.target.value)}
                  aria-label={`Requirement ${index + 1}`}
                  className="flex-1 min-w-0 font-body bg-transparent focus:outline-none"
                  style={{
                    fontSize: 13,
                    color: 'var(--color-text-primary)',
                    border: 'none',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  {/* The current value plus anything not already chosen, so the
                      same requirement can never appear twice. */}
                  {[meta, ...available].filter(Boolean).map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>

                {value.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeAt(index)}
                    disabled={disabled}
                    aria-label={`Remove "${meta?.label}"`}
                    className="shrink-0 flex items-center justify-center transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 'var(--radius-sm)',
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <X size={13} color="var(--color-text-muted)" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {available.length > 0 && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([...value, available[0].value])}
          className="inline-flex items-center gap-1.5 font-body mt-2 transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--color-accent)',
            padding: '5px 8px',
            borderRadius: 'var(--radius-sm)',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          <Plus size={13} aria-hidden="true" />
          Add requirement
        </button>
      )}
    </div>
  );
};

export default RequirementRows;
