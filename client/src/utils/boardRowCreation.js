/**
 * NEW ROWS ON A FLEXIBLE BOARD — where one lands, what it is called, and which
 * cells it is born holding.
 *
 * Three ways make a row on a flexible-columns board, and all three used to be
 * broken in a different way:
 *
 *   - the header's primary button ("New invoice") called the TaskTable's
 *     inline-create, which neither the Ledger nor the Table (DataGrid) renders,
 *     so it did nothing — except leave `creatingInGroup` set, which kept group
 *     drag disabled until a reload;
 *   - a dropped PDF made a bare row in one call and wrote the file in a second,
 *     so a failure between them left a phantom invoice with no document;
 *   - the grid had no "+ Add" row at all.
 *
 * The page now makes every one of them with ONE `createTask` whose
 * `columnValues` carry the cells, and this file is the part of that which is a
 * rule rather than wiring: which group, which name, which cells. Pure, so
 * `boardRowCreation.test.mjs` pins it in plain Node.
 *
 * ---- Nothing here knows what KIND of board it is ---------------------------
 *
 * Billing is only the first board with a ledger. "Is this a ledger board" is
 * answered by what the board offers (`boardViews`) and what it holds (an
 * amount column, `ledgerColumns`); the owner cell is found by ROLE; the row's
 * noun comes from the display table. No template key and no board name is read
 * here, so the next money board gets all of this by having the columns.
 */
import { ledgerColumns, nextInvoiceNumber } from './ledger.js';
import { roleColumn } from './columnRoles.js';
import { boardViews } from './boardViews.js';
import { templateDisplay } from './boardTemplateDisplay.js';
import { addDaysKey, todayKey } from './payments.js';
import { dateInputToISO } from './dateUtils.js';

/**
 * Net terms a new invoice starts on. The sheet's Net buttons change it in one
 * click; 30 is simply the most common answer, so most rows never need them.
 */
export const DEFAULT_NET_DAYS = 30;

/**
 * Does this board keep a ledger — open its rows in the invoice sheet, number
 * new ones as invoices, and date them?
 *
 * BOTH halves, and both are facts about the board rather than its name: it
 * offers the Ledger view, AND it has an amount column for that view to add
 * up. A billing board whose Amount column was deleted is a list of documents,
 * and its rows open in the ordinary panel rather than a sheet built around a
 * figure that is not there.
 */
export const isLedgerBoard = (board) =>
  !!board && boardViews(board).includes('ledger') && !!ledgerColumns(board).amount;

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** A group name reduced to what a comparison should see: case and punctuation gone. */
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Every way a group could be named after `now`'s month, normalised.
 *
 * Month-named groups exist in two generations: the monthly templates seed bare
 * "January" … "December", and people who built a board by hand write
 * "September 2026", "Sep 26" or "2026-09". All of them count. The reader's own
 * locale name is included too, so a board whose months were typed in French
 * finds "septembre" — a Set, so it costs nothing when it repeats the English.
 */
export const currentMonthGroupNames = (now = new Date()) => {
  const m = now.getMonth();
  const y = now.getFullYear();
  const yy = String(y).slice(-2);
  const mm = String(m + 1).padStart(2, '0');
  const long = MONTHS_LONG[m];
  const short = MONTHS_SHORT[m];
  const names = [long, short, `${long} ${y}`, `${short} ${y}`, `${long} ${yy}`, `${short} ${yy}`, `${y}-${mm}`, `${mm}/${y}`];
  // "Sept" is how a good share of people abbreviate September.
  if (m === 8) names.push('Sept', `Sept ${y}`, `Sept ${yy}`);
  try {
    const local = now.toLocaleString(undefined, { month: 'long' });
    if (local) names.push(local, `${local} ${y}`);
  } catch {
    /* an environment without Intl month names just skips the extra */
  }
  return new Set(names.map(norm).filter(Boolean));
};

/**
 * Which group a new row goes into: the one named after the current month when
 * the board has one, else the first group in the order the board is shown in.
 *
 * `orderedGroups` is the page's render order (it honours "Completed last"), so
 * "first" is the group at the top of the screen — where the row will be seen.
 * Null when the board has no groups, which the caller turns into "add a group
 * first" rather than a POST the server would refuse.
 */
export const newRowGroupFor = (orderedGroups, now = new Date()) => {
  const list = Array.isArray(orderedGroups) ? orderedGroups.filter(Boolean) : [];
  if (list.length === 0) return null;
  const names = currentMonthGroupNames(now);
  return list.find((g) => names.has(norm(g.name))) || list[0];
};

/**
 * The name and cells a row made by "New <row>" / "+ Add <row>" starts with.
 *
 *   ledger board   name = the next invoice number after the board's own
 *                  ("INV-2026-012" → "INV-2026-013"); issued = today and due =
 *                  issued + 30, both as LOCAL midnight — the convention every
 *                  date cell writes (`dateInputToISO`), so the day shown is the
 *                  day meant in every timezone.
 *   any board      the column playing the ASSIGNEE role gets the creator, so a
 *                  new row is somebody's from the moment it exists. The server
 *                  lets a contributor name themselves (the self-assign
 *                  carve-out), so this never turns a permitted create into a 403.
 *   other boards   "New <noun>" in the board's own word — "New deal".
 *
 * `tasks` should be EVERY row on the board, not the filtered ones: the next
 * number must follow the highest number that exists, not the highest visible.
 */
export const newRowPlan = (board, { tasks = [], meId = null, now = new Date() } = {}) => {
  const ledger = isLedgerBoard(board);
  const columnValues = {};

  const owner = roleColumn(board, 'assignee');
  if (owner && owner.type === 'person' && owner._id && meId) {
    columnValues[String(owner._id)] = [String(meId)];
  }

  let name;
  if (ledger) {
    const cols = ledgerColumns(board);
    name = nextInvoiceNumber(tasks);
    const issued = todayKey(now);
    if (cols.issued?._id) columnValues[String(cols.issued._id)] = dateInputToISO(issued);
    const due = addDaysKey(issued, DEFAULT_NET_DAYS);
    if (cols.due?._id && due) columnValues[String(cols.due._id)] = dateInputToISO(due);
  } else {
    const [one] = templateDisplay(board).rowNoun;
    name = `New ${one}`;
  }

  return { name, columnValues, ledger };
};

/**
 * The cells a row made from a DROPPED file starts with: the file itself, and
 * issued = today.
 *
 * Issued matters more than it looks. The ledger's period picker files an
 * invoice by its issued day, and one with none shows only under "All time" — so
 * a freshly dropped invoice would vanish the moment someone looked at "This
 * month". Today is also the honest default: it is the day the invoice reached
 * the board, and the sheet opens straight after for anyone to correct it.
 *
 * Empty when the board has no file column — the caller refuses the drop in that
 * case rather than making rows with nowhere to put the document.
 */
export const uploadedRowCells = (board, stored, now = new Date()) => {
  const cols = ledgerColumns(board);
  const out = {};
  if (!cols.file?._id || !stored) return out;
  out[String(cols.file._id)] = [stored];
  if (cols.issued?._id) out[String(cols.issued._id)] = dateInputToISO(todayKey(now));
  return out;
};

/* ---------------------------------------------------------------------------
 * WHICH FILES A BOARD WILL TAKE
 *
 * The same allowlist as the server's board-file upload (`config/cloudinary.js`
 * `isAllowedBoardFile`), checked here FIRST so a dropped .zip is refused with a
 * sentence before a byte is sent, instead of becoming a failed upload card that
 * a Retry can never fix. The server stays the enforcement — this is only the
 * early, friendlier answer — so the two lists must be kept in step.
 * ------------------------------------------------------------------------- */

const UPLOAD_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'application/csv',
  'text/x-csv',
  'application/x-csv',
  'text/comma-separated-values',
  'text/plain',
]);

const UPLOAD_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg',
]);

/** For a file input's `accept`: what the picker should offer. */
export const BOARD_UPLOAD_ACCEPT =
  'application/pdf,image/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt';

/** The server's own sentence for a refused type, so both refusals read alike. */
export const BOARD_UPLOAD_REFUSED =
  "That kind of file can't be added here. Use a PDF, an image, or a Word, Excel, PowerPoint, CSV or text file.";

/**
 * Would the board-file endpoint accept this File? Mirrors the server exactly:
 * any image, the listed document types, and — when the browser could not name
 * the type (empty, or octet-stream, as Windows does for a CSV with no app) —
 * the file's extension.
 */
export const isAllowedBoardUpload = (file) => {
  const mime = String(file?.type || '').toLowerCase().split(';')[0].trim();
  if (mime.startsWith('image/')) return true;
  if (UPLOAD_MIMES.has(mime)) return true;
  if (!mime || mime === 'application/octet-stream') {
    const m = /\.([a-z0-9]+)$/i.exec(String(file?.name || ''));
    return !!m && UPLOAD_EXTENSIONS.has(m[1].toLowerCase());
  }
  return false;
};

/** `files` split into the ones the board will take and the ones it will not, order kept. */
export const splitBoardUploads = (files) => {
  const allowed = [];
  const refused = [];
  for (const f of Array.isArray(files) ? files : Array.from(files || [])) {
    if (!f) continue;
    (isAllowedBoardUpload(f) ? allowed : refused).push(f);
  }
  return { allowed, refused };
};

/** The one sentence for the files a drop left out. Null when it left none out. */
export const refusedUploadsMessage = (refused) => {
  const list = Array.isArray(refused) ? refused : [];
  if (list.length === 0) return null;
  if (list.length === 1) {
    return `“${list[0]?.name || 'That file'}” wasn't added. ${BOARD_UPLOAD_REFUSED}`;
  }
  return `${list.length} files weren't added. ${BOARD_UPLOAD_REFUSED}`;
};

/**
 * The summary a multi-file drop ends with — ONE toast for the whole batch, in
 * the board's own noun: "3 invoices added — add their amounts". Failures are
 * mentioned, not listed: each one is still on screen as a card with Retry.
 * Null when nothing was added (the cards already say everything).
 */
export const addedRowsMessage = (board, added, failed = 0) => {
  if (!added || added < 1) return null;
  const [one, many] = templateDisplay(board).rowNoun;
  const head =
    added === 1
      ? `1 ${one} added — add its amount`
      : `${added} ${many} added — add their amounts`;
  if (!failed) return `${head}.`;
  return `${head}. ${failed} ${failed === 1 ? 'upload' : 'uploads'} failed — retry from ${
    failed === 1 ? 'its card' : 'their cards'
  }.`;
};
