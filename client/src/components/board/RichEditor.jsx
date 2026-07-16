import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Mention from '@tiptap/extension-mention';
import { DriveChip, driveChipify, driveContentFromText } from './driveChipExtension';
import useOrgStore from '../../store/orgStore';

/**
 * Suggestion dropdown rendered while the user types `@`. Positioned via a
 * portal so it can escape any overflow:hidden ancestors. Receives `items`,
 * `command`, and a `selectedIndex` so the parent can drive keyboard nav.
 */
const MentionList = forwardRef(({ items, command }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  const selectItem = (idx) => {
    const item = items[idx];
    if (item) command({ id: item._id, label: item.name });
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowDown') {
        setSelectedIndex((i) => (i + 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === 'ArrowUp') {
        setSelectedIndex((i) =>
          (i - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1)
        );
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        selectItem(selectedIndex);
        return true;
      }
      return false;
    },
  }));

  if (!items || items.length === 0) {
    return (
      <div
        style={{
          background: '#FFFFFF',
          border: '1.5px solid var(--color-border-strong)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-lg)',
          padding: '8px 12px',
          fontSize: 12,
          color: 'var(--color-text-muted)',
        }}
      >
        No matches
      </div>
    );
  }

  return (
    <ul
      style={{
        background: '#FFFFFF',
        border: '1.5px solid var(--color-border-strong)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        listStyle: 'none',
        margin: 0,
        padding: '4px 0',
        maxHeight: 200,
        overflowY: 'auto',
        minWidth: 200,
      }}
    >
      {items.map((m, idx) => (
        <li
          key={m._id}
          onMouseDown={(e) => {
            e.preventDefault();
            selectItem(idx);
          }}
          onMouseEnter={() => setSelectedIndex(idx)}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--color-text-primary)',
            background:
              idx === selectedIndex
                ? 'var(--color-bg-subtle, #F3F4F6)'
                : 'transparent',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span>{m.name}</span>
          {m.email ? (
            <span
              style={{
                fontSize: 11,
                color: 'var(--color-text-muted)',
                marginLeft: 'auto',
              }}
            >
              {m.email}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
});
MentionList.displayName = 'MentionList';

/**
 * Portal-positioned wrapper for the mention dropdown. The TipTap suggestion
 * plugin calls `onStart/onUpdate` with client rect coords; we mirror those
 * into a fixed-position div.
 */
const PortalAnchor = ({ rect, children }) => {
  const wrapperRef = useRef(null);
  const [placement, setPlacement] = useState({ top: 0, left: 0, ready: false });

  useLayoutEffect(() => {
    if (!rect || !wrapperRef.current) return;
    const el = wrapperRef.current;
    const height = el.offsetHeight || 220;
    const width = el.offsetWidth || 280;
    const margin = 8;
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    const spaceBelow = viewportH - rect.bottom;
    const spaceAbove = rect.top;
    // Flip above the caret when the dropdown wouldn't fit below but would fit above.
    const flipAbove = spaceBelow < height + margin && spaceAbove > spaceBelow;

    const top = flipAbove
      ? Math.max(margin, rect.top - height - 4)
      : rect.bottom + 4;
    const left = Math.min(
      Math.max(margin, rect.left),
      Math.max(margin, viewportW - width - margin)
    );
    setPlacement({ top, left, ready: true });
  }, [rect]);

  if (!rect) return null;
  return createPortal(
    <div
      ref={wrapperRef}
      style={{
        position: 'fixed',
        top: placement.top,
        left: placement.left,
        zIndex: 200,
        visibility: placement.ready ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body
  );
};

/**
 * RichEditor — a TipTap-backed composer used by the Updates tab.
 *
 * Props:
 *   placeholder — placeholder string when the doc is empty
 *   onChange(state) — called on every doc change with
 *                     { json, text, mentions: [{_id, name}], isEmpty }
 *   editorRef — optional ref that receives the editor instance (for `.commands` access)
 */
const RichEditor = ({ placeholder = 'Write an update…', onChange, editorRef, initialContent = '' }) => {
  const members = useOrgStore((s) => s.members);
  // Keep the members list in a ref so the mention extension reads fresh data
  // without recreating the editor on every member-fetch.
  const membersRef = useRef(members);
  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  const [mentionState, setMentionState] = useState(null); // { items, command, rect } | null
  const componentRef = useRef(null);
  // Holds the live editor instance so the (creation-time) paste handler can
  // reach it — `editor` from useEditor isn't assigned yet inside the config.
  const selfEditorRef = useRef(null);

  const mentionSuggestion = useMemo(
    () => ({
      char: '@',
      items: ({ query }) => {
        const q = (query || '').toLowerCase();
        return (membersRef.current || [])
          .filter((m) => m.name?.toLowerCase().includes(q))
          .slice(0, 8);
      },
      render: () => {
        let component;
        return {
          onStart: (props) => {
            component = new ReactRenderer(MentionList, {
              props,
              editor: props.editor,
            });
            componentRef.current = component;
            setMentionState({
              items: props.items,
              command: props.command,
              rect: props.clientRect ? props.clientRect() : null,
              ref: component.ref,
            });
          },
          onUpdate: (props) => {
            component?.updateProps(props);
            setMentionState((prev) =>
              prev
                ? {
                    ...prev,
                    items: props.items,
                    command: props.command,
                    rect: props.clientRect ? props.clientRect() : prev.rect,
                  }
                : null
            );
          },
          onKeyDown: (props) => {
            if (props.event.key === 'Escape') {
              setMentionState(null);
              return true;
            }
            return component?.ref?.onKeyDown?.(props) || false;
          },
          onExit: () => {
            component?.destroy();
            component = null;
            componentRef.current = null;
            setMentionState(null);
          },
        };
      },
    }),
    []
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder,
        emptyEditorClass: 'macan-rich-empty',
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Mention.configure({
        HTMLAttributes: { class: 'macan-mention' },
        suggestion: mentionSuggestion,
        renderText: ({ node }) => `@${node.attrs.label || node.attrs.id}`,
      }),
      DriveChip,
    ],
    // Chipify any Drive URLs already present (e.g. editing an older update whose
    // body stored the link as plain text) so edit mode matches the feed.
    content: driveChipify(initialContent || ''),
    editorProps: {
      attributes: {
        class: 'macan-rich-content',
        'aria-label': 'Update body',
      },
      // Paste of a Google Drive link → convert to an icon+title chip on the spot.
      // Non-Drive pastes fall through to TipTap's default handling untouched.
      handlePaste: (_view, event) => {
        const text = event.clipboardData?.getData('text/plain');
        const content = driveContentFromText(text);
        const ed = selfEditorRef.current;
        if (!content || !ed) return false;
        ed.chain().focus().insertContent(content).run();
        return true;
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    selfEditorRef.current = editor;
    if (editorRef && typeof editorRef === 'object') {
      editorRef.current = editor;
    }
  }, [editor, editorRef]);

  const handleUpdate = useCallback(() => {
    if (!editor || !onChange) return;
    const json = editor.getJSON();
    const text = editor.getText();
    const mentions = [];
    const walk = (n) => {
      if (!n) return;
      if (n.type === 'mention' && n.attrs?.id) {
        mentions.push({ _id: n.attrs.id, name: n.attrs.label || '' });
      }
      if (Array.isArray(n.content)) n.content.forEach(walk);
    };
    walk(json);
    onChange({ json, text, mentions, isEmpty: editor.isEmpty });
  }, [editor, onChange]);

  useEffect(() => {
    if (!editor) return undefined;
    editor.on('update', handleUpdate);
    return () => {
      editor.off('update', handleUpdate);
    };
  }, [editor, handleUpdate]);

  return (
    <div className="macan-rich-editor">
      <EditorContent editor={editor} />
      {mentionState ? (
        <PortalAnchor rect={mentionState.rect}>
          <MentionList
            ref={mentionState.ref}
            items={mentionState.items}
            command={mentionState.command}
          />
        </PortalAnchor>
      ) : null}
      <style>{`
        .macan-rich-editor .macan-rich-content {
          min-height: 80px;
          max-height: 240px;
          overflow-y: auto;
          outline: none;
          font-size: 14px;
          line-height: 1.55;
          color: var(--color-text-primary);
          padding: 8px 10px;
          background: var(--color-bg-surface, #FFFFFF);
          border: 1.5px solid var(--color-border-strong);
          border-radius: var(--radius-md);
          transition: border-color 150ms, box-shadow 150ms;
        }
        .macan-rich-editor .macan-rich-content:focus-within,
        .macan-rich-editor .ProseMirror-focused {
          border-color: var(--color-accent);
          box-shadow: 0 0 0 3px var(--color-accent-light);
        }
        .macan-rich-editor .macan-rich-content p {
          margin: 0 0 6px 0;
        }
        .macan-rich-editor .macan-rich-content p:last-child {
          margin-bottom: 0;
        }
        .macan-rich-editor .macan-rich-content h1,
        .macan-rich-editor .macan-rich-content h2,
        .macan-rich-editor .macan-rich-content h3 {
          font-weight: 700;
          margin: 8px 0 4px;
          line-height: 1.3;
        }
        .macan-rich-editor .macan-rich-content h1 { font-size: 18px; }
        .macan-rich-editor .macan-rich-content h2 { font-size: 16px; }
        .macan-rich-editor .macan-rich-content h3 { font-size: 14px; }
        .macan-rich-editor .macan-rich-content ul,
        .macan-rich-editor .macan-rich-content ol {
          padding-left: 20px;
          margin: 4px 0;
        }
        .macan-rich-editor .macan-rich-content ul[data-type="taskList"] {
          list-style: none;
          padding-left: 0;
        }
        .macan-rich-editor .macan-rich-content ul[data-type="taskList"] li {
          display: flex;
          align-items: flex-start;
          gap: 6px;
          margin: 2px 0;
        }
        .macan-rich-editor .macan-rich-content ul[data-type="taskList"] li > label {
          flex-shrink: 0;
          margin-top: 2px;
        }
        .macan-rich-editor .macan-rich-content ul[data-type="taskList"] li > div {
          flex: 1;
        }
        .macan-rich-editor .macan-rich-content .macan-mention {
          color: var(--color-accent);
          background: var(--color-accent-light, rgba(37,99,235,0.1));
          padding: 1px 4px;
          border-radius: 4px;
          font-weight: 600;
        }
        .macan-rich-editor .macan-rich-content .drive-link-chip {
          margin: 3px 2px 3px 0;
          cursor: default;
          user-select: none;
        }
        .macan-rich-editor .macan-rich-content .macan-rich-empty::before,
        .macan-rich-editor .macan-rich-content p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: var(--color-text-muted);
          pointer-events: none;
          height: 0;
        }
        .macan-rich-editor .macan-rich-content strong { font-weight: 700; }
        .macan-rich-editor .macan-rich-content em { font-style: italic; }
        .macan-rich-editor .macan-rich-content code {
          background: var(--color-bg-subtle, #F3F4F6);
          padding: 1px 4px;
          border-radius: 4px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12px;
        }
      `}</style>
    </div>
  );
};

export default RichEditor;
