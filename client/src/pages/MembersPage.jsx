import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Trash2,
  ChevronDown,
  Copy,
  Check,
  Mail,
  Send,
  Link,
  Hash,
  Crown,
  AlertTriangle,
  LayoutDashboard,
  Pencil,
} from 'lucide-react';
import PageWrapper from '../components/layout/PageWrapper';
import Button from '../components/ui/Button';
import Modal from '../components/ui/Modal';
import useAuthStore from '../store/authStore';
import useOrgStore from '../store/orgStore';
import usePermissions from '../hooks/usePermissions';
import PermissionsMatrix from '../components/settings/PermissionsMatrix';
import VaultEscrowSection from '../components/settings/VaultEscrowSection';
import * as orgService from '../services/orgService';
import Dropdown from '../components/ui/Dropdown';
import {
  listExecutives,
  declareExecutive,
  copyExecutiveView,
} from '../services/executiveViewService';
import { formatShortDate } from '../utils/dateUtils';

/**
 * The role preset key the Executive View feature assigns. The KEY is the fixed
 * handle (`EXECUTIVE_ROLE_KEY` in `server/src/utils/capabilities.js`); the role's
 * NAME is data and editable in the matrix, so anything shown to a person is read
 * off the workspace's own roles and this constant is only ever used to find the
 * row. Never branch on it for permission — that is `can(...)`'s job.
 */
const EXECUTIVE_ROLE_KEY = 'executive';

const getInitial = (name) => (name ? name.trim().charAt(0).toUpperCase() : '?');

const Avatar = ({ user, size = 40 }) => {
  const [imgError, setImgError] = useState(false);
  if (user?.profilePic && !imgError) {
    return (
      <img
        src={user.profilePic}
        alt={user.name || 'Avatar'}
        className="object-cover"
        style={{ width: size, height: size, borderRadius: 9999 }}
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <div
      className="flex items-center justify-center font-display font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: 9999,
        background: 'var(--color-accent-light)',
        color: 'var(--color-accent-text)',
        fontSize: size * 0.4,
      }}
      aria-hidden="true"
    >
      {getInitial(user?.name)}
    </div>
  );
};

const Chip = ({ children, variant = 'grey' }) => {
  const styles =
    variant === 'blue'
      ? {
          background: 'var(--color-accent-light)',
          color: 'var(--color-accent-text)',
        }
      : {
          background: 'var(--color-bg-subtle)',
          color: 'var(--color-text-secondary)',
        };
  return (
    <span
      className="inline-flex items-center font-body font-semibold"
      style={{
        height: 22,
        padding: '0 10px',
        fontSize: 11,
        borderRadius: 'var(--radius-full)',
        letterSpacing: 0.3,
        ...styles,
      }}
    >
      {children}
    </span>
  );
};

/**
 * THE EXECUTIVES STRIP — everybody in this workspace who has a curated view.
 *
 * The table below already offers "Edit executive view" on the row of anybody
 * who has one, so this is not the only way in. It is the only way to see the
 * SET. A workspace with four executives has four of those links scattered down
 * a roster of forty people in alphabetical order, and an admin who wants to
 * know "who is set up this way, and does each of them actually have boards" has
 * to read every row to find out. One strip answers it at a glance, and the
 * board count is the part that matters: a view with 0 boards is somebody who
 * was made an executive and then never given anything, which is the worst state
 * this feature has and is invisible everywhere else.
 *
 * ---- WHY IT IS ABSENT RATHER THAN EMPTY ------------------------------------
 *
 * Rendered only when there is at least one profile (the caller decides; this
 * component never draws a "no executives yet" state). A workspace that does not
 * use the feature would otherwise carry a permanent empty card at the top of
 * its Members page advertising a feature nobody asked for — furniture, on the
 * page every new workspace visits to add its second person.
 *
 * ---- ORPHANS ARE COUNTED, NOT LISTED ---------------------------------------
 *
 * `GET /orgs/:orgId/executive-views` keeps a profile whose person has been
 * deleted, with `user: null` — it is the only surface in the app that could
 * ever show one, and hiding it would make it unfixable rather than untidy. But
 * an orphan has no name to print, no avatar to draw and no `userId` to build a
 * configurator link from, so a card for it would be a card with nothing on it
 * and nowhere to go. It gets a line under the strip instead: enough to know it
 * is there, honest about the fact that this screen cannot act on it.
 */
const ExecutivesStrip = ({ rows, orphans, roleName, onEdit }) => (
  <section
    className="bg-surface"
    aria-label="Executives"
    style={{
      borderRadius: 'var(--radius-lg)',
      border: '1px solid var(--color-border)',
      padding: '14px 16px',
    }}
  >
    <div className="flex items-baseline gap-2 flex-wrap">
      <h2
        className="font-display font-bold text-[14px]"
        style={{ color: 'var(--color-text-primary)' }}
      >
        Executives
      </h2>
      <p
        className="font-body text-[12.5px]"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {rows.length} {rows.length === 1 ? 'person has' : 'people have'} a
        curated board list and a composed home page.
      </p>
    </div>

    {/* Wraps rather than scrolls. A horizontal scroller hides its own
        contents, and the whole value of this strip is that the set is
        countable without interacting with it. */}
    <ul className="flex flex-wrap gap-2 mt-3">
      {rows.map((row) => {
        const person = row.user;
        const count = row.boardCount || 0;
        return (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onEdit(person._id)}
              title={`Edit ${person.name || person.email}'s executive view`}
              className="flex items-center gap-2.5 text-left transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{
                padding: '7px 12px 7px 8px',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-full)',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              <Avatar user={person} size={28} />
              <span className="min-w-0">
                <span
                  className="block font-body font-semibold text-[13px] truncate"
                  style={{ color: 'var(--color-text-primary)', maxWidth: 180 }}
                >
                  {person.name || person.email}
                </span>
                <span
                  className="block font-body text-[11.5px]"
                  style={{
                    // A view with nothing on it is the state worth noticing, so
                    // it is the one that is not grey. Not an alarm either —
                    // half an hour after "Make executive" it is simply the
                    // truth, and the fix is the click this chip already is.
                    color:
                      count === 0
                        ? 'var(--color-status-working)'
                        : 'var(--color-text-muted)',
                  }}
                >
                  {count === 0
                    ? 'No boards yet'
                    : `${count} ${count === 1 ? 'board' : 'boards'}`}
                </span>
              </span>
              <Pencil
                size={13}
                aria-hidden="true"
                color="var(--color-text-muted)"
                className="shrink-0"
              />
            </button>
          </li>
        );
      })}
    </ul>

    {orphans > 0 && (
      <p
        className="font-body text-[12px] mt-2.5"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {orphans} further {orphans === 1 ? 'view belongs' : 'views belong'} to
        {orphans === 1 ? ' someone' : ' people'} who {orphans === 1 ? 'is' : 'are'}{' '}
        no longer in this workspace. {orphans === 1 ? 'It reaches' : 'They reach'}{' '}
        nothing — there is no account left to sign in with — and there is nothing
        to edit here.
      </p>
    )}

    <p
      className="font-body text-[12px] mt-2.5"
      style={{ color: 'var(--color-text-muted)' }}
    >
      {/* Said once, here, rather than on every chip: the same sentence repeated
          four times is noise, and this is the fact that makes the strip
          readable — a name on it is a screen somebody else is looking at. */}
      Each of them signs in to only the boards on their list. Give somebody a
      view with “Make executive” on their row below; the {roleName} role is what
      stops the workspace’s public boards arriving anyway.
    </p>
  </section>
);

/**
 * Why a board on the copied view did not come across — the server's
 * `COPY_SKIP_REASONS`, one sentence each.
 *
 * Written for the person who has to decide what to do about it rather than for
 * a log, and the four are genuinely four different situations with four
 * different next moves. Two of them are not about the new executive at all:
 * `cannot-share` is a fact about the ADMIN's own authority over that board (the
 * copy adds each one through the same per-board check a manual add uses), and
 * `source-no-access` is a fact about the person being COPIED FROM — their own
 * list has an entry they can no longer open, so there was no level to copy and
 * granting the default instead would hand the new person more reach than the
 * original holds.
 *
 * An unrecognised key falls back to the server's own `error` string (see
 * `SkippedBoards`) rather than to a generic sentence: a refusal this build has
 * not learned yet is still more useful spelled out, and it is the string a
 * support conversation will be about.
 */
const COPY_SKIP_COPY = {
  deleted: 'This board has been deleted. There was nothing left to copy.',
  'source-no-access':
    'The person you copied from can no longer open this board themselves, so there was no access to pass on. Add it from the next screen if it should be on the list.',
  'cannot-share':
    'You cannot share this board, so it was not added. Ask whoever runs it to share it, or add it from the next screen once you can.',
  failed: 'It could not be shared.',
};

/**
 * The boards a copy could not bring across, named one per line.
 *
 * A COUNT IS NOT A REPORT. "3 boards were skipped" tells an admin that
 * something is wrong and nothing about what, and the thing they have to do next
 * — go and ask the owner of one particular board to share it — needs the name.
 * So every row is named, and none of this is behind a disclosure: a report
 * folded shut is a report that was not read.
 */
const SkippedBoards = ({ skipped }) => (
  <ul
    className="mt-2 flex flex-col"
    style={{
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
    }}
  >
    {skipped.map((entry, index) => (
      <li
        key={String(entry?.board || index)}
        style={{
          padding: '9px 12px',
          borderBottom:
            index === skipped.length - 1 ? 'none' : '1px solid var(--color-border)',
        }}
      >
        <p
          className="font-body font-semibold text-[13px]"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {/* `name` is the board's own name. A board with none left to read by
              is still worth a row — its absence is the fact being reported. */}
          {entry?.name || 'A board on that view'}
        </p>
        <p
          className="font-body text-[12.5px] mt-0.5"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          {/* `error` is the service's own refusal and is null on the three
              reasons that have a sentence above; it is populated exactly where
              the reason is `failed`, which is the case that has nothing better
              to say than what the server said. */}
          {COPY_SKIP_COPY[entry?.reason] ||
            entry?.error ||
            'It could not be shared.'}
        </p>
      </li>
    ))}
  </ul>
);

/**
 * WHAT THE CREATE FLOW ACTUALLY DID — the second shape of the "Make executive"
 * dialog.
 *
 * It is on screen because something needs acknowledging, and there are exactly
 * two things that can: a copy that had to skip boards, and a copy that did not
 * run at all after the role had already moved. Both leave a real person in a
 * real state that is not the one the admin asked for, and both are invisible
 * from anywhere else on this page — which is why neither is a toast.
 *
 * A copy with nothing to report never reaches this component: it navigates
 * straight to the configurator, where the boards it copied are the screen.
 */
const DeclareReport = ({ name, report, error }) => {
  if (error) {
    return (
      <>
        <p className="font-body text-[14px] text-[color:var(--color-text-primary)]">
          <strong>{name}</strong> is an executive now, with an empty view.
        </p>
        <div
          role="alert"
          className="font-body text-[13px] mt-3 flex items-start gap-2"
          style={{
            padding: '10px 12px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-status-stuck-bg)',
            color: 'var(--color-status-stuck)',
          }}
        >
          <AlertTriangle size={15} aria-hidden="true" className="shrink-0 mt-px" />
          <span>
            {error} Their role moved and the view was created — only the copy
            failed, so nothing has been half-copied. Build the list on the next
            screen, or try copying again from there.
          </span>
        </div>
      </>
    );
  }

  const skipped = report?.skipped || [];
  return (
    <>
      <p className="font-body text-[14px] text-[color:var(--color-text-primary)]">
        <strong>{name}</strong> is an executive, with{' '}
        <strong>
          {report.boards} {report.boards === 1 ? 'board' : 'boards'}
        </strong>{' '}
        and {report.home} home{' '}
        {report.home === 1 ? 'section' : 'sections'} copied
        {report.from ? (
          <>
            {' '}
            from <strong>{report.from.name || report.from.email}</strong>
          </>
        ) : null}
        .
      </p>

      <div
        className="font-body text-[13px] mt-3 flex items-start gap-2"
        style={{
          padding: '10px 12px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-status-working-bg)',
          color: 'var(--color-status-working)',
        }}
      >
        <AlertTriangle size={15} aria-hidden="true" className="shrink-0 mt-px" />
        <span>
          {skipped.length} {skipped.length === 1 ? 'board' : 'boards'} could not
          be copied.
        </span>
      </div>

      <SkippedBoards skipped={skipped} />

      <p
        className="font-body text-[12.5px] mt-3"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {/* The half that is easy to assume and wrong. A section pointing at a
            board that was not copied is not broken — it says so itself, to
            them, on their home page — but it is the admin's to notice now
            rather than theirs to discover. */}
        The rest is on their view. If a home section pointed at one of the
        boards above, it will tell them it is unavailable until the board is
        shared — the Preview step on the next screen shows exactly what they
        will see.
      </p>
    </>
  );
};

/**
 * Pick any of the org's roles — including custom ones. This used to be a
 * hardcoded two-option toggle between the strings 'admin' and 'member', which was
 * the clearest symptom of roles not being data: there was no third option to
 * offer, because there was nowhere to put one.
 */
const RoleDropdown = ({ roles, currentRoleId, onChange, disabled }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // The owner role is not assignable HERE. There is exactly one owner, and moving
  // it is not a role change — it is moving the identity the role system refuses to
  // constrain, which is what "Make owner" below does in one atomic write.
  const options = (roles || []).filter((r) => r.key !== 'owner');
  const current = options.find((r) => String(r.id) === String(currentRoleId));

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className="inline-flex items-center gap-1 font-body font-semibold text-[12px] rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{
          height: 26,
          padding: '0 8px',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--color-bg-surface)',
          color: current?.color || 'var(--color-text-primary)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {current?.name || 'Member'}
        {!disabled && <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {open && (
        <div
          className="absolute z-50 mt-1"
          style={{
            minWidth: 130,
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-surface)',
            boxShadow: 'var(--shadow-card)',
            padding: '4px 0',
          }}
        >
          {options.map((opt) => {
            const isCurrent = String(opt.id) === String(currentRoleId);
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (!isCurrent) onChange(opt.id);
                }}
                className="flex w-full items-center gap-2 text-left font-body text-[12px] px-3 py-1.5 hover:bg-[color:var(--color-bg-subtle)]"
                style={{
                  color: 'var(--color-text-primary)',
                  fontWeight: isCurrent ? 600 : 400,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 9999,
                    background: opt.color,
                    flexShrink: 0,
                  }}
                />
                {opt.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const InviteSection = ({ currentOrg }) => {
  const inviteCode = currentOrg?.inviteCode || '';
  const inviteLink = inviteCode
    ? `${window.location.origin}/onboarding?invite=${inviteCode}`
    : '';

  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleCopy = (text, type) => {
    navigator.clipboard.writeText(text).then(() => {
      if (type === 'link') {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
      } else {
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 2000);
      }
    });
  };

  const handleSend = async () => {
    if (!email.trim() || !currentOrg?._id) return;
    setSending(true);
    setError('');
    setSent(false);
    try {
      await orgService.sendInvite(currentOrg._id, email.trim());
      setSent(true);
      setEmail('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send invite. Try again.');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSend();
  };

  return (
    <div
      className="mb-6"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--color-bg-surface)',
        boxShadow: 'var(--shadow-card)',
        padding: '20px 24px',
      }}
    >
      <h2
        className="font-display font-bold text-[15px] mb-4"
        style={{ color: 'var(--color-text-primary)' }}
      >
        Invite People
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {/* Invite Link */}
        <div>
          <p
            className="font-body text-[11px] font-semibold uppercase tracking-widest mb-1.5 flex items-center gap-1.5"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Link size={12} />
            Invite Link
          </p>
          <div
            className="flex items-center gap-2"
            style={{
              border: '1.5px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: '6px 10px',
              background: 'var(--color-bg-input)',
              height: 36,
            }}
          >
            <span
              className="flex-1 font-body text-[12px] truncate select-all"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {inviteLink || 'Loading…'}
            </span>
            <button
              type="button"
              onClick={() => handleCopy(inviteLink, 'link')}
              disabled={!inviteLink}
              aria-label="Copy invite link"
              className="flex items-center gap-1 font-body text-[12px] font-medium shrink-0 transition-colors"
              style={{
                color: copiedLink ? 'var(--color-success, #16a34a)' : 'var(--color-accent)',
                background: 'none',
                border: 'none',
                cursor: inviteLink ? 'pointer' : 'not-allowed',
                padding: '2px 4px',
              }}
            >
              {copiedLink ? <Check size={13} /> : <Copy size={13} />}
              {copiedLink ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        {/* Invite Code */}
        <div>
          <p
            className="font-body text-[11px] font-semibold uppercase tracking-widest mb-1.5 flex items-center gap-1.5"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Hash size={12} />
            Invite Code
          </p>
          <div
            className="flex items-center gap-2"
            style={{
              border: '1.5px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: '6px 10px',
              background: 'var(--color-bg-input)',
              height: 36,
            }}
          >
            <span
              className="flex-1 font-body text-[14px] font-semibold tracking-widest select-all"
              style={{ color: 'var(--color-text-primary)', letterSpacing: '0.15em' }}
            >
              {inviteCode || 'Loading…'}
            </span>
            <button
              type="button"
              onClick={() => handleCopy(inviteCode, 'code')}
              disabled={!inviteCode}
              aria-label="Copy invite code"
              className="flex items-center gap-1 font-body text-[12px] font-medium shrink-0 transition-colors"
              style={{
                color: copiedCode ? 'var(--color-success, #16a34a)' : 'var(--color-accent)',
                background: 'none',
                border: 'none',
                cursor: inviteCode ? 'pointer' : 'not-allowed',
                padding: '2px 4px',
              }}
            >
              {copiedCode ? <Check size={13} /> : <Copy size={13} />}
              {copiedCode ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </div>

      {/* Send invite via email */}
      <div>
        <p
          className="font-body text-[11px] font-semibold uppercase tracking-widest mb-1.5 flex items-center gap-1.5"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Mail size={12} />
          Send Invite via Email
        </p>
        <div className="flex gap-2">
          <div
            className="flex items-center flex-1"
            style={{
              border: '1.5px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: '0 10px',
              background: 'var(--color-bg-input)',
              height: 36,
            }}
          >
            <Mail size={14} style={{ color: 'var(--color-text-muted)', marginRight: 6, flexShrink: 0 }} />
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setSent(false); setError(''); }}
              onKeyDown={handleKeyDown}
              placeholder="colleague@example.com"
              className="flex-1 font-body bg-transparent focus:outline-none"
              style={{ fontSize: 13, color: 'var(--color-text-primary)', border: 'none' }}
            />
          </div>
          <button
            type="button"
            onClick={handleSend}
            disabled={!email.trim() || sending}
            className="flex items-center gap-1.5 font-body font-semibold text-[13px] shrink-0 transition-colors"
            style={{
              height: 36,
              padding: '0 16px',
              background: 'var(--color-accent)',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              cursor: !email.trim() || sending ? 'not-allowed' : 'pointer',
              opacity: !email.trim() || sending ? 0.6 : 1,
            }}
          >
            <Send size={13} />
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
        {sent && (
          <p className="font-body text-[13px] mt-2" style={{ color: 'var(--color-success, #16a34a)' }}>
            Invite sent successfully!
          </p>
        )}
        {error && (
          <p className="font-body text-[13px] mt-2" style={{ color: 'var(--color-error, #dc2626)' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
};

const MembersPage = () => {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const members = useOrgStore((s) => s.members);
  const adminId = useOrgStore((s) => s.adminId);
  const memberRoles = useOrgStore((s) => s.memberRoles);
  const roles = useOrgStore((s) => s.roles);
  const fetchMembers = useOrgStore((s) => s.fetchMembers);
  const transferOwnership = useOrgStore((s) => s.transferOwnership);

  // What the SERVER says this user may do — not a local re-derivation of it.
  // `isOwner` is identity, not a capability: transferring the workspace is the
  // one action no role may ever be granted, so it cannot be spelled `can(...)`.
  const { can, isOwner } = usePermissions();

  const [confirmMember, setConfirmMember] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [changingRole, setChangingRole] = useState(null);
  const [roleError, setRoleError] = useState('');
  // Ownership transfer. One entry point — the owner's own row — rather than a
  // "Make owner" button beside every member: this is the rarest and least
  // reversible action on the page, and thirteen copies of it sitting one click
  // away from Remove is an invitation to a mis-click.
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTo, setTransferTo] = useState(null);
  const [transferQuery, setTransferQuery] = useState('');
  const [transferring, setTransferring] = useState(false);

  /**
   * WHO ALREADY HAS AN EXECUTIVE VIEW — one request for the whole page.
   *
   * THE ROWS, not the count map this used to be, because two surfaces now read
   * one answer and the second one must not cost a second request: the strip
   * above the table lists the people, and every row in the table asks whether
   * ITS person is one of them. `executiveBoardCounts` below is derived from
   * this for the second job — thirteen members would otherwise be thirteen
   * requests to render one column, and the admin plane publishes this summary
   * for exactly this purpose.
   *
   * `null` until the answer is in (or when the caller cannot ask), which is NOT
   * the same as "nobody has one": rendering "Make executive" on somebody who
   * already has a view would send an admin through the declare flow to reach a
   * screen they could have opened directly. The row shows no executive control
   * at all until this is loaded, and the strip does not render.
   */
  const [executives, setExecutives] = useState(null);
  /**
   * Bumped to ask again. The list is stale the moment a view is created from
   * this page, and the create flow does not always leave: a copy that had to
   * skip boards holds its report open, and closing it must not leave a strip
   * that disagrees with what just happened.
   */
  const [executivesToken, setExecutivesToken] = useState(0);
  // "Make executive" is a confirm-then-act flow, modelled on the transfer modal
  // above: the member it was opened on, or null.
  const [makeExecutiveFor, setMakeExecutiveFor] = useState(null);
  const [declaring, setDeclaring] = useState(false);
  const [declareError, setDeclareError] = useState('');
  /**
   * "Start from" — the user id of an existing executive whose view is copied
   * onto the new one, or `''` for a blank view.
   *
   * Offered only when there is somebody to copy FROM. The second executive in a
   * workspace is the one this exists for: their view is almost always the first
   * one again, and rebuilding it by hand is four board adds, a home page and
   * eight switches to get wrong.
   */
  const [copyFrom, setCopyFrom] = useState('');
  /**
   * What the copy could not do — `{ skipped: [...], copied: n }` — held on
   * screen until the admin has seen it.
   *
   * THIS IS THE WHOLE VALUE OF THE FLOW BEING HONEST. The server adds each
   * copied board through the same per-board check a manual add goes through, so
   * a board the CALLER cannot share is not copied. An admin who was not told
   * that walks away believing the two views match, and the person on the
   * receiving end has a home page of sections pointing at boards they cannot
   * open. It is a report, not a toast: a sentence that fades is worse than no
   * sentence at all, because it leaves somebody sure they read something.
   */
  const [copyReport, setCopyReport] = useState(null);
  /**
   * The third outcome: the DECLARE landed and the COPY did not.
   *
   * It cannot be folded into `declareError`, because that banner sits over a
   * dialog whose primary button says "Make executive" — and pressing it again
   * would be right if nothing had happened and wrong here, where the person
   * already has the role and an empty view. So the dialog changes shape
   * instead: the report state, with one way on to the configurator.
   */
  const [declaredWithoutCopy, setDeclaredWithoutCopy] = useState(false);

  const orgAdminId =
    typeof currentOrg?.admin === 'object' && currentOrg?.admin !== null
      ? currentOrg.admin._id || currentOrg.admin
      : currentOrg?.admin;

  useEffect(() => {
    if (currentOrg?._id) {
      fetchMembers(currentOrg._id).catch(() => {});
    }
  }, [currentOrg?._id, fetchMembers]);

  // Only the people who can act on it are asked to pay for it. `can(...)` is
  // resolved by the server and arrives with the members payload, so this flips
  // from false to true mid-mount for a cold page load — hence the boolean in the
  // dependency list rather than `can` itself, whose identity changes on every
  // permission refresh.
  const canManageExecutives = can('org.manage_executive_views');

  useEffect(() => {
    if (!currentOrg?._id || !canManageExecutives) {
      setExecutives(null);
      return undefined;
    }
    // Switching workspaces mid-flight must not let the old workspace's answer
    // land on the new one's table.
    let live = true;
    listExecutives(currentOrg._id)
      .then((data) => {
        if (live) setExecutives(data?.executives || []);
      })
      .catch(() => {
        // Left null, so no row offers an executive control and no strip is
        // drawn. A failed read must not become "nobody is an executive" — that
        // would offer "Make executive" on people who already have a view.
        if (live) setExecutives(null);
      });
    return () => {
      live = false;
    };
  }, [currentOrg?._id, canManageExecutives, executivesToken]);

  /**
   * user id → board count, for the table's per-row decision.
   *
   * A profile whose person was deleted comes back with `user: null` — the one
   * surface in the app that can show an orphan. There is no row in this table
   * for them, so there is nothing to key it on; those are skipped here rather
   * than written as an `undefined` key that would match everybody.
   *
   * `null` in, `null` out: the three-way distinction the rows depend on
   * (unknown / has one / does not) survives the derivation.
   */
  const executiveBoardCounts = useMemo(() => {
    if (!executives) return null;
    const counts = {};
    for (const row of executives) {
      if (!row?.user?._id) continue;
      counts[String(row.user._id)] = row.boardCount || 0;
    }
    return counts;
  }, [executives]);

  /** The strip's rows, and the orphans it can only count. See `ExecutivesStrip`. */
  const executivePeople = useMemo(
    () => (executives || []).filter((row) => row?.user?._id),
    [executives]
  );
  const orphanedViews = (executives || []).length - executivePeople.length;

  /**
   * Who the new view could be copied from — everybody with one EXCEPT the
   * person being given one.
   *
   * Self-exclusion is not defensive tidying. "Make executive" is only offered
   * on a row with no view, so the target cannot normally be in this list — but
   * the list is a cached read and the row's decision comes from the same cache,
   * so both are stale together, and a stale pair would offer somebody their own
   * view as a starting point for itself.
   */
  const copySources = useMemo(
    () =>
      executivePeople.filter(
        (row) => String(row.user._id) !== String(makeExecutiveFor?._id)
      ),
    [executivePeople, makeExecutiveFor]
  );

  /**
   * The dialog has TWO shapes, not one with an extra paragraph.
   *
   * Before: a decision, with consequences and a "Make executive" button.
   * After: a report of what happened, with one way onward. Leaving the decision
   * copy on screen under a report would put "Their role changes to Executive" in
   * the future tense next to a list of boards that already did or did not get
   * copied, and leave a primary button offering to do again a thing that has
   * been done.
   */
  const showingDeclareReport = !!copyReport || declaredWithoutCopy;

  const configuratorPath = (userId) => `/members/${userId}/executive-view`;

  // Opening the dialog clears whatever the LAST attempt said. Without this a
  // refusal about one person stays on screen when the dialog reopens on another,
  // which reads as a refusal about them — and a copy report about somebody else
  // would be read as a report about this one.
  const openMakeExecutive = (member) => {
    setDeclareError('');
    setCopyReport(null);
    setDeclaredWithoutCopy(false);
    // "Start from" re-arms to blank on every open. A source chosen for one
    // person is not a preference about the next one, and a dialog that opened
    // already primed to copy somebody's boards would be reach handed out by a
    // control nobody looked at.
    setCopyFrom('');
    setMakeExecutiveFor(member);
  };

  /** Leave the dialog and open the view that was just created. */
  const goToNewView = () => {
    const id = makeExecutiveFor?._id;
    setMakeExecutiveFor(null);
    setCopyReport(null);
    setDeclaredWithoutCopy(false);
    if (id) navigate(configuratorPath(id));
  };

  /**
   * Dismiss the report without following it through to the configurator.
   *
   * The strip and every row's control are drawn from a list that was read
   * before any of this happened, so the page is now lying about at least one
   * person. Asking again is one request and it is the only way the table can
   * agree with what the admin just did.
   */
  const dismissAfterDeclare = () => {
    setMakeExecutiveFor(null);
    setCopyReport(null);
    setDeclaredWithoutCopy(false);
    setExecutivesToken((n) => n + 1);
  };

  /**
   * Declare, optionally copy, then go to the configurator.
   *
   * The declare and the configurator are one action from the admin's side:
   * "make this person an executive" is not finished until they have boards, and
   * a declare that dropped them back on the members table would leave a person
   * in the executive role with an empty board list — reach withheld and nothing
   * given back, which is the worst intermediate state this feature has. The
   * server's `declare` is idempotent, so a failed navigation is a retry, not a
   * duplicate.
   *
   * ---- WHY THE COPY IS A SECOND CALL AND NOT A FLAG ON THE FIRST -----------
   *
   * `copy-from` refuses to run against a person who has no profile, exactly as
   * "add a board" does, and for the same reason: a route that creates a profile
   * as a side effect is a second way to make somebody an executive, skipping
   * every gate `declare` puts on that decision. So the order is fixed —
   * declare, then copy onto what it made — and the two can genuinely come apart:
   * the first can land and the second fail, which is `declaredWithoutCopy`.
   *
   * ---- AND WHY A SKIPPED BOARD DOES NOT LEAVE ------------------------------
   *
   * The copy adds each board through the same per-board authorisation a manual
   * add goes through, so a board this admin cannot share is skipped rather than
   * granted. That report is the point of the feature being honest, and it is
   * gone the moment this page navigates. When there is one, the dialog stays and
   * shows it; when there is nothing to report, holding somebody in front of a
   * dialog to press one more button would be ceremony.
   */
  const handleDeclareExecutive = async () => {
    if (!makeExecutiveFor || !currentOrg?._id) return;
    const orgId = currentOrg._id;
    const targetId = makeExecutiveFor._id;
    setDeclaring(true);
    setDeclareError('');
    try {
      await declareExecutive(orgId, targetId);
    } catch (err) {
      // Kept INSIDE the modal rather than raised to the page banner: the
      // refusals here are about this one person ("changing their role needs
      // permission to change roles", "the owner cannot be given an executive
      // view"), and they have to be readable next to the button that caused
      // them, which is still on screen.
      setDeclareError(
        err?.response?.data?.error || 'Could not make that person an executive'
      );
      setDeclaring(false);
      return;
    }

    if (!copyFrom) {
      setDeclaring(false);
      setMakeExecutiveFor(null);
      navigate(configuratorPath(targetId));
      return;
    }

    try {
      const result = await copyExecutiveView(orgId, targetId, copyFrom);
      const skipped = result?.skipped || [];
      if (skipped.length === 0) {
        setMakeExecutiveFor(null);
        navigate(configuratorPath(targetId));
        return;
      }
      setCopyReport({
        skipped,
        // `copied[]`, not the length of the resulting board list. What matters
        // is what this copy LANDED, and the two are different numbers the
        // moment the target already had a board of their own — which a person
        // declared one second ago does not, but a page that reported the wrong
        // one of the two would be wrong only in the case nobody tests.
        boards: (result?.copied || []).length,
        home: (result?.profile?.home || []).length,
        from:
          copySources.find((row) => String(row.user._id) === String(copyFrom))
            ?.user || null,
      });
    } catch (err) {
      // The role moved and the view exists; only the copy failed. Said in those
      // words, because "could not make that person an executive" would be false
      // and would invite a second press of a button that is no longer there.
      setDeclaredWithoutCopy(true);
      setDeclareError(
        err?.response?.data?.error ||
          'Could not copy that view. Nothing was copied.'
      );
    } finally {
      setDeclaring(false);
    }
  };

  const handleRemove = async () => {
    if (!confirmMember || !currentOrg?._id) return;
    setRemoving(true);
    try {
      await orgService.removeMember(currentOrg._id, confirmMember._id);
      await fetchMembers(currentOrg._id);
      setConfirmMember(null);
    } catch (err) {
      setRoleError(err?.response?.data?.error || 'Could not remove that member');
    } finally {
      setRemoving(false);
    }
  };

  const handleRoleChange = async (userId, roleId) => {
    if (!currentOrg?._id) return;
    setChangingRole(userId);
    setRoleError('');
    try {
      await orgService.assignRole(currentOrg._id, userId, roleId);
      await fetchMembers(currentOrg._id);
    } catch (err) {
      setRoleError(err?.response?.data?.error || 'Could not change that role');
    } finally {
      setChangingRole(null);
    }
  };

  const openTransfer = () => {
    setTransferTo(null);
    setTransferQuery('');
    setTransferOpen(true);
  };

  const handleTransferOwnership = async () => {
    if (!transferTo || !currentOrg?._id) return;
    setTransferring(true);
    setRoleError('');
    try {
      await transferOwnership(currentOrg._id, transferTo._id);
      setTransferOpen(false);
      setTransferTo(null);
    } catch (err) {
      setRoleError(
        err?.response?.data?.error || 'Could not transfer ownership'
      );
      setTransferOpen(false);
    } finally {
      setTransferring(false);
    }
  };

  const resolvedAdminId = adminId || orgAdminId;

  /**
   * The role's DISPLAY NAME, read off the workspace's own roles.
   *
   * Roles are data — this one is editable in the matrix like every other — so
   * the modal below says whatever this workspace calls it. The literal is only
   * the fallback for a workspace that has not been migrated yet, where the
   * server seeds the role on the first declare anyway.
   */
  const executiveRoleName =
    (roles || []).find((r) => r.key === EXECUTIVE_ROLE_KEY)?.name ||
    'Executive';

  /**
   * THE ACTIONS COLUMN IS WIDER FOR PEOPLE WHO CAN SEE TWO CONTROLS IN IT.
   *
   * It was sized at 170px for a cell that held exactly one control, because the
   * cell was an if/else chain that could only ever render one. A row may now
   * legitimately need both the executive action and Remove, and "Edit executive
   * view" alone is most of 170px — so the column grows, but only for the admins
   * who hold `org.manage_executive_views`. Everyone else's table is the table
   * they have always had, to the pixel.
   *
   * Both class strings are spelled out as literals rather than composed, because
   * Tailwind's JIT scans source text: a template string would emit no CSS for
   * either width. The same pair is used by the header row and by every body row,
   * so the two cannot come apart.
   *
   * On mobile the column becomes `auto` instead of a fixed 110px: the action
   * labels are the only thing that knows how wide they are, and the name beside
   * them already truncates.
   */
  const ROW_GRID = canManageExecutives
    ? 'grid-cols-[1fr_auto] md:grid-cols-[1fr_1fr_110px_110px_250px]'
    : 'grid-cols-[1fr_110px] md:grid-cols-[1fr_1fr_110px_110px_170px]';
  const HEADER_GRID = canManageExecutives
    ? 'md:grid-cols-[1fr_1fr_110px_110px_250px]'
    : 'md:grid-cols-[1fr_1fr_110px_110px_170px]';

  // Everyone the workspace could be handed to: every member except its current
  // owner, who is the person opening this modal.
  const transferCandidates = members.filter(
    (m) => String(m._id) !== String(resolvedAdminId)
  );
  const transferNeedle = transferQuery.trim().toLowerCase();
  const filteredTransferCandidates = transferNeedle
    ? transferCandidates.filter((m) =>
        `${m.name || ''} ${m.email || ''}`.toLowerCase().includes(transferNeedle)
      )
    : transferCandidates;

  return (
    <PageWrapper>
      <div className="mx-auto" style={{ maxWidth: 900 }}>
        <header className="mb-6">
          <h1
            className="font-display font-bold text-[color:var(--color-text-primary)] text-[22px] md:text-[28px]"
            style={{ letterSpacing: '-0.01em' }}
          >
            Members
          </h1>
          <p className="mt-1 font-body text-sm text-[color:var(--color-text-secondary)]">
            {members.length} {members.length === 1 ? 'person' : 'people'} in this workspace
          </p>
        </header>

        {roleError && (
          <div
            role="alert"
            className="mb-4 font-body"
            style={{
              fontSize: 13,
              padding: '10px 12px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-status-stuck-bg)',
              color: 'var(--color-status-stuck)',
            }}
          >
            {roleError}
          </div>
        )}

        {/* THE EXECUTIVES STRIP. Two conditions, and both are load-bearing:
            only somebody who can manage these views is shown it (the list it
            reads is not even fetched otherwise), and only when there is at
            least one — see the component's header for why an empty one would be
            furniture. A workspace that does not use the feature, and every
            member of one that does, gets the page they had before this existed,
            to the pixel. */}
        {canManageExecutives && executivePeople.length > 0 && (
          <div className="mb-5">
            <ExecutivesStrip
              rows={executivePeople}
              orphans={orphanedViews}
              roleName={executiveRoleName}
              onEdit={(id) => navigate(configuratorPath(id))}
            />
          </div>
        )}

        <div
          className="bg-surface"
          style={{
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-card)',
          }}
        >
          <div
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              overflow: 'visible',
            }}
          >
            {/* Table header */}
            <div
              className={`hidden md:grid ${HEADER_GRID} items-center px-4`}
              style={{
                height: 40,
                background: 'var(--color-bg-subtle)',
                borderBottom: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
              }}
            >
              {['Member', 'Email', 'Role', 'Joined', ''].map((h) => (
                <span
                  key={h}
                  className="font-body font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]"
                  style={{ fontSize: 11 }}
                >
                  {h}
                </span>
              ))}
            </div>

            {members.map((m) => {
              const isTheOwner = String(m._id) === String(resolvedAdminId);
              const isSelf = String(m._id) === String(user?._id);
              // The role the SERVER resolved for this person (owner → explicit
              // assignment → legacy admins[] → default). The client no longer
              // re-implements that order.
              const role = memberRoles?.[String(m._id)] || null;

              // The owner's role is nobody's to change — there is exactly one, and
              // ownership is not transferable. The server rejects it either way;
              // this just keeps the UI honest.
              const canChangeRole =
                can('org.assign_roles') && !isTheOwner && !isSelf;
              const canRemove =
                can('org.remove_members') && !isTheOwner && !isSelf;
              // The transfer control lives on the OWNER'S OWN ROW, and only when
              // the viewer is that owner. Identity, never a capability — a
              // delegate who can appoint an owner can appoint themselves. Who it
              // goes to is chosen inside the modal.
              const canTransfer = isOwner && isTheOwner && isSelf;

              // Invariant 8: the owner cannot be given an executive view (the
              // server refuses it on three separate routes). And not on your own
              // row — withholding your own reach from a screen you are standing
              // on is a lockout with a confirm dialog in front of it.
              //
              // `executiveBoardCounts === null` means the answer is not in, so
              // nothing renders: see the state's comment for why an unknown must
              // not read as "not an executive".
              const canGiveExecutiveView =
                canManageExecutives &&
                executiveBoardCounts !== null &&
                !isTheOwner &&
                !isSelf;
              const executiveBoards = canGiveExecutiveView
                ? executiveBoardCounts[String(m._id)]
                : undefined;
              const hasExecutiveView = executiveBoards !== undefined;

              return (
                <div
                  key={m._id}
                  className={`grid ${ROW_GRID} items-center gap-2 px-4 py-3`}
                  style={{ borderBottom: '1px solid var(--color-border)' }}
                >
                  {/* Avatar + name */}
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar user={m} size={32} />
                    <div className="min-w-0">
                      <p className="font-body font-semibold text-[13px] text-[color:var(--color-text-primary)] truncate">
                        {m.name || 'Unnamed'}
                        {isSelf && (
                          <span className="ml-2 font-body font-normal text-[11px] text-[color:var(--color-text-muted)]">
                            (you)
                          </span>
                        )}
                      </p>
                      <p className="md:hidden font-body text-[11px] text-[color:var(--color-text-muted)] truncate">
                        {m.email}
                      </p>
                    </div>
                  </div>

                  {/* Email (desktop) */}
                  <div className="hidden md:block min-w-0">
                    <p className="font-body text-[13px] text-[color:var(--color-text-secondary)] truncate">
                      {m.email}
                    </p>
                  </div>

                  {/* Role chip / dropdown */}
                  <div className="hidden md:block">
                    {isTheOwner ? (
                      <Chip variant="blue">Owner</Chip>
                    ) : canChangeRole ? (
                      <RoleDropdown
                        roles={roles}
                        currentRoleId={role?.id}
                        onChange={(roleId) => handleRoleChange(m._id, roleId)}
                        disabled={changingRole === m._id}
                      />
                    ) : (
                      <Chip variant={role?.key === 'admin' ? 'blue' : 'grey'}>
                        {role?.name || 'Member'}
                      </Chip>
                    )}
                  </div>

                  {/* Joined date */}
                  <div className="hidden md:block">
                    <span className="font-body text-[12px] text-[color:var(--color-text-muted)]">
                      {m.createdAt ? formatShortDate(m.createdAt) : '—'}
                    </span>
                  </div>

                  {/* Actions — an action GROUP, not a single control.
                      This used to be an if/else chain, which was honest while a
                      row could only ever offer one thing: Transfer lives on the
                      owner's own row and Remove is refused there, so the two
                      could never both apply. The executive action breaks that —
                      the rows where an admin may hand somebody a curated view
                      are exactly the rows where they may also remove them — so
                      the three render independently and the chain's mutual
                      exclusion is left to the conditions themselves, which
                      already encode it.

                      Constructive before destructive: Remove is last on the
                      line so the pointer never passes over it on the way to
                      something safe. `flex-wrap` keeps the pair stacking rather
                      than overflowing when the column is narrow. */}
                  <div className="flex justify-end md:justify-start items-center gap-x-3 gap-y-1.5 flex-wrap">
                    {canTransfer && (
                      <button
                        type="button"
                        onClick={openTransfer}
                        className="inline-flex items-center gap-1 font-body font-semibold text-[12px] text-[color:var(--color-accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] rounded"
                      >
                        <Crown size={14} aria-hidden="true" />
                        Transfer ownership
                      </button>
                    )}

                    {canGiveExecutiveView && (
                      <button
                        type="button"
                        onClick={() =>
                          hasExecutiveView
                            ? navigate(configuratorPath(m._id))
                            : openMakeExecutive(m)
                        }
                        // Somebody who already has a view goes STRAIGHT to the
                        // configurator: there is nothing to confirm, the change
                        // has already been made, and a dialog in front of an
                        // edit screen is a click that tells nobody anything.
                        // Somebody who does not gets the modal, because the
                        // first press is the one that changes their role.
                        title={
                          hasExecutiveView
                            ? `${executiveBoards} ${
                                executiveBoards === 1 ? 'board' : 'boards'
                              } on their list`
                            : `Give ${m.name || m.email} a curated workspace`
                        }
                        className="inline-flex items-center gap-1 font-body font-semibold text-[12px] whitespace-nowrap text-[color:var(--color-accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] rounded"
                      >
                        <LayoutDashboard size={14} aria-hidden="true" />
                        {hasExecutiveView
                          ? 'Edit executive view'
                          : 'Make executive'}
                      </button>
                    )}

                    {canRemove && (
                      <button
                        type="button"
                        onClick={() => setConfirmMember(m)}
                        className="inline-flex items-center gap-1 font-body font-semibold text-[12px] text-[color:var(--color-status-stuck)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-status-stuck)] rounded"
                        aria-label={`Remove ${m.name || m.email}`}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                        Remove
                      </button>
                    )}

                    {/* The owner row seen by anyone who is NOT the owner — no
                        action applies to it at all. The Role column already says
                        "Owner"; this keeps the column from collapsing to nothing
                        on their line. */}
                    {!canTransfer &&
                      !canGiveExecutiveView &&
                      !canRemove &&
                      isTheOwner && (
                        <span className="md:block hidden">
                          <Chip variant="blue">Owner</Chip>
                        </span>
                      )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {can('org.invite_members') && (
          <div className="mt-6">
            <InviteSection currentOrg={currentOrg} />
          </div>
        )}

        {/* The permissions matrix. Any member may READ it — knowing who can do
            what is not itself a privilege, and it makes the role chips above
            legible. Only the owner can change it. */}
        {currentOrg?._id && (
          <div className="mt-8">
            <PermissionsMatrix
              orgId={currentOrg._id}
              onRolesChanged={() => fetchMembers(currentOrg._id).catch(() => {})}
            />
          </div>
        )}

        {/* The workspace break-glass key for board vaults. Sits with the
            permissions matrix because both are org-wide security settings, not
            anybody's personal preference. Any member may see WHETHER one
            exists — that is what tells them their vault can be recovered — but
            only `org.manage_settings` can create or rotate it, which the server
            enforces and the section reflects. */}
        {currentOrg?._id && (
          <div className="mt-8">
            <VaultEscrowSection orgId={currentOrg._id} />
          </div>
        )}

        {/* Transfer ownership — pick the new owner, then confirm.
            The consequences sit under the list rather than behind a second
            confirm step: they are the same three facts whoever is chosen, and
            they need to be on screen at the moment the button is clicked, not
            one dialog earlier. */}
        <Modal
          isOpen={transferOpen}
          onClose={() => (transferring ? null : setTransferOpen(false))}
          title="Transfer ownership"
          maxWidth={560}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setTransferOpen(false)}
                disabled={transferring}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleTransferOwnership}
                disabled={!transferTo || transferring}
              >
                {transferring
                  ? 'Transferring…'
                  : transferTo
                    ? `Make ${transferTo.name || transferTo.email} the owner`
                    : 'Transfer ownership'}
              </Button>
            </>
          }
        >
          <p
            className="font-body text-[13px]"
            style={{ color: 'var(--color-text-muted)', marginBottom: 12 }}
          >
            Choose who should own <strong>{currentOrg?.name}</strong>. There is
            only ever one owner, so this hands yours over.
          </p>

          {transferCandidates.length === 0 ? (
            <p
              className="font-body text-[13px]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              There is nobody else in this workspace to transfer ownership to.
            </p>
          ) : (
            <>
              {transferCandidates.length > 6 && (
                <input
                  type="text"
                  value={transferQuery}
                  onChange={(e) => setTransferQuery(e.target.value)}
                  placeholder="Search members by name or email…"
                  className="font-body"
                  style={{
                    width: '100%',
                    fontSize: 13,
                    padding: '8px 12px',
                    marginBottom: 8,
                    borderRadius: 'var(--radius-md)',
                    border: '1.5px solid var(--color-border-strong)',
                    background: 'var(--color-bg-surface)',
                    color: 'var(--color-text-primary)',
                  }}
                />
              )}

              <div
                role="radiogroup"
                aria-label="New workspace owner"
                className="flex flex-col"
                style={{
                  maxHeight: 260,
                  overflowY: 'auto',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                {filteredTransferCandidates.length === 0 ? (
                  <p
                    className="font-body text-[13px]"
                    style={{ color: 'var(--color-text-muted)', padding: 12 }}
                  >
                    No members match “{transferQuery.trim()}”.
                  </p>
                ) : (
                  filteredTransferCandidates.map((m, i) => {
                    const selected = transferTo?._id === m._id;
                    const role = memberRoles?.[String(m._id)] || null;
                    // The container already draws a bottom edge; a border on the
                    // last row doubles it into a 2px line.
                    const isLast = i === filteredTransferCandidates.length - 1;
                    return (
                      <button
                        key={m._id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setTransferTo(m)}
                        disabled={transferring}
                        className="flex items-center gap-3 text-left w-full"
                        style={{
                          padding: '10px 12px',
                          borderBottom: isLast
                            ? 'none'
                            : '1px solid var(--color-border)',
                          background: selected
                            ? 'var(--color-accent-light)'
                            : 'transparent',
                          cursor: transferring ? 'wait' : 'pointer',
                        }}
                      >
                        <Avatar user={m} size={32} />
                        <div className="min-w-0 flex-1">
                          <p className="font-body font-semibold text-[13px] text-[color:var(--color-text-primary)] truncate">
                            {m.name || 'Unnamed'}
                          </p>
                          <p className="font-body text-[12px] text-[color:var(--color-text-muted)] truncate">
                            {m.email}
                          </p>
                        </div>
                        <Chip variant={role?.key === 'admin' ? 'blue' : 'grey'}>
                          {role?.name || 'Member'}
                        </Chip>
                        {selected && (
                          <Check
                            size={16}
                            aria-hidden="true"
                            style={{ color: 'var(--color-accent)' }}
                          />
                        )}
                      </button>
                    );
                  })
                )}
              </div>

              <ul
                className="font-body text-[13px] mt-4 space-y-1.5 list-disc pl-5"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                <li>
                  They gain every permission unconditionally, including deleting
                  the workspace.
                </li>
                <li>
                  You become an <strong>Admin</strong> — you keep whatever that
                  role grants in this workspace, but you lose the owner's
                  unconditional access and can no longer delete the workspace.
                </li>
                <li>Only the new owner can transfer ownership back to you.</li>
              </ul>
            </>
          )}
        </Modal>

        {/* Make executive — confirm, then act, then land on the configurator.

            Modelled on the transfer modal above: the consequences sit on the
            same screen as the button, because they are the whole reason this is
            a dialog rather than a link. Two of the three are SUBTRACTIONS — the
            person ends up seeing less than they did a moment ago — and the one
            thing everybody assumes ("so they can see the boards now?") is the
            one thing this does not do. So the dialog says both halves, plainly,
            and the second half has a heading of its own. */}
        <Modal
          isOpen={!!makeExecutiveFor}
          onClose={() =>
            declaring
              ? null
              : showingDeclareReport
                ? dismissAfterDeclare()
                : setMakeExecutiveFor(null)
          }
          title={showingDeclareReport ? 'Executive view created' : 'Make executive'}
          maxWidth={560}
          footer={
            showingDeclareReport ? (
              <>
                <Button variant="secondary" onClick={dismissAfterDeclare}>
                  Not now
                </Button>
                <Button onClick={goToNewView}>Open their view</Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  onClick={() => setMakeExecutiveFor(null)}
                  disabled={declaring}
                >
                  Cancel
                </Button>
                <Button onClick={handleDeclareExecutive} disabled={declaring}>
                  {declaring
                    ? copyFrom
                      ? 'Copying…'
                      : 'Making executive…'
                    : 'Make executive'}
                </Button>
              </>
            )
          }
        >
          {showingDeclareReport ? (
            <DeclareReport
              name={makeExecutiveFor?.name || makeExecutiveFor?.email}
              report={copyReport}
              error={declaredWithoutCopy ? declareError : ''}
            />
          ) : (
          <>
          <p className="font-body text-[14px] text-[color:var(--color-text-primary)]">
            Make{' '}
            <strong>
              {makeExecutiveFor?.name || makeExecutiveFor?.email}
            </strong>{' '}
            an <strong>{executiveRoleName}</strong> in{' '}
            <strong>{currentOrg?.name}</strong>?
          </p>

          <ul
            className="font-body text-[13px] mt-3 space-y-1.5 list-disc pl-5"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <li>
              Their role changes to <strong>{executiveRoleName}</strong> — as
              capable as an admin on the boards they are given, including
              sharing them.
            </li>
            <li>
              <strong>
                They stop seeing this workspace's public boards automatically.
              </strong>{' '}
              A public board they hold no share of leaves their board list,
              their My Work and their notifications — it is reach that is
              withheld, not a screen that is tidied.
            </li>
            <li>
              From then on they see <strong>only the boards you give them</strong>
              , on a home page you compose.
            </li>
          </ul>

          <p
            className="font-body font-semibold text-[12px] uppercase tracking-wide mt-4"
            style={{ color: 'var(--color-text-muted)' }}
          >
            What this does not do
          </p>
          <ul
            className="font-body text-[13px] mt-1.5 space-y-1.5 list-disc pl-5"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <li>
              <strong>It grants no boards.</strong> Their list starts empty. You
              pick the boards on the next screen, and each one you add there is
              a real share of that board.
            </li>
            <li>
              It changes nothing for anybody else — no other role, board or
              screen moves.
            </li>
            <li>
              It is undoable: deleting the view later puts them back on the
              standard app, and their role is a separate decision you make from
              this table.
            </li>
          </ul>

          {/* START FROM — only when there is somebody to start from.
              A workspace with its FIRST executive has nothing to copy and no
              decision to make, so the control does not exist there; the second
              one is the whole reason it does. It sits last in the dialog, after
              the consequences, because it is the one optional thing on it and
              putting a dropdown above the sentence that says what the button
              does would make the sentence look like help text for the dropdown.

              It copies the SHAPE and re-runs the reach: each board goes through
              the same per-board authorisation a manual add uses, so this is not
              a way to hand out access the admin could not hand out one board at
              a time, and anything it could not share comes back as a report
              rather than a silence. */}
          {copySources.length > 0 && (
            <div
              className="mt-4"
              style={{
                padding: '12px 14px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-bg-subtle)',
              }}
            >
              <Dropdown
                label="Start from"
                value={copyFrom}
                onChange={setCopyFrom}
                disabled={declaring}
                options={[
                  { value: '', label: 'A blank view' },
                  ...copySources.map((row) => ({
                    value: String(row.user._id),
                    label: `${row.user.name || row.user.email} — ${
                      row.boardCount || 0
                    } ${row.boardCount === 1 ? 'board' : 'boards'}`,
                  })),
                ]}
              />
              <p
                className="font-body text-[12.5px] mt-2"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                {copyFrom
                  ? 'Their boards, home sections and rail switches are copied onto the new view, and each board is shared again in your name. Any board you cannot share yourself is skipped — you will be shown which, before you go anywhere.'
                  : 'They start with nothing on their list, and you pick the boards on the next screen.'}
              </p>
            </div>
          )}

          <p
            className="font-body text-[12.5px] mt-3"
            style={{ color: 'var(--color-text-muted)' }}
          >
            The next screen confirms the role they end up with, and warns you if
            it has been edited to still see public boards — which would leave
            the curated list not being the whole list.
          </p>

          {declareError && (
            <p
              role="alert"
              className="font-body text-[13px] mt-3"
              style={{
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-status-stuck-bg)',
                color: 'var(--color-status-stuck)',
              }}
            >
              {declareError}
            </p>
          )}
          </>
          )}
        </Modal>

        {/* Confirm remove modal */}
        <Modal
          isOpen={!!confirmMember}
          onClose={() => (removing ? null : setConfirmMember(null))}
          title="Remove member"
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setConfirmMember(null)}
                disabled={removing}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={handleRemove} disabled={removing}>
                {removing ? 'Removing…' : 'Remove'}
              </Button>
            </>
          }
        >
          <p className="font-body text-[14px] text-[color:var(--color-text-primary)]">
            Remove{' '}
            <strong>{confirmMember?.name || confirmMember?.email}</strong> from
            this organisation? They will lose access to all boards and tasks.
          </p>
        </Modal>
      </div>
    </PageWrapper>
  );
};

export default MembersPage;
