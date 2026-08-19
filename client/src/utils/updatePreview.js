/**
 * Short preview of the update a reply answers.
 *
 * Used in two places that must agree — the composer's "Replying to" banner and
 * the reference rendered on a posted reply — so it lives here rather than in
 * either component.
 *
 * Returns { kind: 'text' | 'file' | 'empty', label }: the text body when there
 * is one, otherwise the attachment name, so a file-only update is still
 * identifiable instead of showing as a blank reference.
 */
export const replyPreview = (parent) => {
  const text = (parent?.bodyText || '').trim();
  if (text) {
    return {
      kind: 'text',
      label: text.length > 60 ? text.slice(0, 60).trimEnd() + '…' : text,
    };
  }
  const attachments = Array.isArray(parent?.attachments) ? parent.attachments : [];
  if (attachments.length > 0) {
    const extra = attachments.length > 1 ? ` +${attachments.length - 1}` : '';
    return { kind: 'file', label: (attachments[0].name || 'attachment') + extra };
  }
  return { kind: 'empty', label: '' };
};
