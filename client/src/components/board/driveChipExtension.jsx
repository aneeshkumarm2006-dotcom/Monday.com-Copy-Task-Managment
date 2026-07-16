/* eslint-disable react-refresh/only-export-components */
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import DriveLinkChip from './DriveLinkChip';
import { DRIVE_URL_REGEX, parseDriveUrl } from '../../utils/driveLinks';

const ChipNodeView = ({ node }) => (
  <NodeViewWrapper as="span" style={{ display: 'inline' }}>
    <DriveLinkChip url={node.attrs.href} />
  </NodeViewWrapper>
);

/**
 * DriveChip — an inline, atomic TipTap node holding a single Google Drive URL,
 * rendered as an icon + title chip.
 *
 * Two ways it gets into a doc:
 *   1. In the read-only feed, `driveChipify` swaps plain-text URLs → chips at
 *      display time (so existing updates render the same as new ones).
 *   2. In the editable composer, a paste of a Drive URL is converted to a chip
 *      immediately (see RichEditor's handlePaste). One Backspace deletes it.
 */
export const DriveChip = Node.create({
  name: 'driveChip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      href: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-drive-chip]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'a',
      mergeAttributes(HTMLAttributes, { 'data-drive-chip': '' }),
      HTMLAttributes.href || '',
    ];
  },

  // getText() (used for the plain-text body + email fallback) should surface the
  // URL, not an empty string, since the chip is an atom with no text children.
  renderText({ node }) {
    return node.attrs.href || '';
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChipNodeView);
  },

  // A single Backspace removes the whole chip when the caret sits right after
  // it — the atom is deleted as one unit rather than needing a select-then-delete.
  addKeyboardShortcuts() {
    const removeChipBefore = () => {
      const { state } = this.editor;
      const { selection } = state;
      if (!selection.empty) return false;
      const before = selection.$from.nodeBefore;
      if (before && before.type.name === this.name) {
        const pos = selection.$from.pos;
        return this.editor.commands.deleteRange({ from: pos - before.nodeSize, to: pos });
      }
      return false;
    };
    return { Backspace: removeChipBefore };
  },
});

/**
 * Split a plain string into an array of TipTap-JSON inline nodes (text +
 * driveChip), or return null when it holds no Google Drive URL. Shared by the
 * read-only `driveChipify` and the composer's paste handler so both recognise
 * the exact same URLs.
 */
export const driveContentFromText = (text) => {
  if (typeof text !== 'string' || !text) return null;
  const re = new RegExp(DRIVE_URL_REGEX.source, 'gi');
  const out = [];
  let last = 0;
  let m;
  let matched = false;
  while ((m = re.exec(text)) !== null) {
    // Trailing punctuation (".", ")", ",") shouldn't be swallowed into the URL.
    const raw = m[0].replace(/[.,)\]]+$/, '');
    if (!parseDriveUrl(raw)) continue;
    matched = true;
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push({ type: 'driveChip', attrs: { href: raw } });
    last = m.index + raw.length;
  }
  if (!matched) return null;
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
};

/**
 * Transform a TipTap doc so every plain-text Google Drive URL becomes a
 * `driveChip` inline node. Text nodes are split around each URL so surrounding
 * text (and marks like bold) survive untouched. Existing driveChip nodes are
 * left as-is. Returns a new doc; the input is not mutated.
 */
export const driveChipify = (doc) => {
  if (!doc || typeof doc !== 'object') return doc;

  const transformNode = (node) => {
    if (!node || typeof node !== 'object') return node;

    if (node.type === 'text' && typeof node.text === 'string') {
      const parts = driveContentFromText(node.text);
      if (!parts) return node;
      // Preserve marks (bold/italic/etc.) on the text portions.
      return parts.map((p) =>
        p.type === 'text' ? { ...node, text: p.text } : p
      );
    }

    if (Array.isArray(node.content)) {
      const content = [];
      node.content.forEach((child) => {
        const result = transformNode(child);
        if (Array.isArray(result)) content.push(...result);
        else if (result) content.push(result);
      });
      return { ...node, content };
    }

    return node;
  };

  return transformNode(doc);
};
