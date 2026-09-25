import { useEffect, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';

/**
 * DeleteBoardModal — confirmation dialog for deleting a board.
 *
 * This is the ONLY board-delete surface in the app (the card menu on the boards
 * grid), and it is opened from a list — not from inside the board, where the
 * user would at least see its tabs. So whatever this modal does not say, the
 * user does not know at the moment they click.
 *
 * It used to say "all task groups, tasks, and comments", which named three of
 * roughly eighteen things `boardController.deleteBoard` destroys. The ones it
 * left out are the ones nobody can get back: the board Vault (zero-knowledge —
 * not even the workspace owner can restore it), every chat channel and its
 * whole message history, and the client-portal roster, whose removal revokes
 * outside people's sign-in to a board they were working from.
 *
 * The list below is written from that cascade and is deliberately GENERAL where
 * the prop cannot tell us the truth. Vault existence lives in a separate
 * collection keyed by board and is not on the board payload, and there is no
 * client-contact count on it either, so those lines say what is destroyed "if
 * this board has one" rather than asserting a number this component cannot
 * know. Fetching a per-board impact summary just to render a dialog was the
 * alternative, and it was rejected: it puts a network round trip (and a failure
 * mode) in front of a destructive confirmation whose honest version needs no
 * server at all. `boardType` IS on the board document, so the client-portal and
 * tracker lines are conditioned on it.
 */
const DeleteBoardModal = ({ isOpen, board, onClose, onConfirm }) => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [confirmText, setConfirmText] = useState('');

  // The same gate Settings already puts in front of deleting a WORKSPACE — an
  // exact, trimmed match against the thing's own name. A board is one rung down
  // from a workspace and one rung up from anything else in the app, and this
  // dialog is opened from a card menu on a grid, where the row above and the row
  // below look identical. A misclick here is unrecoverable; typing the name is
  // what makes it impossible to be a misclick.
  //
  // The name, not the word DELETE, for the reason the workspace modal uses it:
  // the board HAS a name, and echoing it back proves you are deleting the one
  // you think you are, which a constant word cannot.
  const confirmMatches =
    !!board?.name && confirmText.trim() === String(board.name).trim();

  // The page keeps this modal MOUNTED and only flips `isOpen`, so state from
  // the last board survives into the next one. After a successful delete that
  // meant `submitting` stayed true: the next board opened already "Deleting…",
  // with Cancel and the close button both locked out. Every open starts clean.
  useEffect(() => {
    if (!isOpen) return;
    setSubmitting(false);
    setError(null);
    setConfirmText('');
  }, [isOpen, board?._id]);

  const handleConfirm = async () => {
    if (!confirmMatches) return;
    try {
      setSubmitting(true);
      setError(null);
      await onConfirm(board);
      setSubmitting(false);
      setConfirmText('');
    } catch (err) {
      const msg =
        err?.response?.data?.error || err?.message || 'Something went wrong';
      setError(msg);
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (submitting) return;
    setError(null);
    setConfirmText('');
    onClose?.();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Delete Board"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={handleClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleConfirm}
            disabled={submitting || !confirmMatches}
          >
            {submitting ? 'Deleting…' : 'Delete Board'}
          </Button>
        </>
      }
    >
      <p
        className="font-body"
        style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
      >
        Are you sure you want to delete{' '}
        <span className="font-semibold">{board?.name}</span>?
      </p>
      <p
        className="mt-2 font-body"
        style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
      >
        Deleting this board permanently removes:
      </p>
      <ul
        className="mt-1 font-body flex flex-col gap-1"
        style={{
          fontSize: 13,
          color: 'var(--color-text-secondary)',
          paddingLeft: 16,
          listStyleType: 'disc',
        }}
      >
        <li>
          Every group, task and subitem, with their updates, comments, files and
          activity history
        </li>
        <li>All chat channels on this board and their entire message history</li>
        <li>Its automations, group notes and connector field mappings</li>
        {board?.boardType === 'tracker' && (
          <li>Its goals, trackers and ads budget records</li>
        )}
        {board?.boardType === 'client' && (
          <li>
            The client portal — every client contact on this board loses access
            immediately
          </li>
        )}
        <li>
          The board Vault, if this board has one — its key material goes with
          it, so nothing stored there can be recovered afterwards, workspace
          escrow included
        </li>
      </ul>
      <p
        className="mt-2 font-body"
        style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
      >
        This action cannot be undone.
      </p>

      <div className="mt-3">
        <label
          className="font-body font-semibold"
          style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
          htmlFor="delete-board-confirm"
        >
          Type <span className="font-semibold" style={{ color: 'var(--color-text-primary)' }}>{board?.name}</span> to confirm:
        </label>
        <input
          id="delete-board-confirm"
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          disabled={submitting}
          autoComplete="off"
          className="mt-2 w-full font-body bg-white px-3 focus:outline-none focus:border-[color:var(--color-accent)]"
          style={{
            fontSize: 13,
            height: 38,
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
          }}
        />
      </div>

      {error && (
        <p
          className="mt-3 font-body text-xs"
          style={{ color: 'var(--color-status-stuck)' }}
        >
          {error}
        </p>
      )}
    </Modal>
  );
};

export default DeleteBoardModal;
