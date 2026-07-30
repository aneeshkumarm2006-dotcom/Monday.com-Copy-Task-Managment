import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, Paperclip, Send, ArrowLeft, LogOut, Loader2, CheckCircle2,
  CircleDot, MessageSquare, X, Inbox, Timer, Building2, ChevronRight,
  Bug, Sparkles, ClipboardList, HelpCircle, Star, RotateCcw, Hand,
  Search, Megaphone, ChevronDown, Clock, Mail, Code2,
  FileText, Check, AlertCircle, UploadCloud,
} from 'lucide-react';
import {
  getMyIssues, createMyIssue, uploadIssueAttachment,
  getIssueThread, postThreadMessage, reopenIssue, rateIssue,
  getPortalToken, clearPortalToken,
} from '../services/portalService';
import '../styles/portal.css';

/* ---- shared config -------------------------------------------------------- */
const BUCKETS = {
  open: { label: 'Open', color: '#B45309', icon: CircleDot },
  ongoing: { label: 'In progress', color: '#2563EB', icon: Timer },
  resolved: { label: 'Resolved', color: '#059669', icon: CheckCircle2 },
};
const TYPES = {
  meta_ads: { label: 'Meta Ads', icon: Megaphone, color: '#1877F2' },
  google_ads: { label: 'Google Ads', icon: Search, color: '#EA4335' },
  email_marketing: { label: 'Email Marketing', icon: Mail, color: '#059669' },
  website_development: { label: 'Website Development', icon: Code2, color: '#7C3AED' },
  bug: { label: 'Bug', icon: Bug, color: '#DC2626' },
  feature: { label: 'Feature request', icon: Sparkles, color: '#F59E0B' },
  requirement: { label: 'Requirement', icon: ClipboardList, color: '#2563EB' },
  question: { label: 'Question', icon: HelpCircle, color: '#0891B2' },
};
const PRIORITIES = {
  low: { label: 'Low', color: '#64748B' },
  medium: { label: 'Medium', color: '#2563EB' },
  high: { label: 'High', color: '#EA580C' },
  critical: { label: 'Urgent', color: '#DC2626' },
};

// The intake form adapts its labels + placeholders to the chosen request type,
// so picking Bug vs Requirement vs Question visibly tailors what we ask for.
const DEFAULT_FORM = {
  titleLabel: 'Title',
  titlePlaceholder: 'e.g. Login page not loading',
  detailsLabel: 'Details',
  detailsPlaceholder: "Describe what's happening, your requirement, or your question — and anything that helps us.",
};
const TYPE_FORM = {
  bug: {
    titleLabel: 'What went wrong?',
    titlePlaceholder: 'e.g. Login page shows a blank screen',
    detailsLabel: 'What happened?',
    detailsPlaceholder: 'Steps to reproduce · what you expected · what actually happened.',
  },
  feature: {
    titleLabel: 'What would you like?',
    titlePlaceholder: 'e.g. Add dark mode to the dashboard',
    detailsLabel: 'Describe the idea',
    detailsPlaceholder: 'What should it do, and what problem would it solve for you?',
  },
  requirement: {
    titleLabel: 'What do you need?',
    titlePlaceholder: 'e.g. New landing page for the spring campaign',
    detailsLabel: 'Requirement details',
    detailsPlaceholder: 'Goals · scope · references or deadlines · what "done" looks like.',
  },
  question: {
    titleLabel: 'Your question',
    titlePlaceholder: 'e.g. How do I export my report?',
    detailsLabel: 'Add any details',
    detailsPlaceholder: 'Anything that gives us context to answer well.',
  },
  meta_ads: {
    titleLabel: 'What do you need for Meta Ads?',
    titlePlaceholder: 'e.g. Launch a lead-gen campaign for the new offer',
    detailsLabel: 'Campaign details',
    detailsPlaceholder: 'Goals · budget · audience · creatives/links · start date.',
  },
  google_ads: {
    titleLabel: 'What do you need for Google Ads?',
    titlePlaceholder: 'e.g. Search campaign for our service pages',
    detailsLabel: 'Campaign details',
    detailsPlaceholder: 'Goals · budget · keywords/landing pages · target locations · start date.',
  },
  email_marketing: {
    titleLabel: 'What do you need sent?',
    titlePlaceholder: 'e.g. Monthly newsletter to our subscriber list',
    detailsLabel: 'Campaign details',
    detailsPlaceholder: 'Audience · offer/message · any copy or assets · desired send date.',
  },
  website_development: {
    titleLabel: 'What do you need built?',
    titlePlaceholder: 'e.g. New landing page for the spring launch',
    detailsLabel: 'Project details',
    detailsPlaceholder: 'Pages/features · references or examples · content status · deadline.',
  },
};

const LIST_POLL = 20000;
const THREAD_POLL = 9000;
const SEEN_KEY = 'macan_portal_seen';
const WELCOME_KEY = 'macan_portal_welcomed';

/* ---- helpers -------------------------------------------------------------- */
const formatShortDate = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return ''; }
};
const formatTime = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
};
const initialsOf = (name) => (name || '?').trim().charAt(0).toUpperCase();
const isImage = (a) =>
  (a?.mime && a.mime.startsWith('image/')) ||
  /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a?.name || '') ||
  /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(a?.url || '');

const formatBytes = (n) => {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  const mb = b / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const getSeen = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch { return {}; } };
const markSeen = (id) => {
  try {
    const s = getSeen();
    s[id] = new Date().toISOString();
    localStorage.setItem(SEEN_KEY, JSON.stringify(s));
  } catch { /* ignore quota/private-mode */ }
};
const isUnread = (issue, seen) =>
  issue.lastReplyFromTeam &&
  (!seen[issue.id] || new Date(issue.lastActivityAt) > new Date(seen[issue.id]));

/* ---- small presentational bits -------------------------------------------- */
const StatusChip = ({ label, color }) => (
  <span className="mcp-status" style={{ '--sc': color || '#64748B' }}>
    <span className="mcp-status-dot" />
    {label || 'Open'}
  </span>
);
const TypeBadge = ({ type }) => {
  const t = TYPES[type];
  if (!t) return null;
  const Icon = t.icon;
  return <span className="mcp-badge" style={{ '--bc': t.color }}><Icon size={12} /> {t.label}</span>;
};
const PriorityBadge = ({ priority }) => {
  const p = PRIORITIES[priority];
  if (!p || priority === 'medium') return null; // medium is the default — don't clutter
  return <span className="mcp-badge" style={{ '--bc': p.color }}><span className="mcp-prio-dot" /> {p.label}</span>;
};
const Avatar = ({ url, name }) =>
  url
    ? <img className="mcp-avatar" src={url} alt="" />
    : <span className="mcp-avatar-fallback">{initialsOf(name)}</span>;

/**
 * Today as `YYYY-MM-DD`, in the client's OWN timezone — the format `<input
 * type="date">` wants for `min`. Built from the local date parts rather than
 * `toISOString()`, which converts to UTC first and so hands anyone west of
 * Greenwich yesterday's date after their afternoon.
 */
const todayInputValue = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/* ---- attachments ---------------------------------------------------------- */
const MAX_FILE_BYTES = 25 * 1024 * 1024; // mirrors the server's multer limit
const MAX_FILES = 6;
let attachSeq = 0;

/**
 * Owns the files a client has picked and each file's own upload lifecycle
 * (`ready` → `uploading` → `done` | `error`). Both composers share it so a
 * picked file, its progress and — the point of all this — its confirmed
 * "Uploaded" state look and behave identically wherever you attach something.
 *
 * `context` ('request' | 'thread') travels with every upload and records where
 * the file came in. The two composers must pass different values: it is what
 * lets the original request keep showing its own screenshots and nothing else,
 * here and on the team's side.
 */
const useAttachmentTray = (context = 'thread') => {
  const [items, setItems] = useState([]);
  const [notice, setNotice] = useState('');
  const previews = useRef([]);
  // Mirror of `items` for the event handlers below, which need the latest list
  // without being re-created (and re-binding) on every keystroke.
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  // Object URLs are released only on unmount: revoking on remove would blank the
  // preview of a row that is still on screen.
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
      if (current.some(isDupe) || accepted.some(isDupe)) return; // already picked
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
        key: `att-${attachSeq}`, file, previewUrl,
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
  const remove = useCallback((key) => {
    setItems((prev) => prev.filter((it) => it.key !== key));
    setNotice('');
  }, []);
  const reset = useCallback(() => { setItems([]); setNotice(''); }, []);

  /**
   * Uploads every not-yet-stored file onto `issueId`, streaming progress into the
   * tray. Files already `done` are skipped and returned as-is, so retrying after
   * a partial failure never uploads the same screenshot twice.
   *
   * Sequential on purpose: one bar moving at a time reads far clearer than
   * several crawling together, and it stays well inside the upload rate limit.
   */
  const uploadAll = useCallback(async (issueId) => {
    const snapshot = itemsRef.current;
    const uploaded = [];
    const failures = [];
    for (const it of snapshot) {
      if (it.status === 'done' && it.attachment) { uploaded.push(it.attachment); continue; }
      patch(it.key, { status: 'uploading', progress: 0, error: '' });
      try {
        const { attachment } = await uploadIssueAttachment(
          issueId,
          it.file,
          (p) => patch(it.key, { progress: p }),
          context
        );
        patch(it.key, { status: 'done', progress: 100, attachment });
        uploaded.push(attachment);
      } catch (err) {
        const msg = err.response?.data?.error
          || (err.code === 'ECONNABORTED' ? 'Upload timed out.' : "Couldn't upload — tap to retry.");
        patch(it.key, { status: 'error', progress: 0, error: msg });
        failures.push(it.file.name);
      }
    }
    return { uploaded, failures };
  }, [patch, context]);

  return { items, notice, setNotice, addFiles, remove, reset, uploadAll };
};

/** One picked file: preview, name, size, live progress, and its final state. */
const AttachmentTray = ({ items, onRemove, locked }) => {
  if (!items.length) return null;
  return (
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
          ) : it.status !== 'uploading' && !locked ? (
            <button type="button" className="mcp-tray-x" onClick={() => onRemove(it.key)}
              aria-label={`Remove ${it.file.name}`}>
              <X size={14} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
};

/** Drop zone + browse button. `variant="inline"` renders just the button. */
const AttachControl = ({ tray, disabled, variant = 'zone' }) => {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const pick = (e) => { tray.addFiles(e.target.files); e.target.value = ''; };

  const input = (
    <input ref={inputRef} type="file" multiple style={{ display: 'none' }} onChange={pick} />
  );

  if (variant === 'inline') {
    return (
      <>
        {input}
        <button type="button" disabled={disabled} onClick={() => inputRef.current?.click()}
          className="mcp-btn mcp-btn--ghost" style={{ height: 38, fontSize: 13 }}>
          <Paperclip size={14} /> Attach
        </button>
      </>
    );
  }

  return (
    <div
      className="mcp-drop" data-over={over} data-disabled={disabled || undefined}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault(); setOver(false);
        if (!disabled) tray.addFiles(e.dataTransfer?.files);
      }}
      onClick={() => !disabled && inputRef.current?.click()}
      role="button" tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inputRef.current?.click(); } }}
    >
      {input}
      <span className="mcp-drop-ico"><UploadCloud size={18} /></span>
      <span className="mcp-drop-text">
        <b>Click to browse</b> or drop files here
        <span className="mcp-drop-hint">Screenshots, PDFs, docs — up to {MAX_FILES} files, 25MB each. You can paste a screenshot too.</span>
      </span>
    </div>
  );
};

/* ========================================================================== */
const PortalDashboardPage = () => {
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const [context, setContext] = useState({ orgName: '', companyName: '', contactName: '', categories: [] });
  const [issues, setIssues] = useState([]);
  const [filter, setFilter] = useState('all');
  const [seen, setSeen] = useState(getSeen);
  const [showWelcome, setShowWelcome] = useState(() => localStorage.getItem(WELCOME_KEY) !== '1');

  const [composerOpen, setComposerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  // Post-submit receipt: { ref, uploaded, failed }
  const [flash, setFlash] = useState(null);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest'); // newest | oldest | priority
  const [typeFilter, setTypeFilter] = useState('all');
  const [showHelp, setShowHelp] = useState(false);
  const [annDismissed, setAnnDismissed] = useState(false);

  const loadIssues = useCallback(async () => {
    try {
      const data = await getMyIssues();
      setContext(data.context || { orgName: '', companyName: '', contactName: '', categories: [] });
      setIssues(data.issues || []);
    } catch (err) {
      if (err.response?.status === 401) setExpired(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!getPortalToken()) { setExpired(true); setLoading(false); return; }
    loadIssues();
  }, [loadIssues]);

  useEffect(() => {
    if (expired || selectedId) return undefined;
    const tick = () => document.visibilityState === 'visible' && loadIssues();
    const id = setInterval(tick, LIST_POLL);
    return () => clearInterval(id);
  }, [expired, selectedId, loadIssues]);

  // The submit receipt clears itself, but a failed-upload one stays until the
  // client dismisses it — that's something they may still need to act on.
  useEffect(() => {
    if (!flash || flash.failed) return undefined;
    const t = setTimeout(() => setFlash(null), 10000);
    return () => clearTimeout(t);
  }, [flash]);

  const openIssue = (id) => { markSeen(id); setSeen(getSeen()); setSelectedId(id); };
  const dismissWelcome = () => { localStorage.setItem(WELCOME_KEY, '1'); setShowWelcome(false); };
  const logout = () => { clearPortalToken(); setExpired(true); };

  const selected = issues.find((i) => i.id === selectedId) || null;
  const counts = {
    open: issues.filter((i) => i.state === 'open').length,
    ongoing: issues.filter((i) => i.state === 'ongoing').length,
    resolved: issues.filter((i) => i.state === 'resolved').length,
  };
  const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
  const q = query.trim().toLowerCase();
  let visible = filter === 'all' ? issues : issues.filter((i) => i.state === filter);
  if (typeFilter !== 'all') visible = visible.filter((i) => i.type === typeFilter);
  if (q) visible = visible.filter((i) => `${i.name} ${i.note} ${i.ref}`.toLowerCase().includes(q));
  visible = [...visible].sort((a, b) => {
    if (sort === 'priority') return (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
    const da = new Date(a.createdAt).getTime(); const db = new Date(b.createdAt).getTime();
    return sort === 'oldest' ? da - db : db - da;
  });

  if (loading) return <DashboardSkeleton />;

  if (expired) {
    return (
      <div className="mcp mcp-page mcp-shell">
        <div className="mcp-card-lg mcp-pop" style={{ maxWidth: 420, padding: 36, textAlign: 'center' }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#eff4ff', color: '#2563eb' }}>
            <LogOut size={24} />
          </div>
          <p style={{ fontSize: 17, fontWeight: 700, margin: '0 0 8px' }}>Your session has ended</p>
          <p style={{ fontSize: 14, color: '#64748B', margin: 0, lineHeight: 1.55 }}>
            Please open your portal link again to sign back in.
          </p>
        </div>
      </div>
    );
  }

  const orgInitial = (context.orgName || 'S').trim().charAt(0).toUpperCase();
  const firstName = (context.contactName || '').trim().split(' ')[0];

  return (
    <div className="mcp mcp-page">
      <header className="mcp-topbar">
        <div className="mcp-container--wide" style={{ paddingTop: 14, paddingBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
            <span className="mcp-brand-mark">{orgInitial}</span>
            <span style={{ fontSize: 15.5, fontWeight: 800, letterSpacing: '-0.02em' }}>
              {context.orgName || 'Support portal'}
            </span>
          </div>
          <button type="button" onClick={logout} className="mcp-linkbtn"><LogOut size={15} /> Sign out</button>
        </div>
      </header>

      <main className="mcp-container--wide" style={{ paddingTop: 30 }}>
        {selected ? (
          <div style={{ maxWidth: 860, margin: '0 auto' }}>
            <IssueDetail
              key={selected.id}
              issue={selected}
              orgName={context.orgName}
              onBack={() => { setSelectedId(null); loadIssues(); }}
            />
          </div>
        ) : (
          <div className="mcp-rise">
            {/* Greeting */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, marginBottom: 22, flexWrap: 'wrap' }}>
              <div>
                <h1 className="mcp-greet-name">{firstName ? `Welcome back, ${firstName}` : 'Welcome back'}</h1>
                <p className="mcp-greet-sub" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span>Here's everything you've raised with {context.orgName || 'us'}.</span>
                  {context.companyName && <span className="mcp-company"><Building2 size={13} /> {context.companyName}</span>}
                </p>
              </div>
              <button type="button" className="mcp-btn mcp-btn--primary" onClick={() => setComposerOpen(true)}>
                <Plus size={16} /> Raise a request
              </button>
            </div>

            {/* Submit receipt — the client's confirmation that the request AND
                their files actually landed. */}
            {flash && (
              <div className={`mcp-flash mcp-pop ${flash.failed ? 'mcp-flash--warn' : ''}`}>
                <span className="mcp-flash-ico">
                  {flash.failed ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="mcp-flash-title">
                    {flash.failed ? 'Request submitted — some files missing' : 'Request submitted'}
                    {flash.ref ? ` · ${flash.ref}` : ''}
                  </div>
                  <div className="mcp-flash-sub">
                    {flash.uploaded > 0 && <><Paperclip size={12} /> {plural(flash.uploaded, 'file')} uploaded and attached. </>}
                    {flash.failed > 0
                      ? `${plural(flash.failed, 'file')} didn’t upload — open the request to attach ${flash.failed === 1 ? 'it' : 'them'} again.`
                      : `${context.orgName || 'The team'} has been notified and will reply here.`}
                  </div>
                </div>
                <button type="button" onClick={() => setFlash(null)} aria-label="Dismiss" className="mcp-flash-x">
                  <X size={16} />
                </button>
              </div>
            )}

            {/* Team announcement banner */}
            {context.announcement && !annDismissed && (
              <div className="mcp-card" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 16px', marginBottom: 18, background: '#FEFCE8', borderColor: '#FDE68A' }}>
                <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#FEF08A', color: '#A16207' }}>
                  <Megaphone size={16} />
                </span>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: '#713F12', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  {context.announcement}
                </div>
                <button type="button" onClick={() => setAnnDismissed(true)} aria-label="Dismiss"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#A16207', padding: 2 }}>
                  <X size={16} />
                </button>
              </div>
            )}

            {/* Welcome hero (first visit) */}
            {showWelcome && (
              <WelcomeHero
                orgName={context.orgName}
                hasIssues={issues.length > 0}
                onDismiss={dismissWelcome}
                onStart={() => { setComposerOpen(true); dismissWelcome(); }}
              />
            )}

            {/* Stat cards / filters */}
            <div className="mcp-stats">
              {['open', 'ongoing', 'resolved'].map((k) => {
                const b = BUCKETS[k]; const Icon = b.icon; const active = filter === k;
                return (
                  <button key={k} type="button" className="mcp-stat" data-active={active}
                    onClick={() => setFilter(active ? 'all' : k)} style={{ color: b.color }} aria-pressed={active}>
                    <span className="mcp-stat-ico" style={{ background: `${b.color}18`, color: b.color }}><Icon size={22} /></span>
                    <div>
                      <div className="mcp-stat-num">{counts[k]}</div>
                      <div className="mcp-stat-label">{b.label}</div>
                    </div>
                  </button>
                );
              })}
            </div>

            {composerOpen && (
              <NewIssueForm
                categories={context.categories}
                onClose={() => setComposerOpen(false)}
                onCreated={(receipt) => {
                  setComposerOpen(false);
                  setFlash({ ref: '', uploaded: 0, failed: 0, ...(receipt || {}) });
                  loadIssues();
                }}
              />
            )}

            {issues.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 }}>
                <h2 style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', margin: 0, color: '#334155' }}>
                  {filter === 'all' ? 'All requests' : BUCKETS[filter].label}
                  <span style={{ color: '#94A3B8', fontWeight: 600 }}> · {visible.length}</span>
                </h2>
                {filter !== 'all' && <button type="button" className="mcp-linkbtn" onClick={() => setFilter('all')}>Show all</button>}
              </div>
            )}

            {/* Search / type filter / sort toolbar */}
            {issues.length > 0 && (
              <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
                <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
                  <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94A3B8' }} />
                  <input className="mcp-field" style={{ paddingLeft: 34 }} placeholder="Search requests…"
                    value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <select className="mcp-field" style={{ width: 'auto', cursor: 'pointer' }} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                  <option value="all">All types</option>
                  {Object.entries(TYPES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
                </select>
                <select className="mcp-field" style={{ width: 'auto', cursor: 'pointer' }} value={sort} onChange={(e) => setSort(e.target.value)}>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="priority">By priority</option>
                </select>
              </div>
            )}

            {issues.length === 0 && !composerOpen ? (
              <div className="mcp-card-lg" style={{ padding: '48px 32px', textAlign: 'center' }}>
                <div style={{ width: 60, height: 60, borderRadius: 16, margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#eff4ff', color: '#2563eb' }}>
                  <Inbox size={28} />
                </div>
                <p style={{ fontSize: 16, fontWeight: 700, margin: '0 0 5px' }}>No requests yet</p>
                <p style={{ fontSize: 13.5, color: '#64748B', margin: '0 0 20px', lineHeight: 1.5 }}>
                  Raise your first request and the team will get straight on it.
                </p>
                <button type="button" className="mcp-btn mcp-btn--primary" onClick={() => setComposerOpen(true)} style={{ margin: '0 auto' }}>
                  <Plus size={16} /> Raise a request
                </button>
              </div>
            ) : visible.length === 0 ? (
              <div className="mcp-card" style={{ padding: '32px', textAlign: 'center', color: '#64748B', fontSize: 13.5 }}>
                Nothing here right now.
              </div>
            ) : (
              <div className="mcp-cards">
                {visible.map((issue, i) => (
                  <button key={issue.id} type="button" onClick={() => openIssue(issue.id)}
                    className="mcp-tcard mcp-rise"
                    style={{ '--sc': issue.statusColor || '#cbd5e1', animationDelay: `${Math.min(i, 8) * 45}ms` }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <StatusChip label={issue.statusLabel} color={issue.statusColor} />
                      {isUnread(issue, seen) && <span className="mcp-new"><span className="mcp-new-dot" /> New reply</span>}
                    </div>

                    <div className="mcp-tcard-title">{issue.name}</div>
                    {issue.note && <div className="mcp-tcard-note">{issue.note}</div>}

                    <div style={{ flex: 1 }} />

                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginTop: 12 }}>
                      <TypeBadge type={issue.type} />
                      <PriorityBadge priority={issue.priority} />
                      {issue.category && <span className="mcp-tag">{issue.category}</span>}
                      {issue.attachmentCount > 0 && (
                        <span className="mcp-badge" style={{ '--bc': '#475569' }}>
                          <Paperclip size={12} /> {plural(issue.attachmentCount, 'file')}
                        </span>
                      )}
                      {issue.dueDate && (
                        <span className="mcp-badge" style={{ '--bc': '#0891B2' }}>
                          <Clock size={12} /> Needed by {formatShortDate(issue.dueDate)}
                        </span>
                      )}
                    </div>

                    <div className="mcp-tcard-foot">
                      <span>
                        {issue.ref && <span style={{ fontWeight: 700, color: '#64748B' }}>{issue.ref}</span>}
                        {issue.ref && ' · '}Raised {formatShortDate(issue.createdAt)}
                      </span>
                      <ChevronRight size={16} className="mcp-item-chev" />
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Help & FAQs (knowledge base) */}
            {Array.isArray(context.faqs) && context.faqs.length > 0 && (
              <div className="mcp-card-lg" style={{ marginTop: 22, overflow: 'hidden' }}>
                <button type="button" onClick={() => setShowHelp((v) => !v)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', background: 'none', border: 'none', cursor: 'pointer', font: 'inherit' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 700 }}>
                    <HelpCircle size={17} color="#2563eb" /> Help &amp; FAQs
                  </span>
                  <ChevronDown size={18} style={{ color: '#94A3B8', transform: showHelp ? 'rotate(180deg)' : 'none', transition: 'transform .18s ease' }} />
                </button>
                {showHelp && (
                  <div style={{ padding: '0 20px 10px' }}>
                    {context.faqs.map((f, i) => (
                      <div key={i} style={{ borderTop: '1px solid #eef2f9', padding: '14px 0' }}>
                        {f.q && <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 5 }}>{f.q}</div>}
                        {f.a && <div style={{ fontSize: 13.5, color: '#475569', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{f.a}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

/* ---- Welcome hero --------------------------------------------------------- */
const WelcomeHero = ({ orgName, hasIssues, onDismiss, onStart }) => {
  const steps = [
    { icon: Plus, title: 'Raise a request', body: 'Describe a bug, idea, requirement, or question — attach a screenshot if it helps.' },
    { icon: Timer, title: 'We get to work', body: `The ${orgName || 'team'} picks it up and keeps the status up to date.` },
    { icon: MessageSquare, title: 'Track & chat', body: 'Follow progress and message the team on each request until it’s resolved.' },
  ];
  return (
    <div className="mcp-welcome mcp-pop">
      <button type="button" onClick={onDismiss} aria-label="Dismiss"
        style={{ position: 'absolute', top: 14, right: 14, zIndex: 2, background: 'rgba(255,255,255,0.16)', border: 'none', borderRadius: 8, width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', cursor: 'pointer' }}>
        <X size={16} />
      </button>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 620 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)', marginBottom: 8 }}>
          <Hand size={15} /> Welcome to your support portal
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', margin: '0 0 6px', color: '#fff' }}>
          One place for everything you need from {orgName || 'us'}.
        </h2>
        <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.8)', margin: 0, lineHeight: 1.55 }}>
          Raise requests, share requirements, attach files, and track every update through to done.
        </p>
      </div>
      <div className="mcp-welcome-steps">
        {steps.map(({ icon: Icon, title, body }) => (
          <div key={title} className="mcp-welcome-step">
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 9, background: 'rgba(255,255,255,0.18)', marginBottom: 9 }}>
              <Icon size={16} color="#fff" />
            </span>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: '#fff', marginBottom: 2 }}>{title}</div>
            <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.75)', lineHeight: 1.45 }}>{body}</div>
          </div>
        ))}
      </div>
      <button type="button" onClick={onStart} className="mcp-btn"
        style={{ position: 'relative', zIndex: 1, marginTop: 18, background: '#fff', color: '#2563eb' }}>
        <Plus size={16} /> {hasIssues ? 'Raise a request' : 'Raise your first request'}
      </button>
    </div>
  );
};

/* ---- Loading skeleton ----------------------------------------------------- */
const DashboardSkeleton = () => (
  <div className="mcp mcp-page">
    <header className="mcp-topbar">
      <div className="mcp-container--wide" style={{ paddingTop: 14, paddingBottom: 14, display: 'flex', alignItems: 'center', gap: 11 }}>
        <div className="mcp-skel" style={{ width: 40, height: 40, borderRadius: 11 }} />
        <div className="mcp-skel" style={{ width: 150, height: 20 }} />
      </div>
    </header>
    <main className="mcp-container--wide" style={{ paddingTop: 30 }}>
      <div className="mcp-skel" style={{ width: 240, height: 30, marginBottom: 10 }} />
      <div className="mcp-skel" style={{ width: 320, height: 16, marginBottom: 24 }} />
      <div className="mcp-stats">{[0, 1, 2].map((i) => <div key={i} className="mcp-skel" style={{ height: 96 }} />)}</div>
      <div className="mcp-cards">{[0, 1, 2].map((i) => <div key={i} className="mcp-skel" style={{ height: 158 }} />)}</div>
    </main>
  </div>
);

/* ---- New issue form ------------------------------------------------------- */
const NewIssueForm = ({ categories, onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [type, setType] = useState('');
  const [priority, setPriority] = useState('medium');
  const [dueDate, setDueDate] = useState('');
  const [category, setCategory] = useState('');
  // idle → creating → uploading → (partial | done)
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  // 'request' — these files are part of the request itself, and stay pinned to it.
  const tray = useAttachmentTray('request');
  // Set once the issue exists, so retrying a failed upload never re-creates it.
  const [created, setCreated] = useState(null);

  const failedCount = tray.items.filter((i) => i.status === 'error').length;
  const doneCount = tray.items.filter((i) => i.status === 'done').length;
  const busy = phase === 'creating' || phase === 'uploading';
  const locked = busy || phase === 'partial' || phase === 'done';

  const submit = async (e) => {
    e?.preventDefault?.();
    if (locked && phase !== 'partial') return;
    if (!name.trim()) { setError('Please describe your issue.'); return; }
    setError('');

    let issueInfo = created;
    if (!issueInfo) {
      setPhase('creating');
      try {
        const { issue } = await createMyIssue({
          name: name.trim(), note: note.trim(),
          type: type || undefined, priority,
          dueDate: dueDate || undefined,
          category: category || undefined,
        });
        issueInfo = { id: issue.id, ref: issue.ref };
        setCreated(issueInfo);
      } catch (err) {
        setError(err.response?.data?.error || 'Could not submit. Please try again.');
        setPhase('idle');
        return;
      }
    }

    if (!tray.items.length) { onCreated({ ref: issueInfo.ref, uploaded: 0 }); return; }

    setPhase('uploading');
    const { uploaded, failures } = await tray.uploadAll(issueInfo.id);
    if (failures.length) { setPhase('partial'); return; }

    // Hold for a beat so the green "Uploaded" ticks are actually seen — the
    // whole point is that the client knows their files landed.
    setPhase('done');
    setTimeout(() => onCreated({ ref: issueInfo.ref, uploaded: uploaded.length }), 950);
  };

  const finishWithoutFailed = () =>
    onCreated({ ref: created?.ref, uploaded: doneCount, failed: failedCount });

  const label = { fontSize: 12.5, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 7 };
  const f = TYPE_FORM[type] || DEFAULT_FORM;

  return (
    <form onSubmit={submit} className="mcp-card-lg mcp-pop" style={{ padding: 22, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>Raise a new request</span>
        {/* Once the request exists, closing must still refresh the list and show
            the receipt — otherwise it looks like nothing was submitted. */}
        <button type="button" onClick={created ? finishWithoutFailed : onClose} disabled={busy}
          className="mcp-linkbtn" style={{ padding: 4 }} aria-label="Close"><X size={18} /></button>
      </div>

      {/* Type */}
      <label style={label}>What kind of request is this?</label>
      <div className="mcp-seg" style={{ marginBottom: 16 }}>
        {Object.entries(TYPES).map(([k, t]) => {
          const Icon = t.icon; const on = type === k;
          return (
            <button key={k} type="button" className="mcp-seg-btn" data-on={on} disabled={locked}
              onClick={() => setType(on ? '' : k)}
              style={on ? { color: t.color, borderColor: t.color, background: `${t.color}12`, boxShadow: `0 0 0 4px ${t.color}22` } : undefined}>
              <Icon size={15} /> {t.label}
            </button>
          );
        })}
      </div>

      <label style={label}>{f.titleLabel}</label>
      <input className="mcp-field" style={{ marginBottom: 16 }} placeholder={f.titlePlaceholder} disabled={locked}
        value={name} onChange={(e) => setName(e.target.value)} autoFocus />

      <label style={label}>{f.detailsLabel}</label>
      <textarea className="mcp-field" style={{ marginBottom: 16, minHeight: 104 }}
        placeholder={f.detailsPlaceholder} disabled={locked}
        value={note} onChange={(e) => setNote(e.target.value)}
        onPaste={(e) => {
          // Pasting a screenshot straight into the description attaches it —
          // the most common way a client shares one.
          const files = e.clipboardData?.files;
          if (files?.length) { e.preventDefault(); tray.addFiles(files); }
        }} />

      {/* Priority */}
      <label style={label}>How urgent is it?</label>
      <div className="mcp-seg" style={{ marginBottom: 16 }}>
        {Object.entries(PRIORITIES).map(([k, p]) => {
          const on = priority === k;
          return (
            <button key={k} type="button" className="mcp-seg-btn" data-on={on} disabled={locked}
              onClick={() => setPriority(k)}
              style={on ? { color: p.color, borderColor: p.color, background: `${p.color}12`, boxShadow: `0 0 0 4px ${p.color}22` } : undefined}>
              <span className="mcp-prio-dot" style={{ '--bc': p.color }} /> {p.label}
            </button>
          );
        })}
      </div>

      {/* "Needed by" can't be in the past — a deadline before the request was
          even raised is never what anyone meant, so the picker greys those days
          out rather than accepting one and quietly landing an overdue task on
          the team's board. `min` is today, read at render so a form left open
          overnight can't strand yesterday as a valid pick. */}
      <label style={label}>Needed by <span style={{ fontWeight: 400, color: '#94A3B8' }}>(optional)</span></label>
      <input type="date" className="mcp-field" style={{ marginBottom: 16, cursor: 'pointer' }} disabled={locked}
        min={todayInputValue()}
        value={dueDate} onChange={(e) => setDueDate(e.target.value)}
        onClick={(e) => { try { e.currentTarget.showPicker?.(); } catch { /* not supported / not allowed */ } }} />

      {Array.isArray(categories) && categories.length > 0 && (
        <>
          <label style={label}>Category <span style={{ fontWeight: 400, color: '#94A3B8' }}>(optional)</span></label>
          <select className="mcp-field" style={{ marginBottom: 16, cursor: 'pointer' }} disabled={locked} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Select a category</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </>
      )}

      {/* Attachments */}
      <label style={label}>
        Attachments <span style={{ fontWeight: 400, color: '#94A3B8' }}>(optional)</span>
        {tray.items.length > 0 && (
          <span style={{ fontWeight: 600, color: '#2563EB' }}> · {plural(tray.items.length, 'file')} selected</span>
        )}
      </label>
      <AttachControl tray={tray} disabled={locked} />
      {/* `busy`, not `locked`: after a partial failure the client must still be
          able to drop a stubborn file and continue. */}
      <AttachmentTray items={tray.items} onRemove={tray.remove} locked={busy} />
      {tray.notice && (
        <p className="mcp-inline-warn"><AlertCircle size={13} /> {tray.notice}</p>
      )}

      {/* Some files failed — the request itself is already saved, so never make
          the client retype it. Retry uploads the failed ones only. */}
      {phase === 'partial' && failedCount > 0 ? (
        <div className="mcp-warnbox" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 9 }}>
            <AlertCircle size={17} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>
                Request {created?.ref} was submitted{doneCount > 0 ? ` with ${plural(doneCount, 'file')}` : ''}.
              </div>
              <div style={{ lineHeight: 1.5 }}>
                {plural(failedCount, 'file')} didn’t upload. Your request is safe — you can retry the upload now, or
                continue and add the {failedCount === 1 ? 'file' : 'files'} later from inside the request.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 9, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="submit" className="mcp-btn mcp-btn--primary" style={{ height: 36, fontSize: 13 }}>
              <RotateCcw size={14} /> Retry {failedCount === 1 ? 'upload' : 'uploads'}
            </button>
            <button type="button" onClick={finishWithoutFailed} className="mcp-btn mcp-btn--ghost" style={{ height: 36, fontSize: 13 }}>
              Continue anyway
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
          {phase === 'uploading' && (
            <span className="mcp-progress-note">
              <Loader2 size={13} className="mcp-spin" /> Uploading {plural(tray.items.length, 'file')} — please keep this page open
            </span>
          )}
          <button type="submit" disabled={busy || phase === 'done'} className="mcp-btn mcp-btn--primary">
            {phase === 'creating' && <><Loader2 size={15} className="mcp-spin" /> Submitting…</>}
            {phase === 'uploading' && <><Loader2 size={15} className="mcp-spin" /> Uploading {Math.min(doneCount + 1, tray.items.length)} of {tray.items.length}…</>}
            {phase === 'done' && <><CheckCircle2 size={15} /> Submitted</>}
            {/* 'partial' with nothing left failing = the client dropped the
                problem files; the request is already saved, so just finish. */}
            {phase === 'partial' && <><Check size={15} /> Finish</>}
            {phase === 'idle' && <><Send size={14} /> Submit request</>}
          </button>
        </div>
      )}
      {error && <p style={{ fontSize: 13, color: '#DC2626', margin: '14px 0 0' }}>{error}</p>}
    </form>
  );
};

/* ---- Issue detail + thread ------------------------------------------------ */
const IssueDetail = ({ issue, orgName, onBack }) => {
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');
  const [sentAt, setSentAt] = useState(0);
  const [busy, setBusy] = useState('');
  const [hoverStar, setHoverStar] = useState(0);
  // 'thread' — files sent mid-conversation belong to their message, not to the
  // original request block above it.
  const tray = useAttachmentTray('thread');
  const scrollAnchor = useRef(null);
  const seenIds = useRef(new Set());

  const applyMessages = useCallback((incoming) => {
    setMessages(incoming.map((m) => ({ ...m, _fresh: !seenIds.current.has(m.id) })));
    incoming.forEach((m) => seenIds.current.add(m.id));
  }, []);

  const load = useCallback(async (opts = {}) => {
    try {
      const data = await getIssueThread(issue.id);
      if (data.issue) setDetail(data.issue);
      applyMessages(data.messages || []);
    } catch { /* keep what we have */ }
    finally { if (opts.initial) setLoading(false); }
  }, [issue.id, applyMessages]);

  const hasRequestBlock = !!(detail && (detail.note || (detail.attachments && detail.attachments.length)));

  useEffect(() => { load({ initial: true }); }, [load]);

  useEffect(() => {
    const tick = () => document.visibilityState === 'visible' && load();
    const id = setInterval(tick, THREAD_POLL);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  useEffect(() => {
    scrollAnchor.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const post = async (e) => {
    e?.preventDefault?.();
    if (posting) return;
    if (!text.trim() && !tray.items.length) return;
    setPosting(true);
    setPostError('');
    try {
      let attachments;
      if (tray.items.length) {
        const { uploaded, failures } = await tray.uploadAll(issue.id);
        if (failures.length) {
          // Don't send half a message: the client keeps their text and can retry
          // (already-uploaded files are reused, not uploaded again).
          setPostError(`${plural(failures.length, 'file')} couldn’t upload, so your message hasn’t been sent yet. Retry, or remove ${failures.length === 1 ? 'it' : 'them'} and send.`);
          return;
        }
        attachments = uploaded;
      }
      const { message } = await postThreadMessage(issue.id, { bodyText: text.trim(), attachments });
      seenIds.current.add(message.id);
      setMessages((m) => [...m, { ...message, _fresh: true }]);
      setText(''); tray.reset();
      setSentAt(Date.now());
      markSeen(issue.id);
    } catch (err) {
      setPostError(err.response?.data?.error || 'Couldn’t send your message. Please try again.');
    } finally { setPosting(false); }
  };

  // The "Sent" tick is a confirmation, not a permanent label — fade it out.
  useEffect(() => {
    if (!sentAt) return undefined;
    const t = setTimeout(() => setSentAt(0), 4000);
    return () => clearTimeout(t);
  }, [sentAt]);

  const doReopen = async () => {
    setBusy('reopen');
    try { await reopenIssue(issue.id); await load(); } catch { /* ignore */ }
    finally { setBusy(''); }
  };
  const doRate = async (n) => {
    setBusy('rate');
    try { await rateIssue(issue.id, n); await load(); } catch { /* ignore */ }
    finally { setBusy(''); }
  };

  const statusLabel = detail?.statusLabel ?? issue.statusLabel;
  const statusColor = detail?.statusColor ?? issue.statusColor;
  const resolved = detail ? detail.resolved : issue.resolved;
  const rating = detail?.rating || 0;

  // Every stored attachment renders with its name and size, images with a
  // thumbnail — so a client can see exactly what the team received.
  const renderAttachments = (list) => {
    const arr = (Array.isArray(list) ? list : []).filter((a) => a && a.url);
    if (!arr.length) return null;
    return (
      <div className="mcp-att-wrap">
        <span className="mcp-att-count"><Paperclip size={11} /> {plural(arr.length, 'attachment')}</span>
        {arr.map((a, i) => (
          <a key={i} href={a.url} target="_blank" rel="noreferrer" className="mcp-att-item">
            {isImage(a) && <img className="mcp-thumb" src={a.url} alt={a.name || 'attachment'} />}
            <span className="mcp-attach">
              <Paperclip size={12} />
              <span className="mcp-att-name">{a.name || 'Attachment'}</span>
              {formatBytes(a.size) && <span className="mcp-att-size">· {formatBytes(a.size)}</span>}
            </span>
          </a>
        ))}
      </div>
    );
  };

  return (
    <div className="mcp-rise">
      <button type="button" onClick={onBack} className="mcp-linkbtn" style={{ marginBottom: 14 }}>
        <ArrowLeft size={15} /> Back to my requests
      </button>

      <div className="mcp-card-lg" style={{ padding: '17px 20px', marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          {issue.ref && <div style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', marginBottom: 3 }}>{issue.ref}</div>}
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em' }}>{issue.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8, flexWrap: 'wrap' }}>
            <TypeBadge type={detail?.type ?? issue.type} />
            <PriorityBadge priority={detail?.priority ?? issue.priority} />
            {issue.dueDate && (
              <span className="mcp-badge" style={{ '--bc': '#0891B2' }}>
                <Clock size={12} /> Needed by {formatShortDate(issue.dueDate)}
              </span>
            )}
          </div>
        </div>
        <StatusChip label={statusLabel} color={statusColor} />
      </div>

      <div className="mcp-card-lg" style={{ padding: 20 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}><Loader2 size={22} color="#2563EB" className="mcp-spin" /></div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 15, marginBottom: 18 }}>
            {/* Original request */}
            {hasRequestBlock && (
              <div className="mcp-msg-row mine">
                <span className="mcp-msg-author">{detail.authorLabel || 'You'} · original request</span>
                <div className="mcp-bubble mine">
                  {detail.note}
                  {renderAttachments(detail.attachments)}
                </div>
              </div>
            )}

            {messages.map((m) => (
              m.system ? (
                <div key={m.id} className={`mcp-sys ${m._fresh ? 'mcp-rise' : ''}`}>
                  <CheckCircle2 size={13} /> {m.bodyText}
                </div>
              ) : (
                <div key={m.id} className={`mcp-msg-row ${m.mine ? 'mine' : ''} ${m._fresh ? 'mcp-rise' : ''}`}>
                  {m.mine ? (
                    <span className="mcp-msg-author">{m.authorLabel}</span>
                  ) : (
                    <div className="mcp-msg-head">
                      <Avatar url={m.authorAvatar} name={m.authorLabel} />
                      <span className="mcp-msg-author" style={{ margin: 0 }}>
                        {m.authorLabel}
                        {m.authorTeam ? <span style={{ opacity: 0.7 }}> · {m.authorTeam}</span> : null}
                      </span>
                    </div>
                  )}
                  <div className={`mcp-bubble ${m.mine ? 'mine' : 'them'}`}>
                    {m.bodyText}
                    {renderAttachments(m.attachments)}
                  </div>
                  <span className="mcp-msg-time">{formatTime(m.createdAt)}</span>
                </div>
              )
            ))}

            {!hasRequestBlock && messages.length === 0 && (
              <div style={{ textAlign: 'center', padding: '10px 0 22px' }}>
                <div style={{ width: 46, height: 46, borderRadius: 12, margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#eff4ff', color: '#2563eb' }}>
                  <MessageSquare size={22} />
                </div>
                <p style={{ fontSize: 13.5, color: '#64748B', margin: 0, lineHeight: 1.5 }}>
                  No messages yet. Add a comment and {orgName || 'the team'} will reply right here.
                </p>
              </div>
            )}
            <div ref={scrollAnchor} />
          </div>
        )}

        {/* Resolved → rate + reopen */}
        {!loading && resolved && (
          <div className="mcp-resolved-panel">
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 14, fontWeight: 700, color: '#047857' }}>
              <CheckCircle2 size={16} /> This request was resolved.
            </div>
            {rating ? (
              <div style={{ marginTop: 8, fontSize: 13, color: '#047857' }}>
                Thanks for rating us {rating}/5.
              </div>
            ) : (
              <>
                <div style={{ marginTop: 6, fontSize: 13, color: '#475569' }}>How did we do?</div>
                <div className="mcp-stars" onMouseLeave={() => setHoverStar(0)}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} type="button" className="mcp-star" data-on={n <= (hoverStar || rating)}
                      disabled={busy === 'rate'} onMouseEnter={() => setHoverStar(n)} onClick={() => doRate(n)} aria-label={`${n} star${n > 1 ? 's' : ''}`}>
                      <Star size={24} fill={n <= (hoverStar || rating) ? '#f59e0b' : 'none'} />
                    </button>
                  ))}
                </div>
              </>
            )}
            <div style={{ marginTop: 12 }}>
              <button type="button" className="mcp-btn mcp-btn--ghost" style={{ height: 36, fontSize: 13 }} disabled={busy === 'reopen'} onClick={doReopen}>
                {busy === 'reopen' ? <><Loader2 size={14} className="mcp-spin" /> Reopening…</> : <><RotateCcw size={14} /> Reopen request</>}
              </button>
            </div>
          </div>
        )}

        {/* Composer */}
        <form onSubmit={post} style={{ borderTop: '1px solid #eef2f9', paddingTop: 16 }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); tray.addFiles(e.dataTransfer?.files); }}>
          <textarea className="mcp-field" style={{ minHeight: 66, marginBottom: 12 }} placeholder="Write a message… (you can paste or drop a screenshot)"
            value={text} onChange={(e) => setText(e.target.value)} disabled={posting}
            onPaste={(e) => {
              const files = e.clipboardData?.files;
              if (files?.length) { e.preventDefault(); tray.addFiles(files); }
            }}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') post(e); }} />

          <AttachmentTray items={tray.items} onRemove={tray.remove} locked={posting} />
          {tray.notice && <p className="mcp-inline-warn"><AlertCircle size={13} /> {tray.notice}</p>}
          {postError && <p className="mcp-inline-error"><AlertCircle size={13} /> {postError}</p>}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <AttachControl tray={tray} disabled={posting} variant="inline" />
              {tray.items.length > 0 && (
                <span style={{ fontSize: 12.5, color: '#64748B' }}>{plural(tray.items.length, 'file')} ready</span>
              )}
              {!!sentAt && !tray.items.length && (
                <span className="mcp-sent-note mcp-pop"><CheckCircle2 size={13} /> Sent</span>
              )}
            </div>
            <button type="submit" disabled={posting || (!text.trim() && !tray.items.length)} className="mcp-btn mcp-btn--primary">
              {posting
                ? <><Loader2 size={14} className="mcp-spin" /> {tray.items.length ? 'Uploading & sending…' : 'Sending…'}</>
                : <><Send size={14} /> Send</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PortalDashboardPage;
