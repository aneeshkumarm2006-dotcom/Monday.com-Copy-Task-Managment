import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Paperclip, Send, Loader2, X, Check, AlertCircle, FileText,
} from 'lucide-react';
import { uploadPortalChatFile } from '../../services/portalService';

/**
 * The composer for the EXTERNAL client portal's chat and mail.
 *
 * WHY THIS EXISTS RATHER THAN `components/board/UpdateComposer`: that one
 * statically imports `useToastStore`, `useNotificationStore`, `useOrgStore` and
 * `updateService` — i.e. the whole app-authenticated module graph, including a
 * `services/api.js` whose 401 handler deletes `macan_token`. Rendering it on a
 * page an external client loads would put a team member's own session one
 * stray 401 away from being signed out in another tab. So the portal gets its
 * own, which speaks only `portalService`.
 *
 * A plain <textarea> is deliberate: it is exactly what the portal's issue
 * thread already uses, and a client writing "the logo looks squashed on mobile"
 * has no use for a toolbar. Cmd/Ctrl+Enter sends. Files upload through
 * `uploadPortalChatFile` with the same tray + progress-bar treatment the
 * request form uses, so an attachment looks and behaves identically wherever
 * the client attaches one.
 */

const MAX_FILE_BYTES = 25 * 1024 * 1024; // mirrors the server's multer limit
const MAX_FILES = 6;
export const SUBJECT_MAX = 200; // the server refuses longer; we stop it here first
let attachSeq = 0;

const formatBytes = (n) => {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  const mb = b / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const PortalComposer = ({
  channelId,
  placeholder = 'Write a message…',
  submitLabel = 'Send',
  withSubject = false,
  subjectPlaceholder = 'Subject',
  disabled = false,
  autoFocus = false,
  minHeight = 68,
  onSubmit,
  onCancel,
  cancelLabel = 'Cancel',
}) => {
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [items, setItems] = useState([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const fileInput = useRef(null);
  const previews = useRef([]);
  // Mirror of `items` for handlers that must see the latest list without being
  // rebuilt (and re-bound) on every keystroke.
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  // Object URLs are released only on unmount: revoking on remove would blank a
  // thumbnail that is still on screen mid-animation.
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const addFiles = useCallback((fileList) => {
    const picked = Array.from(fileList || []);
    if (!picked.length) return;
    const current = itemsRef.current;
    const problems = [];
    const accepted = [];
    let room = MAX_FILES - current.length;

    picked.forEach((file) => {
      const isDupe = (p) => p.file.name === file.name && p.file.size === file.size;
      if (current.some(isDupe) || accepted.some(isDupe)) return;
      if (room <= 0) { problems.push(`You can attach up to ${MAX_FILES} files at a time.`); return; }
      if (file.size > MAX_FILE_BYTES) {
        problems.push(`“${file.name}” is ${formatBytes(file.size)} — files must be under 25MB.`);
        return;
      }
      let previewUrl = '';
      if ((file.type || '').startsWith('image/')) {
        previewUrl = URL.createObjectURL(file);
        previews.current.push(previewUrl);
      }
      attachSeq += 1;
      accepted.push({
        key: `pc-${attachSeq}`, file, previewUrl,
        status: 'ready', progress: 0, error: '', attachment: null,
      });
      room -= 1;
    });

    if (accepted.length) setItems((prev) => [...prev, ...accepted]);
    setNotice(problems[0] || '');
  }, []);

  const patch = useCallback((key, changes) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...changes } : it)));
  }, []);

  /**
   * Uploads every not-yet-stored file, one at a time. Files already `done` are
   * returned as-is, so retrying after a partial failure never uploads the same
   * screenshot twice. Sequential on purpose: one bar moving reads far clearer
   * than six crawling together, and it stays inside the upload rate limit.
   */
  const uploadAll = useCallback(async () => {
    const uploaded = [];
    const failures = [];
    for (const it of itemsRef.current) {
      if (it.status === 'done' && it.attachment) { uploaded.push(it.attachment); continue; }
      patch(it.key, { status: 'uploading', progress: 0, error: '' });
      try {
        const { attachment } = await uploadPortalChatFile(
          channelId,
          it.file,
          (p) => patch(it.key, { progress: p })
        );
        patch(it.key, { status: 'done', progress: 100, attachment });
        uploaded.push(attachment);
      } catch (err) {
        const msg = err.response?.data?.error
          || (err.code === 'ECONNABORTED' ? 'Upload timed out.' : "Couldn't upload — tap send to retry.");
        patch(it.key, { status: 'error', progress: 0, error: msg });
        failures.push(it.file.name);
      }
    }
    return { uploaded, failures };
  }, [channelId, patch]);

  const subjectValue = subject.trim();
  const bodyValue = text.trim();
  const canSend = !busy && !disabled
    && (withSubject ? !!subjectValue : true)
    && (!!bodyValue || items.length > 0);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (busy || disabled) return;
    if (withSubject && !subjectValue) { setError('Please add a subject.'); return; }
    if (!bodyValue && !items.length) return;

    setBusy(true);
    setError('');
    try {
      let attachments;
      if (items.length) {
        const { uploaded, failures } = await uploadAll();
        if (failures.length) {
          // Never send half a message: the text is kept and the already-stored
          // files are reused on retry.
          setError(`${plural(failures.length, 'file')} couldn’t upload, so nothing has been sent yet. Try again, or remove ${failures.length === 1 ? 'it' : 'them'}.`);
          return;
        }
        attachments = uploaded;
      }
      await onSubmit({
        subject: withSubject ? subjectValue.slice(0, SUBJECT_MAX) : undefined,
        bodyText: bodyValue,
        attachments,
      });
      setText('');
      setSubject('');
      setItems([]);
      setNotice('');
    } catch (err) {
      setError(err.response?.data?.error || 'Couldn’t send. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const catchFiles = (e) => {
    const files = e.clipboardData?.files;
    if (files?.length) { e.preventDefault(); addFiles(files); }
  };

  return (
    <form
      className="mcp-composer"
      onSubmit={submit}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (!disabled) addFiles(e.dataTransfer?.files); }}
    >
      {withSubject && (
        <div className="mcp-composer-subject">
          <input
            className="mcp-field"
            placeholder={subjectPlaceholder}
            value={subject}
            maxLength={SUBJECT_MAX}
            disabled={busy || disabled}
            autoFocus={autoFocus}
            onChange={(e) => setSubject(e.target.value)}
          />
          <span className="mcp-composer-count" data-near={subject.length > SUBJECT_MAX - 20 || undefined}>
            {subject.length}/{SUBJECT_MAX}
          </span>
        </div>
      )}

      <textarea
        className="mcp-field"
        style={{ minHeight }}
        placeholder={placeholder}
        value={text}
        disabled={busy || disabled}
        autoFocus={autoFocus && !withSubject}
        onChange={(e) => setText(e.target.value)}
        onPaste={catchFiles}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(e); }}
      />

      {items.length > 0 && (
        <div className="mcp-tray">
          {items.map((it) => (
            <div key={it.key} className="mcp-tray-item" data-status={it.status}>
              {it.previewUrl
                ? <img className="mcp-tray-thumb" src={it.previewUrl} alt="" />
                : <span className="mcp-tray-ico"><FileText size={17} /></span>}

              <div className="mcp-tray-meta">
                <div className="mcp-tray-name" title={it.file.name}>{it.file.name}</div>
                <div className="mcp-tray-sub">
                  {it.status === 'uploading' && <><Loader2 size={11} className="mcp-spin" /> Uploading… {it.progress}%</>}
                  {it.status === 'done' && <span className="mcp-tray-ok"><Check size={12} /> Uploaded</span>}
                  {it.status === 'error' && <span className="mcp-tray-bad"><AlertCircle size={12} /> {it.error}</span>}
                  {it.status === 'ready' && (formatBytes(it.file.size) || 'Ready to upload')}
                </div>
                {(it.status === 'uploading' || it.status === 'done') && (
                  <span className="mcp-bar"><i style={{ width: `${it.status === 'done' ? 100 : it.progress}%` }} /></span>
                )}
              </div>

              {it.status === 'done' ? (
                <span className="mcp-tray-check" aria-label="Uploaded"><Check size={13} /></span>
              ) : it.status !== 'uploading' ? (
                <button
                  type="button"
                  className="mcp-tray-x"
                  aria-label={`Remove ${it.file.name}`}
                  onClick={() => { setItems((p) => p.filter((x) => x.key !== it.key)); setNotice(''); }}
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {notice && <p className="mcp-inline-warn"><AlertCircle size={13} /> {notice}</p>}
      {error && <p className="mcp-inline-error"><AlertCircle size={13} /> {error}</p>}

      <div className="mcp-composer-foot">
        <div className="mcp-composer-tools">
          <input
            ref={fileInput}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          />
          <button
            type="button"
            className="mcp-btn mcp-btn--ghost"
            style={{ height: 36, fontSize: 13 }}
            disabled={busy || disabled}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip size={14} /> Attach
          </button>
          {items.length > 0 && (
            <span className="mcp-composer-hint">{plural(items.length, 'file')} ready</span>
          )}
          {!items.length && (
            <span className="mcp-composer-hint mcp-composer-hint--wide">
              Paste or drop a screenshot · ⌘/Ctrl + Enter to send
            </span>
          )}
        </div>

        <div className="mcp-composer-actions">
          {onCancel && (
            <button type="button" className="mcp-btn mcp-btn--ghost" style={{ height: 38 }}
              disabled={busy} onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          <button type="submit" className="mcp-btn mcp-btn--primary" style={{ height: 38 }} disabled={!canSend}>
            {busy
              ? <><Loader2 size={14} className="mcp-spin" /> {items.length ? 'Uploading & sending…' : 'Sending…'}</>
              : <><Send size={14} /> {submitLabel}</>}
          </button>
        </div>
      </div>
    </form>
  );
};

export default PortalComposer;
