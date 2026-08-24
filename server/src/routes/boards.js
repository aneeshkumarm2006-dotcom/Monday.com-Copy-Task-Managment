const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  getBoards,
  createBoard,
  updateBoard,
  deleteBoard,
  reorderBoards,
  listLabels,
  addLabel,
  updateLabel,
  deleteLabel,
  reorderLabels,
  listStatuses,
  addStatus,
  updateStatus,
  deleteStatus,
  reorderStatuses,
  listGroupTags,
  addGroupTag,
  updateGroupTag,
  deleteGroupTag,
  reorderGroupTags,
  getConnectableBoards,
  getBoardMembers,
  getBoardAccess,
  setBoardAccess,
  transferBoardOwnership,
} = require('../controllers/boardController');
const {
  listColumns,
  addColumn,
  updateColumn,
  reorderColumns,
  deleteColumn,
} = require('../controllers/columnController');
const { getActivityExport } = require('../controllers/boardExportController');
const {
  convertBoardType, getBoardMonths, setMonthTimezone,
} = require('../controllers/trackerBoardController');

const router = express.Router();

// All board routes require authentication
router.use(authMiddleware);

// GET /api/boards?org=:orgId — list boards for an organisation
router.get('/', getBoards);

// POST /api/boards — create a board (admin-only, enforced in controller)
router.post('/', createBoard);

// PUT /api/boards/reorder — reorder boards within an organisation
// Must come BEFORE /:id so "reorder" isn't parsed as a board id.
router.put('/reorder', reorderBoards);

// PUT /api/boards/:id — update a board (admin-only)
router.put('/:id', updateBoard);

// DELETE /api/boards/:id — delete a board + cascade (admin-only)
router.delete('/:id', deleteBoard);

// --- Tracker boards -------------------------------------------------------
// POST with { dryRun: true } returns the month-split preview and writes nothing.
router.post('/:id/convert', convertBoardType);
router.get('/:id/months', getBoardMonths);
// Changing the timezone re-files every task, so it is its own endpoint rather
// than a field on PUT /:id — see the controller.
router.put('/:id/month-timezone', setMonthTimezone);

// --- Labels (per board) ---------------------------------------------------
// reorder must come BEFORE the /:lid routes so it isn't matched as a label id
router.get('/:id/labels',            listLabels);
router.post('/:id/labels',           addLabel);
router.put('/:id/labels/reorder',    reorderLabels);
router.put('/:id/labels/:lid',       updateLabel);
router.delete('/:id/labels/:lid',    deleteLabel);

// --- Statuses (per board) -------------------------------------------------
router.get('/:id/statuses',          listStatuses);
router.post('/:id/statuses',         addStatus);
router.put('/:id/statuses/reorder',  reorderStatuses);
router.put('/:id/statuses/:sid',     updateStatus);
router.delete('/:id/statuses/:sid',  deleteStatus);

// --- Group tags (per board, extra feature) --------------------------------
// The tag vocabulary a board's GROUPS may be filed under. Listing is open to
// anyone who can read the board; every write needs `column.manage` AND the
// caller's own `features.groupTags` opt-in. reorder before /:gtid, as above.
router.get('/:id/group-tags',           listGroupTags);
router.post('/:id/group-tags',          addGroupTag);
router.put('/:id/group-tags/reorder',   reorderGroupTags);
router.put('/:id/group-tags/:gtid',     updateGroupTag);
router.delete('/:id/group-tags/:gtid',  deleteGroupTag);

// --- Columns (per board, flexible-columns engine, F1) ---------------------
// reorder must come BEFORE the /:cid routes so it isn't parsed as a column id
router.get('/:id/columns',            listColumns);
router.post('/:id/columns',           addColumn);
router.patch('/:id/columns/reorder',  reorderColumns);
router.patch('/:id/columns/:cid',     updateColumn);
router.delete('/:id/columns/:cid',    deleteColumn);

// --- Cross-board connectivity (F2) ----------------------------------------
// Boards a connect_boards column on this board may target.
router.get('/:id/connectable',        getConnectableBoards);

// --- Board roster ----------------------------------------------------------
// Who may be ASSIGNED work here: the org roster narrowed to those who can read
// this board. Every picker on a board page reads this rather than the whole
// workspace, so a private board stops offering people who are not on it (and
// whom `validateAssignees` would refuse anyway). Read access is the only gate.
router.get('/:id/members',            getBoardMembers);

// --- Per-board access grants (private boards) ------------------------------
// Viewing is open to the owner + editors; changing is limited to the owner and
// members the owner gave full access. All enforced in the controller.
router.get('/:id/access',             getBoardAccess);
router.put('/:id/access',             setBoardAccess);

// --- Ownership transfer ----------------------------------------------------
// Move `createdBy` — the only thing that confers board lifecycle — to another
// member. The board owner may always do it; the WORKSPACE owner may too, as the
// break-glass for a board whose owner has left. The outgoing owner is left with
// an edit + full-access grant so handing the board over never locks them out of
// it. All enforced in the controller.
router.post('/:id/transfer-ownership', transferBoardOwnership);

// --- Activity export -------------------------------------------------------
// Every event recorded on the board within a date range. Gated three ways in
// the controller: board read access, `board.export_activity`, and the caller's
// own `features.activityExport` opt-in.
router.get('/:id/activity-export',    getActivityExport);

module.exports = router;
