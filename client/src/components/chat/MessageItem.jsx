import { CheckSquare, ClipboardPlus, MessageSquare, Trash2, Check } from 'lucide-react';
import ReadOnlyRichBody from '../board/ReadOnlyRichBody';
import Avatar from '../ui/Avatar';
import { monthLabel } from './chatFormat';
import { GmailAttachments, WhatsAppAttachments } from './conversationSkins';
import { gmailStamp, gmailStampLong, gmailAgo, gmailListDate, waClock } from '../../utils/conversationFormat';
import macanMark from '../../assets/macan-mark.svg';

/**
 * One message, wherever the TEAM reads a conversation — the global /chat page,
 * a thread panel, or a client board's Chat tab.
 *
 * ---- Two skins, and why they are in one file -------------------------------
 *
 * The team sees the same two interfaces the client does: mail is GMAIL, and
 * chat is the room in styles/conversations.css — WhatsApp's structure in the
 * product's own paint. That is the whole brief on both sides: a client writes
 * in one and the person answering them is looking at exactly the same bubble.
 * Splitting the two renderers into separate
 * files would have separated them from the things that must not diverge: who a
 * message is FROM (a User, a ClientContact, or the system — three shapes, two
 * of which leave `author` null), whether the reader may delete it, and the task
 * and goal chips. Those are resolved once at the top and the skin is chosen at
 * the bottom.
 *
 * `variant` is required at every call site rather than defaulted, because a
 * message rendered in the wrong skin is not a styling slip — a chat bubble
 * in a mailbox reads as a different product.
 *
 * System messages (automations, alerts) render as "Macan" with the brand mark —
 * never as a person.
 */

/** Task reference: a compact blue pill. */
const TaskChip = ({ task, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex items-center gap-1.5 max-w-full transition-colors duration-100 hover:bg-[#E4EEFF]"
    style={{
      border: '1px solid #BFDBFE',
      background: '#EFF6FF',
      color: '#1E40AF',
      borderRadius: 999,
      padding: '3px 12px',
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
    }}
  >
    <CheckSquare size={12} aria-hidden="true" className="shrink-0" />
    <span className="truncate">{task.name}</span>
  </button>
);

/** Goal reference: a left-accented card with an Open affordance. */
const GoalCard = ({ goal, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="block w-full max-w-[360px] text-left transition-colors duration-100 hover:bg-[#f6f8fc]"
    style={{
      border: '1px solid #dadce0',
      borderLeft: '3px solid #0b57d0',
      borderRadius: 8,
      background: '#ffffff',
      padding: '8px 12px',
      cursor: 'pointer',
    }}
  >
    <span className="block font-bold uppercase" style={{ fontSize: 9.5, letterSpacing: '0.07em', color: '#5f6368' }}>
      Goal{goal.monthKey ? ` · ${monthLabel(goal.monthKey)}` : ''}
    </span>
    <span className="block truncate mt-0.5" style={{ fontSize: 12.5, fontWeight: 600, color: '#202124' }}>
      {goal.name}
    </span>
    <span className="block mt-1" style={{ fontSize: 11, fontWeight: 600, color: '#0b57d0' }}>
      Open →
    </span>
  </button>
);

/**
 * The red NEW divider. Kept in both skins: neither Gmail nor WhatsApp has an
 * exact equivalent, and "everything below this arrived since you last looked"
 * is worth more to the person answering than the last 1% of the imitation.
 */
export const NewDivider = () => (
  <div className="flex items-center my-2 px-2" aria-label="New messages">
    <span className="flex-1" style={{ borderTop: '1px solid #F0D4D2' }} />
    <span
      className="font-extrabold text-white"
      style={{
        background: '#DC2626',
        fontSize: 9,
        letterSpacing: '0.09em',
        borderRadius: 999,
        padding: '2px 10px',
        margin: '0 -1px',
      }}
    >
      NEW
    </span>
    <span className="flex-1" style={{ borderTop: '1px solid #F0D4D2' }} />
  </div>
);

/** "This was written by the client", next to their name. */
const ClientTag = () => (
  <span
    className="font-semibold shrink-0"
    style={{
      fontSize: 9,
      letterSpacing: '0.04em',
      color: '#1E40AF',
      background: '#EFF6FF',
      border: '1px solid #BFDBFE',
      borderRadius: 999,
      padding: '1px 6px',
      marginLeft: 6,
      verticalAlign: '1px',
      display: 'inline-block',
    }}
  >
    Client
  </span>
);

const SystemGlyph = ({ size = 36 }) => (
  <span
    className="flex items-center justify-center shrink-0"
    style={{ width: size, height: size, borderRadius: 999, background: '#e8f0fe' }}
    aria-hidden="true"
  >
    <img src={macanMark} alt="" width={Math.round(size * 0.45)} height={Math.round(size * 0.45)} />
  </span>
);

/* ---- the actions, in whichever skin asked for them ------------------------ */
const Actions = ({ message, canManage, canMakeTask, isOwn, onReply, onDelete, onMakeTask, tone }) => {
  const anything = onReply || (canMakeTask && !message.task) || isOwn || canManage;
  if (!anything) return null;
  const base = {
    fontSize: 11.5,
    color: tone === 'wa' ? 'var(--color-text-secondary)' : '#5f6368',
  };
  const hidden =
    'inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity';

  return (
    <div className="flex items-center gap-3 mt-1">
      {onReply &&
        (message.replyCount > 0 ? (
          <button
            type="button"
            onClick={() => onReply(message)}
            className="transition-colors hover:underline"
            style={{ ...base, fontWeight: 600, color: tone === 'wa' ? 'var(--color-accent)' : '#0b57d0' }}
          >
            {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'} →
          </button>
        ) : (
          <button type="button" onClick={() => onReply(message)} className={hidden} style={base}>
            <MessageSquare size={11} aria-hidden="true" />
            Reply
          </button>
        ))}
      {canMakeTask && !message.task && (
        <button type="button" onClick={() => onMakeTask(message)} className={hidden} style={base}>
          <ClipboardPlus size={11} aria-hidden="true" />
          Make a task
        </button>
      )}
      {(isOwn || canManage) && (
        <button
          type="button"
          onClick={() => onDelete(message)}
          aria-label="Delete message"
          className={`${hidden} hover:text-[#d93025]`}
          style={base}
        >
          <Trash2 size={11} aria-hidden="true" />
          Delete
        </button>
      )}
    </div>
  );
};

const MessageItem = ({
  message,
  currentUserId,
  canManage,
  canMakeTask,
  onReply,
  onDelete,
  onMakeTask,
  onOpenChip,
  /** 'gmail' inside a mailbox, 'whatsapp' inside a room. Always pass it. */
  variant = 'whatsapp',
  /** Gmail only: who this went to, e.g. "to Acme Ltd". The team plane knows
   *  the room's audience; the message does not. */
  recipient = '',
  /** Gmail only: folded messages render as one line. */
  collapsed = false,
  onToggle,
  /** WhatsApp only: false when this continues a run from the same person, which
   *  is what drops the tail and the repeated name. */
  tail = true,
}) => {
  const isSystem = message.authorType === 'system';
  /**
   * A message the CLIENT wrote, on a client-facing surface. It has no `author`
   * at all — a ClientContact is deliberately not a User — so everything below
   * that reaches for `message.author` has to be told about this case or the
   * outside company shows up as "Unknown" with a blank circle, which is the one
   * participant a client room cannot afford to leave unnamed.
   *
   * `isOwn` never applies: a team member is never the client.
   */
  const isClient = message.authorType === 'client';
  const clientName =
    (message.portalAuthor?.name || '').trim() || message.portalAuthor?.email || 'Client';
  const isOwn =
    !isSystem && !isClient && String(message.author?._id) === String(currentUserId);
  const mentionsMe = (message.mentions || []).some(
    (m) => String(m?._id || m) === String(currentUserId)
  );
  const name = isSystem ? 'Macan' : isClient ? clientName : message.author?.name || 'Unknown';
  const avatarUser = isClient ? { name: clientName } : message.author;

  const actions = (
    <Actions
      message={message}
      canManage={canManage}
      canMakeTask={canMakeTask}
      isOwn={isOwn}
      onReply={onReply}
      onDelete={onDelete}
      onMakeTask={onMakeTask}
      tone={variant === 'whatsapp' ? 'wa' : 'gm'}
    />
  );

  const chips = (message.task || message.goal) && (
    <div className="flex flex-col items-start gap-1.5 mt-1.5">
      {message.task && <TaskChip task={message.task} onClick={() => onOpenChip('task', message.task)} />}
      {message.goal && <GoalCard goal={message.goal} onClick={() => onOpenChip('goal', message.goal)} />}
    </div>
  );

  /* ---- Gmail ------------------------------------------------------------- */
  if (variant === 'gmail') {
    if (collapsed) {
      return (
        <button type="button" className="gm-fold-msg" onClick={onToggle}>
          <span className="gm-fold-av" style={{ background: 'none' }}>
            {isSystem ? <SystemGlyph size={24} /> : <Avatar user={avatarUser} size={24} />}
          </span>
          <span className="gm-fold-who">{isOwn ? 'me' : name}</span>
          <span className="gm-fold-peek">
            {(message.bodyText || '').replace(/\s+/g, ' ').trim() || 'Attachment'}
          </span>
          <span className="gm-fold-when">{gmailListDate(message.createdAt)}</span>
        </button>
      );
    }

    const ago = gmailAgo(message.createdAt);
    return (
      <div
        className="gm-msg group"
        style={mentionsMe ? { background: '#FFFBEB', borderRadius: 8 } : undefined}
      >
        <div className="gm-msg-head">
          {isSystem ? <SystemGlyph /> : <Avatar user={avatarUser} size={36} />}
          <div className="gm-msg-who">
            <div className="gm-msg-from">
              {isOwn ? 'me' : name}
              {isClient && <ClientTag />}
            </div>
            <div className="gm-msg-to">
              {recipient || 'to the team'}
              {message.editedAt ? ' · edited' : ''}
            </div>
          </div>
          <span className="gm-msg-when" title={gmailStampLong(message.createdAt)}>
            {gmailStamp(message.createdAt)}{ago ? ` (${ago})` : ''}
          </span>
        </div>

        <div className="gm-msg-body gm-msg-body--rich">
          <ReadOnlyRichBody body={message.body} fallbackText={message.bodyText} />
          {chips}
        </div>

        <GmailAttachments items={message.attachments} />
        <div style={{ marginLeft: 48 }}>{actions}</div>
      </div>
    );
  }

  /* ---- WhatsApp ---------------------------------------------------------- */
  if (isSystem) {
    return <div className="wa-sys">{message.bodyText}</div>;
  }

  const side = isOwn ? 'out' : 'in';
  return (
    <div className={`wa-row group ${side} ${tail ? 'wa-row--new' : ''}`}>
      <div
        className={['wa-b', side, tail ? 'wa-b--tail' : '', 'wa-b--rich'].filter(Boolean).join(' ')}
        // "Someone called your name", in the one place WhatsApp leaves free.
        style={mentionsMe ? { boxShadow: '0 0 0 2px #f0b429' } : undefined}
      >
        {!isOwn && tail && (
          <span className="wa-name">
            {name}
            {isClient && <ClientTag />}
          </span>
        )}
        <WhatsAppAttachments items={message.attachments} />
        <ReadOnlyRichBody body={message.body} fallbackText={message.bodyText} />
        {chips}
        {/* AFTER the body, always: the float only lands on the last line if the
            text is already there. Move it above and every bubble grows a row. */}
        <span className="wa-meta">
          {message.editedAt && <span>edited</span>}
          {waClock(message.createdAt)}
          {/* One tick means sent, which is all we know — there is no per-message
              read receipt in this data model, so the blue double tick would be
              telling someone their message had been read on no evidence. */}
          {isOwn && <Check size={14} className="wa-tick" aria-label="Sent" />}
        </span>
      </div>
      {actions}
    </div>
  );
};

export default MessageItem;
