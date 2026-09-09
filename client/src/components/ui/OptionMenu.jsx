import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Search } from 'lucide-react';
import useDropdownPosition from '../../utils/useDropdownPosition';
import { filterOptions, nextIndex, SEARCH_THRESHOLD } from '../../utils/menuNav';
import { chipStyle } from '../../utils/chipStyle';

/**
 * OPTION MENU — THE ONE ANCHORED DROPDOWN.
 *
 * ---- USE THIS FOR EVERY NEW DROPDOWN --------------------------------------
 *
 * Any menu that hangs off a thing you clicked belongs here: picking a value,
 * choosing several, or running a command. Before this existed there were four
 * separate implementations on the board alone — `StatusMenu`, `PriorityMenu`,
 * `LabelPicker` and the group header's own inline menu — each with its own copy
 * of anchored positioning, viewport flip, click-outside and Escape, and each
 * slightly different by the time anybody compared them. Two of them supported
 * no keyboard at all.
 *
 * If you are about to write `createPortal` and a `mousedown` listener, you want
 * this component instead. If it cannot do what you need, add the capability
 * here rather than starting a fifth one.
 *
 * (`ui/Dropdown` is a different control and stays: it is a form SELECT with its
 * own trigger box, for modals and settings. This one has no trigger — you own
 * that — and anchors to whatever you clicked.)
 *
 * ---- WHAT IT DOES ---------------------------------------------------------
 *
 *   layout="blocks"   full-width filled colour blocks. What a status picker
 *                     looks like: the option is painted the way the cell will
 *                     be, so choosing is recognising rather than reading.
 *   layout="rows"     a chip or an icon and a label on a row. For multi-select
 *                     and for command menus.
 *
 *   multiple          toggles instead of picking, shows checkboxes, and STAYS
 *                     OPEN — because setting three labels should not mean
 *                     opening the same menu three times.
 *   search            appears on its own past SEARCH_THRESHOLD options. Below
 *                     that a search box over five items is furniture.
 *   footer            the "Edit labels" escape hatch, behind a rule, so a
 *                     detour that opens a modal never sits flush against a
 *                     one-click toggle.
 *
 * Keyboard throughout: ↑ ↓ to move, Enter to choose, Escape to close, and
 * typing filters when the search is showing.
 *
 * ---- OPTIONS --------------------------------------------------------------
 *
 *   { value, label, palette?, icon?, danger?, disabled? }
 *
 * `palette` is a `{ bg, text, solid, deep }` from `priorityColors.js` and makes
 * the option render as a chip. `icon` is a lucide component and makes it render
 * as a command. Neither is required — a bare label renders as plain text.
 */

const MENU_MAX_HEIGHT = 260;

const OptionMenu = ({
  anchorEl,
  options = [],
  value = null,
  selectedValues = null,
  multiple = false,
  onSelect,
  onClose,
  title = null,
  footer = null,
  layout = 'rows',
  chipVariant = 'tag',
  width = 236,
  ariaLabel,
}) => {
  const menuRef = useRef(null);
  const searchRef = useRef(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);

  // The positioning hook takes a ref; callers hand us a DOM node. Wrapping it
  // rather than duplicating the hook is the whole point of having one.
  const anchorRef = useMemo(() => ({ current: anchorEl || null }), [anchorEl]);
  const { top, left, openUpward } = useDropdownPosition(anchorRef, !!anchorEl, {
    menuHeight: MENU_MAX_HEIGHT,
  });

  const showSearch = options.length >= SEARCH_THRESHOLD;
  const visible = useMemo(() => filterOptions(options, query), [options, query]);

  const selected = useMemo(
    () =>
      new Set(
        (multiple ? selectedValues || [] : [value])
          .filter((v) => v !== null && v !== undefined)
          .map((v) => v.toString())
      ),
    [multiple, selectedValues, value]
  );

  useEffect(() => {
    if (showSearch) searchRef.current?.focus();
  }, [showSearch]);

  useEffect(() => {
    const onDocClick = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      if (anchorEl?.contains(e.target)) return;
      onClose?.();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => nextIndex(i, e.key === 'ArrowDown' ? 1 : -1, visible.length));
        return;
      }
      if (e.key === 'Enter' && active >= 0 && visible[active]) {
        e.preventDefault();
        const opt = visible[active];
        if (opt.disabled) return;
        onSelect?.(opt.value, opt);
        if (!multiple) onClose?.();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorEl, onClose, onSelect, visible, active, multiple]);

  if (!anchorEl) return null;

  const choose = (opt) => {
    if (opt.disabled) return;
    onSelect?.(opt.value, opt);
    // Multi-select stays open: setting three labels should not mean opening the
    // same menu three times.
    if (!multiple) onClose?.();
  };

  const renderOption = (opt, i) => {
    const isSelected = selected.has(String(opt.value));
    const isActive = i === active;
    const Icon = opt.icon || null;

    if (layout === 'blocks' && opt.palette) {
      return (
        <button
          key={opt.value}
          type="button"
          role="option"
          aria-selected={isSelected}
          disabled={opt.disabled}
          onMouseEnter={() => setActive(i)}
          onClick={() => choose(opt)}
          className="relative w-full flex items-center justify-center transition-opacity duration-100 hover:opacity-90"
          style={{
            ...chipStyle(opt.palette, 'fill'),
            height: 31,
            borderRadius: 5,
            cursor: opt.disabled ? 'not-allowed' : 'pointer',
            opacity: opt.disabled ? 0.5 : 1,
            boxShadow: isActive
              ? '0 0 0 2px var(--color-bg-surface), 0 0 0 4px var(--color-accent)'
              : 'none',
          }}
        >
          {opt.label}
          {isSelected && (
            <Check size={13} strokeWidth={3} style={{ position: 'absolute', right: 8 }} aria-hidden="true" />
          )}
        </button>
      );
    }

    return (
      <button
        key={opt.value}
        type="button"
        role="option"
        aria-selected={isSelected}
        disabled={opt.disabled}
        onMouseEnter={() => setActive(i)}
        onClick={() => choose(opt)}
        className="w-full flex items-center gap-2 text-left"
        style={{
          padding: '6px 8px',
          borderRadius: 6,
          border: 'none',
          background: isActive ? 'var(--color-accent-light)' : 'transparent',
          color: opt.danger ? 'var(--color-status-stuck)' : 'var(--color-text-primary)',
          fontSize: 13,
          cursor: opt.disabled ? 'not-allowed' : 'pointer',
          opacity: opt.disabled ? 0.5 : 1,
        }}
      >
        {Icon && <Icon size={14} aria-hidden="true" className="shrink-0" />}
        {opt.palette ? (
          <span style={chipStyle(opt.palette, chipVariant)}>{opt.label}</span>
        ) : (
          <span className="truncate">{opt.label}</span>
        )}

        {multiple && (
          <span
            aria-hidden="true"
            className="ml-auto shrink-0 flex items-center justify-center"
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              border: isSelected ? 'none' : '1.5px solid var(--color-border-strong)',
              background: isSelected ? 'var(--color-accent)' : 'transparent',
              color: '#fff',
            }}
          >
            {isSelected && <Check size={10} strokeWidth={3.5} />}
          </span>
        )}
        {!multiple && isSelected && (
          <Check size={13} strokeWidth={3} className="ml-auto shrink-0" style={{ color: 'var(--color-accent)' }} aria-hidden="true" />
        )}
      </button>
    );
  };

  return createPortal(
    <div
      ref={menuRef}
      role="listbox"
      aria-label={ariaLabel || title || 'Options'}
      aria-multiselectable={multiple || undefined}
      className="fixed"
      style={{
        top,
        left,
        width,
        zIndex: 200,
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        overflow: 'hidden',
        transformOrigin: openUpward ? 'bottom' : 'top',
      }}
    >
      {(title || (multiple && selected.size > 0)) && (
        <div
          className="flex items-center justify-between gap-2"
          style={{
            padding: '7px 11px',
            background: 'var(--color-bg-subtle)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <span
            className="font-body"
            style={{
              fontSize: 10,
              letterSpacing: '0.13em',
              textTransform: 'uppercase',
              color: 'var(--color-text-muted)',
            }}
          >
            {title}
          </span>
          {multiple && selected.size > 0 && (
            <span
              className="font-body"
              style={{ fontSize: 10, color: 'var(--color-text-muted)' }}
            >
              {selected.size} selected
            </span>
          )}
        </div>
      )}

      {showSearch && (
        <div
          className="flex items-center gap-2"
          style={{ padding: '6px 10px', borderBottom: '1px solid var(--color-border)' }}
        >
          <Search size={13} aria-hidden="true" color="var(--color-text-muted)" className="shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // Clear the highlight with the same keystroke that changes what
              // is visible — otherwise Enter chooses whatever has just slid
              // into the old index.
              setActive(-1);
            }}
            placeholder="Filter…"
            aria-label="Filter options"
            className="w-full font-body bg-transparent border-none outline-none"
            style={{ fontSize: 12.5, color: 'var(--color-text-primary)' }}
          />
        </div>
      )}

      <div
        style={{
          maxHeight: MENU_MAX_HEIGHT,
          overflowY: 'auto',
          padding: 6,
          display: 'flex',
          flexDirection: 'column',
          gap: layout === 'blocks' ? 4 : 1,
        }}
      >
        {visible.length === 0 ? (
          <p
            className="font-body text-center"
            style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '14px 0' }}
          >
            Nothing matches “{query}”
          </p>
        ) : (
          visible.map(renderOption)
        )}
      </div>

      {footer && (
        <button
          type="button"
          onClick={footer.onClick}
          className="w-full flex items-center gap-2 text-left"
          style={{
            padding: '8px 11px',
            borderTop: '1px solid var(--color-border)',
            background: 'var(--color-bg-subtle)',
            border: 'none',
            fontSize: 12.5,
            color: 'var(--color-text-secondary)',
            cursor: 'pointer',
          }}
        >
          {footer.icon && <footer.icon size={13} aria-hidden="true" />}
          {footer.label}
        </button>
      )}
    </div>,
    document.body
  );
};

export default OptionMenu;
