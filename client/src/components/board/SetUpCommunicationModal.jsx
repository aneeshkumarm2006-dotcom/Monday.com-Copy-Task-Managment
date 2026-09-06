import { useState } from 'react';
import { Check, Hash, Mail, Send } from 'lucide-react';
import Modal from '../ui/Modal';
import Avatar from '../ui/Avatar';
import {
  SURFACE_KEYS,
  describePlan,
  planSurfaces,
  surfaceByKey,
} from '../../utils/chatSurfaces';

/**
 * "How should we talk to this client about this work?" — the one moment a
 * workstream's conversations are chosen.
 *
 * A client workstream starts with NOTHING. That is the deliberate difference
 * from tracker boards, where a room is minted per group on sight: not every
 * client wants chat, some want subject-lined mail, and a room a client can post
 * into that nobody asked for is worse than no room at all. So this modal is the
 * only way a surface comes into existence, and it is why an empty selection is
 * refused rather than quietly accepted — see `utils/chatSurfaces.js`.
 *
 * ---- Why two big cards instead of three checkboxes -------------------------
 *
 * Chat and mail are not features to tick; they are two different shapes of
 * conversation, and the person choosing has to picture the one they are buying.
 * A running stream you skim, or a subject line you open. The preview inside
 * each card is the whole argument, so the cards are the size of the argument.
 *
 * The team room is genuinely a checkbox: it is not a third shape, it is the
 * same chat room with the client left out, and it is additive to either choice.
 *
 * ---- The previews are PURE ------------------------------------------------
 *
 * Hard-coded people, hard-coded subjects, no fetching, nothing driven by props.
 * At setup time there is by definition no conversation to show, so a preview
 * that tried to be real would either be empty or be a lie. Note the avatars are
 * `ui/Avatar` — one flat accent circle per person, per `utils/avatar.js`. The
 * multi-colour tile hash in the chat sidebar is for ORGANISATIONS, and bringing
 * it near a person is the exact regression that rule exists to prevent.
 *
 * Props:
 *   isOpen, onClose
 *   groupName, clientName   — for the title and the question
 *   existingKeys            — surfaces already on this workstream; shown on and
 *                             disabled, and never counted by the button
 *   allowClientSurfaces     — false on a board with no live client portal. It
 *                             must mirror the server's `isLiveClientBoard`:
 *                             `boardType:'client'` AND `portalEnabled`. The
 *                             board type alone is not that answer — a client
 *                             board whose link was switched off still has the
 *                             type — and the server refuses the WHOLE plan for
 *                             asking, taking the private team room down with
 *                             the client rooms.
 *   onCreate(selection)     — returns a promise; the parent closes on success
 */

const CARD_KEYS = ['clientChat', 'clientMail'];

/** A message row in the chat preview. One side or the other, per the mock. */
const PreviewMessage = ({ name, text, time, mine = false }) => (
  <div
    className="flex items-start gap-1.5"
    style={{ flexDirection: mine ? 'row-reverse' : 'row' }}
  >
    <span className="shrink-0" style={{ marginTop: 1 }}>
      <Avatar user={{ name }} size={16} />
    </span>
    <span className="min-w-0" style={{ textAlign: mine ? 'right' : 'left' }}>
      <span className="flex items-baseline gap-1.5" style={{ flexDirection: mine ? 'row-reverse' : 'row' }}>
        <span
          className="font-body font-bold truncate"
          style={{ fontSize: 9.5, color: 'var(--color-text-primary)' }}
        >
          {name}
        </span>
        {time && (
          <span className="font-body shrink-0" style={{ fontSize: 8.5, color: 'var(--color-text-muted)' }}>
            {time}
          </span>
        )}
      </span>
      <span
        className="font-body block"
        style={{ fontSize: 10, lineHeight: 1.35, color: 'var(--color-text-secondary)' }}
      >
        {text}
      </span>
    </span>
  </div>
);

const ChatPreview = () => (
  <div className="flex flex-col gap-2">
    <PreviewMessage name="Priya" time="10:14" text="Budget's live today" />
    <PreviewMessage name="Sara" text="Thanks!" mine />
    {/* The docked composer, drawn rather than mounted — a real one here would
        be a text box people try to type in. */}
    <div
      className="flex items-center gap-1.5 mt-0.5"
      style={{
        height: 22,
        padding: '0 8px',
        border: '1px solid var(--color-border)',
        borderRadius: 999,
        background: 'var(--color-bg-subtle, #F3F4F6)',
      }}
    >
      <span className="font-body flex-1 truncate" style={{ fontSize: 9.5, color: 'var(--color-text-muted)' }}>
        Message #workstream
      </span>
      <Send size={9} color="var(--color-text-muted)" aria-hidden="true" className="shrink-0" />
    </div>
  </div>
);

/** A subject row in the mail preview. */
const PreviewThread = ({ subject, people, count, time, unread = false }) => (
  <div className="flex items-start gap-1.5">
    <span
      className="shrink-0"
      style={{
        width: 5,
        height: 5,
        marginTop: 4,
        borderRadius: 999,
        background: unread ? 'var(--color-accent)' : 'transparent',
      }}
      aria-hidden="true"
    />
    <span className="min-w-0 flex-1">
      <span className="flex items-baseline gap-2">
        <span
          className="font-body flex-1 truncate"
          style={{
            fontSize: 10,
            fontWeight: unread ? 700 : 600,
            color: 'var(--color-text-primary)',
          }}
        >
          {subject}
        </span>
        <span className="font-body shrink-0" style={{ fontSize: 8.5, color: 'var(--color-text-muted)' }}>
          {time}
        </span>
      </span>
      <span
        className="font-body block truncate"
        style={{ fontSize: 9.5, color: 'var(--color-text-muted)' }}
      >
        {people} · {count}
      </span>
    </span>
  </div>
);

const MailPreview = () => (
  <div className="flex flex-col gap-2">
    <PreviewThread subject="Q4 budget" people="Priya, Sara" count={4} time="10:14" unread />
    <PreviewThread subject="October plan" people="Priya, Sara, Raj" count={7} time="Tue" />
    {/* Mail's equivalent of the docked composer: you start a subject rather
        than typing into a running stream. Same drawn-not-mounted trick. */}
    <div className="flex justify-center mt-0.5">
      <span
        className="font-body inline-flex items-center justify-center"
        style={{
          height: 20,
          padding: '0 12px',
          fontSize: 9.5,
          fontWeight: 600,
          color: 'var(--color-accent)',
          background: 'var(--color-accent-light)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        Compose
      </span>
    </div>
  </div>
);

const PREVIEWS = { clientChat: ChatPreview, clientMail: MailPreview };
const CARD_ICONS = { clientChat: Hash, clientMail: Mail };

/**
 * One toggle card.
 *
 * `aria-pressed` rather than a radio group, because BOTH can be on: the same
 * pattern as `WeekdayChips` in `ui/FormControls.jsx`, scaled up to the size of
 * the choice. The selected treatment is `ClientSignInMethodField`'s — a 1.5px
 * accent border and the accent wash — for the same reason: two controls that
 * mean "this one is chosen" must not look like two different products.
 */
const SurfaceCard = ({ surfaceKey, selected, existing, disabled, onToggle }) => {
  const surface = surfaceByKey(surfaceKey);
  const Preview = PREVIEWS[surfaceKey];
  const Icon = CARD_ICONS[surfaceKey];
  const on = selected || existing;
  const inert = disabled || existing;

  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={inert}
      onClick={() => onToggle(surfaceKey)}
      className="font-body text-left flex flex-col"
      style={{
        padding: 12,
        border: `1.5px solid ${on ? 'var(--color-accent)' : 'var(--color-border)'}`,
        borderRadius: 'var(--radius-lg)',
        background: on ? 'var(--color-accent-light, #EFF6FF)' : 'transparent',
        cursor: inert ? 'default' : 'pointer',
        opacity: disabled && !existing ? 0.55 : 1,
        transition: 'border-color 0.15s ease, background 0.15s ease',
      }}
    >
      <span className="flex items-center gap-1.5" style={{ marginBottom: 8 }}>
        <Icon size={12} aria-hidden="true" color={on ? 'var(--color-accent)' : 'var(--color-text-muted)'} />
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: on ? 'var(--color-accent)' : 'var(--color-text-muted)',
          }}
        >
          {surface?.label}
        </span>
      </span>

      {/* The preview sits on its own white ground so the accent wash behind a
          selected card never reads as part of the conversation. */}
      <span
        className="block"
        style={{
          padding: 10,
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          background: '#FFFFFF',
          minHeight: 108,
        }}
      >
        <Preview />
      </span>

      <span
        className="block"
        style={{
          marginTop: 10,
          paddingTop: 9,
          borderTop: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border)'}`,
          opacity: on ? 0.85 : 1,
        }}
      >
        <span
          className="block"
          style={{ fontSize: 11.5, lineHeight: 1.4, color: 'var(--color-text-secondary)' }}
        >
          {surface?.blurb}
        </span>
      </span>

      <span className="flex items-center justify-end gap-1.5" style={{ marginTop: 8 }}>
        <span
          className="flex items-center justify-center shrink-0"
          style={{
            width: 14,
            height: 14,
            borderRadius: 3,
            border: `1.5px solid ${on ? 'var(--color-accent)' : 'var(--color-border-strong)'}`,
            background: on ? 'var(--color-accent)' : 'transparent',
          }}
          aria-hidden="true"
        >
          {on && <Check size={10} color="#FFFFFF" strokeWidth={3} />}
        </span>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: on ? 'var(--color-accent)' : 'var(--color-text-secondary)',
          }}
        >
          {existing ? 'Already set up' : selected ? 'Selected' : 'Select'}
        </span>
      </span>
    </button>
  );
};

const SetUpCommunicationModal = ({
  isOpen,
  onClose,
  groupName,
  clientName,
  existingKeys = [],
  allowClientSurfaces,
  onCreate,
}) => {
  const [picked, setPicked] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const existing = new Set((existingKeys || []).map(String));

  /**
   * What is actually being asked for.
   *
   * A surface that already exists is forced OFF here rather than left on: the
   * endpoint is idempotent and would happily accept it, but the button counts
   * this object, and "Create 2 surfaces" when one of them has been there for
   * months is a claim about what is about to happen that is not true.
   *
   * A client surface is forced off the same way while `allowClientSurfaces` is
   * false. The cards are disabled, so it normally cannot be picked at all — but
   * the prop can arrive late (the caller has to ask the server whether the
   * portal is live), and a tick made in that window would otherwise be stuck:
   * `planSurfaces` refuses the whole plan for it, and the card it lives on is
   * now disabled, so there is no way to untick it and the team room the person
   * also chose cannot be created either. Dropping it here keeps the legal half
   * of the selection submittable.
   */
  const selection = Object.fromEntries(
    SURFACE_KEYS.map((key) => [
      key,
      !existing.has(key) &&
        !!picked[key] &&
        (allowClientSurfaces || !CARD_KEYS.includes(key)),
    ])
  );

  const plan = planSurfaces(selection, { allowClientSurfaces });

  const toggle = (key) => {
    setError('');
    setPicked((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSubmit = async () => {
    if (!plan.ok || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await onCreate?.(selection);
    } catch (err) {
      // Inline, never a toast-and-close: the selection took thought, and
      // throwing it away to show a message that disappears means making every
      // choice again. The server's own words where it gave any — it knows
      // things this modal does not, like a portal disabled mid-session.
      setError(
        err?.response?.data?.error || 'Could not set this up. Please try again.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const teamSurface = surfaceByKey('team');
  const teamExists = existing.has('team');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Set up communication${groupName ? ` — ${groupName}` : ''}`}
      // 760, not the 480 default: two cards that each have to show a legible
      // preview do not fit in one column of the standard modal.
      maxWidth={760}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="font-body font-semibold transition-colors hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-60"
            style={{
              height: 36,
              padding: '0 16px',
              fontSize: 13,
              color: 'var(--color-text-secondary)',
              background: 'transparent',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!plan.ok || submitting}
            className="font-body font-semibold text-white bg-accent hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            style={{
              height: 36,
              padding: '0 16px',
              fontSize: 13,
              border: 'none',
              borderRadius: 'var(--radius-md)',
            }}
          >
            {submitting ? 'Setting up…' : describePlan(plan.surfaces)}
          </button>
        </>
      }
    >
      <p
        className="font-body"
        style={{ fontSize: 13.5, color: 'var(--color-text-secondary)', marginBottom: 14 }}
      >
        How should we talk to{' '}
        <strong style={{ color: 'var(--color-text-primary)' }}>
          {clientName || 'this client'}
        </strong>{' '}
        about this work?
      </p>

      {/* One column on a phone, two from `sm` up. Nothing here is width-aware
          beyond that: desktop keeps the side-by-side comparison the cards exist
          for, and a narrow screen stacks them rather than shrinking the
          previews into illegibility. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {CARD_KEYS.map((key) => (
          <SurfaceCard
            key={key}
            surfaceKey={key}
            selected={!!selection[key]}
            existing={existing.has(key)}
            // A board with no live client portal can hold no client-facing
            // room at all. Disabling the card is the honest shape: the choice is
            // unavailable, not absent, and the note below says why.
            disabled={!allowClientSurfaces}
            onToggle={toggle}
          />
        ))}
      </div>

      {!allowClientSurfaces && (
        <p
          className="font-body"
          style={{ fontSize: 11.5, color: 'var(--color-text-muted)', marginTop: 8 }}
        >
          Chat and mail with the client need a live client portal on this
          board — the private team room below works either way.
        </p>
      )}

      <label
        className="flex items-start gap-2.5 cursor-pointer"
        style={{
          marginTop: 14,
          padding: '10px 12px',
          border: `1.5px solid ${selection.team || teamExists ? 'var(--color-accent)' : 'var(--color-border)'}`,
          borderRadius: 'var(--radius-md)',
          background: selection.team || teamExists ? 'var(--color-accent-light, #EFF6FF)' : 'transparent',
          cursor: teamExists ? 'default' : 'pointer',
          transition: 'border-color 0.15s ease, background 0.15s ease',
        }}
      >
        <input
          type="checkbox"
          checked={selection.team || teamExists}
          disabled={teamExists}
          onChange={() => toggle('team')}
          className="shrink-0"
          style={{ width: 15, height: 15, marginTop: 1, accentColor: 'var(--color-accent)' }}
        />
        <span className="min-w-0">
          <span
            className="font-body block"
            style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}
          >
            Also create a private team room{groupName ? ` for ${groupName}` : ''}
            <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}> (chat)</span>
            {teamExists && (
              <span style={{ fontWeight: 600, color: 'var(--color-accent)' }}> · Already set up</span>
            )}
          </span>
          <span
            className="font-body block"
            style={{ fontSize: 11.5, marginTop: 1, color: 'var(--color-text-muted)' }}
          >
            {teamSurface?.blurb}
          </span>
        </span>
      </label>

      {error ? (
        <p
          className="font-body"
          role="alert"
          style={{ fontSize: 12, marginTop: 12, color: 'var(--color-status-stuck)' }}
        >
          {error}
        </p>
      ) : (
        !plan.ok && (
          // Guidance, not an error: the button is already disabled, and this
          // says which move re-enables it. The refusal text comes from the same
          // module the server refuses with, so the two never disagree about why.
          <p
            className="font-body"
            style={{ fontSize: 12, marginTop: 12, color: 'var(--color-text-muted)' }}
          >
            {plan.refusals[0]}
          </p>
        )
      )}

      {/* A quiet reminder that this is not the last word. Creating a surface is
          additive and idempotent, so coming back for another one costs nothing
          — which is what makes it safe to pick only what the work needs today. */}
      <p
        className="font-body"
        style={{ fontSize: 11, marginTop: 12, color: 'var(--color-text-muted)' }}
      >
        You can add the others later — nothing here is one-way.
      </p>
    </Modal>
  );
};

export default SetUpCommunicationModal;
