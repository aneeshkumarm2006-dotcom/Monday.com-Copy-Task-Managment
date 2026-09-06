import { AlertCircle, ArrowRight, MessageCircle, Plus } from 'lucide-react';

/**
 * The client workspace's landing screen: every service at a glance, and a short
 * "needs you" list above it.
 *
 * Every number here is DERIVED from data the page already holds — the task store
 * for requests and progress, the channel list for unread. Nothing on this screen
 * costs a request of its own, which is what lets it be the default view rather
 * than something you opt into.
 */

const Stat = ({ label, value, tone }) => (
  <span className="font-body flex items-baseline gap-1" style={{ fontSize: 12 }}>
    <span style={{ fontWeight: 700, color: tone || 'var(--color-text-primary)' }}>{value}</span>
    <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
  </span>
);

const ServiceCard = ({ service, onOpen, onSetUpRooms, canManage }) => {
  const pct = service.taskCount
    ? Math.round((service.doneCount / service.taskCount) * 100)
    : 0;

  return (
    <div
      className="flex flex-col gap-2.5 p-4 bg-surface"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          aria-hidden="true"
          className="shrink-0"
          style={{
            width: 10,
            height: 10,
            borderRadius: 3,
            background: service.color || 'var(--color-text-muted)',
          }}
        />
        <button
          type="button"
          onClick={() => onOpen(service.id, 'work')}
          className="font-display truncate text-left min-w-0 flex-1 hover:underline"
          style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}
        >
          {service.name}
        </button>
        {/* There is no owner slot here. A per-service owner would have to come
            from the group, and `owner` is resolved server-side for TRACKER
            boards only (groupController.serializeGroups) — TaskGroup has no
            owner field at all, just the tracker's ownerTimeline. The block that
            used to render `service.owner.name` could therefore never fire, and
            read as a working feature to anyone maintaining this. */}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Stat value={service.taskCount} label="tasks" />
        <Stat value={service.doneCount} label="done" />
        {service.openRequests > 0 && (
          <Stat value={service.openRequests} label="open requests" tone="#B45309" />
        )}
      </div>

      <div
        aria-hidden="true"
        style={{
          height: 5,
          borderRadius: 999,
          background: 'var(--color-bg-subtle)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: service.color || 'var(--color-accent)',
            transition: 'width .3s',
          }}
        />
      </div>

      {/* ONE control, not a Chat button and a Mail button.
          `onOpen(id, 'talk')` can only choose the service's TAB; the room
          inside it is picked by BoardChatTab, which lands on the first
          client-facing surface every time. Two buttons with two different
          unread counts therefore led to the same room, and "Mail 3" put you in
          the chat with the mail still unread. One label that matches where the
          click goes is honest; two that don't are not. */}
      {service.hasRooms == null ? (
        // Rooms are still loading. NOT the same as having none — the amber
        // "set up" prompt below is a real problem report and must not flash on
        // every service on every load.
        <span
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          Loading conversations…
        </span>
      ) : service.hasRooms ? (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => onOpen(service.id, 'talk')}
            className="font-body flex items-center gap-1"
            style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
          >
            <MessageCircle size={12} aria-hidden="true" />
            Conversations
            {service.unread > 0 && (
              <span style={{ color: 'var(--color-accent)', fontWeight: 700 }}>
                {service.unread}
              </span>
            )}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => (canManage ? onSetUpRooms(service.id) : onOpen(service.id, 'talk'))}
          className="font-body flex items-center gap-1.5 self-start"
          style={{
            height: 26,
            padding: '0 8px',
            fontSize: 11.5,
            fontWeight: 600,
            color: '#B45309',
            border: '1px dashed #B45309',
            borderRadius: 'var(--radius-md)',
            background: 'transparent',
          }}
        >
          <Plus size={11} aria-hidden="true" />
          No rooms yet — set up
        </button>
      )}

      <div className="flex items-center justify-between">
        <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          {service.sharedCount > 0
            ? `${service.sharedCount} row${service.sharedCount === 1 ? '' : 's'} the client sees`
            : 'Nothing shared yet'}
        </span>
        <button
          type="button"
          onClick={() => onOpen(service.id, 'work')}
          className="font-body flex items-center gap-1"
          style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--color-accent)' }}
        >
          Open
          <ArrowRight size={11} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

const ClientOverview = ({
  services = [],
  needsYou = [],
  canManage,
  onOpen,
  onSetUpRooms,
  onAddService,
}) => (
  <div className="flex flex-col gap-6">
    {needsYou.length > 0 && (
      <section className="flex flex-col gap-2">
        <h2
          className="font-body uppercase"
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: '0.07em',
            color: 'var(--color-text-muted)',
          }}
        >
          Needs you
        </h2>
        <div
          className="flex flex-col bg-surface"
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
          }}
        >
          {needsYou.map((item, i) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpen(item.serviceId, item.tab)}
              className="font-body flex items-center gap-2.5 px-4 text-left transition-colors hover:bg-[color:var(--color-bg-subtle)]"
              style={{
                minHeight: 42,
                borderTop: i === 0 ? 'none' : '1px solid var(--color-border)',
              }}
            >
              <span
                aria-hidden="true"
                className="shrink-0"
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: item.tone === 'requests' ? '#B45309' : 'var(--color-accent)',
                }}
              />
              <span
                className="shrink-0 truncate"
                style={{ fontSize: 12, fontWeight: 700, maxWidth: 130 }}
              >
                {item.serviceName}
              </span>
              <span
                className="truncate flex-1 min-w-0"
                style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}
              >
                {item.text}
              </span>
              <ArrowRight
                size={13}
                aria-hidden="true"
                className="shrink-0"
                color="var(--color-text-muted)"
              />
            </button>
          ))}
        </div>
      </section>
    )}

    <section className="flex flex-col gap-2">
      <h2
        className="font-body uppercase"
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: '0.07em',
          color: 'var(--color-text-muted)',
        }}
      >
        Services
      </h2>

      {services.length === 0 ? (
        <div
          className="flex flex-col items-start gap-3 p-6 bg-surface"
          style={{ border: '1px dashed var(--color-border-strong)', borderRadius: 'var(--radius-lg)' }}
        >
          <AlertCircle size={20} color="var(--color-text-muted)" aria-hidden="true" />
          <p className="font-body" style={{ fontSize: 13.5, fontWeight: 600 }}>
            No services yet &mdash; the portal isn&rsquo;t live
          </p>
          <p
            className="font-body"
            style={{ fontSize: 12.5, color: 'var(--color-text-muted)', maxWidth: 460 }}
          >
            A service is one of the things you deliver for this client, and it comes
            with its own requests, chat and mailbox. Adding the first one is what
            creates this client&rsquo;s portal link and sends their invitation &mdash;
            so they arrive to something worth looking at, rather than an empty page.
          </p>
          {canManage && (
            <button
              type="button"
              onClick={onAddService}
              className="font-body flex items-center gap-1.5"
              style={{
                height: 32,
                padding: '0 12px',
                fontSize: 12.5,
                fontWeight: 600,
                color: '#FFFFFF',
                background: 'var(--color-accent)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <Plus size={13} aria-hidden="true" />
              Add the first service
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {services.map((s) => (
            <ServiceCard
              key={s.id}
              service={s}
              onOpen={onOpen}
              onSetUpRooms={onSetUpRooms}
              canManage={canManage}
            />
          ))}
        </div>
      )}
    </section>
  </div>
);

export default ClientOverview;
