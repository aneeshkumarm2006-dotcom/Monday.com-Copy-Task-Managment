import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

  // Guards the one-time seed so a re-render cannot overwrite a choice the user
  // just made. Keyed by board, so opening a different board seeds again.
  const seededFor = useRef(null);

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
    seededFor.current = null;
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

  // Seed once per board, after the month list arrives.
  //
  //   URL has a month that exists      → use it, rewrite nothing
  //   URL has a month that does not    → replace with the default (stale link)
  //   URL has no month                 → localStorage, else the server default
  useEffect(() => {
    if (!enabled || months.length === 0) return;
    if (seededFor.current === boardId) return;
    seededFor.current = boardId;

    const fallback = meta?.defaultKey || months[0]?.key;
    if (isMonthKey(urlMonth) && findMonth(months, urlMonth)) {
      writeStoredMonth(boardId, urlMonth);
      return;
    }
    const seed = (!urlMonth && readStoredMonth(boardId)) || fallback;
    if (seed && findMonth(months, seed)) setMonth(seed, { replace: true });
    else if (fallback) setMonth(fallback, { replace: true });
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
