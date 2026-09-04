import { CheckSquare, ClipboardPlus, MessageSquare, Trash2 } from 'lucide-react';
import AttachmentList from '../board/AttachmentList';
import ReadOnlyRichBody from '../board/ReadOnlyRichBody';
import Avatar from '../ui/Avatar';
import { monthLabel, timeShort } from './chatFormat';
import macanMark from '../../assets/macan-mark.svg';

/**
 * One message, wherever a conversation is drawn — the global /chat page, a
 * thread panel, or a client board's Chat tab.
 *
 * Extracted from `ChatPage.jsx` unchanged when the board tab arrived. The
 * markup is the mobile design mock's, and the two share it so a message looks
 * the same in both places: avatar, name, short time, rich body, then the
 * share chips, attachments, and the hover row of actions.
 *
 * `ReadOnlyRichBody` is imported from its OWN file rather than through
 * `UpdatesTab`'s re-export, and that matters more than it looks: `UpdatesTab`
 * pulls in `updateService`, `taskAttachmentService` and `authStore`, so the
 * convenient import dragged the whole task-panel module graph into every screen
 * that renders a message. See the header of `board/ReadOnlyRichBody.jsx`.
 *
 * System messages (automations, alerts) render as "Macan" with the brand mark —
 * never as a person.
 */

/** Task reference: a compact blue pill, per the mock. */
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
    <span className="font-body truncate">{task.name}</span>
  </button>
);

/** Goal reference: the mock's left-accented card with an Open affordance. */
const GoalCard = ({ goal, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="block w-full max-w-[360px] text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
    style={{
      border: '1px solid var(--color-border)',
      borderLeft: '3px solid var(--color-accent)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-bg-base)',
      padding: '8px 12px',
      cursor: 'pointer',
    }}
  >
    <span
      className="font-body block font-bold uppercase"
      style={{ fontSize: 9.5, letterSpacing: '0.07em', color: 'var(--color-text-muted)' }}
    >
      Goal{goal.monthKey ? ` · ${monthLabel(goal.monthKey)}` : ''}
    </span>
    <span
      className="font-body block truncate mt-0.5"
      style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)' }}
    >
      {goal.name}
    </span>
    <span
      className="font-body block mt-1"
      style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-accent)' }}
    >
      Open →
    </span>
  </button>
);

/** The red NEW divider, exactly as the mock draws it. */
export const NewDivider = () => (
  <div className="flex items-center my-2 px-2" aria-label="New messages">
    <span className="flex-1" style={{ borderTop: '1px solid #F0D4D2' }} />
    <span
      className="font-body font-extrabold text-white"
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

const SystemGlyph = () => (
  <span
    className="flex items-center justify-center shrink-0"
    style={{
      width: 30,
      height: 30,
      borderRadius: 'var(--radius-full)',
      background: 'var(--color-accent-light)',
    }}
    aria-hidden="true"
  >
    <img src={macanMark} alt="" width={16} height={16} />
  </span>
);

const MessageItem = ({
  message,
  currentUserId,
  canManage,
  canMakeTask,
  onReply,
  onDelete,
  onMakeTask,
  onOpenChip,
}) => {
  const isSystem = message.authorType === 'system';
  const isOwn = !isSystem && String(message.author?._id) === String(currentUserId);
  const mentionsMe = (message.mentions || []).some(
    (m) => String(m?._id || m) === String(currentUserId)
  );

  return (
    <div
      className="group flex items-start gap-2.5 px-3 py-2"
      style={
        mentionsMe
          ? {
              // The amber mention wash from the mock — the whole surface says
              // "someone called your name", without a rail in sight.
              background: '#FFFBEB',
              border: '1px solid #F1DCA8',
              borderRadius: 12,
            }
          : undefined
      }
    >
      <span className="mt-0.5 shrink-0">
        {isSystem ? <SystemGlyph /> : <Avatar user={message.author} size={30} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className="font-body font-bold truncate"
            style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
          >
            {isSystem ? 'Macan' : message.author?.name || 'Unknown'}
          </span>
          <span className="font-body shrink-0" style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>
            {timeShort(message.createdAt)}
            {message.editedAt ? ' · edited' : ''}
          </span>
        </div>

        <div className="font-body text-[13px] text-[color:var(--color-text-primary)]">
          <ReadOnlyRichBody body={message.body} fallbackText={message.bodyText} />
        </div>

        {(message.task || message.goal) && (
          <div className="flex flex-col items-start gap-1.5 mt-1.5">
            {message.task && (
              <TaskChip task={message.task} onClick={() => onOpenChip('task', message.task)} />
            )}
            {message.goal && (
              <GoalCard goal={message.goal} onClick={() => onOpenChip('goal', message.goal)} />
            )}
          </div>
        )}

        {message.attachments?.length > 0 && (
          <div className="mt-1.5">
            <AttachmentList attachments={message.attachments} compact />
          </div>
        )}

        <div className="flex items-center gap-3 mt-1">
          {onReply &&
            (message.replyCount > 0 ? (
              <button
                type="button"
                onClick={() => onReply(message)}
                className="font-body transition-colors hover:underline"
                style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--color-accent)' }}
              >
                {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'} →
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onReply(message)}
                className="font-body inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity hover:text-[color:var(--color-accent)]"
                style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
              >
                <MessageSquare size={11} aria-hidden="true" />
                Reply
              </button>
            ))}
          {canMakeTask && !message.task && (
            <button
              type="button"
              onClick={() => onMakeTask(message)}
              className="font-body inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity hover:text-[color:var(--color-accent)]"
              style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
            >
              <ClipboardPlus size={11} aria-hidden="true" />
              Make a task
            </button>
          )}
          {(isOwn || canManage) && (
            <button
              type="button"
              onClick={() => onDelete(message)}
              aria-label="Delete message"
              className="font-body inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity hover:text-[color:var(--color-status-stuck)]"
              style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
            >
              <Trash2 size={11} aria-hidden="true" />
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default MessageItem;
