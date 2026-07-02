const TaskGroup = require('../models/TaskGroup');
const Note = require('../models/Note');
const { loadBoardContext } = require('./groupController');

/**
 * Note controller — rich-text docs attached to a board group. Access mirrors
 * groups: any org member with read access on the board may list notes; only
 * members with edit access (`ctx.isAdmin` from loadBoardContext) may create,
 * edit, or delete them.
 */

const POPULATE = [
  { path: 'author', select: 'name profilePic email' },
  { path: 'lastEditedBy', select: 'name profilePic email' },
];

// True when the note has no title, no plain-text, and an empty/absent body.
const isEmptyNote = ({ title, body, bodyText }) => {
  const hasTitle = typeof title === 'string' && title.trim().length > 0;
  const hasText = typeof bodyText === 'string' && bodyText.trim().length > 0;
  const hasBody =
    body && typeof body === 'object' && Object.keys(body).length > 0;
  return !hasTitle && !hasText && !hasBody;
};

/**
 * GET /api/groups/:groupId/notes — notes for a group, most recently edited
 * first. Requires board read access.
 */
const getNotes = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupId } = req.params;

    const group = await TaskGroup.findById(groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const ctx = await loadBoardContext(group.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const notes = await Note.find({ group: groupId })
      .populate(POPULATE)
      .sort({ updatedAt: -1 });

    return res.json({ notes });
  } catch (err) {
    console.error('getNotes error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/groups/:groupId/notes — create a note. Editor only. Rejects a
 * fully-empty note as a backstop (the client only POSTs on first real content).
 */
const createNote = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupId } = req.params;
    const { title, body, bodyText } = req.body || {};

    if (isEmptyNote({ title, body, bodyText })) {
      return res.status(400).json({ error: 'Note is empty' });
    }

    const group = await TaskGroup.findById(groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const ctx = await loadBoardContext(group.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.isAdmin) {
      return res.status(403).json({ error: 'Edit access required' });
    }

    const note = await Note.create({
      group: groupId,
      board: group.board,
      author: userId,
      title: typeof title === 'string' ? title : '',
      body: body ?? null,
      bodyText: typeof bodyText === 'string' ? bodyText : '',
    });
    await note.populate(POPULATE);

    return res.status(201).json({ note });
  } catch (err) {
    console.error('createNote error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PATCH /api/notes/:id — partial update of title/body/bodyText. Editor only.
 */
const updateNote = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { title, body, bodyText } = req.body || {};

    const note = await Note.findById(id);
    if (!note) return res.status(404).json({ error: 'Note not found' });

    const ctx = await loadBoardContext(note.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.isAdmin) {
      return res.status(403).json({ error: 'Edit access required' });
    }

    if (typeof title === 'string') note.title = title;
    if (body !== undefined) note.body = body;
    if (typeof bodyText === 'string') note.bodyText = bodyText;
    note.lastEditedBy = userId;

    await note.save();
    await note.populate(POPULATE);

    return res.json({ note });
  } catch (err) {
    console.error('updateNote error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/notes/:id — remove a note. Editor only.
 */
const deleteNote = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const note = await Note.findById(id);
    if (!note) return res.status(404).json({ error: 'Note not found' });

    const ctx = await loadBoardContext(note.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.isAdmin) {
      return res.status(403).json({ error: 'Edit access required' });
    }

    await Note.deleteOne({ _id: id });
    return res.json({ ok: true });
  } catch (err) {
    console.error('deleteNote error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/boards/:boardId/notes/counts — cheap per-group note counts for the
 * header badges. Requires board read access. Returns { counts: { groupId: n } }.
 */
const getNoteCounts = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { boardId } = req.params;

    const ctx = await loadBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const rows = await Note.aggregate([
      { $match: { board: ctx.board._id } },
      { $group: { _id: '$group', count: { $sum: 1 } } },
    ]);

    const counts = {};
    for (const r of rows) counts[r._id.toString()] = r.count;

    return res.json({ counts });
  } catch (err) {
    console.error('getNoteCounts error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getNotes,
  createNote,
  updateNote,
  deleteNote,
  getNoteCounts,
};
