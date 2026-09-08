import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, MapPin, Search, X } from 'lucide-react';

import { searchConnectorLocations } from '../../../../services/connectorService';

/**
 * WHERE a keyword is searched from, chosen by name instead of by integer.
 *
 * ---- The problem, stated once ----------------------------------------------
 *
 * DataForSEO addresses a market with a number. 2840 is the United States, 2826
 * the United Kingdom. The form this replaces asked for that number in a `type=
 * "number"` field with the two best-known values written into the helper text.
 *
 * THAT FIELD HAS NO WRONG-LOOKING VALUES. A typo'd 2804 (Ukraine) where 2840
 * was meant is a valid code for a real market: nothing rejects it, nothing looks
 * odd, and the first sign of the mistake is a rank report that has been quietly
 * measuring the wrong country — at full price the whole time, because every
 * market re-buys every keyword on every collection.
 *
 * So this is not a nicety. It is the only place a location code is ever checked.
 *
 * ---- Two catalogs, and why they arrive differently -------------------------
 *
 * COUNTRIES come with the connector descriptor, already in the browser. Their
 * codes are `2000 + the ISO numeric code` — a rule, not a table — so the server
 * derives all ~115 of them and they cost nothing to ship.
 *
 * CITIES do not have derivable codes and there are tens of thousands per
 * country, so they are read from the provider on demand. That read is free but
 * it can fail, and when it does THIS COMPONENT MUST STILL WORK: the country list
 * is local, and failing to reach a city list leaves a working country picker
 * rather than a dead field. Nothing here treats a city search failure as an
 * error worth blocking on.
 */

const SEARCH_DEBOUNCE_MS = 250;

const box = {
  height: 34,
  width: '100%',
  padding: '0 10px 0 30px',
  fontSize: 13,
  borderRadius: 'var(--radius-md)',
  border: '1.5px solid var(--color-border-strong)',
  background: 'var(--color-bg-input, var(--color-bg-surface))',
  color: 'var(--color-text-primary)',
};

/**
 * One market: a place, a language and a device.
 *
 * @param {Object} props
 * @param {{locationCode: number|string, languageCode: string, device: string, label: string}} props.value
 * @param {Function} props.onChange - called with a patch
 * @param {Function|null} props.onRemove - null when this is the only market
 * @param {Array<Object>} props.countries - the descriptor's own catalog
 * @param {Array<{code: string, label: string}>} props.languages
 * @param {Array<string>} props.devices
 * @param {boolean} props.canSearchCities
 * @param {string} props.boardId
 * @param {string} props.provider
 * @param {boolean} props.disabled
 */
const MarketPicker = ({
  value,
  onChange,
  onRemove,
  countries = [],
  languages = [],
  devices = ['desktop', 'mobile'],
  canSearchCities = false,
  boardId,
  provider,
  disabled = false,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  /**
   * WHICH COUNTRY'S CITIES ARE ON SCREEN, or null while the list is countries.
   *
   * The picker has two modes and this single piece of state is what says which,
   * so they cannot both be true. Drilling into a country sets it; the back
   * arrow and picking anything clear it.
   */
  const [drilled, setDrilled] = useState(null);
  const [cities, setCities] = useState([]);
  const [loadingCities, setLoadingCities] = useState(false);
  const [cityError, setCityError] = useState(null);

  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const inputRef = useRef(null);

  /**
   * WHERE THE PANEL SITS ON SCREEN, in viewport coordinates.
   *
   * ---- Why this is not just `position: absolute` under the trigger ----------
   *
   * It was, and it was clipped. This picker lives inside a modal whose body
   * scrolls, and an absolutely-positioned child of a scrolling container is
   * cut off at that container's edge — so the city list appeared with two of
   * its four rows sliced away and no scrollbar of its own to reach them. That
   * is not a cosmetic problem: the rows you cannot see are the market you came
   * here to pick.
   *
   * So the panel is PORTALLED to the document body and positioned `fixed`
   * against the trigger's measured rectangle. It escapes every ancestor's
   * overflow by construction rather than by hoping none of them clips.
   *
   * The cost is that a fixed panel does not travel with its trigger, so the
   * measurement has to be redone whenever anything moves — see the listeners
   * below, which are why this is not simply measured once on open.
   */
  const [anchor, setAnchor] = useState(null);

  const measure = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    /**
     * Wide enough for the longest thing it has to show, which is a city's full
     * comma-joined name — "Newcastle upon Tyne, England, United Kingdom" — beside
     * its code. Narrower than this and the code, which is the only way to tell
     * two identically-named places apart, is the part that gets cut.
     */
    const width = Math.min(Math.max(rect.width, 340), window.innerWidth - 16);
    // Kept inside the viewport on the right, so a picker near the edge of a
    // wide modal does not open off screen.
    const left = Math.min(rect.left, window.innerWidth - width - 8);

    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    // Flip up when there is more room there — the market rows stack downwards,
    // so the last one in a four-market site is always near the bottom.
    const flip = below < 240 && above > below;

    setAnchor({
      left: Math.max(8, left),
      width,
      top: flip ? undefined : rect.bottom + 4,
      bottom: flip ? window.innerHeight - rect.top + 4 : undefined,
      maxHeight: Math.max(180, (flip ? above : below) - 8),
    });
  }, []);

  const countryByCode = useMemo(
    () => new Map(countries.map((c) => [Number(c.locationCode), c])),
    [countries]
  );

  /**
   * The chosen market as a sentence.
   *
   * Falls back to the raw code when the catalog does not know it — which is the
   * normal state for a city, whose code lives only in a provider response we no
   * longer hold, and for a Site authored before this picker existed.
   */
  const chosen = useMemo(() => {
    const code = Number(value?.locationCode);
    if (!code) return null;
    const known = countryByCode.get(code);
    return {
      code,
      label: value?.label || known?.name || `Location ${code}`,
      known: !!known,
    };
  }, [value?.locationCode, value?.label, countryByCode]);

  // Measured before paint, so the panel never appears at the wrong place for a
  // frame and then jumps.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  /**
   * Re-measure on anything that moves the trigger.
   *
   * `true` on the scroll listener is load-bearing: scroll does not bubble, and
   * the container that actually moves this is the MODAL BODY, not the window.
   * Capturing catches every ancestor's scroll without this component having to
   * know which one of them is the scroller.
   */
  useEffect(() => {
    if (!open) return undefined;
    const onMove = () => measure();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, measure]);

  // Close on an outside click. A picker that stays open behind the next field
  // is the one interaction bug people notice immediately.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      // BOTH halves count as "inside": the panel is portalled out of the
      // wrapper, so a click on a city row is outside `wrapRef` in the DOM and
      // would otherwise close the list before it registered.
      if (wrapRef.current?.contains(event.target)) return;
      if (panelRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Escape closes it, which a portalled panel has to handle itself.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /**
   * Fetch the drilled country's places, debounced.
   *
   * ---- Why the debounce is here and not on the server ------------------------
   *
   * The server caches a whole country's list, so the SECOND keystroke is cheap
   * and only the first is not. The debounce is about the round trip, not the
   * provider's cost — and it is what stops a held-down key becoming a request
   * per character against a rate limit shared with everyone else on the board.
   */
  useEffect(() => {
    if (!drilled) return undefined;
    let cancelled = false;
    setLoadingCities(true);

    const timer = setTimeout(async () => {
      try {
        const rows = await searchConnectorLocations(boardId, provider, {
          country: drilled.countryIso,
          q: query,
        });
        if (!cancelled) {
          setCities(rows);
          setCityError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setCities([]);
          /**
           * Reported INSIDE the dropdown and nowhere else. A city list that
           * cannot be reached is not a reason to fail a form: the country is
           * already picked and is a perfectly good market. The message says so
           * rather than reading as a validation failure.
           */
          setCityError(
            err?.response?.data?.error ||
              'Could not reach the provider for cities. The country still works.'
          );
        }
      } finally {
        if (!cancelled) setLoadingCities(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [drilled, query, boardId, provider]);

  /** Country matches, ranked the way the server ranks them: prefix beats contains. */
  const countryMatches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return countries.slice(0, 40);

    // A bare number is a location code, not a name — the escape hatch that keeps
    // every market reachable for somebody who already has the code.
    if (/^\d+$/.test(needle)) {
      const hit = countryByCode.get(Number(needle));
      return hit ? [hit] : [];
    }

    return countries
      .map((country) => {
        const name = country.name.toLowerCase();
        let score = 0;
        if (name === needle) score = 1000;
        else if (name.startsWith(needle)) score = 500 - name.length;
        else if (name.includes(` ${needle}`)) score = 300 - name.length;
        else if (name.includes(needle)) score = 100 - name.length;
        else if (country.countryIso.toLowerCase() === needle) score = 400;
        return { country, score };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.country.name.localeCompare(b.country.name))
      .slice(0, 40)
      .map((row) => row.country);
  }, [query, countries, countryByCode]);

  /**
   * Pick a place.
   *
   * The LANGUAGE MOVES WITH THE COUNTRY, but only when the current one is not a
   * language that country plausibly speaks. Switching from the US to France
   * should offer French; switching from the US to Canada while the user has
   * deliberately chosen `fr` should not undo that choice.
   */
  const choose = (row) => {
    const languagesHere = row.languages || ['en'];
    const keepLanguage = languagesHere.includes(value?.languageCode);
    onChange({
      locationCode: row.locationCode,
      label: row.label || row.name,
      ...(keepLanguage ? {} : { languageCode: languagesHere[0] || 'en' }),
    });
    setOpen(false);
    setQuery('');
    setDrilled(null);
  };

  const rows = drilled ? cities : countryMatches;

  return (
    <li
      className="flex flex-wrap items-end gap-2"
      style={{
        padding: '10px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-subtle)',
      }}
    >
      {/* ---- Location ------------------------------------------------------ */}
      <div style={{ flex: '2 1 240px', minWidth: 200, position: 'relative' }} ref={wrapRef}>
        <Label>Location</Label>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => !disabled && setOpen((o) => !o)}
          disabled={disabled}
          className="flex items-center gap-2 w-full text-left"
          style={{
            height: 34,
            padding: '0 10px',
            fontSize: 13,
            borderRadius: 'var(--radius-md)',
            border: '1.5px solid var(--color-border-strong)',
            background: 'var(--color-bg-input, var(--color-bg-surface))',
            color: chosen ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
            cursor: disabled ? 'default' : 'pointer',
          }}
        >
          <MapPin size={13} className="shrink-0" aria-hidden="true" />
          <span className="truncate flex-1">{chosen ? chosen.label : 'Pick a country or city'}</span>
          {chosen && (
            <span
              className="shrink-0 font-body"
              style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
            >
              {chosen.code}
            </span>
          )}
        </button>

        {open && anchor &&
          createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed',
              zIndex: 1200,
              left: anchor.left,
              width: anchor.width,
              ...(anchor.top !== undefined ? { top: anchor.top } : { bottom: anchor.bottom }),
              maxHeight: anchor.maxHeight,
              overflowY: 'auto',
              // Never sideways. A horizontal scrollbar here hides the location
              // code, which is the one field that disambiguates two places with
              // the same name.
              overflowX: 'hidden',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg-surface)',
              boxShadow: '0 10px 30px rgba(0,0,0,0.16)',
            }}
          >
            <div className="p-2" style={{ position: 'sticky', top: 0, background: 'var(--color-bg-surface)' }}>
              <div style={{ position: 'relative' }}>
                <Search
                  size={13}
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: 9,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--color-text-muted)',
                  }}
                />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    drilled ? `Search in ${drilled.name}…` : 'Search a country, or paste a code'
                  }
                  style={box}
                  className="font-body"
                />
              </div>
              {drilled && (
                <button
                  type="button"
                  onClick={() => {
                    setDrilled(null);
                    setQuery('');
                    setCities([]);
                    setCityError(null);
                  }}
                  className="font-body mt-2"
                  style={{
                    fontSize: 11.5,
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    color: 'var(--color-accent)',
                    cursor: 'pointer',
                  }}
                >
                  &larr; Back to countries
                </button>
              )}
            </div>

            {loadingCities && (
              <p
                className="font-body flex items-center gap-2 px-3 py-3"
                style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
              >
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                Reading {drilled?.name}&rsquo;s locations…
              </p>
            )}

            {cityError && !loadingCities && (
              <p
                className="font-body px-3 py-2"
                style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
              >
                {cityError}
              </p>
            )}

            {!loadingCities && rows.length === 0 && !cityError && (
              <p
                className="font-body px-3 py-3"
                style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
              >
                Nothing matches &ldquo;{query}&rdquo;.
              </p>
            )}

            <ul>
              {rows.map((row) => (
                <li key={`${row.locationCode}-${row.name}`}>
                  <div className="flex items-stretch">
                    <button
                      type="button"
                      onClick={() => choose(row)}
                      className="flex items-center gap-2 flex-1 text-left px-3 py-2"
                      style={{
                        background:
                          Number(value?.locationCode) === Number(row.locationCode)
                            ? 'var(--color-bg-subtle)'
                            : 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 12.5,
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      {Number(value?.locationCode) === Number(row.locationCode) ? (
                        <Check size={12} className="shrink-0" aria-hidden="true" />
                      ) : (
                        <span style={{ width: 12 }} aria-hidden="true" />
                      )}
                      {/* `min-w-0` is what makes `truncate` work inside a flex
                          row — without it the name refuses to shrink and pushes
                          the code off the edge instead. */}
                      <span className="truncate font-body min-w-0 flex-1">
                        {row.label || row.name}
                      </span>
                      <span
                        className="shrink-0 font-body"
                        style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                      >
                        {row.locationCode}
                      </span>
                    </button>

                    {/* Drilling in is offered only for a country, and only when
                        an account exists to read the list from. Without one the
                        picker is countries-only, which is a complete answer
                        rather than a broken version of a bigger one. */}
                    {!drilled && canSearchCities && (
                      <button
                        type="button"
                        onClick={() => {
                          setDrilled(row);
                          setQuery('');
                          setCities([]);
                          setCityError(null);
                        }}
                        className="font-body shrink-0 px-2"
                        style={{
                          fontSize: 11,
                          background: 'transparent',
                          border: 'none',
                          borderLeft: '1px solid var(--color-border)',
                          color: 'var(--color-text-muted)',
                          cursor: 'pointer',
                        }}
                        aria-label={`Search cities in ${row.name}`}
                      >
                        Cities
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>,
          document.body
        )}
      </div>

      {/* ---- Language ------------------------------------------------------ */}
      <div style={{ flex: '1 1 150px', minWidth: 130 }}>
        <Label>Language</Label>
        <select
          value={value?.languageCode || 'en'}
          onChange={(e) => onChange({ languageCode: e.target.value })}
          disabled={disabled}
          className="font-body"
          style={{ ...box, padding: '0 8px' }}
        >
          {languages.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.label} ({lang.code})
            </option>
          ))}
        </select>
      </div>

      {/* ---- Device -------------------------------------------------------- */}
      <div className="shrink-0">
        <Label>Device</Label>
        <div className="flex" style={{ gap: 4 }}>
          {devices.map((device) => {
            const active = (value?.device || 'desktop') === device;
            return (
              <button
                key={device}
                type="button"
                onClick={() => onChange({ device })}
                disabled={disabled}
                className="font-body"
                style={{
                  height: 34,
                  padding: '0 12px',
                  fontSize: 12.5,
                  borderRadius: 'var(--radius-md)',
                  border: `1.5px solid ${active ? 'var(--color-accent)' : 'var(--color-border-strong)'}`,
                  background: active ? 'var(--color-accent-light, var(--color-bg-subtle))' : 'transparent',
                  color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                  cursor: disabled ? 'default' : 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {device}
              </button>
            );
          })}
        </div>
      </div>

      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label="Remove this market"
          className="inline-flex items-center justify-center shrink-0"
          style={{
            width: 34,
            height: 34,
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border)',
            background: 'transparent',
            color: 'var(--color-text-muted)',
            cursor: 'pointer',
          }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </li>
  );
};

const Label = ({ children }) => (
  <span
    className="font-body block mb-1"
    style={{
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      color: 'var(--color-text-muted)',
    }}
  >
    {children}
  </span>
);

export default MarketPicker;
