import { useEffect, useMemo, useState } from 'react';
import {
  FileText,
  FileSpreadsheet,
  Presentation,
  ClipboardList,
  Folder,
  File,
} from 'lucide-react';
import { parseDriveUrl } from '../../utils/driveLinks';
import { getLinkTitle } from '../../services/linkPreviewService';

/**
 * Per-type icon + Google brand colour. Keeps the chip recognisable at a glance
 * the way the Gmail/Docs attachment chips are.
 */
const TYPE_META = {
  doc: { Icon: FileText, color: '#4285F4' },
  sheet: { Icon: FileSpreadsheet, color: '#0F9D58' },
  slide: { Icon: Presentation, color: '#F4B400' },
  form: { Icon: ClipboardList, color: '#7248B9' },
  folder: { Icon: Folder, color: '#5F6368' },
  file: { Icon: File, color: '#5F6368' },
};

/**
 * DriveLinkChip — renders a Google Drive/Docs URL as an icon + title chip
 * instead of a raw link. The title is fetched lazily from the server proxy;
 * until it resolves (or if it can't be resolved for a private doc) a type
 * label like "Google Doc" is shown.
 *
 * Rendered inline (display:inline-flex) so it sits naturally within a line of
 * update text next to mentions and other words.
 */
const DriveLinkChip = ({ url }) => {
  const info = useMemo(() => parseDriveUrl(url), [url]);
  const [title, setTitle] = useState(null);

  useEffect(() => {
    if (!info) return undefined;
    let active = true;
    getLinkTitle(info.url).then((t) => {
      if (active && t) setTitle(t);
    });
    return () => {
      active = false;
    };
  }, [info]);

  // Not a drive URL after all — degrade to a plain link so nothing is lost.
  if (!info) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>
    );
  }

  const { Icon, color } = TYPE_META[info.type] || TYPE_META.file;
  const display = title || info.label;

  return (
    <a
      href={info.url}
      target="_blank"
      rel="noopener noreferrer"
      title={display}
      className="drive-link-chip"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        maxWidth: '100%',
        verticalAlign: 'middle',
        padding: '4px 10px 4px 8px',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-bg-surface, #FFFFFF)',
        textDecoration: 'none',
        color: 'var(--color-text-primary)',
        lineHeight: 1.3,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          width: 24,
          height: 24,
          borderRadius: 4,
          background: `${color}1A`, // ~10% tint of the brand colour
          color,
        }}
      >
        <Icon size={15} />
      </span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {display}
      </span>
    </a>
  );
};

export default DriveLinkChip;
