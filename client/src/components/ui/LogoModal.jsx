import Modal from './Modal';
import LogoUploader from './LogoUploader';

/**
 * LogoModal — the uploader in a dialog, with a live preview of where the logo
 * will actually appear.
 *
 * Opened from places that have no settings form of their own to host an
 * uploader: a group's header, a board's heading. The `preview` render prop
 * draws the real surface (a mock header row, a heading) with the current logo,
 * so the question "does this look right THERE" is answered before closing.
 */
const LogoModal = ({
  isOpen,
  onClose,
  title = 'Logo',
  description = '',
  value = '',
  name = '',
  color,
  onUpload,
  onRemove,
  preview,
}) => (
  <Modal isOpen={isOpen} onClose={onClose} title={title} maxWidth={460}>
    {description && (
      <p className="font-body text-[color:var(--color-text-secondary)] mb-4" style={{ fontSize: 13 }}>
        {description}
      </p>
    )}
    <LogoUploader value={value} name={name} color={color} onUpload={onUpload} onRemove={onRemove} />
    {preview && (
      <div className="mt-5">
        <p
          className="font-body uppercase text-[color:var(--color-text-muted)] mb-2"
          style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em' }}
        >
          Preview
        </p>
        <div
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--color-bg-page, var(--color-bg-subtle))',
            padding: 12,
          }}
        >
          {preview(value)}
        </div>
      </div>
    )}
  </Modal>
);

export default LogoModal;
