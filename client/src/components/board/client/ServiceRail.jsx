import { LayoutGrid, Plus, Settings, Users } from 'lucide-react';

/**
 * The client workspace's primary navigation: one row per SERVICE, plus Overview,
 * People and Settings.
 *
 * ---- WHY THE RAIL NEVER GROWS SUB-ROWS FOR ROOMS --------------------------
 *
 * A four-service client has four services × (chat + mail + team room) = twelve
 * conversations. Listing them here would be sixteen rows of navigation before
 * any work is visible — precisely the mess this redesign exists to remove. The
 * rail picks a SERVICE; the room switcher inside the service picks a ROOM. Two
 * small choices instead of one large one.
 *
 * ---- WHY TWO BADGES AND NOT ONE -------------------------------------------
 *
 * Blue counts unread messages, amber counts open client requests. They are
 * different kinds of debt — one is someone waiting for a reply, the other is
 * work not started — and summing them would produce a number that means nothing.
 * Three or more badges would be noise, so the legend at the foot names these two
 * and the rail shows nothing else.
 */

const Badge = ({ n, tone }) => {
  if (!n) return null;
  return (
    <span
      className="font-body shrink-0"
      style={{
        minWidth: 17,
        height: 17,
        padding: '0 5px',
        borderRadius: 999,
        background: tone === 'requests' ? '#B45309' : 'var(--color-accent)',
        color: '#FFFFFF',
        fontSize: 10,
        fontWeight: 700,
        lineHeight: '17px',
        textAlign: 'center',
      }}
    >
      {n > 99 ? '99+' : n}
    </span>
  );
};

const Row = ({ icon: Icon, dot, label, active, unread, requests, warn, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    className="font-body flex items-center gap-2 w-full text-left transition-colors"
    style={{
      minHeight: 34,
      padding: '0 10px',
      borderRadius: 'var(--radius-md)',
      background: active ? 'var(--color-accent-light)' : 'transparent',
      color: active ? 'var(--color-accent-text)' : 'var(--color-text-secondary)',
      fontSize: 13,
      fontWeight: active ? 700 : 500,
    }}
  >
    {dot ? (
      <span
        aria-hidden="true"
        className="shrink-0"
        style={{ width: 8, height: 8, borderRadius: 3, background: dot }}
      />
    ) : Icon ? (
      <Icon size={14} aria-hidden="true" className="shrink-0" />
    ) : null}
    <span className="truncate flex-1 min-w-0">{label}</span>
    {warn && (
      <span
        title="No conversations set up yet"
        aria-label="No conversations set up yet"
        className="shrink-0"
        style={{ fontSize: 11, color: '#B45309' }}
      >
        !
      </span>
    )}
    <Badge n={unread} tone="unread" />
    <Badge n={requests} tone="requests" />
  </button>
);

// There is no `peopleCount` prop. It existed, defaulted to 0 and was never
// passed by the one call site, so the badge could not render; and it was fed to
// `requests`, whose amber the legend below reserves for OPEN CLIENT REQUESTS —
// so a roster of four would have read as four unanswered requests. Reading the
// roster also costs a manage-gated request that 403s for most people who can
// open this rail. If the count is wanted here later it needs its own neutral
// tone, not a borrowed one.
const ServiceRail = ({
  services = [],
  activeKey,
  onSelect,
  canManage,
  onAddService,
}) => (
  <nav
    aria-label="Services"
    className="flex flex-col gap-0.5 shrink-0 w-full lg:w-[228px]"
  >
    <Row
      icon={LayoutGrid}
      label="Overview"
      active={activeKey === 'overview'}
      onClick={() => onSelect('overview')}
    />

    <p
      className="font-body uppercase px-2.5 pt-3 pb-1"
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: '0.07em',
        color: 'var(--color-text-muted)',
      }}
    >
      Services
    </p>

    {services.length === 0 && (
      <p
        className="font-body px-2.5 pb-2"
        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
      >
        No services yet.
      </p>
    )}

    {services.map((s) => (
      <Row
        key={s.id}
        dot={s.color || 'var(--color-text-muted)'}
        label={s.name}
        active={String(activeKey) === String(s.id)}
        unread={s.unread}
        requests={s.openRequests}
        // `=== false` is load-bearing. `hasRooms` is null until the channel
        // list has loaded, and a plain `!s.hasRooms` painted a "!" on every
        // service on every load before snapping to the truth.
        warn={s.hasRooms === false}
        onClick={() => onSelect(s.id)}
      />
    ))}

    {canManage && (
      <button
        type="button"
        onClick={onAddService}
        className="font-body flex items-center gap-1.5 mt-1"
        style={{
          minHeight: 30,
          padding: '0 10px',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--color-accent)',
          border: '1px dashed var(--color-accent)',
          borderRadius: 'var(--radius-md)',
          background: 'transparent',
        }}
      >
        <Plus size={12} aria-hidden="true" />
        Add service
      </button>
    )}

    <div
      style={{ height: 1, background: 'var(--color-border)', margin: '12px 4px' }}
      aria-hidden="true"
    />

    <Row
      icon={Users}
      label="People"
      active={activeKey === 'people'}
      onClick={() => onSelect('people')}
    />
    {/* Settings is manager-only: everything behind it — the shareable link, the
        announcement, rotating or switching the link off — is refused by the
        server for anyone else, and the modal renders that refusal as "this
        board has no services", which is a lie about the client's access. */}
    {canManage && (
      <Row
        icon={Settings}
        label="Settings"
        active={activeKey === 'settings'}
        onClick={() => onSelect('settings')}
      />
    )}

    {/* The legend is not decoration. Two differently-coloured numbers with no
        key is a puzzle, and a puzzle in navigation gets ignored. */}
    <div className="px-2.5 pt-4 flex flex-col gap-1">
      <span
        className="font-body flex items-center gap-1.5"
        style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}
      >
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--color-accent)' }}
        />
        unread messages
      </span>
      <span
        className="font-body flex items-center gap-1.5"
        style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}
      >
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: 999, background: '#B45309' }}
        />
        open client requests
      </span>
    </div>
  </nav>
);

export default ServiceRail;
