import { FileText, KeyRound, Paperclip, StickyNote, Table2 } from 'lucide-react';
import { CredentialEditor, CredentialViewer } from './items/CredentialItem';
import { RichItemEditor, RichViewer } from './items/RichItem';
import { SheetEditor, SheetViewer } from './items/SheetItem';
import { FileEditor, FileViewer } from './items/FileItem';

/**
 * The item-type registry — the one place that knows what kinds of thing a vault
 * can hold.
 *
 * Adding a type is this file plus one under `items/`: nothing in the tab, the
 * list, the detail panel or the store branches on `item.type`. They all look it
 * up here. The alternative — a switch in the list for the icon, another in the
 * detail for the editor, a third for the empty payload — is four places to
 * forget, and the one you forget fails silently.
 *
 * THE CONTRACT each entry provides:
 *
 *   icon, label, description  what the "+ New" menu shows
 *   blank()                   an empty payload for a new item
 *   heading(payload)          the list row's title — always the item's own title
 *   preview(payload)          the muted second line; MUST NOT return a secret
 *   Viewer({ payload, item }) the read view
 *   Editor({ payload, onChange, ... })  the edit view
 *   editorHeight              optional; only the rich types care
 *
 * `onChange` handed to an Editor is a React state setter: it accepts both a next
 * value and an updater function, and editors use whichever fits.
 *
 * THE RULE FOR `preview`: it renders in a list that is on screen the whole time
 * the vault is open, over someone's shoulder and in every screen share. So it
 * may describe an item and must never reveal one. "Username · has password" is
 * the most it may say; the username itself is already borderline, which is why
 * credentials show only the shape of what they hold.
 */

/**
 * The empty payload for each type.
 *
 * They live here rather than beside their editors so the `items/*.jsx` files
 * export components and nothing else — mixing a plain function into a component
 * module breaks React Fast Refresh for the whole file, which in practice means
 * losing an in-progress draft on every save while working on it.
 */
const BLANK = {
  credential: () => ({
    title: '',
    username: '',
    password: '',
    apiKey: '',
    url: '',
    notes: '',
  }),
  rich: () => ({ title: '', body: null, bodyText: '' }),
  sheet: () => ({ title: '', columns: ['Name', 'Value'], rows: [['', '']] }),
  file: () => ({ title: '', filename: '', mime: '', size: 0, notes: '' }),
};

/** Collapse text to a single line for a list preview. */
const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim();

const truncate = (text, max = 90) => {
  const line = oneLine(text);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export const VAULT_ITEM_TYPES = {
  credential: {
    icon: KeyRound,
    label: 'Credential',
    description: 'A login, an API key, or both',
    blank: BLANK.credential,
    heading: (p) => p.title || 'Untitled credential',
    // Names the FIELDS THAT EXIST, never their values. A list of vault rows is
    // exactly the surface a shoulder-surfer gets for free.
    preview: (p) =>
      [
        p.username && 'has username',
        p.password && 'has password',
        p.apiKey && 'has API key',
        p.url && 'has URL',
      ]
        .filter(Boolean)
        .join(' · ') || 'Empty',
    Viewer: CredentialViewer,
    Editor: CredentialEditor,
  },

  note: {
    icon: StickyNote,
    label: 'Note',
    description: 'A few lines of rich text',
    blank: BLANK.rich,
    heading: (p) => p.title || 'Untitled note',
    // A note's body is prose about a secret rather than the secret itself, so a
    // preview is genuinely useful here where it would be reckless above.
    preview: (p) => truncate(p.bodyText) || 'Empty',
    Viewer: RichViewer,
    Editor: RichItemEditor,
    editorHeight: 200,
  },

  doc: {
    icon: FileText,
    label: 'Doc',
    description: 'A full page — a runbook or a procedure',
    blank: BLANK.rich,
    heading: (p) => p.title || 'Untitled doc',
    preview: (p) => truncate(p.bodyText) || 'Empty',
    Viewer: RichViewer,
    Editor: RichItemEditor,
    editorHeight: 420,
  },

  sheet: {
    icon: Table2,
    label: 'Sheet',
    description: 'A small grid of related values',
    blank: BLANK.sheet,
    heading: (p) => p.title || 'Untitled sheet',
    preview: (p) => {
      const rows = Array.isArray(p.rows) ? p.rows.length : 0;
      const cols = Array.isArray(p.columns) ? p.columns.length : 0;
      return `${rows} row${rows === 1 ? '' : 's'} · ${cols} column${cols === 1 ? '' : 's'}`;
    },
    Viewer: SheetViewer,
    Editor: SheetEditor,
  },

  file: {
    icon: Paperclip,
    label: 'File',
    description: 'Encrypted in your browser before upload',
    blank: BLANK.file,
    heading: (p) => p.title || p.filename || 'Untitled file',
    preview: (p) => oneLine(p.filename) || 'Encrypted file',
    Viewer: FileViewer,
    Editor: FileEditor,
  },
};

/** The order the "+ New" menu offers them in — most reached-for first. */
export const VAULT_ITEM_ORDER = ['credential', 'note', 'doc', 'sheet', 'file'];

/**
 * Look up a type, with a fallback that renders rather than crashes.
 *
 * A row whose `type` this build does not know is possible in one real case: a
 * colleague on a newer deploy created it. Falling back to a labelled stub means
 * they see "unknown item" and can still delete it, instead of the whole vault
 * tab throwing on one row.
 */
export const typeMeta = (type) =>
  VAULT_ITEM_TYPES[type] || {
    icon: FileText,
    label: type || 'Unknown',
    description: '',
    blank: () => ({ title: '' }),
    heading: (p) => p?.title || 'Unknown item',
    preview: () => 'This item type is not supported in this version.',
    Viewer: () => null,
    Editor: () => null,
  };
