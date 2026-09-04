import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Mention from '@tiptap/extension-mention';
import { DriveChip, driveChipify } from './driveChipExtension';

/**
 * Read-only renderer for a TipTap doc. Uses `useEditor` in editable:false
 * mode — that way mentions, task lists, and other custom nodes render with
 * the same plugins the composer uses, without pulling in @tiptap/html.
 *
 * WHY THIS IS ITS OWN FILE, and must stay one: it lived inside `UpdatesTab.jsx`,
 * which imports `updateService`, `taskAttachmentService`, `authStore` and
 * `toastStore` — all of which speak to the app through `services/api.js` and the
 * app's JWT. The Client Portal renders on a different auth plane entirely
 * (`portalService`, `macan_portal_token`, no app stores), so importing this
 * renderer from there used to drag the whole app-authenticated module graph into
 * a page an EXTERNAL client loads. Rendering a paragraph of rich text must not
 * require any of that. `UpdatesTab` re-exports the name, so every existing
 * importer is unaffected.
 *
 * ---- WHAT THE EXTRACTION DOES NOT BUY, and where the remaining edge is ------
 *
 * It severs the DIRECT imports. It does not make the subtree app-free, and it
 * is worth being exact about that, because the claim above reads stronger than
 * it is:
 *
 *     ReadOnlyRichBody → driveChipExtension → DriveLinkChip
 *                      → services/linkPreviewService → services/api.js
 *
 * `DriveLinkChip` fetches a Drive document's title on mount. On the portal that
 * is an app-authenticated call from an external client's browser, and
 * `api.js`'s 401 handler deletes `macan_token` — signing a team member out of
 * Macan in another tab, which is precisely the failure this file was extracted
 * to avoid, arriving one edge further down.
 *
 * `getLinkTitle` therefore returns null when there is no app token, and the
 * comment there explains why. If another app-authenticated call is ever added
 * anywhere under this component, it needs the same guard: the boundary is the
 * whole subtree, not this file.
 */
const ReadOnlyRichBody = ({ body, fallbackText }) => {
  // Google Drive/Docs links are swapped for icon+title chips at display time —
  // both stored updates (URL as plain text) and new ones render the same way.
  const content = driveChipify(
    body ||
      (fallbackText
        ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: fallbackText }] }] }
        : '')
  );

  const editor = useEditor(
    {
      editable: false,
      content,
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Mention.configure({
          HTMLAttributes: { class: 'macan-mention' },
          renderText: ({ node }) => `@${node.attrs.label || node.attrs.id}`,
        }),
        DriveChip,
      ],
    },
    [body, fallbackText]
  );

  if (!editor) return null;

  return (
    <div className="macan-rich-readonly">
      <EditorContent editor={editor} />
      <style>{`
        .macan-rich-readonly .ProseMirror {
          outline: none;
          font-size: 14px;
          line-height: 1.55;
          color: var(--color-text-primary);
        }
        .macan-rich-readonly .ProseMirror p {
          margin: 0 0 4px 0;
        }
        .macan-rich-readonly .ProseMirror p:last-child { margin-bottom: 0; }
        .macan-rich-readonly .ProseMirror h1 { font-size: 18px; font-weight: 700; margin: 4px 0; }
        .macan-rich-readonly .ProseMirror h2 { font-size: 16px; font-weight: 700; margin: 4px 0; }
        .macan-rich-readonly .ProseMirror h3 { font-size: 14px; font-weight: 700; margin: 4px 0; }
        .macan-rich-readonly .ProseMirror ul,
        .macan-rich-readonly .ProseMirror ol {
          padding-left: 20px;
          margin: 4px 0;
        }
        .macan-rich-readonly .ProseMirror ul[data-type="taskList"] {
          list-style: none;
          padding-left: 0;
        }
        .macan-rich-readonly .ProseMirror ul[data-type="taskList"] li {
          display: flex;
          align-items: flex-start;
          gap: 6px;
          margin: 2px 0;
        }
        .macan-rich-readonly .ProseMirror ul[data-type="taskList"] li > label {
          flex-shrink: 0;
          margin-top: 2px;
        }
        .macan-rich-readonly .ProseMirror ul[data-type="taskList"] li > div {
          flex: 1;
        }
        .macan-rich-readonly .ProseMirror .macan-mention {
          color: var(--color-accent);
          background: var(--color-accent-light, rgba(37,99,235,0.1));
          padding: 1px 4px;
          border-radius: 4px;
          font-weight: 600;
        }
        .macan-rich-readonly .ProseMirror .drive-link-chip {
          margin: 3px 0;
          transition: background 120ms, border-color 120ms;
        }
        .macan-rich-readonly .ProseMirror .drive-link-chip:hover {
          background: var(--color-bg-subtle, #F3F4F6);
          border-color: var(--color-border-strong);
        }
      `}</style>
    </div>
  );
};

export default ReadOnlyRichBody;
