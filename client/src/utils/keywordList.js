/**
 * A TRACKED-KEYWORD LIST, as the browser previews it.
 *
 * ---- What this is, and what it is emphatically not -------------------------
 *
 * It is a PREVIEW of an answer the server owns. `dataforseo/sites.js`
 * `readKeywords` is what actually decides whether a list can be saved: it
 * normalises, deduplicates, caps, and refuses search operators, and its verdict
 * is the one that binds because it is the one holding the money.
 *
 * These functions exist so that the same verdict can be shown BEFORE the save.
 * The old form was a plain textarea, and it was honest about nothing: the box
 * said 204 and the bill said 197, because duplicates, casing and blank lines
 * were collapsed silently on the way in and there was no way to see it but to
 * save and look.
 *
 * THE RULE THAT FALLS OUT: nothing here may be the only place a rule is
 * enforced. If this file drifts from the server's, the failure has to be a
 * warning that did not appear — never a keyword that got through.
 *
 * It lives in `utils/` rather than beside the editor because two components
 * need it (the editor, to flag rows; the wizard, to refuse a step) and because
 * a module exporting both a component and helpers breaks Fast Refresh.
 */

/**
 * The operator prefixes the provider charges extra for.
 *
 * Each one multiplies that keyword's price by FIVE, and they stack. That is why
 * the server refuses them outright rather than warning — and why they are worth
 * surfacing here too: a hundred pasted keywords with one `site:` in the middle
 * is a save that fails with a sentence about a keyword the person then has to
 * go and find in a list of a hundred.
 *
 * A copy of the server's list, deliberately used only to warn. See the header.
 */
export const OPERATOR_HINTS = [
  'site:',
  'intitle:',
  'inurl:',
  'intext:',
  'inanchor:',
  'filetype:',
  'related:',
  'cache:',
  'allintitle:',
  'allinurl:',
  'allintext:',
];

/**
 * One keyword, normalised the way the server normalises it.
 *
 * Whitespace collapsed, trimmed, lowercased. Google is case-insensitive, so
 * "Best CRM" and "best crm" are ONE keyword — and a preview that showed them as
 * two would be claiming a bill twice the size of the real one.
 *
 * @param {any} value
 * @returns {string}
 */
export const normaliseKeyword = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Split a paste into keywords.
 *
 * Newlines, commas AND tabs all separate, because the three places people paste
 * from are a text file, a spreadsheet column and a CSV. A splitter that only
 * knew newlines would read a whole CSV row as one keyword two hundred
 * characters long — which the server then refuses for length, with a sentence
 * about a keyword nobody typed.
 *
 * @param {any} text
 * @returns {string[]}
 */
export const splitKeywordText = (text) =>
  String(text || '')
    .split(/[\r\n,\t]+/)
    .map(normaliseKeyword)
    .filter(Boolean);

/**
 * The operators inside one keyword.
 *
 * @param {any} keyword
 * @returns {string[]}
 */
export const operatorsIn = (keyword) =>
  OPERATOR_HINTS.filter((op) => String(keyword || '').includes(op));

/**
 * The keywords in a list that carry an operator.
 *
 * Used by the wizard to refuse a step rather than only to warn: we already know
 * the server will reject these, and letting somebody complete two more steps
 * before finding that out is a worse version of the same answer.
 *
 * @param {string[]} keywords
 * @returns {string[]}
 */
export const keywordsWithOperators = (keywords) =>
  (Array.isArray(keywords) ? keywords : []).filter((k) => operatorsIn(k).length > 0);

/**
 * Merge a paste into an existing list, and say what happened.
 *
 * ---- Why the report is part of the return ----------------------------------
 *
 * BECAUSE ADDING IS LOSSY, and silence about that is exactly what made the old
 * textarea's count untrustworthy. "38 added, 6 already there" is the difference
 * between believing the number and going back to re-count a spreadsheet.
 *
 * @param {string[]} existing
 * @param {any} text
 * @returns {{keywords: string[], added: number, duplicate: number}}
 */
export const mergeKeywords = (existing, text) => {
  const current = Array.isArray(existing) ? existing : [];
  const incoming = splitKeywordText(text);

  const seen = new Set(current);
  const added = [];
  let duplicate = 0;

  for (const keyword of incoming) {
    if (seen.has(keyword)) {
      duplicate += 1;
      continue;
    }
    seen.add(keyword);
    added.push(keyword);
  }

  return { keywords: [...current, ...added], added: added.length, duplicate };
};
