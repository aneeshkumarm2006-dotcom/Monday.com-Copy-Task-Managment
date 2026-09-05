import { ChevronRight, Mail, MessageSquare } from 'lucide-react';

/**
 * The client portal's home: a TABLE OF SERVICES.
 *
 * This is the screen the whole portal rewrite is built around. A client company
 * buys several things — SEO, Meta Ads, Google Ads, web development — and each is
 * handled by a different person on their side. Landing them in one flat list of
 * requests made everything look like one undifferentiated pile. Here they pick
 * the service first, and everything after that is scoped to it.
 *
 * ---- ONE TABLE, RESTYLED — NOT TWO TREES ----------------------------------
 *
 * Real `<table>` semantics on desktop (the client asked for a table, and it IS
 * tabular), and below 860px the header hides and each row becomes a card via
 * CSS alone. Two DOM trees behind `hidden` would drift the moment one of them
 * gained a badge the other did not.
 *
 * ---- WHY THE CHIPS ARE THEIR OWN LINKS ------------------------------------
 *
 * The service name opens Requests; the chat and mail chips open those directly.
 * A stretched-row link would swallow them, and going straight to an unread
 * mailbox without passing through the request list is the entire point of
 * showing the counts here.
 */

const rel = (iso, now) => {
  if (!iso) return '';
  const ms = (now ? new Date(now) : new Date()) - new Date(iso);
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

const Chip = ({ icon: Icon, n, label, onClick, disabled }) => (
  <button
    type="button"
    className="mcp-svc-chip"
    onClick={onClick}
    disabled={disabled}
    data-unread={n > 0 ? 'true' : undefined}
    aria-label={
      disabled
        ? `${label} is not set up yet`
        : n > 0
          ? `${label}, ${n} unread`
          : label
    }
  >
    <Icon size={14} aria-hidden="true" />
    {n > 0 ? <span className="mcp-tab-count">{n > 99 ? '99+' : n}</span> : null}
  </button>
);

const PortalServiceTable = ({ services = [], serverTime = null, onOpen }) => {
  if (!services.length) {
    return (
      <div className="mcp-card mcp-card-lg" style={{ textAlign: 'center' }}>
        <p style={{ fontWeight: 700, marginBottom: 6 }}>Your portal is being set up</p>
        <p className="mcp-note" style={{ margin: 0 }}>
          Your services will appear here, and you&rsquo;ll get an email as soon as
          they do.
        </p>
      </div>
    );
  }

  return (
    <table className="mcp-svc-table">
      <caption className="mcp-sr-only">
        Your services. Pick one to see its requests, chat and mail.
      </caption>
      <thead>
        <tr>
          <th scope="col">Service</th>
          <th scope="col">Requests</th>
          <th scope="col">Chat</th>
          <th scope="col">Mail</th>
          <th scope="col">Last activity</th>
          <th scope="col" aria-label="Open" />
        </tr>
      </thead>
      <tbody>
        {services.map((s) => {
          const open = s.requests?.open || 0;
          const ongoing = s.requests?.ongoing || 0;
          return (
            <tr key={s.id} style={{ '--p-svc': s.color || 'var(--p-primary)' }}>
              <td data-label="Service">
                <button
                  type="button"
                  className="mcp-svc-name"
                  onClick={() => onOpen(s.id, 'tasks')}
                >
                  {s.name}
                </button>
              </td>

              <td data-label="Requests">
                {open > 0 ? (
                  <span className="mcp-svc-strong">
                    {open} open
                  </span>
                ) : (
                  <span className="mcp-svc-quiet">All clear</span>
                )}
                {ongoing > 0 && (
                  <span className="mcp-svc-quiet"> · {ongoing} in progress</span>
                )}
              </td>

              <td data-label="Chat">
                <Chip
                  icon={MessageSquare}
                  n={s.unread?.chat || 0}
                  label={`${s.name} chat`}
                  disabled={!s.channels?.chat}
                  onClick={() => onOpen(s.id, 'chat')}
                />
              </td>

              <td data-label="Mail">
                <Chip
                  icon={Mail}
                  n={s.unread?.mail || 0}
                  label={`${s.name} mail`}
                  disabled={!s.channels?.mail}
                  onClick={() => onOpen(s.id, 'mail')}
                />
              </td>

              <td data-label="Last activity">
                <span className="mcp-svc-quiet">
                  {s.lastActivityAt ? rel(s.lastActivityAt, serverTime) : 'Nothing yet'}
                </span>
              </td>

              <td>
                <button
                  type="button"
                  className="mcp-svc-go"
                  onClick={() => onOpen(s.id, 'tasks')}
                  aria-label={`Open ${s.name}`}
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

export default PortalServiceTable;
