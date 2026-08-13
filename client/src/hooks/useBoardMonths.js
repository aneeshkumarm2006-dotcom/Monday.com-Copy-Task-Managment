import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listBoardMonths } from '../services/monthService';
import {
  findMonth, isMonthKey, readStoredMonth, writeStoredMonth,
} from '../utils/monthKeys';

/**
 * Owns "which month is this board showing".
 *
 * THE URL IS THE SINGLE SOURCE OF TRUTH, matching the doctrine already written
 * for `?view=` in BoardDetailPage: two sources of truth for what you are
 * looking at is the classic bug here, and `?month=2026-07` is even more worth
 * pasting to a colleague than `?view=delivery` — it is precisely what they need
 * in order to see the same numbers you are.
 *
 * localStorage is a SEED, never a source. It supplies the default when the URL
 * carries no month, and is written on every change; reading only ever touches
 * the URL. One writer, one reader, so the doctrine holds.
 *
 * This lives in a hook purely to keep ~80 lines of reconciliation out of
 * BoardDetailPage, which is already 2,300 lines. There is no context and no
 * store slice, because there is nothing to drill through: every consumer of the
 * month — the task memo, DeliveryTab, GoalsTab, the bulk bar — is rendered by
 * BoardDetailPage itself.
 *
 * @param {string} boardId
 * @param {{ enabled: boolean }} options - false on non-tracker boards, where
 *   this hook fetches nothing and returns inert values.
 */
const useBoardMonths = (boardId, { enabled = false } = {}) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [months, setMonths] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!enabled || !boardId) {
      setMonths([]);
      setMeta(null);
      return;
    }
    setLoading(true);
    try {
      const data = await listBoardMonths(boardId);
      setMonths(Array.isArray(data?.months) ? data.months : []);
      setMeta(data || null);
    } catch {
      // A 404 here means the board is not monthly (a type flip in another tab,
      // usually). Empty months collapse the selector rather than erroring.
      setMonths([]);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }, [boardId, enabled]);

  useEffect(() => {
    load();
  }, [load]);

  const urlMonth = searchParams.get('month');

  const setMonth = useCallback(
    (next, { replace = false } = {}) => {
      if (!isMonthKey(next)) return;
      writeStoredMonth(boardId, next);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set('month', next);
          return params;
        },
        { replace }
      );
    },
    [boardId, setSearchParams]
  );

  // Seed the month whenever the URL does not already name a usable one.
  //
  //   URL has a month that exists      → use it, rewrite nothing
  //   URL has a month that does not    → replace with the default (stale link)
  //   URL has no month                 → localStorage, else the server default
  //
  // This deliberately runs on every render where the URL is monthless, NOT once
  // per board. It used to be a one-time seed guarded by a ref, on the theory
  // that re-running could overwrite a choice the user had just made — it cannot,
  // because a user's choice goes straight into `?month=` and is caught by the
  // first branch below. What the guard DID do was strand the board: any
  // navigation that replaced the query string while staying on the same board —
  // clicking a notification for a task on the board you are already looking at —
  // dropped `?month=` with the seed already spent, so `monthKey` stayed null
  // forever. That is a board stuck on "Pick a month" with no groups and no
  // tasks, because the whole board read is gated on the month having resolved.
  // Re-seeding is the thing that makes such a link self-heal.
  useEffect(() => {
    if (!enabled || months.length === 0) return;

    if (isMonthKey(urlMonth) && findMonth(months, urlMonth)) {
      writeStoredMonth(boardId, urlMonth);
      return;
    }

    const fallback = meta?.defaultKey || months[0]?.key;
    const remembered = urlMonth ? null : readStoredMonth(boardId);
    const seed = (remembered && findMonth(months, remembered)) ? remembered : fallback;
    // `seed !== urlMonth` cannot fire on a month the list contains (that
    // returned above), so it only stops a server default missing from its own
    // month list from re-writing the same URL on every render.
    if (seed && seed !== urlMonth) setMonth(seed, { replace: true });
  }, [enabled, months, meta, urlMonth, boardId, setMonth]);

  // Never hand out a month the list does not contain — a stale `?month=` must
  // not be used as a task filter, or the board silently renders empty.
  const monthKey = useMemo(() => {
    if (!enabled) return null;
    if (isMonthKey(urlMonth) && findMonth(months, urlMonth)) return urlMonth;
    return null;
  }, [enabled, urlMonth, months]);

  const selectedMonth = useMemo(
    () => findMonth(months, monthKey),
    [months, monthKey]
  );

  return {
    monthKey,
    setMonth,
    months,
    selectedMonth,
    currentKey: meta?.currentKey || null,
    timezone: meta?.timezone || null,
    unfiledCount: meta?.unfiled?.count || 0,
    monthsLoading: loading,
    /** Refetch — used after a goal edit changes a month's `unclosed` badge. */
    refreshMonths: load,
  };
};

export default useBoardMonths;
