import { AlertTriangle, Folder, ListChecks, TrendingUp } from 'lucide-react';

import SectionFrame from '../SectionFrame';
import StatCard from '../../ui/StatCard';
import useBoardStore from '../../../store/boardStore';

/**
 * WorkspaceNumbersSection — the Analytics page's four figures.
 *
 * Payload (`executiveHome.runWorkspaceNumbers`):
 *   { range, boardId, summary: { totalTasks, completionRate, overdueTasks, activeBoards } }
 *
 * ---- THE SAME FOUR TILES AS `/analytics`, ON PURPOSE ----------------------
 *
 * Same icons, same labels, same colours, same order, and the numbers come from
 * the same `buildAnalytics(...)` call the Analytics page's own endpoint makes.
 * A person who reads "412 total tasks" here and clicks through must land on a
 * page that agrees, and the cheapest way to guarantee that is to draw it the
 * same way rather than to invent a home-page treatment of the same four facts.
 *
 * ---- WHY THERE IS NO EMPTY STATE -----------------------------------------
 *
 * The composer never returns `empty` for this type, and the frame is therefore
 * never asked for a message. Four figures reading zero is a real answer about a
 * quiet workspace, not an absence — a tile that replaced them with "nothing to
 * show" would be hiding a fact behind a placeholder.
 *
 * `unavailable` IS reachable and means one specific thing: this person's org
 * role no longer carries `analytics.view`. Roles are data and are edited in the
 * matrix, so a section composed last month can lose its source this afternoon.
 * The server answers that with a sentence rather than a 403 precisely so the
 * other seven sections still render, and the frame prints it calmly.
 *
 * ---- WHY THE NARROWED CASE HAS TO SAY SO ---------------------------------
 *
 * `config.board` turns these into ONE BOARD's numbers under a heading that says
 * "Workspace". That is the section's design — a narrowing, not a subject, which
 * is why the composer marks it `optionalBoard` — but an unlabelled 412 that
 * silently means one board out of forty is the kind of number somebody repeats
 * in a meeting. The board's name is not on the payload (the tile draws four
 * figures, and the composer ships only `summary`), so it is read from the board
 * store, which the home page has already loaded and which is itself filtered on
 * `canRead`. A board the store has not caught up with degrades to "one board" —
 * vaguer, still true, and never a wrong name.
 */

/** The range values `analyticsReport.VALID_RANGES` accepts, in its own words. */
const RANGE_LABELS = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time',
};

const WorkspaceNumbersSection = ({ section }) => {
  const data = section?.data || {};
  const summary = data.summary || {};
  const boards = useBoardStore((s) => s.boards);

  const boardName = data.boardId
    ? (boards || []).find((b) => String(b?._id || '') === String(data.boardId))?.name || 'one board'
    : null;

  const subtitle = [RANGE_LABELS[data.range] || RANGE_LABELS['30d'], boardName]
    .filter(Boolean)
    .join(' · ');

  return (
    <SectionFrame section={section} title="Workspace numbers" subtitle={subtitle}>
      {() => (
        // Two columns on a tablet, four on a wide screen — and one on a phone,
        // where four 120px-tall saturated tiles side by side would each be
        // eighty pixels wide.
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            icon={ListChecks}
            label="Total Tasks"
            value={summary.totalTasks || 0}
            color="blue"
          />
          <StatCard
            icon={TrendingUp}
            label="Completion Rate"
            /* A NUMBER with a suffix, never a formatted string: StatCard
               animates a count-up and falls back to printing the value
               verbatim for anything that is not finite. */
            value={summary.completionRate || 0}
            suffix="%"
            color="green"
          />
          <StatCard
            icon={AlertTriangle}
            label="Overdue Tasks"
            value={summary.overdueTasks || 0}
            color="red"
            /* No `onClick`. The Analytics page opens a modal naming who is
               carrying the late work; that breakdown is gated on
               `productivity.view_others`, the composer passes `canSeeOthers:
               false` unconditionally, and this page has nothing to open. */
          />
          <StatCard
            icon={Folder}
            label="Active Boards"
            value={summary.activeBoards || 0}
            color="purple"
          />
        </div>
      )}
    </SectionFrame>
  );
};

export default WorkspaceNumbersSection;
