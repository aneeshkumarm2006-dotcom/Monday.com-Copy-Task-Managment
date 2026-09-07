import { Paperclip } from 'lucide-react';
import {
  formatBytes, attachmentKind, attachmentLabel, isImageAttachment, initialOf,
} from '../../utils/conversationFormat';

/**
 * The pieces of the Gmail and WhatsApp skins that BOTH planes draw — the
 * external client's portal and the team's board tab. See styles/conversations.css.
 *
 * They live here rather than beside either consumer for the reason the
 * stylesheet does: the point of copying an interface this closely is that a
 * client and the team member answering them are looking at the same thing. Two
 * copies of an attachment card is how one side quietly grows a file size the
 * other does not have.
 *
 * PORTAL-SAFE, AND MUST STAY SO: nothing here may import a service, a store, or
 * anything that reaches `services/api.js` — its 401 handler deletes a team
 * member's `macan_token`, and these render on a page an outside company loads.
 * lucide icons and pure formatters only.
 */

/* ---- Gmail ---------------------------------------------------------------- */

/** Gmail's sender circle. One colour for everyone, per the product's avatar
 *  doctrine — the per-person colour hash was deleted on purpose. */
export const GmAvatar = ({ url, name, className = 'gm-av' }) =>
  url
    ? <img className={className} src={url} alt="" />
    : <span className={`${className} gm-av--letter`}>{initialOf(name)}</span>;

/** The coloured square: red PDF, green image, blue doc, grey everything else. */
export const FileGlyph = ({ file }) => (
  <span className="gm-glyph" data-kind={attachmentKind(file)} aria-hidden="true">
    <Paperclip size={11} />
  </span>
);

/**
 * The chips Gmail hangs under a LIST row — the fastest way to answer "which of
 * these has the invoice in it" without opening anything. Names only: the list
 * is not a download surface, so the rows carry no URLs.
 */
export const GmailRowChips = ({ items, extra = 0 }) => {
  if (!items?.length) return null;
  return (
    <span className="gm-chips">
      {items.map((a, i) => (
        <span key={i} className="gm-chip">
          <FileGlyph file={a} />
          <span className="gm-chip-name">{a.name || 'Attachment'}</span>
        </span>
      ))}
      {extra > 0 && (
        <span className="gm-chip"><span className="gm-chip-name">+{extra} more</span></span>
      )}
    </span>
  );
};

/** Inside an open message, Gmail draws a card per file. These do have URLs. */
export const GmailAttachments = ({ items }) => {
  const arr = (Array.isArray(items) ? items : []).filter((a) => a && a.url);
  if (!arr.length) return null;
  return (
    <div className="gm-atts">
      {arr.map((a, i) => (
        <a key={i} className="gm-att" href={a.url} target="_blank" rel="noreferrer">
          {isImageAttachment(a)
            ? <img className="gm-att-thumb" src={a.url} alt="" />
            : <FileGlyph file={a} />}
          <span className="gm-att-meta">
            <span className="gm-att-name">{a.name || 'Attachment'}</span>
            <span className="gm-att-size">
              {[attachmentLabel(a), formatBytes(a.size)].filter(Boolean).join(' · ')}
            </span>
          </span>
        </a>
      ))}
    </div>
  );
};

/* ---- WhatsApp ------------------------------------------------------------- */

/**
 * WhatsApp gives a photo the whole bubble and everything else a tinted row with
 * a coloured tab. The two are genuinely different objects there, not one
 * component with a thumbnail slot, so they are two branches here.
 */
export const WhatsAppAttachments = ({ items }) => {
  const arr = (Array.isArray(items) ? items : []).filter((a) => a && a.url);
  if (!arr.length) return null;
  return (
    <>
      {arr.map((a, i) => (
        <a key={i} className="wa-att-link" href={a.url} target="_blank" rel="noreferrer">
          {isImageAttachment(a) ? (
            <img className="wa-img" src={a.url} alt={a.name || 'attachment'} />
          ) : (
            <span className="wa-doc">
              <span className="wa-doc-ico" aria-hidden="true">
                <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '-0.02em' }}>
                  {attachmentLabel(a).slice(0, 3)}
                </span>
              </span>
              <span className="wa-doc-meta">
                <span className="wa-doc-name">{a.name || 'Attachment'}</span>
                <span className="wa-doc-sub">
                  {[formatBytes(a.size), attachmentLabel(a)].filter(Boolean).join(' · ')}
                </span>
              </span>
            </span>
          )}
        </a>
      ))}
    </>
  );
};
