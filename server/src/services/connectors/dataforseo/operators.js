/**
 * Search-operator detection for tracked keywords.
 *
 * ---- Why a keyword field needs a validator at all --------------------------
 *
 * DataForSEO prices a SERP call by multipliers that STACK, and search operators
 * are the steepest of them: x5 PER OPERATOR. `depth` is x1 per additional ten
 * results, so `depth: 100` is x10. Rectangles add one base price.
 * `site:example.com` at `depth: 100` with rectangles on Live is $0.102 for ONE
 * CALL — against $0.0006 for the ordinary Standard SERP the same field would
 * otherwise buy.
 *
 * A tracked-keyword field is a textarea somebody pastes into. Two hundred
 * keywords with one `site:` prefix each, collected weekly across twenty-five
 * clients, is not a rounding error on a monthly bill — it is a different bill.
 * And nothing about the response would look wrong: the numbers come back, the
 * charts draw, and the only symptom is the invoice.
 *
 * ---- Why it REFUSES rather than warns --------------------------------------
 *
 * A cost warning in a form is read once and dismissed forever. More to the
 * point, an operator in a rank-tracking keyword is almost always a MISTAKE:
 * `site:acme.com` does not measure where acme.com ranks for anything, it lists
 * pages. The one legitimate use — an operator query somebody genuinely wants
 * tracked — is rare enough to deserve its own deliberate feature with its own
 * cost display, rather than a silent five-fold multiplier on a field designed
 * for "best crm for agencies".
 *
 * ---- The honest limits of this --------------------------------------------
 *
 * It is a text matcher, so it has false positives, and they are chosen rather
 * than accidental:
 *
 *   - `OR` and `AND` are flagged only in UPPERCASE and only as whole words, so
 *     "sword and shield" is fine and "cars OR trucks" is not. "OR real estate",
 *     meaning Oregon, IS refused. That is the correct trade in a field where the
 *     alternative is an unnoticed x5.
 *   - A leading `-`, `+` or `~` on any whitespace-separated token is flagged;
 *     one INSIDE a word is not, so "long-tail keywords" and "e-commerce" pass.
 *   - Nothing here tries to decide whether the operator would have "worked".
 *     Google's parser is not ours to reimplement, and DataForSEO bills for the
 *     attempt either way.
 *
 * The refusal always names what was found, because "invalid keyword" in front of
 * a two-hundred-line paste is not a message anybody can act on.
 */

/**
 * Operators written as a prefix and a colon.
 *
 * Google's documented set plus the ones DataForSEO's own pricing note calls out.
 * Matched case-insensitively and only where a colon follows, so "site: reliability"
 * is caught and "chennai site plan" is not.
 */
const PREFIX_OPERATORS = [
  'site',
  'inurl',
  'intitle',
  'intext',
  'inanchor',
  'allinurl',
  'allintitle',
  'allintext',
  'allinanchor',
  'filetype',
  'ext',
  'related',
  'cache',
  'link',
  'info',
  'define',
  'source',
  'loc',
  'location',
  'daterange',
  'before',
  'after',
  'imagesize',
  'inpostauthor',
  'author',
  'movie',
  'stocks',
  'weather',
  'map',
  'book',
  'around',
];

const PREFIX_RE = new RegExp(`\\b(${PREFIX_OPERATORS.join('|')})\\s*:`, 'i');

/**
 * @typedef {Object} FoundOperator
 * @property {string} operator - what to show the person, e.g. `site:` or `"`
 * @property {string} why - one clause naming what it does
 */

/**
 * Every search operator in one keyword.
 *
 * @param {string} keyword
 * @returns {FoundOperator[]} empty for an ordinary keyword
 */
const findSearchOperators = (keyword) => {
  const text = String(keyword || '');
  const found = [];
  const seen = new Set();

  const add = (operator, why) => {
    if (seen.has(operator)) return;
    seen.add(operator);
    found.push({ operator, why });
  };

  const prefix = PREFIX_RE.exec(text);
  if (prefix) add(`${prefix[1].toLowerCase()}:`, 'restricts the search rather than measuring a rank');

  if (text.includes('"')) add('"', 'forces an exact-phrase match');
  if (text.includes('*')) add('*', 'is a wildcard');
  if (text.includes('(') || text.includes(')')) add('( )', 'groups terms');
  if (text.includes('|')) add('|', 'means OR');
  if (/\bOR\b/.test(text)) add('OR', 'combines two searches');
  if (/\bAND\b/.test(text)) add('AND', 'combines two searches');
  if (/(?:^|\s)-\S/.test(text)) add('-', 'excludes a term');
  if (/(?:^|\s)\+\S/.test(text)) add('+', 'forces a term');
  if (/(?:^|\s)~\S/.test(text)) add('~', 'asks for synonyms');
  if (/\d\.\.\d/.test(text)) add('..', 'is a numeric range');

  return found;
};

/**
 * The sentence a person reads when their keyword is refused.
 *
 * Names the keyword, names every operator found, and says what it would cost —
 * because "not allowed" invites a support ticket and "each one multiplies the
 * price of that keyword by five" does not.
 *
 * @param {string} keyword
 * @param {FoundOperator[]} operators
 * @returns {string}
 */
const operatorRefusal = (keyword, operators) => {
  const names = operators.map((o) => `"${o.operator}"`).join(', ');
  const plural = operators.length > 1 ? 'Search operators' : 'A search operator';
  return (
    `${plural} in "${keyword}": ${names}. ` +
    'DataForSEO charges five times the normal price for every operator in a ' +
    'keyword, and they stack. Track the plain keyword instead.'
  );
};

/**
 * True when the keyword carries no search operator.
 * @param {string} keyword
 */
const isPlainKeyword = (keyword) => findSearchOperators(keyword).length === 0;

module.exports = {
  findSearchOperators,
  operatorRefusal,
  isPlainKeyword,
  PREFIX_OPERATORS,
};
