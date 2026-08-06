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
  getConnectableBoards,
  getBoardAccess,
  setBoardAccess,
} = require('../controllers/boardController');
const {
  listColumns,
  addColumn,
  updateColumn,
  reorderColumns,
  deleteColumn,
} = require('../controllers/columnController');
const { getActivityExport } = require('../controllers/boardExportController');

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

// --- Per-board access grants (private boards) ------------------------------
// Viewing is open to the owner + editors; changing is limited to the owner and
// members the owner gave full access. All enforced in the controller.
router.get('/:id/access',             getBoardAccess);
router.put('/:id/access',             setBoardAccess);

// --- Activity export -------------------------------------------------------
// Every event recorded on the board within a date range. Gated three ways in
// the controller: board read access, `board.export_activity`, and the caller's
// own `features.activityExport` opt-in.
router.get('/:id/activity-export',    getActivityExport);

module.exports = router;
