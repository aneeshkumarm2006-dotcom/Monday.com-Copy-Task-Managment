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
 * rendered as an icon + title chip. These nodes aren't authored or stored; they
 * are injected at display time by `driveChipify` so both existing updates (which
 * hold the URL as plain text) and new ones render identically.
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

  addNodeView() {
    return ReactNodeViewRenderer(ChipNodeView);
  },
});

/**
 * Transform a TipTap doc so every plain-text Google Drive URL becomes a
 * `driveChip` inline node. Text nodes are split around each URL so surrounding
 * text (and marks like bold) survive untouched. Returns a new doc; the input is
 * not mutated.
 */
export const driveChipify = (doc) => {
  if (!doc || typeof doc !== 'object') return doc;

  const transformNode = (node) => {
    if (!node || typeof node !== 'object') return node;

    // Split a text node containing one or more drive URLs (anywhere in the run,
    // not just when the whole node is a URL) into a mix of text and driveChip
    // nodes. Each match is validated with parseDriveUrl so a bare google.com URL
    // that isn't a real doc is left as ordinary text.
    if (node.type === 'text' && typeof node.text === 'string') {
      const text = node.text;
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
        if (m.index > last) out.push({ ...node, text: text.slice(last, m.index) });
        out.push({ type: 'driveChip', attrs: { href: raw } });
        last = m.index + raw.length;
      }
      if (!matched) return node;
      if (last < text.length) out.push({ ...node, text: text.slice(last) });
      return out;
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
