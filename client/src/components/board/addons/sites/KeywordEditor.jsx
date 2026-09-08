import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Plus, Trash2, Upload, X } from 'lucide-react';

import Button from '../../../ui/Button';
import {
  mergeKeywords,
  operatorsIn,
  splitKeywordText,
} from '../../../../utils/keywordList';

/**
 * THE KEYWORD LIST — the field that decides what a site costs.
 *
 * ---- Why this is not a textarea ---------------------------------------------
 *
 * It was one, and the textarea was honest about nothing. The number that
 * matters is not "how much text is in the box", it is HOW MANY KEYWORDS WILL BE
 * BOUGHT, and between those two sit duplicates, casing, stray whitespace and
 * blank lines — all of which the server silently collapses on the way in. So the
 * box said 204 and the bill said 197, and the only way to find out which was
 * which was to save.
 *
 * This does the same normalisation the server does, in front of the person
 * typing: one keyword per row, deduplicated, counted. THE SERVER STILL DECIDES —
 * `readKeywords` runs again on save and its answer is the one that binds, which
 * is why nothing here tries to be the authority on a cap or an operator. This is
 * a preview of that answer, not a second implementation of it.
 *
 * ---- The two refusals shown before saving -----------------------------------
 *
 * A SEARCH OPERATOR (`site:`, `intitle:`) multiplies the price of that keyword
 * by five at the provider, and they stack. The server refuses them outright. It
 * is worth surfacing here anyway, because a hundred pasted keywords with one
 * `site:` in the middle is a save that fails with a sentence about a keyword the
 * person then has to go and find.
 *
 * THE CAP is the other. Two hundred keywords times four markets is eight hundred
 * results bought on every single collection, forever, and somebody pasting a
 * spreadsheet column has no idea they crossed it until the save is refused.
 */

/**
 * @param {Object} props
 * @param {string[]} props.keywords - the accepted list
 * @param {Function} props.onChange
 * @param {number} props.max
 * @param {number} props.markets - how many markets multiply this list
 * @param {boolean} props.disabled
 */
const KeywordEditor = ({ keywords = [], onChange, max = 200, markets = 1, disabled = false }) => {
  const [draft, setDraft] = useState('');
  /**
   * What the last add did, as a sentence.
   *
   * Shown because ADDING IS LOSSY and silence about that is what makes the
   * count disagree with the box. "38 added, 6 already there, 1 blank" is the
   * difference between trusting the number and re-counting a spreadsheet.
   */
  const [lastAdd, setLastAdd] = useState(null);
  const fileRef = useRef(null);

  const flagged = useMemo(
    () => keywords.map((k) => ({ keyword: k, operators: operatorsIn(k) })).filter((r) => r.operators.length),
    [keywords]
  );

  const add = (text) => {
    if (!splitKeywordText(text).length) {
      setLastAdd({ message: 'Nothing to add.' });
      return;
    }

    const { keywords: next, added, duplicate } = mergeKeywords(keywords, text);
    onChange(next);
    setDraft('');

    const parts = [`${added} added`];
    if (duplicate) parts.push(`${duplicate} already there`);
    if (next.length > max) {
      // Said, not enforced — the server owns the cap, and truncating somebody's
      // paste silently is how a keyword list loses its tail without a word.
      parts.push(`${next.length} is over the ${max} cap`);
    }
    setLastAdd({ message: parts.join(' · ') });
  };

  const importFile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      add(text);
    } catch {
      setLastAdd({ message: 'That file could not be read.' });
    } finally {
      // Cleared so re-picking the same file fires `change` again.
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const over = keywords.length > max;
  const perCollection = keywords.length * Math.max(markets, 0);

  return (
    <div className="flex flex-col gap-3">
      {/* ---- The paste box -------------------------------------------------- */}
      <div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(event) => {
            /**
             * A PASTE OF SEVERAL LINES IS ADDED IMMEDIATELY.
             *
             * The whole reason somebody opens this step is to move a list in
             * from somewhere else, and making them paste and then press a
             * button adds a step to the one action this screen exists for. A
             * single-line paste is left in the box, because that is somebody
             * typing rather than importing.
             */
            const text = event.clipboardData?.getData('text') || '';
            if (splitKeywordText(text).length > 1) {
              event.preventDefault();
              add(text);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              add(draft);
            }
          }}
          placeholder={'best crm for agencies\nagency project management\nclient reporting software'}
          disabled={disabled}
          rows={4}
          className="font-body"
          style={{
            width: '100%',
            padding: '8px 10px',
            fontSize: 13,
            lineHeight: 1.6,
            borderRadius: 'var(--radius-md)',
            border: '1.5px solid var(--color-border-strong)',
            background: 'var(--color-bg-input, var(--color-bg-surface))',
            color: 'var(--color-text-primary)',
            resize: 'vertical',
          }}
        />
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <Button variant="secondary" icon={Plus} onClick={() => add(draft)} disabled={disabled || !draft.trim()}>
            Add to list
          </Button>
          <Button
            variant="secondary"
            icon={Upload}
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
          >
            Import a file
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            onChange={(e) => importFile(e.target.files?.[0])}
            style={{ display: 'none' }}
          />
          <p className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
            One per line, or a pasted spreadsheet column. Enter adds.
          </p>
        </div>
        {lastAdd && (
          <p className="font-body mt-1.5" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
            {lastAdd.message}
          </p>
        )}
      </div>

      {/* ---- The operator warning ------------------------------------------- */}
      {flagged.length > 0 && (
        <div
          className="flex items-start gap-2 px-3 py-2.5 font-body"
          style={{
            fontSize: 12,
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-warning-light, #FEF3C7)',
            color: 'var(--color-warning-text, #92400E)',
          }}
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {flagged.length === 1
              ? `“${flagged[0].keyword}” contains ${flagged[0].operators.join(', ')}.`
              : `${flagged.length} keywords contain search operators.`}{' '}
            Each operator multiplies that keyword&rsquo;s price by five and they stack, so the
            server refuses them. Remove them to continue.
          </span>
        </div>
      )}

      {/* ---- Added to the campaign ------------------------------------------ */}
      <div>
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          <span
            className="font-body"
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--color-text-muted)',
            }}
          >
            Tracked keywords
          </span>
          <span
            className="font-body"
            style={{
              fontSize: 11.5,
              color: over ? 'var(--color-danger, #DC2626)' : 'var(--color-text-muted)',
            }}
          >
            {keywords.length} of {max}
            {keywords.length > 0 && markets > 0
              ? ` · ${perCollection} result${perCollection === 1 ? '' : 's'} per collection`
              : ''}
          </span>
        </div>

        {keywords.length === 0 ? (
          <p
            className="font-body px-3 py-4"
            style={{
              fontSize: 12.5,
              color: 'var(--color-text-muted)',
              borderRadius: 'var(--radius-md)',
              border: '1px dashed var(--color-border)',
            }}
          >
            Nothing yet. Paste a list above, or import a .txt or .csv.
          </p>
        ) : (
          <>
            <ul
              className="flex flex-wrap gap-1.5"
              style={{
                maxHeight: 190,
                overflowY: 'auto',
                padding: 8,
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border)',
                background: 'var(--color-bg-subtle)',
              }}
            >
              {keywords.map((keyword, index) => {
                const bad = operatorsIn(keyword).length > 0;
                /**
                 * Anything past the cap is greyed rather than hidden. Hiding it
                 * would make a list of 240 look like a list of 200 that saves
                 * fine, and it does not.
                 */
                const beyond = index >= max;
                return (
                  <li
                    key={keyword}
                    className="inline-flex items-center gap-1.5 font-body"
                    style={{
                      fontSize: 12,
                      padding: '3px 5px 3px 9px',
                      borderRadius: 999,
                      background: bad
                        ? 'var(--color-warning-light, #FEF3C7)'
                        : 'var(--color-bg-surface)',
                      border: '1px solid var(--color-border)',
                      color: bad ? 'var(--color-warning-text, #92400E)' : 'var(--color-text-primary)',
                      opacity: beyond ? 0.45 : 1,
                    }}
                  >
                    <span className="truncate" style={{ maxWidth: 240 }}>
                      {keyword}
                    </span>
                    <button
                      type="button"
                      onClick={() => onChange(keywords.filter((k) => k !== keyword))}
                      disabled={disabled}
                      aria-label={`Remove ${keyword}`}
                      className="inline-flex items-center justify-center"
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 999,
                        border: 'none',
                        background: 'transparent',
                        color: 'inherit',
                        cursor: 'pointer',
                        opacity: 0.6,
                      }}
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>

            <button
              type="button"
              onClick={() => onChange([])}
              disabled={disabled}
              className="inline-flex items-center gap-1.5 font-body mt-2"
              style={{
                fontSize: 11.5,
                background: 'transparent',
                border: 'none',
                padding: 0,
                color: 'var(--color-text-muted)',
                cursor: 'pointer',
              }}
            >
              <Trash2 size={11} aria-hidden="true" />
              Clear all {keywords.length}
            </button>
          </>
        )}

        {over && (
          <p
            className="font-body mt-1.5"
            style={{ fontSize: 11.5, color: 'var(--color-danger, #DC2626)' }}
          >
            That is {keywords.length}. The cap is {max}, because every one of them is bought again
            on every collection — in every market.
          </p>
        )}
      </div>
    </div>
  );
};

export default KeywordEditor;
