import { useCallback } from 'react';
import Input from '../../ui/Input';
import RichEditor from '../../board/RichEditor';
import ReadOnlyRichBody from '../../board/ReadOnlyRichBody';

/**
 * Note and Doc — the two rich-text item types, sharing one implementation.
 *
 * They differ only in intent and in how much room they get: a Note is a few
 * lines (a recovery phrase, the steps to rotate a key), a Doc is a page (a
 * runbook, an onboarding checklist). Splitting them into two components to
 * express that would be two copies of the same editor, so the height comes from
 * the registry instead and the code stays single.
 *
 * The editor is the app's existing `RichEditor`, unchanged. Worth stating why
 * that is safe: TipTap holds the document in memory and hands it back as JSON
 * through `onChange`. Nothing in it persists or transmits anything — the
 * plaintext reaches the network only if a caller sends it, and the only caller
 * here seals it first.
 */

export const RichViewer = ({ payload }) => {
  if (!payload.bodyText?.trim() && !payload.body) {
    return (
      <p className="font-body text-sm text-[color:var(--color-text-muted)] italic">
        This one is empty.
      </p>
    );
  }
  return (
    <div className="macan-vault-rich">
      <ReadOnlyRichBody body={payload.body} fallbackText={payload.bodyText} />
    </div>
  );
};

export const RichItemEditor = ({ payload, onChange, minHeight = 200, placeholder }) => {
  // `RichEditor` builds its TipTap instance once from `initialContent` and then
  // reports changes; it is deliberately uncontrolled. So this handler must merge
  // into the LATEST payload rather than close over the one it was created with,
  // or a title typed after the body would be dropped on the next keystroke.
  const handleBody = useCallback(
    ({ json, text }) => {
      onChange((prev) => ({ ...prev, body: json, bodyText: text }));
    },
    [onChange]
  );

  return (
    <div className="flex flex-col gap-4">
      <Input
        label="Title"
        value={payload.title}
        onChange={(e) => onChange((prev) => ({ ...prev, title: e.target.value }))}
        placeholder="How to rotate the production keys"
        required
        autoFocus
      />
      <div>
        <span className="block mb-2 font-body font-medium text-[color:var(--color-text-secondary)] text-xs uppercase tracking-wide">
          Content
        </span>
        <div
          style={{
            border: '1.5px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-input)',
            padding: '10px 12px',
            minHeight,
          }}
        >
          <RichEditor
            placeholder={placeholder || 'Write it down…'}
            initialContent={payload.body || payload.bodyText || ''}
            onChange={handleBody}
          />
        </div>
      </div>
    </div>
  );
};
