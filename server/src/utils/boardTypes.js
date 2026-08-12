/**
 * The board types, in one place.
 *
 * This list was previously duplicated across three files — the `Board.boardType`
 * enum, the validation array in `createBoard`, and the radio group in
 * `BoardFormModal` — with no constant tying them together. Adding a type meant
 * finding all three: miss the enum and Mongoose rejects the save, miss the
 * array and creation 400s, miss the radio and nobody can pick it. The server
 * two now both read from here.
 *
 * Each type is a distinct KIND of board, and they are mutually exclusive:
 *
 *   standard — an ordinary internal board.
 *   client   — adds an external-collaboration plane (portal links, client
 *              threads, shared tickets) on top of a private board.
 *   monthly  — partitions the board by calendar month, and adds the Delivery
 *              and Goals views scoped to the selected month.
 */

const BOARD_TYPES = ['standard', 'client', 'monthly'];

const isBoardType = (value) => BOARD_TYPES.includes(value);

module.exports = { BOARD_TYPES, isBoardType };
