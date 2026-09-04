const Message = require('../models/Message');
const Channel = require('../models/Channel');
const TaskGroup = require('../models/TaskGroup');
const eventBus = require('./eventBus');
const { channelUserAudience } = require('./chatAudience');

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
      // A system post is internal by construction — `ensureGroupChannel`
      // defaults to the team surface and nothing asks it for a client one — so
      // this deliberately fans out to USERS ONLY. Were a client-facing channel
      // ever passed in here, the contacts would still not be told, which is the
      // right way round for a failure mode to point.
      const audience = await channelUserAudience(channel);
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
 * The channel for one (board, group, mode, audience) — creating it if chat has
 * never been opened in this workspace. Same idempotent upsert as the sidebar's
 * backfill, so an automation firing before anyone visits chat still has a room
 * to post into. Returns null (and posts nowhere) when the group is gone.
 *
 * ---- Why this takes a mode and an audience, and why they default this way ---
 *
 * The filter used to be `{board, group}`, which identified exactly one row. A
 * workstream can now carry up to four surfaces, so that pair matches up to four
 * documents and MongoDB returns whichever it likes.
 *
 * The only caller is the POST_TO_CHANNEL automation. So without these two
 * arguments, an automation firing on a client board could post an internal
 * system message — a task name, a status, whatever the rule was written to
 * announce — straight INTO THE ROOM THE CLIENT IS READING, at random.
 *
 * Defaulting to the private team surface is what keeps every existing caller
 * correct with no edit. If POST_TO_CHANNEL should ever be able to reach a
 * client, that becomes an explicit field on the action's config — a thing
 * somebody chose — never a coin flip.
 *
 * @param {'chat'|'mail'} [mode='chat']
 * @param {'team'|'client'} [audience='team']
 */
const ensureGroupChannel = async (
  orgId,
  boardId,
  groupId,
  mode = 'chat',
  audience = 'team'
) => {
  if (!boardId || !groupId) return null;
  const group = await TaskGroup.findById(groupId).select('name board');
  if (!group || String(group.board) !== String(boardId)) return null;

  return Channel.findOneAndUpdate(
    { board: boardId, group: groupId, mode, audience },
    {
      $setOnInsert: {
        organisation: orgId,
        board: boardId,
        group: groupId,
        mode,
        audience,
        name: group.name || 'Untitled client',
        archived: false,
        createdBy: null,
      },
    },
    { upsert: true, new: true }
  );
};

module.exports = { postSystemMessage, ensureGroupChannel };
