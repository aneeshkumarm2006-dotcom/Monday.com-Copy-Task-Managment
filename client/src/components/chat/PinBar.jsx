import { useState } from 'react';
import { Pin, X, ChevronDown } from 'lucide-react';

/**
 * The pinned-messages strip under a room's header.
 *
 * COLLAPSED TO ONE LINE by default, however many pins there are. A pin bar that
 * expands to show all ten pushes the conversation off the screen, which turns
 * the feature into a thing people stop using because it is in the way — so the
 * bar shows the most recent pin and a count, and opens on demand.
 *
 * Renders nothing when there are no pins. It is chrome, and chrome that says
 * "no pins yet" is chrome nobody asked for.
 */
const PinBar = ({ pins = [], onOpen, onUnpin, canManage }) => {
  const [open, setOpen] = useState(false);
  if (!pins.length) return null;

  const preview = (m) =>
    (m.bodyText || '').trim() ||
    (m.task ? `Task: ${m.task.name}` : '') ||
    (m.goal ? `Goal: ${m.goal.name}` : '') ||
    (m.attachments?.length ? `${m.attachments.length} attachment(s)` : 'Message');

  return (
    <div
      style={{
        background: 'var(--color-status-working-bg)',
        borderBottom: '1px solid #F3E4C4',
        flexShrink: 0,
      }}
    >
      <div className="flex items-center gap-2.5 px-4 py-2">
        <Pin size={12} color="#8A5A08" aria-hidden="true" className="shrink-0" />
        <button
          type="button"
          onClick={() => (pins.length === 1 ? onOpen(pins[0]) : setOpen((v) => !v))}
          className="flex-1 min-w-0 text-left font-body truncate"
          style={{ fontSize: 12, color: '#8A5A08' }}
        >
          <span style={{ fontWeight: 700 }}>Pinned</span>
          <span aria-hidden="true"> — </span>
          {preview(pins[0])}
        </button>
        {pins.length > 1 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex items-center gap-1 shrink-0 font-body"
            style={{ fontSize: 11.5, color: '#A9873C', fontWeight: 600 }}
          >
            {open ? 'Hide' : `View all ${pins.length}`}
            <ChevronDown
              size={12}
              aria-hidden="true"
              style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease' }}
            />
          </button>
        )}
      </div>

      {open && (
        <ul
          className="px-4 pb-2 flex flex-col gap-1"
          style={{ maxHeight: 168, overflowY: 'auto' }}
        >
          {pins.map((m) => (
            <li key={m._id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onOpen(m)}
                className="flex-1 min-w-0 text-left font-body truncate rounded px-2 py-1.5 transition-colors hover:bg-[#F6E7C6]"
                style={{ fontSize: 12, color: '#7A4F06' }}
              >
                <span style={{ fontWeight: 600 }}>
                  {m.author?.name || (m.authorType === 'client' ? m.portalAuthor?.name : '') || 'Macan'}
                </span>
                <span aria-hidden="true"> · </span>
                {preview(m)}
              </button>
              {canManage && (
                <button
                  type="button"
                  onClick={() => onUnpin(m)}
                  aria-label="Unpin this message"
                  title="Unpin"
                  className="shrink-0 flex items-center justify-center rounded transition-colors hover:bg-[#F6E7C6]"
                  style={{ width: 22, height: 22, color: '#A9873C' }}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default PinBar;
