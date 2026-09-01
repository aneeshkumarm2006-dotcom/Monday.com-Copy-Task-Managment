import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Blocks,
  Globe,
  Link2Off,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';

import Button from '../../ui/Button';
import Dropdown from '../../ui/Dropdown';
import Switch from '../../ui/Switch';
import Spinner from '../../ui/Spinner';
import EmptyState from '../../ui/EmptyState';
import useToastStore from '../../../store/toastStore';
import FieldMappingPanel from './FieldMappingPanel';
import SiteFormModal from './SiteFormModal';
import ConnectorSettingsPanel from './ConnectorSettingsPanel';
import AdsBudgetAddonCard from './AdsBudgetAddonCard';
import GoalVocabularyCard from './GoalVocabularyCard';
import {
  getBoardConnectors,
  setBoardConnector,
  getConnectorProjects,
  refreshConnectorProjects,
  setConnectorProjectGroup,
} from '../../../services/connectorService';

/**
 * Add-ons — what this board has switched on.
 *
 * ---- Two kinds of add-on now live here -------------------------------------
 *
 * CONNECTORS, which are the bulk of this file: an external account, connected
 * once for the whole workspace, wired to this board's groups.
 *
 * And ADD-ONS THAT REACH NOTHING — currently the Ads Budget tracker, whose
 * numbers are all typed in. It has no account, no quota and no provider, so it
 * is a single switch rather than a section. It lives here because this is the
 * tab people already open to ask "what can this board do", and a second tab
 * holding one switch would be a worse answer to that question than a heading.
 *
 * That is also why a connector failure below is NOT fatal to this tab any more:
 * it renders as a notice in the connectors half, and the switches above it stay
 * usable. The same rule GoalsTab states for its own secondary reads — a failing
 * request must never blank a page that does not depend on it.
 *
 * ---- The connector half ----------------------------------------------------
 *
 * Accounts are connected once, for the whole workspace, in Settings →
 * Connectors. This tab is the other half: switch a connector on for this board,
 * and say which of the provider's projects feeds which group.
 *
 * ---- Why the mapping is per GROUP ------------------------------------------
 *
 * One Ubersuggest project is one domain. A tracker board carries one client per
 * group — two dozen of them, two dozen separate domains — so a project-to-board
 * mapping could only ever address one client. The group is the unit that means
 * something.
 *
 * ---- Why Refresh is a button and not an effect -----------------------------
 *
 * Quota is shared across the entire workspace and is finite. Everything this
 * tab renders comes out of our own database; only Refresh reaches the provider.
 * An effect that fetched on mount would let one person with a tab open spend the
 * week's allowance on nothing but page loads. If you are tempted to "just
 * refresh on open", that is the reason not to.
 *
 * ---- The two halves of the wiring ------------------------------------------
 *
 * A project mapping says WHOSE numbers these are; a field mapping says WHERE on
 * a goal each number lands. Both live here because they are one job — a person
 * switching a connector on for a board does both in the same sitting — and both
 * are data rather than code for the same reason: the three SEO boards in this
 * workspace use disjoint goal-column ids and disagree about the spelling of the
 * difficulty key, so anything hardcoded would fill one board and silently skip
 * two. See FieldMappingPanel.jsx.
 */

/** Fixed copy — never the provider's own error text, which is uncontrolled. */
const NO_ACCOUNTS =
  'No account is connected to this workspace yet. An organisation admin can add one under Settings → Connectors.';

const AddonsTab = ({
  boardId,
  groups = [],
  canManage: canManageProp = false,
  // `goal.manage` on this board — the same gate the Goals tab uses for its own
  // column editor. It only enables the "Add a column for this" shortcut inside
  // the field-mapping panel; the mapping itself is `connector.manage`, because
  // nothing about it writes to a goal.
  canManageGoalColumns = false,
  // The Ads Budget add-on: the board's stored `{ enabled, currency }`, whether
  // this person may change it, and a callback so the board page can patch its
  // own copy — the tab bar is derived from `enabled`, so the new tab has to
  // appear the moment the switch settles.
  adsBudget = null,
  canManageAdsBudget = false,
  onAdsBudgetChanged = null,
  // The board's goal WORDING, and whether this person owns the board. A
  // separate gate from every other card here on purpose — see
  // GoalVocabularyCard for why it is the owner rather than an org admin.
  goalVocabulary = null,
  canManageGoalVocabulary = false,
  onBoardChanged = null,
}) => {
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);
  const toastInfo = useToastStore((s) => s.info);

  const [connectors, setConnectors] = useState([]);
  const [accounts, setAccounts] = useState([]);
  /**
   * The board page's own answer is the starting point, so the controls do not
   * flicker on mount — but the SERVER's answer wins as soon as it arrives. It
   * resolves the same two-layer AND against the live board rather than against
   * whatever the page loaded, and hiding a control was never the enforcement
   * anyway: every write below is gated again server-side.
   */
  const [canManage, setCanManage] = useState(canManageProp);
  const [projectsByProvider, setProjectsByProvider] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Per-provider and per-project busy flags, so one row spinning never disables
  // the rest of the tab.
  const [refreshing, setRefreshing] = useState(null);
  const [togglingProvider, setTogglingProvider] = useState(null);
  const [savingProject, setSavingProject] = useState(null);

  /**
   * The site being authored, for a provider whose projects are created HERE
   * rather than mirrored from anywhere.
   *
   * `{provider, project}` with a null project meaning "create". One piece of
   * state rather than an open flag plus a target, so the two cannot disagree
   * about which dialog is on screen.
   */
  const [siteModal, setSiteModal] = useState(null);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!boardId) return;
      if (!quiet) setLoading(true);
      try {
        const data = await getBoardConnectors(boardId);
        setConnectors(data.connectors || []);
        setAccounts(data.accounts || []);
        setCanManage(!!data.canManage);

        // Projects only for the connectors that are actually switched on. A
        // board with the connector off has nothing to map, and asking would be
        // a request per provider for a list nobody is going to see.
        const enabled = (data.connectors || []).filter((c) => c.enabled);
        const listings = await Promise.all(
          enabled.map(async (c) => {
            try {
              const res = await getConnectorProjects(boardId, c.name);
              return [c.name, res.projects || []];
            } catch {
              // One provider failing must not blank the whole tab.
              return [c.name, []];
            }
          })
        );
        setProjectsByProvider(Object.fromEntries(listings));
        setError(null);
      } catch (err) {
        setError(
          err?.response?.data?.error || 'Could not load this board’s add-ons.'
        );
      } finally {
        setLoading(false);
      }
    },
    [boardId]
  );

  useEffect(() => {
    load();
  }, [load]);

  const groupNameById = useMemo(
    () => new Map(groups.map((g) => [String(g._id), g.name])),
    [groups]
  );

  const toggleConnector = async (provider, next) => {
    setTogglingProvider(provider);
    try {
      await setBoardConnector(boardId, provider, { enabled: next });
      await load({ quiet: true });
      toastSuccess(next ? 'Connector enabled for this board.' : 'Connector disabled.');
    } catch (err) {
      toastError(
        err?.response?.data?.error || 'Could not change that connector.'
      );
    } finally {
      setTogglingProvider(null);
    }
  };

  /**
   * Pull the project list from the provider.
   *
   * The response reports PER ACCOUNT, because the pool is plural and each
   * account has its own quota and its own grant. One account out of quota while
   * three succeed is a partial refresh worth saying out loud — reporting it as a
   * flat failure would hide three accounts' worth of projects that did arrive.
   */
  const refresh = async (provider) => {
    setRefreshing(provider);
    try {
      const { projects, report } = await refreshConnectorProjects(boardId, provider);
      setProjectsByProvider((prev) => ({ ...prev, [provider]: projects }));

      const failed = (report?.accounts || []).filter((a) => !a.ok);
      if (!failed.length) {
        toastSuccess(
          `${projects.length} project${projects.length === 1 ? '' : 's'} up to date.`
        );
      } else if (failed.some((a) => a.quotaExhausted)) {
        toastInfo(
          'Ubersuggest is out of quota on at least one account. Report limits reset daily.'
        );
      } else if (failed.some((a) => a.needsReauth)) {
        toastError(
          'At least one account needs reconnecting under Settings → Connectors.'
        );
      } else {
        toastError(failed[0].error || 'Some accounts could not be refreshed.');
      }
      // Statuses and the last-refreshed stamp live on the other endpoint.
      load({ quiet: true });
    } catch (err) {
      toastError(
        err?.response?.data?.error || 'Could not refresh those projects.'
      );
    } finally {
      setRefreshing(null);
    }
  };

  /**
   * A site was created or edited. Merged into the list in place rather than
   * refetched, so the row does not jump while the dialog is closing — and a
   * creation is prepended, because the thing somebody has just made should not
   * appear somewhere down an alphabetical list.
   */
  const siteSaved = (provider, saved) => {
    setProjectsByProvider((prev) => {
      const list = prev[provider] || [];
      const exists = list.some((p) => String(p._id) === String(saved._id));
      return {
        ...prev,
        [provider]: exists
          ? list.map((p) => (String(p._id) === String(saved._id) ? saved : p))
          : [saved, ...list],
      };
    });
    toastSuccess(
      `${saved.name || saved.domain} saved. Map it to a group to start collecting.`
    );
  };

  const mapProject = async (provider, project, groupId) => {
    setSavingProject(project._id);
    try {
      const updated = await setConnectorProjectGroup(
        boardId,
        provider,
        project._id,
        groupId
      );
      setProjectsByProvider((prev) => ({
        ...prev,
        [provider]: (prev[provider] || []).map((p) =>
          p._id === updated._id ? updated : p
        ),
      }));
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not save that mapping.');
    } finally {
      setSavingProject(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mt-5 flex flex-col gap-6">
      {/* Add-ons that reach nothing outside this app. One switch each. */}
      <div className="flex flex-col gap-3">
        <h3
          className="font-body font-medium"
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--color-text-secondary)',
          }}
        >
          Board add-ons
        </h3>
        <AdsBudgetAddonCard
          boardId={boardId}
          adsBudget={adsBudget}
          canManage={canManageAdsBudget}
          onChanged={onAdsBudgetChanged}
        />
        <GoalVocabularyCard
          boardId={boardId}
          goalVocabulary={goalVocabulary}
          canManage={canManageGoalVocabulary}
          onChanged={onBoardChanged}
        />
      </div>

      <div className="flex flex-col gap-3">
        <h3
          className="font-body font-medium"
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--color-text-secondary)',
          }}
        >
          Connectors
        </h3>
        <p className="font-body text-[13px] text-[color:var(--color-text-secondary)]">
          External data sources for this board. Accounts are connected once for the
          whole workspace under{' '}
          <Link
            to="/settings?tab=connectors"
            className="underline"
            style={{ color: 'var(--color-accent)' }}
          >
            Settings &rarr; Connectors
          </Link>
          ; here you choose which of their projects feeds which group.
        </p>

        {/* A connector read that failed is reported HERE and nothing else on
            the tab is lost — including the switches above, which somebody
            without `connector.view` must still be able to reach. */}
        {error ? (
          <EmptyState icon={Blocks} title="Connectors are not available" description={error} />
        ) : null}

        <div className="flex flex-col gap-4">
        {connectors.map((connector) => {
          const projects = projectsByProvider[connector.name] || [];
          const providerAccounts = accounts.filter(
            (a) => a.provider === connector.name
          );
          const stale = providerAccounts.filter((a) => a.status === 'needs_reauth');
          const busy = refreshing === connector.name;

          return (
            <section
              key={connector.name}
              style={{
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                overflow: 'hidden',
              }}
            >
              {/* ---- Header: what it is, and whether it is on --------------- */}
              <div
                className="flex items-start gap-3 px-4 py-4"
                style={{ background: 'var(--color-bg-subtle)' }}
              >
                <div
                  aria-hidden="true"
                  className="flex items-center justify-center shrink-0"
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--color-bg-surface)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  <Plug size={17} />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="font-body text-[14px] font-semibold text-[color:var(--color-text-primary)]">
                    {connector.label}
                  </p>
                  <p className="font-body text-[12.5px] text-[color:var(--color-text-muted)] mt-0.5">
                    {connector.blurb}
                  </p>
                  {connector.enabled && connector.lastRefreshAt && (
                    <p
                      className="font-body mt-1"
                      style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                    >
                      Projects last refreshed{' '}
                      {new Date(connector.lastRefreshAt).toLocaleString()}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {/* Two different verbs for two different providers, and the
                      DESCRIPTOR decides which. A provider whose projects are
                      mirrored gets "Refresh projects", which reads a list from
                      the far end; one that authors its own gets "Add site",
                      because there is no far end to read. Neither branch names
                      a provider. */}
                  {connector.enabled && canManage && connector.projectAuthoring && (
                    <Button
                      variant="secondary"
                      icon={Plus}
                      onClick={() =>
                        setSiteModal({ provider: connector.name, project: null })
                      }
                      disabled={!connector.accountCount}
                    >
                      Add {connector.projectAuthoring.label.toLowerCase()}
                    </Button>
                  )}
                  {connector.enabled && canManage && !connector.projectAuthoring && (
                    <Button
                      variant="secondary"
                      icon={RefreshCw}
                      onClick={() => refresh(connector.name)}
                      disabled={busy || !connector.accountCount}
                    >
                      {busy ? 'Refreshing…' : 'Refresh projects'}
                    </Button>
                  )}
                  <Switch
                    checked={!!connector.enabled}
                    disabled={!canManage || togglingProvider === connector.name}
                    onChange={(next) => toggleConnector(connector.name, next)}
                    label={`Enable ${connector.label} on this board`}
                  />
                </div>
              </div>

              {/* ---- Body --------------------------------------------------- */}
              {!connector.accountCount ? (
                <p
                  className="font-body text-[12.5px] px-4 py-4"
                  style={{
                    color: 'var(--color-text-muted)',
                    borderTop: '1px solid var(--color-border)',
                  }}
                >
                  {NO_ACCOUNTS}
                </p>
              ) : !connector.enabled ? (
                <p
                  className="font-body text-[12.5px] px-4 py-4"
                  style={{
                    color: 'var(--color-text-muted)',
                    borderTop: '1px solid var(--color-border)',
                  }}
                >
                  Switch this on to browse the{' '}
                  {connector.accountCount === 1
                    ? 'connected account’s'
                    : `${connector.accountCount} connected accounts’`}{' '}
                  projects and map them to groups. Turning it off later keeps
                  every mapping.
                </p>
              ) : (
                <>
                  {stale.length > 0 && (
                    <div
                      className="flex items-start gap-2 px-4 py-3 font-body"
                      style={{
                        borderTop: '1px solid var(--color-border)',
                        fontSize: 12.5,
                        background: 'var(--color-warning-light, #FEF3C7)',
                        color: 'var(--color-warning-text, #92400E)',
                      }}
                    >
                      <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>
                        {stale.map((a) => a.label).join(', ')} need
                        {stale.length === 1 ? 's' : ''} reconnecting before
                        {stale.length === 1 ? ' its' : ' their'} projects can be
                        refreshed. An organisation admin can do that under
                        Settings &rarr; Connectors.
                      </span>
                    </div>
                  )}

                  {projects.length === 0 ? (
                    <div
                      className="px-4 py-6"
                      style={{ borderTop: '1px solid var(--color-border)' }}
                    >
                      <EmptyState
                        icon={Globe}
                        title={
                          connector.projectAuthoring
                            ? `No ${connector.projectAuthoring.label.toLowerCase()}s yet`
                            : 'No projects mirrored yet'
                        }
                        description={
                          connector.projectAuthoring
                            ? connector.projectAuthoring.help ||
                              'Add a site — a domain, the markets you track it in, and the keywords you track there.'
                            : canManage
                              ? 'Refresh to read the project list from the provider. Nothing is fetched automatically — the quota is shared across the whole workspace.'
                              : 'Nobody has refreshed this board’s project list yet.'
                        }
                        actionLabel={
                          !canManage
                            ? undefined
                            : connector.projectAuthoring
                              ? `Add a ${connector.projectAuthoring.label.toLowerCase()}`
                              : 'Refresh projects'
                        }
                        onAction={
                          !canManage
                            ? undefined
                            : connector.projectAuthoring
                              ? () =>
                                  setSiteModal({ provider: connector.name, project: null })
                              : () => refresh(connector.name)
                        }
                      />
                    </div>
                  ) : (
                    <ul>
                      {projects.map((project) => (
                        <ProjectRow
                          key={project._id}
                          project={project}
                          groups={groups}
                          groupNameById={groupNameById}
                          projects={projects}
                          boardId={boardId}
                          canManage={canManage}
                          saving={savingProject === project._id}
                          onMap={(groupId) =>
                            mapProject(connector.name, project, groupId)
                          }
                          // Only a LOCALLY-AUTHORED row is editable here. A
                          // mirrored one is somebody else's record, and our edit
                          // would fight the next refresh, which always wins.
                          onEdit={
                            canManage && project.locallyAuthored
                              ? () =>
                                  setSiteModal({ provider: connector.name, project })
                              : null
                          }
                        />
                      ))}
                    </ul>
                  )}

                  {/* What this board renders, how often it collects, and how
                      much of the workspace's money it may account for. Shown
                      only for a provider that declares screens — for one that
                      does not, every switch in it would be a no-op. */}
                  {connector.availableScreens?.length > 0 && (
                    <ConnectorSettingsPanel
                      boardId={boardId}
                      connector={connector}
                      canManage={canManage}
                      onSaved={() => load({ quiet: true })}
                    />
                  )}

                  {/* Where each of the provider's values lands on a goal.
                      Rendered for a connector that has reached phase 4 —
                      `availableFields` is `[]` for one that has not, and the
                      panel would have nothing to show. */}
                  {connector.availableFields?.length > 0 && (
                    <FieldMappingPanel
                      boardId={boardId}
                      provider={connector.name}
                      providerLabel={connector.label}
                      canManage={canManage}
                      canManageColumns={canManageGoalColumns}
                    />
                  )}
                </>
              )}
            </section>
          );
        })}
        </div>
      </div>

      {siteModal && (
        <SiteFormModal
          isOpen
          onClose={() => setSiteModal(null)}
          boardId={boardId}
          provider={siteModal.provider}
          authoring={
            connectors.find((c) => c.name === siteModal.provider)?.projectAuthoring
          }
          accounts={accounts.filter((a) => a.provider === siteModal.provider)}
          project={siteModal.project}
          onSaved={(saved) => siteSaved(siteModal.provider, saved)}
        />
      )}
    </div>
  );
};

/**
 * One mirrored project and the group it feeds.
 *
 * Three states worth distinguishing, because collapsing them is what makes a
 * mapping screen confusing:
 *
 *   - unmapped            — normal. An agency's account holds projects for
 *                           clients who are not on this board, and prospects who
 *                           are not clients at all.
 *   - mapped HERE         — shows the group, and can be changed.
 *   - mapped ELSEWHERE    — bound to a group on another board. Shown, because
 *                           hiding it would make it look available and then fail
 *                           on save with nothing to explain why.
 */
const ProjectRow = ({
  project,
  groups,
  groupNameById,
  projects,
  boardId,
  canManage,
  saving,
  onMap,
  onEdit = null,
}) => {
  const boundHere = project.board && String(project.board) === String(boardId);
  const boundElsewhere = !!project.group && !boundHere;

  // Groups already spoken for by another project of this provider. Listed but
  // disabled, so the reason a group is unavailable is visible rather than
  // discovered by it silently not being there.
  const takenGroupIds = useMemo(
    () =>
      new Set(
        projects
          .filter((p) => p.group && p._id !== project._id)
          .map((p) => String(p.group))
      ),
    [projects, project._id]
  );

  const options = useMemo(
    () => [
      { value: '', label: 'Not mapped' },
      ...groups.map((g) => ({
        value: String(g._id),
        label: takenGroupIds.has(String(g._id))
          ? `${g.name} (already mapped)`
          : g.name,
        disabled: takenGroupIds.has(String(g._id)),
      })),
    ],
    [groups, takenGroupIds]
  );

  return (
    <li
      className="flex flex-wrap items-center gap-3 px-4 py-3"
      style={{
        borderTop: '1px solid var(--color-border)',
        // A project that vanished at the provider is kept and greyed, never
        // deleted — it parents whatever history has been collected for it.
        opacity: project.missing ? 0.55 : 1,
      }}
    >
      <div className="flex-1 min-w-[180px]">
        <div className="flex items-center gap-2">
          <p className="font-body text-[13.5px] font-semibold text-[color:var(--color-text-primary)] truncate">
            {project.name}
          </p>
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
              <Link2Off size={11} aria-hidden="true" />
              No longer at the provider
            </span>
          )}
        </div>
        <p
          className="font-body mt-0.5 truncate"
          style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          {project.domain || project.externalId}
          {typeof project.keywordCount === 'number'
            ? ` · ${project.keywordCount} keyword${project.keywordCount === 1 ? '' : 's'}`
            : ''}
          {project.locations?.length
            ? ` · ${project.locations
                .map((l) => [l.lang, l.label || l.locId].filter(Boolean).join(' '))
                .join(', ')}`
            : ''}
        </p>
      </div>

      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1.5 font-body shrink-0"
          style={{
            fontSize: 12.5,
            color: 'var(--color-text-secondary)',
            background: 'transparent',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            height: 30,
            padding: '0 10px',
            cursor: 'pointer',
          }}
        >
          <Pencil size={12} aria-hidden="true" />
          Edit
        </button>
      )}

      <div className="shrink-0" style={{ width: 220 }}>
        {boundElsewhere ? (
          <p
            className="font-body"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            Mapped to a group on another board.
          </p>
        ) : canManage ? (
          <Dropdown
            size="sm"
            options={options}
            value={boundHere ? String(project.group) : ''}
            disabled={saving}
            onChange={(value) => onMap(value || null)}
            // Not `label` — that renders a visible heading above the trigger,
            // which on a list of two dozen projects would be two dozen repeats
            // of the same word. The row already says which project this is.
            ariaLabel={`Group for ${project.name}`}
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
    </li>
  );
};

export default AddonsTab;
