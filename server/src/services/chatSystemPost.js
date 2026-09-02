const Message = require('../models/Message');
const Channel = require('../models/Channel');
const TaskGroup = require('../models/TaskGroup');
const eventBus = require('./eventBus');
const { channelAudience } = require('./chatAudience');

/**
 * System posts — the ONE way anything non-human writes into a channel.
 *
 * Phase 1's rule was "zero automatic posting"; Phase 2 relaxes it to "only
 * through here", so the properties that matter stay in one place:
 *
 *   - a system message carries `authorType: 'system'` and no author — the
 *     client renders the Macan mark, never a person;
 *   - it may carry a task/goal chip, and pointing is still all a chip does;
 *   - it fans out to the channel's full derived audience (there is no author
 *     to exclude) over the same SSE event human messages use;
 *   - it never creates notifications. An automation that posted AND buzzed
 *     everyone's bell would double-charge the interruption — the unread badge
 *     on the channel is the system post's entire claim on attention.
 */

/**
 * Post into a channel. Best-effort by design: callers are automations and
 * alert runners, and a failed chat post must never fail the thing that was
 * actually being done. Returns the message, or null.
 */
const postSystemMessage = async (channel, { bodyText, taskId = null, goalId = null }) => {
  try {
    if (!channel || channel.archived) return null;
    const text = (bodyText || '').trim();
    if (!text) return null;

    const message = await Message.create({
      channel: channel._id,
      authorType: 'system',
      author: null,
      bodyText: text.slice(0, 2000),
      task: taskId || null,
      goal: goalId || null,
    });

    try {
      const audience = await channelAudience(channel);
      if (audience.length) {
        eventBus.emit('chat.message', {
          channelId: String(channel._id),
          messageId: String(message._id),
          orgId: String(channel.organisation),
          recipientIds: audience,
        });
      }
    } catch (emitErr) {
      // Delivery is best-effort; the message is stored either way.
    }

    return message;
  } catch (err) {
    console.error('postSystemMessage error:', err);
    return null;
  }
};

/**
 * The client channel for one (board, group) — creating it if chat has never
 * been opened in this workspace. Same idempotent upsert as the sidebar's
 * backfill, so an automation firing before anyone visits chat still has a
 * room to post into. Returns null (and posts nowhere) when the group is gone.
 */
const ensureGroupChannel = async (orgId, boardId, groupId) => {
  if (!boardId || !groupId) return null;
  const group = await TaskGroup.findById(groupId).select('name board');
  if (!group || String(group.board) !== String(boardId)) return null;

  return Channel.findOneAndUpdate(
    { board: boardId, group: groupId },
    {
      $setOnInsert: {
        organisation: orgId,
        board: boardId,
        group: groupId,
        name: group.name || 'Untitled client',
        archived: false,
        createdBy: null,
      },
    },
    { upsert: true, new: true }
  );
};

module.exports = { postSystemMessage, ensureGroupChannel };
