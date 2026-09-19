import { useMemo, useState } from 'react';
import {
  Columns3,
  Globe,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react';

import Button from '../../../ui/Button';
import EmptyState from '../../../ui/EmptyState';
import SortableTh from '../../../ui/SortableTh';
import Spinner from '../../../ui/Spinner';
import {
  FilterPopover,
  OptionList,
  OptionRow,
} from '../../../ui/FilterControls';
import { ScrollTable, Td } from '../connector/SectionShell';
import { marketLabel, staleness, toneColor } from '../../../../utils/connectorFormat';
import {
  DEFAULT_SITE_COLUMNS,
  SITE_COLUMNS,
  SITE_STATES,
  filterSiteRows,
  siteColumn,
  siteStateOf,
  sortSiteRows,
  summariseSiteRows,
} from '../../../../utils/siteRows';

/**
 * THE SITES TABLE — every site the workspace tracks, one row each.
 *
 * ---- What this replaced, and why -------------------------------------------
 *
 * The tab used to open straight into ONE site's dashboard, picked by a dropdown
 * in the project bar. That is the right first screen for somebody who already
 * knows which client they came to look at, and the wrong one for everybody else:
 * an agency's first question is "how are all of them doing", and the only way to
 * answer it was to choose each site in turn and remember the numbers.
 *
 * Worse, the dropdown was built from the board's MAPPED sites, so a site that
 * was not attached to a client group — a prospect's domain, a competitor, the
 * agency's own site — was unreachable from this tab entirely. It could be added
 * and then never looked at.
 *
 * So the tab opens here now. A site is a row whether or not it belongs to a
 * client, the row says which, and drilling into one is the second click.
 *
 * ---- Why the table is the whole screen and not a panel above the dashboard --
 *
 * Because they answer different questions and a screen that tried to do both
 * would do the second one in a third of the width. The index compares sites; the
 * dashboard explains one. `SeoDashboardTab` switches between them and nothing
 * renders both.
 *
 * ---- Every number here arrived computed -------------------------------------
 *
 * `services/connectors/siteIndex.js` reduced each site to a row server-side, and
 * it is the ONLY place that arithmetic happens — the same rule `goalTypes.js`
 * and `adsBudgetPacing.js` hold for theirs. This file formats and orders;
 * `utils/siteRows.js` holds the columns. Nothing here recomputes a metric, and a
 * column that needs a number nobody sent is a change to the server.
 *
 * ---- It spends nothing ------------------------------------------------------
 *
 * Opening this table contacts no provider. On DataForSEO that is load-bearing
 * rather than polite: it bills at the moment a collection is ordered, so a table
 * that fetched on mount would buy SERPs per viewer per render.
 */

/** Google's favicon service — needs no key, and degrades to nothing. */
const faviconFor = (domain) =>
  domain
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`
    : null;

const STATE_BY_KEY = new Map(SITE_STATES.map((s) => [s.key, s]));

/**
 * The state chip on a row.
 *
 * A live, mapped site gets NOTHING — it is the ordinary case, and a chip on
 * every row is a chip that says nothing about any of them. The three states that
 * need a person are the three that are drawn.
 */
const StateChip = ({ row }) => {
  const key = siteStateOf(row);
  if (key === 'live') return null;
  const state = STATE_BY_KEY.get(key);
  const tone = state?.tone === 'warning'
    ? {
        bg: 'var(--color-warning-light, #FEF3C7)',
        fg: 'var(--color-warning-text, #92400E)',
      }
    : { bg: 'var(--color-bg-subtle)', fg: 'var(--color-text-muted)' };

  return (
    <span
      className="inline-flex items-center font-body shrink-0"
      style={{
        fontSize: 10.5,
        padding: '2px 7px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        background: tone.bg,
        color: tone.fg,
      }}
    >
      {state?.label || key}
    </span>
  );
};

/**
 * A metric cell: the number, and underneath it what it did since last time.
 *
 * The delta is NOT `SectionShell`'s `Delta` component. That one prints "No
 * change" in words, which is right in a five-across stat row and wrong eleven
 * times per row in a table — it would be the loudest text on the screen and it
 * would say nothing. Here an absent or zero delta is simply absent, and the
 * number stands alone.
 *
 * `invert` comes from the column, because rank is the one where a rise is a
 * fall. Getting that backwards colours every improvement red on a page somebody
 * is about to screenshot for a client.
 */
const MetricCell = ({ row, column }) => {
  const delta = row.deltas?.[column.key];
  const moved = typeof delta === 'number' && delta !== 0;
  const good = column.invert ? delta < 0 : delta > 0;

  return (
    <Td align="right">
      <span
        className="font-body"
        style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
      >
        {column.format(row)}
      </span>
      {moved && (
        <span
          className="font-body block"
          style={{ fontSize: 10.5, color: toneColor(good ? 'positive' : 'negative') }}
        >
          {delta > 0 ? '▲' : '▼'} {Math.abs(Math.round(delta * 10) / 10)}
        </span>
      )}
    </Td>
  );
};

const Summary = ({ label, value }) => (
  <div>
    <p
      className="font-body"
      style={{
        fontSize: 10.5,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: 'var(--color-text-muted)',
      }}
    >
      {label}
    </p>
    <p
      className="font-display font-semibold"
      style={{ fontSize: 18, color: 'var(--color-text-primary)' }}
    >
      {value}
    </p>
  </div>
);

/**
 * @param {Object} props
 * @param {Array} props.sites - rows from `GET .../sites`
 * @param {boolean} props.loading
 * @param {string} props.label - the provider's own name
 * @param {string} props.noun - what this provider calls one ("Site")
 * @param {boolean} props.canManage
 * @param {boolean} props.canAdd - `canManage` AND an account is connected
 * @param {Function} props.onOpen - (site) => void, the drill-in
 * @param {Function} props.onAdd
 * @param {Function} props.onEdit - (site) => void
 * @param {Function} props.onRefresh
 * @param {boolean} props.refreshing
 */
const SitesIndexScreen = ({
  sites = [],
  loading = false,
  label = 'SEO',
  noun = 'Site',
  canManage = false,
  canAdd = false,
  onOpen,
  onAdd,
  onEdit,
  onRefresh,
  refreshing = false,
}) => {
  const [query, setQuery] = useState('');
  const [states, setStates] = useState([]);
  const [columns, setColumns] = useState(DEFAULT_SITE_COLUMNS);
  /**
   * Visibility descending by default.
   *
   * The table's job is "which of these needs me", and that is the column that
   * answers it across sites of different sizes. Alphabetical would be a filing
   * cabinet again.
   */
  const [sort, setSort] = useState({ key: 'visibility', dir: 'desc' });

  const totals = useMemo(() => summariseSiteRows(sites), [sites]);

  const rows = useMemo(
    () => sortSiteRows(filterSiteRows(sites, { query, states }), sort),
    [sites, query, states, sort]
  );

  const shown = useMemo(
    () => columns.map(siteColumn).filter(Boolean),
    [columns]
  );

  /**
   * Does this workspace read its sites in more than one market?
   *
   * If it does, every row has to say which — a rank is a rank IN A MARKET and a
   * table mixing two without labelling them is a table whose numbers cannot be
   * checked. If it does not, the same string down twenty rows is noise that
   * costs a column's width. Same rule `ProviderChrome` applies to its own market
   * picker, for the same reason.
   */
  const manyMarkets = useMemo(
    () => new Set(sites.map((s) => s.variant).filter(Boolean)).size > 1,
    [sites]
  );

  const toggleState = (key) =>
    setStates((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );

  const toggleColumn = (key) =>
    setColumns((prev) => {
      // Never all the way empty: a table with a name column and nothing else is
      // a list, and there is no way back to a column from a menu that is off.
      if (prev.includes(key)) {
        return prev.length === 1 ? prev : prev.filter((k) => k !== key);
      }
      // Re-inserted in the catalog's own order, so the columns do not shuffle
      // themselves into the order they happened to be switched on in.
      return SITE_COLUMNS.filter((c) => c.key === key || prev.includes(c.key)).map(
        (c) => c.key
      );
    });

  if (loading && !sites.length) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
      }}
    >
      {/* ---- The strip: what this workspace is tracking, and what it buys --- */}
      <div
        className="flex flex-wrap items-end gap-x-8 gap-y-4 px-4 py-3.5"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <Summary label={`${noun}s`} value={totals.sites} />
        <Summary label="Collecting" value={totals.live} />
        {totals.drafts > 0 && <Summary label="Unfinished" value={totals.drafts} />}
        {totals.unmapped > 0 && (
          <Summary label="Not mapped" value={totals.unmapped} />
        )}
        <Summary
          label="Results / collection"
          value={totals.resultsPerCollection.toLocaleString()}
        />

        <div className="ml-auto flex items-center gap-2">
          {canManage && (
            <Button
              variant="secondary"
              icon={RefreshCw}
              onClick={onRefresh}
              disabled={refreshing}
            >
              {refreshing ? 'Working…' : 'Refresh'}
            </Button>
          )}
          {canAdd && (
            <Button icon={Plus} onClick={onAdd}>
              Add a {noun.toLowerCase()}
            </Button>
          )}
        </div>
      </div>

      {/* ---- Search, state filter, columns ---------------------------------- */}
      <div
        className="flex flex-wrap items-center gap-2 px-4 py-2.5"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <div className="relative" style={{ flex: '1 1 220px', maxWidth: 320 }}>
          <Search
            size={14}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--color-text-muted)',
            }}
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // The group name is searched too — on a board holding two dozen
            // clients the thing somebody remembers is the client, not the domain.
            placeholder={`Search ${noun.toLowerCase()}s, domains or clients`}
            aria-label={`Search ${noun.toLowerCase()}s`}
            className="font-body w-full"
            style={{
              height: 34,
              paddingLeft: 30,
              paddingRight: 10,
              fontSize: 13,
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg-base)',
              color: 'var(--color-text-primary)',
            }}
          />
        </div>

        <FilterPopover
          label="Status"
          icon={SlidersHorizontal}
          activeCount={states.length}
        >
          <OptionList>
            {SITE_STATES.map((state) => (
              <OptionRow
                key={state.key}
                checked={states.includes(state.key)}
                onToggle={() => toggleState(state.key)}
              >
                {state.label}
              </OptionRow>
            ))}
          </OptionList>
        </FilterPopover>

        <FilterPopover label="Columns" icon={Columns3}>
          <OptionList>
            {SITE_COLUMNS.map((column) => (
              <OptionRow
                key={column.key}
                checked={columns.includes(column.key)}
                onToggle={() => toggleColumn(column.key)}
              >
                {column.label}
              </OptionRow>
            ))}
          </OptionList>
        </FilterPopover>

        {(query || states.length > 0) && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setStates([]);
            }}
            className="font-body"
            style={{
              fontSize: 12.5,
              background: 'none',
              border: 'none',
              padding: '0 4px',
              color: 'var(--color-accent)',
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
        )}

        <span
          className="font-body ml-auto"
          style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          {rows.length === sites.length
            ? `${sites.length} ${noun.toLowerCase()}${sites.length === 1 ? '' : 's'}`
            : `${rows.length} of ${sites.length}`}
        </span>
      </div>

      {/* ---- The table ------------------------------------------------------ */}
      {sites.length === 0 ? (
        <div className="px-4 py-8">
          <EmptyState
            icon={Globe}
            title={`No ${noun.toLowerCase()}s yet`}
            description={
              canAdd
                ? `A ${noun.toLowerCase()} is a domain, the markets you track it in, and the keywords you track there. It does not have to belong to a client on this board — add a prospect or a competitor and map it later, or never.`
                : `Nobody has set up a ${noun.toLowerCase()} for this workspace yet.`
            }
            actionLabel={canAdd ? `Add a ${noun.toLowerCase()}` : undefined}
            onAction={canAdd ? onAdd : undefined}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-8">
          <EmptyState
            icon={Search}
            title="Nothing matches"
            description="No site matches that search and those filters."
            actionLabel="Clear filters"
            onAction={() => {
              setQuery('');
              setStates([]);
            }}
          />
        </div>
      ) : (
        <ScrollTable maxHeight={560}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <SortableTh column="site" sort={sort} onSort={setSort} width={240}>
                  {noun}
                </SortableTh>
                <SortableTh column="group" sort={sort} onSort={setSort}>
                  Client
                </SortableTh>
                {shown.map((column) => (
                  <SortableTh
                    key={column.key}
                    column={column.key}
                    sort={sort}
                    onSort={setSort}
                    align="right"
                    title={column.help || `Sort by ${column.label}`}
                  >
                    {column.label}
                  </SortableTh>
                ))}
                <SortableTh column="collectedAt" sort={sort} onSort={setSort} align="right">
                  Collected
                </SortableTh>
                {/*
                  ---- The actions column is PINNED to the right ---------------

                  Written inline rather than through `SortableTh`/`Td`, because
                  it is the one column that needs `position: sticky` on a second
                  axis and those primitives own their own positioning.

                  It needs it because eleven columns do not fit a laptop and this
                  table scrolls sideways inside its own box by design — so
                  without pinning, the control that finishes a half-built site is
                  permanently past the right edge, on the row whose whole purpose
                  is to ask somebody to finish it. Sticky in both axes: `top` for
                  the header row, `right` for the column.
                */}
                {canManage && (
                  <th
                    scope="col"
                    className="font-body font-medium"
                    style={{
                      width: 96,
                      padding: '8px 12px',
                      position: 'sticky',
                      top: 0,
                      right: 0,
                      zIndex: 1,
                      background: 'var(--color-bg-subtle)',
                      borderBottom: '1px solid var(--color-border)',
                      borderLeft: '1px solid var(--color-border)',
                    }}
                  >
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const draft = row.status === 'draft';
                return (
                  <tr
                    key={row._id}
                    style={{
                      // A site that vanished at the provider is greyed and kept —
                      // it parents every reading ever taken for that domain.
                      opacity: row.missing ? 0.55 : 1,
                      background: draft ? 'var(--color-bg-subtle)' : 'transparent',
                    }}
                  >
                    {/* ---- Identity: the whole cell is the drill-in --------- */}
                    <Td>
                      <button
                        type="button"
                        onClick={() => onOpen?.(row)}
                        className="flex items-center gap-2.5 text-left w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          borderRadius: 'var(--radius-sm)',
                        }}
                        title={`Open ${row.name || row.domain}`}
                      >
                        <img
                          src={faviconFor(row.domain)}
                          alt=""
                          aria-hidden="true"
                          width={18}
                          height={18}
                          className="shrink-0"
                          style={{ borderRadius: 4 }}
                          onError={(e) => {
                            e.currentTarget.style.visibility = 'hidden';
                          }}
                        />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span
                              className="font-body font-semibold truncate"
                              style={{
                                fontSize: 13.5,
                                color: 'var(--color-accent)',
                                maxWidth: 170,
                              }}
                            >
                              {row.name || row.domain}
                            </span>
                            <StateChip row={row} />
                          </span>
                          <span
                            className="font-body block truncate"
                            style={{
                              fontSize: 11.5,
                              color: 'var(--color-text-muted)',
                              maxWidth: 210,
                            }}
                            title={[row.domain, row.variant && marketLabel(row.variant)]
                              .filter(Boolean)
                              .join(' · ')}
                          >
                            {row.domain}
                            {/*
                              The market these ranks are FROM — printed only when
                              this workspace has more than one, which is the same
                              rule `ProviderChrome` follows for its own pickers.
                              A rank with no market beside it cannot be checked;
                              a market repeated identically down twenty rows is
                              the column that pushes every other one off a laptop
                              screen. The tooltip carries it either way.
                            */}
                            {manyMarkets && row.variant
                              ? ` · ${marketLabel(row.variant)}`
                              : ''}
                          </span>
                        </span>
                      </button>
                    </Td>

                    {/* ---- Which client, if any ---------------------------- */}
                    <Td muted={!row.groupName}>
                      {row.groupName ||
                        (row.mappedElsewhere ? 'On another board' : 'Not mapped')}
                    </Td>

                    {shown.map((column) => (
                      <MetricCell key={column.key} row={row} column={column} />
                    ))}

                    <Td align="right" muted>
                      {row.collectedAt ? staleness(row.collectedAt) : 'Never'}
                    </Td>

                    {canManage && (
                      <td
                        className="font-body"
                        style={{
                          fontSize: 13,
                          textAlign: 'right',
                          padding: '8px 12px',
                          borderBottom: '1px solid var(--color-border)',
                          borderLeft: '1px solid var(--color-border)',
                          whiteSpace: 'nowrap',
                          // Pinned — see the header cell. The background is
                          // opaque and matches the row's, or the columns it is
                          // floating over would show through it.
                          position: 'sticky',
                          right: 0,
                          background: draft
                            ? 'var(--color-bg-subtle)'
                            : 'var(--color-bg-surface)',
                        }}
                      >
                        {/* Only a site AUTHORED here can be edited here. A
                            mirrored project belongs to its provider, and an Edit
                            button over one would be a control that can only
                            ever fail. */}
                        {row.locallyAuthored && (
                          <button
                            type="button"
                            onClick={() => onEdit?.(row)}
                            className="font-body"
                            style={{
                              fontSize: 12.5,
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              color: 'var(--color-accent)',
                              cursor: 'pointer',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {draft ? 'Finish' : 'Edit'}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollTable>
      )}

      {/* ---- The footnote the numbers need ---------------------------------- */}
      <p
        className="font-body px-4 py-2.5"
        style={{
          fontSize: 11.5,
          color: 'var(--color-text-muted)',
          borderTop: '1px solid var(--color-border)',
        }}
      >
        {/*
          Said once, plainly, on the screen where the numbers are compared.
          Visibility is OURS — a weighted count of ranks — and calling it traffic
          on a client report would be a claim we cannot support.
        */}
        Every figure comes from this workspace’s own stored collections, not from
        a live lookup — opening this table costs nothing. Visibility is a
        weighted score over the keywords you track, not an estimate of traffic.
        Movement is against the previous collection of the same {label} reading.
      </p>
    </div>
  );
};

export default SitesIndexScreen;
