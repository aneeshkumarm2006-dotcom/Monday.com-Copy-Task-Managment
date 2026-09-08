import { useMemo, useState } from 'react';
import {
  Globe,
  KeyRound,
  MapPin,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-react';

import Button from '../../../ui/Button';
import Dropdown from '../../../ui/Dropdown';
import EmptyState from '../../../ui/EmptyState';
import useToastStore from '../../../../store/toastStore';
import SiteSetupWizard from './SiteSetupWizard';
import { deleteConnectorSite } from '../../../../services/connectorService';

/**
 * THE SITES ON THIS BOARD, as cards rather than as a list of rows.
 *
 * ---- Why the rows became cards ---------------------------------------------
 *
 * The old row was one line: a name, a domain, a keyword count, and a group
 * dropdown pushed to the right. It answered "what is this called" and nothing
 * else — and the questions people actually open this tab with are "is this one
 * finished", "how much is it buying", and "whose is it".
 *
 * Those are three facts per site, and three facts do not fit on a line beside a
 * dropdown. So each site gets a card carrying its own state, and the ONE state
 * that used to be invisible is now the loudest thing on it: a DRAFT reads as
 * unfinished, with the button that finishes it, instead of looking like a
 * working site that mysteriously collects nothing.
 *
 * ---- What a card deliberately does not do ----------------------------------
 *
 * It does not fetch anything. Everything here came with the board load, and the
 * tab's rule has always been that only an explicit Refresh reaches a provider.
 * A card that pulled its own numbers would turn opening a tab into a purchase.
 */

/** Google's favicon service, which needs no key and degrades to nothing. */
const faviconFor = (domain) =>
  domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64` : null;

const Stat = ({ icon, children, muted = false }) => {
  const Icon = icon;
  return (
    <span
      className="inline-flex items-center gap-1.5 font-body"
      style={{
        fontSize: 12,
        color: muted ? 'var(--color-text-muted)' : 'var(--color-text-secondary)',
      }}
    >
      <Icon size={12} className="shrink-0" aria-hidden="true" />
      {children}
    </span>
  );
};

/**
 * @param {Object} props
 * @param {string} props.boardId
 * @param {Object} props.connector - the board's connector row, with `projectAuthoring`
 * @param {Array} props.projects
 * @param {Array} props.accounts
 * @param {Array} props.groups
 * @param {boolean} props.canManage
 * @param {Function} props.onSaved - one project changed
 * @param {Function} props.onDeleted
 * @param {Function} props.onMap - (project, groupId) => Promise
 * @param {string|null} props.savingProjectId
 */
const SitesPanel = ({
  boardId,
  connector,
  projects = [],
  accounts = [],
  groups = [],
  canManage = false,
  onSaved,
  onDeleted,
  onMap,
  savingProjectId = null,
}) => {
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  /** `{project}` with a null project meaning "create". One piece of state, so
   *  the dialog and its target cannot disagree about what is on screen. */
  const [wizard, setWizard] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const authoring = connector.projectAuthoring;
  const noun = (authoring?.label || 'Site').toLowerCase();

  const groupNameById = useMemo(
    () => new Map(groups.map((g) => [String(g._id), g.name])),
    [groups]
  );

  /**
   * Drafts first.
   *
   * They are the only rows that need an action from a person, and an unfinished
   * site at the bottom of an alphabetical list of twenty is one nobody ever
   * finishes.
   */
  const ordered = useMemo(
    () =>
      [...projects].sort((a, b) => {
        const rank = (p) => (p.status === 'draft' ? 0 : p.missing ? 2 : 1);
        return rank(a) - rank(b) || (a.name || '').localeCompare(b.name || '');
      }),
    [projects]
  );

  const remove = async (project) => {
    setDeleting(project._id);
    try {
      await deleteConnectorSite(boardId, connector.name, project._id);
      onDeleted?.(project._id);
      toastSuccess(`${project.name || project.domain} deleted.`);
    } catch (err) {
      // `HAS_HISTORY` is the interesting one and the server explains it: a site
      // with readings is unmapped, never deleted, because the row parents every
      // reading ever taken for that domain.
      toastError(err?.response?.data?.error || 'That site could not be deleted.');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--color-border)' }}>
      {ordered.length === 0 ? (
        <div className="px-4 py-6">
          <EmptyState
            icon={Globe}
            title={`No ${noun}s yet`}
            description={
              authoring?.help ||
              'A site is a domain, the markets you track it in, and the keywords you track there.'
            }
            actionLabel={canManage ? `Add a ${noun}` : undefined}
            onAction={canManage ? () => setWizard({ project: null }) : undefined}
          />
        </div>
      ) : (
        <ul className="flex flex-col">
          {ordered.map((project) => {
            const draft = project.status === 'draft';
            const boundHere = project.board && String(project.board) === String(boardId);
            const boundElsewhere = !!project.group && !boundHere;
            const markets = project.targets?.length || 0;
            const keywordCount = project.trackedKeywords?.length ?? project.keywordCount ?? 0;
            const perCollection = keywordCount * markets;
            const scope = (authoring?.scopes || []).find((s) => s.key === project.scope);

            return (
              <li
                key={project._id}
                className="flex flex-wrap items-start gap-3 px-4 py-3.5"
                style={{
                  borderTop: '1px solid var(--color-border)',
                  // A project that vanished at the provider is kept and greyed,
                  // never deleted — it parents its own collected history.
                  opacity: project.missing ? 0.55 : 1,
                  background: draft ? 'var(--color-bg-subtle)' : 'transparent',
                }}
              >
                {/* ---- Identity --------------------------------------------- */}
                <img
                  src={faviconFor(project.domain)}
                  alt=""
                  aria-hidden="true"
                  width={22}
                  height={22}
                  className="shrink-0"
                  style={{ marginTop: 2, borderRadius: 4 }}
                  onError={(e) => {
                    e.currentTarget.style.visibility = 'hidden';
                  }}
                />

                <div className="flex-1" style={{ minWidth: 200 }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <p
                      className="font-body font-semibold truncate"
                      style={{ fontSize: 13.5, color: 'var(--color-text-primary)' }}
                    >
                      {project.name || project.domain}
                    </p>

                    {draft && (
                      <span
                        className="inline-flex items-center gap-1 font-body shrink-0"
                        style={{
                          fontSize: 10.5,
                          padding: '2px 7px',
                          borderRadius: 999,
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          background: 'var(--color-warning-light, #FEF3C7)',
                          color: 'var(--color-warning-text, #92400E)',
                        }}
                      >
                        Setup unfinished
                      </span>
                    )}

                    {project.missing && (
                      <span
                        className="inline-flex items-center gap-1 font-body shrink-0"
                        style={{
                          fontSize: 11,
                          padding: '2px 7px',
                          borderRadius: 999,
                          background: 'var(--color-bg-subtle)',
                          color: 'var(--color-text-muted)',
                        }}
                      >
                        <TriangleAlert size={11} aria-hidden="true" />
                        No longer at the provider
                      </span>
                    )}
                  </div>

                  <p
                    className="font-body mt-0.5 truncate"
                    style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                  >
                    {project.domain || project.externalId}
                    {scope && project.scope !== 'domain'
                      ? ` · ${scope.label}${project.scopePath ? ` ${project.scopePath}` : ''}`
                      : ''}
                  </p>

                  {/* ---- What it is set to collect ------------------------- */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
                    <Stat icon={KeyRound} muted={!keywordCount}>
                      {keywordCount} keyword{keywordCount === 1 ? '' : 's'}
                    </Stat>
                    <Stat icon={MapPin} muted={!markets}>
                      {markets
                        ? project.targets
                            .map((t) => t.label || `#${t.locationCode}`)
                            .join(', ')
                        : 'No market'}
                    </Stat>
                    {project.competitors?.length > 0 && (
                      <Stat icon={Users}>
                        {project.competitors.length} competitor
                        {project.competitors.length === 1 ? '' : 's'}
                      </Stat>
                    )}
                    {perCollection > 0 && !draft && (
                      <span
                        className="font-body"
                        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                      >
                        {/*
                          The number that decides what this costs, on the card
                          rather than only inside the form that set it. Keywords
                          times markets, bought again on every collection.
                        */}
                        {perCollection} results per collection
                      </span>
                    )}
                  </div>

                  {draft && (
                    <p
                      className="font-body mt-2"
                      style={{ fontSize: 11.5, color: 'var(--color-warning-text, #92400E)' }}
                    >
                      {/*
                        Said plainly, because the alternative is somebody
                        assuming a half-built site is quietly costing them
                        money. It is not, and that is enforced twice server-side.
                      */}
                      Nothing is collected or charged until setup finishes.
                    </p>
                  )}
                </div>

                {/* ---- The binding ------------------------------------------ */}
                <div className="shrink-0" style={{ width: 210 }}>
                  {draft ? (
                    <p
                      className="font-body"
                      style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                    >
                      {/* A draft cannot be mapped — the server refuses it — so
                          offering the dropdown would be offering a control that
                          only ever errors. */}
                      Finish setup to map it to a client.
                    </p>
                  ) : boundElsewhere ? (
                    <p
                      className="font-body"
                      style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                    >
                      Mapped to a group on another board.
                    </p>
                  ) : canManage ? (
                    <Dropdown
                      size="sm"
                      options={[
                        { value: '', label: 'Not mapped' },
                        ...groups.map((g) => {
                          const taken = projects.some(
                            (p) =>
                              p.group &&
                              String(p.group) === String(g._id) &&
                              String(p._id) !== String(project._id)
                          );
                          return {
                            value: String(g._id),
                            label: taken ? `${g.name} (already mapped)` : g.name,
                            disabled: taken,
                          };
                        }),
                      ]}
                      value={boundHere ? String(project.group) : ''}
                      disabled={savingProjectId === project._id}
                      onChange={(value) => onMap?.(project, value || null)}
                      ariaLabel={`Group for ${project.name || project.domain}`}
                    />
                  ) : (
                    <p
                      className="font-body"
                      style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}
                    >
                      {boundHere
                        ? groupNameById.get(String(project.group)) || 'Mapped'
                        : 'Not mapped'}
                    </p>
                  )}
                </div>

                {/* ---- Actions ---------------------------------------------- */}
                {canManage && project.locallyAuthored && (
                  <div className="flex items-center gap-2 shrink-0">
                    {draft ? (
                      <Button onClick={() => setWizard({ project })}>Resume setup</Button>
                    ) : (
                      <Button
                        variant="secondary"
                        icon={Pencil}
                        onClick={() => setWizard({ project })}
                      >
                        Edit
                      </Button>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(project)}
                      disabled={deleting === project._id}
                      aria-label={`Delete ${project.name || project.domain}`}
                      className="inline-flex items-center justify-center"
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--color-border)',
                        background: 'transparent',
                        color: 'var(--color-text-muted)',
                        cursor: deleting === project._id ? 'default' : 'pointer',
                      }}
                    >
                      {deleting === project._id ? (
                        <MoreHorizontal size={13} aria-hidden="true" />
                      ) : (
                        <Trash2 size={13} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canManage && ordered.length > 0 && (
        <div className="px-4 py-3" style={{ borderTop: '1px solid var(--color-border)' }}>
          <Button variant="secondary" icon={Plus} onClick={() => setWizard({ project: null })}>
            Add a {noun}
          </Button>
        </div>
      )}

      {wizard && (
        <SiteSetupWizard
          isOpen
          onClose={() => setWizard(null)}
          boardId={boardId}
          provider={connector.name}
          authoring={authoring}
          accounts={accounts}
          groups={groups}
          projects={projects}
          project={wizard.project}
          onSaved={onSaved}
        />
      )}
    </div>
  );
};

export default SitesPanel;
