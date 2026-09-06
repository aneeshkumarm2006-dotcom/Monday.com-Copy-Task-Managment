import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus, Paperclip, Send, ArrowLeft, LogOut, Loader2, CheckCircle2,
  CircleDot, MessageSquare, X, Inbox, Timer, Building2, ChevronRight,
  ChevronLeft, Bug, Sparkles, ClipboardList, HelpCircle, Star, RotateCcw, Hand,
  Search, Megaphone, ChevronDown, Clock, Mail, Code2,
  FileText, Check, AlertCircle, UploadCloud, RefreshCw,
} from 'lucide-react';
import {
  getMyIssues, createMyIssue, uploadIssueAttachment,
  getIssueThread, postThreadMessage, reopenIssue, rateIssue,
  getPortalToken, clearPortalToken, getLastPortalLink,
  getPortalChannels, getPortalHome,
  getPortalPreferences, updatePortalPreferences,
} from '../services/portalService';
import usePortalStream from '../hooks/usePortalStream';
import PortalChat from '../components/portal/PortalChat';
import PortalMail from '../components/portal/PortalMail';
import { PORTAL_BRAND, PORTAL_BRAND_INITIAL } from '../utils/portalBrand';
import { dateInputToISO } from '../utils/dateUtils';
import '../styles/portal.css';
import { streamsOfMode } from '../utils/portalChatRows';
import PortalServiceTable from '../components/portal/PortalServiceTable';

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
// EVERY one of these buckets is keyed per contact, for the same reason: one
// browser gets shared (an office machine, a laptop two people sign in on), and
// what one person has read, dismissed or last looked at is not what the next
// person has. An unscoped read-state bucket is the worst of the three — person
// A opening a request would clear person B's "New reply" dot and B would never
// know the team had answered.
const SEEN_KEY = 'macan_portal_seen';
const WELCOME_KEY = 'macan_portal_welcomed';
// Which of Tasks / Chat / Mail this contact was last on, so a client who lives
// in the mailbox doesn't land on the task list every single visit.
const TAB_KEY = 'macan_portal_tab';
// Written by PortalLandingPage before it hands over to this page, so the
// `?service=` on an invitation link survives sign-in (which is a full page
// navigation through Google, and takes the query string with it). Read exactly
// once here and removed immediately — see the effect that consumes it.
const PENDING_SERVICE_KEY = 'macan_portal_pending_service';

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

// Every bucket below is `{ [contactKey]: value }`. `who` is empty until we know
// which contact this is, and writing under an empty key would put one person's
// state where the next person picks it up — so an empty key reads as nothing and
// writes nothing.
const readBucket = (key, who) => {
  if (!who) return null;
  try { return JSON.parse(localStorage.getItem(key) || '{}')[who] ?? null; }
  catch { return null; }
};
const writeBucket = (key, who, value) => {
  if (!who) return;
  try {
    const all = JSON.parse(localStorage.getItem(key) || '{}');
    all[who] = value;
    localStorage.setItem(key, JSON.stringify(all));
  } catch { /* ignore quota/private-mode */ }
};

const getSeen = (who) => readBucket(SEEN_KEY, who) || {};
const markSeen = (who, id) => {
  if (!who || !id) return;
  const s = getSeen(who);
  s[id] = new Date().toISOString();
  writeBucket(SEEN_KEY, who, s);
};
const isUnread = (issue, seen) =>
  issue.lastReplyFromTeam &&
  (!seen[issue.id] || new Date(issue.lastActivityAt) > new Date(seen[issue.id]));

const readWelcomed = (who) => readBucket(WELCOME_KEY, who) === true;
const writeWelcomed = (who) => writeBucket(WELCOME_KEY, who, true);

const readTabPref = (who) => readBucket(TAB_KEY, who) || '';
const writeTabPref = (who, tab) => writeBucket(TAB_KEY, who, tab);


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
 * Marks an item the TEAM put on this list rather than one the client raised —
 * an ask pointed at the client ("send us the logo files"), not a ticket of
 * theirs. Without it the two are indistinguishable on the card, and a client
 * skimming their list would read the team's asks as their own open complaints
 * and wait for someone else to act on them.
 */
const FromTeamBadge = ({ orgName }) => (
  <span className="mcp-badge" style={{ '--bc': '#7C3AED' }}>
    <Building2 size={12} /> From {orgName || 'the team'}
  </span>
);

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
  // Read once: it never changes while this page is mounted, and the expired
  // screen is the only thing that reads it.
  const [lastLink] = useState(getLastPortalLink);
  const [context, setContext] = useState({ orgName: '', companyName: '', contactName: '', categories: [] });
  const [issues, setIssues] = useState([]);
  const [filter, setFilter] = useState('all');
  // Both start empty and are filled in once we know WHO this is — see the
  // effect below. Reading them before that would read a bucket that belongs to
  // whoever used this browser last.
  const [seen, setSeen] = useState({});
  const [showWelcome, setShowWelcome] = useState(false);
  // The two reads behind this screen fail independently, and a failure that
  // renders as an empty portal is worse than one that says so: the empty state
  // reads "your portal is being set up", which is a lie told to a paying
  // client whose account is fine and whose network isn't.
  const [issuesError, setIssuesError] = useState('');
  const [homeError, setHomeError] = useState('');
  // `loading` only ever tracked the issue read. The service table is fed by the
  // home read, so the skeleton has to wait for that one too or the table
  // renders its "being set up" panel in the gap between the two responses.
  const [homeLoaded, setHomeLoaded] = useState(false);

  const [composerOpen, setComposerOpen] = useState(false);
  // Post-submit receipt: { ref, uploaded, failed }
  const [flash, setFlash] = useState(null);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest'); // newest | oldest | priority
  const [typeFilter, setTypeFilter] = useState('all');
  // Which of this client's workstreams (SEO, Ads, Web Development) to show.
  // The board IS the client and its groups are the service lines, so this is
  // the primary axis — the state counts below recount within it.
  /**
   * WHICH SERVICE the client is looking at (null = the service table), WHICH
   * TAB inside it, and WHICH REQUEST is open. All three live in the URL rather
   * than in `useState`.
   *
   * The service is the spine of the portal. A client company buys several
   * things — SEO, Meta Ads, Google Ads, web development — and each is run by a
   * different person on their side; one flat list made all of it look like a
   * single pile. The table picks a service, and requests, chat and mail are all
   * scoped to it from then on. `serviceId` doubles as the old `workstream`
   * filter, which is why the request list and the intake form needed no rework.
   *
   * WHY THE URL: table → service → open request is three levels deep, and as
   * plain component state it created no history entries at all. On a phone,
   * where Back is a system gesture rather than a button on the page, that threw
   * the client clean out of the portal — usually back into their email client —
   * from three screens in. In the URL, Back walks request → service → table,
   * reload lands where they were, and the `?service=` on an invitation link is
   * a bookmarkable address instead of something to strip on arrival.
   */
  const [params, setParams] = useSearchParams();
  const serviceId = params.get('service') || null;
  const tab = params.get('tab') || 'tasks';
  const selectedId = params.get('request') || null;

  /**
   * The one writer for those three. `null`/`''` removes a param, so the URL
   * only ever carries the screen you are actually on. `replace` is for
   * normalisation (consuming a deep link, dropping a service the client can no
   * longer see) — those must not become a history entry the Back button walks
   * the client back into.
   */
  const navigateTo = useCallback((changes, { replace = false } = {}) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      Object.entries(changes).forEach(([k, v]) => {
        if (v === null || v === undefined || v === '') next.delete(k);
        else next.set(k, String(v));
      });
      return next;
    }, { replace });
  }, [setParams]);

  const [home, setHome] = useState(null);
  // null until known, so the switch never renders in a guessed position.
  const [notifyEmail, setNotifyEmail] = useState(null);
  const workstream = serviceId || 'all';
  const [showHelp, setShowHelp] = useState(false);
  const [annDismissed, setAnnDismissed] = useState(false);

  /* ---- chat & mail ------------------------------------------------------ */
  // null until asked for; `{ workstreams: [] }` once we know there is nothing.
  const [channels, setChannels] = useState(null);
  const [unread, setUnread] = useState({}); // channelId -> count
  const [chatWs, setChatWs] = useState('');
  const [mailWs, setMailWs] = useState('');
  // The newest SSE frame, stamped so an identical message re-delivered still
  // re-fires the child effects. One connection for the whole page: two panes
  // each opening their own EventSource would burn two of the browser's six
  // per-origin sockets for no gain.
  const [live, setLive] = useState(null);
  const liveSeq = useRef(0);

  const loadIssues = useCallback(async () => {
    try {
      const data = await getMyIssues();
      setContext(data.context || { orgName: '', companyName: '', contactName: '', categories: [] });
      setIssues(data.issues || []);
      setIssuesError('');
    } catch (err) {
      // Only a 401 means "sign in again". Everything else — a 500, the 20s
      // axios timeout, a phone that dropped off the network — used to fall
      // through to an empty list rendered as a healthy, empty portal.
      if (err.response?.status === 401) setExpired(true);
      else setIssuesError(err.response?.data?.error || "We couldn't load your portal.");
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

  /* ---- chat & mail surfaces --------------------------------------------
   * Only ever asked for on an `advanced` portal. `context.tier` is shipped by
   * getMyIssues precisely so a basic board never makes this call at all — the
   * endpoint would 403 anyway, but a guaranteed-403 request on every load is
   * just noise in the client's network tab and ours.
   * ---------------------------------------------------------------------- */
  const loadChannels = useCallback(async () => {
    try {
      const data = await getPortalChannels();
      const fresh = {};
      (data?.workstreams || []).forEach((w) => {
        (w.surfaces || []).forEach((s) => { fresh[s.id] = s.unread || 0; });
      });
      setChannels(data || { workstreams: [] });
      setUnread(fresh);
    } catch {
      // 403 (basic tier / chat off) or a blip — either way, no tabs.
      setChannels({ workstreams: [] });
    }
  }, []);

  useEffect(() => {
    // No tier check any more: chat and mail are what a client portal IS, and
    // every service has both from the day it is created.
    if (expired) return undefined;
    loadChannels();
    const tick = () => document.visibilityState === 'visible' && loadChannels();
    const id = setInterval(tick, LIST_POLL);
    return () => clearInterval(id);
  }, [expired, loadChannels]);

  // The service table's single read. Polled on the same cadence as the issue
  // list, because the counts on it are the reason to come back to this screen.
  const loadHome = useCallback(async () => {
    try {
      setHome(await getPortalHome());
      setHomeError('');
    } catch (err) {
      if (err?.response?.status === 401) setExpired(true);
      else setHomeError(err?.response?.data?.error || "We couldn't load your services.");
    } finally {
      setHomeLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (expired) return undefined;
    loadHome();
    const tick = () => document.visibilityState === 'visible' && loadHome();
    const id = setInterval(tick, LIST_POLL);
    return () => clearInterval(id);
  }, [expired, loadHome]);

  /**
   * The invitation email deep-links straight at a service
   * (`/portal/<token>?service=<groupId>`), so somebody invited for Meta Ads
   * lands on Meta Ads rather than on a table they have to read first.
   *
   * That query string cannot ride through sign-in — Google is a full page
   * navigation off this origin and back — so PortalLandingPage stashes the id
   * in `sessionStorage` before it redirects and this reads it. Read on mount
   * and REMOVED IMMEDIATELY, before we know whether it names anything: a key
   * left behind would re-select that service on every later visit in this tab,
   * which is exactly the bug the old `replaceState` strip existed to avoid.
   *
   * `undefined` means "not read yet" and `''` means "read, nothing pending",
   * which is also what makes a second run (React's development double-mount)
   * a no-op rather than a read of an already-deleted key.
   */
  const pendingService = useRef(undefined);
  useEffect(() => {
    if (pendingService.current !== undefined) return;
    let want = '';
    try {
      want = sessionStorage.getItem(PENDING_SERVICE_KEY) || '';
      sessionStorage.removeItem(PENDING_SERVICE_KEY);
    } catch { /* private mode — no deep link, no crash */ }
    pendingService.current = want;
  }, []);

  // Applied once the roster has arrived, because a service the client cannot
  // see must not be selected. The same pass drops a `?service=` that is
  // bookmarked, stale, or simply wrong — without it the client would sit on a
  // nameless, empty service screen with no way to tell why.
  useEffect(() => {
    if (!home) return;
    const known = (id) => (home.services || []).some((x) => String(x.id) === String(id));
    const want = pendingService.current;
    if (want) {
      pendingService.current = '';
      if (known(want)) { navigateTo({ service: String(want), request: null }, { replace: true }); return; }
    }
    if (serviceId && !known(serviceId)) {
      navigateTo({ service: null, tab: null, request: null }, { replace: true });
    }
  }, [home, serviceId, navigateTo]);

  useEffect(() => {
    if (expired) return;
    getPortalPreferences()
      .then((r) => setNotifyEmail(r.notifyEmail !== false))
      // A preference we cannot read is a switch we should not show.
      .catch(() => setNotifyEmail(null));
  }, [expired]);

  const services = home?.services || [];
  const activeService = serviceId ? services.find((x) => String(x.id) === String(serviceId)) : null;
  // Either read failing leaves this screen unable to say anything true about
  // the account, so the two share one message.
  const loadError = homeError || issuesError;

  const chatStreams = useMemo(() => streamsOfMode(channels, 'chat'), [channels]);
  const mailStreams = useMemo(() => streamsOfMode(channels, 'mail'), [channels]);
  const hasChat = chatStreams.length > 0;
  const hasMail = mailStreams.length > 0;

  // Locked to the SERVICE the client picked, and to NOTHING when that service
  // has no room of this mode. The old per-tab workstream pickers are gone:
  // choosing the service already answered that question, and asking again on
  // every tab was the duplication this redesign removes.
  //
  // There is deliberately no "first stream" fallback. A service can genuinely
  // lack a surface — it was created while the portal was off, or the team
  // archived the channel — and falling back put the client in ANOTHER
  // service's room under this service's heading: they read the wrong team's
  // history and posted into the wrong team's thread with nothing on screen
  // saying so. Resolving to nothing renders the "isn't switched on yet" panel,
  // which is what that panel was written for.
  useEffect(() => {
    setChatWs(serviceId && chatStreams.some((w) => w.id === serviceId) ? serviceId : '');
  }, [chatStreams, serviceId]);
  useEffect(() => {
    setMailWs(serviceId && mailStreams.some((w) => w.id === serviceId) ? serviceId : '');
  }, [mailStreams, serviceId]);

  // The contact id when the home payload has arrived, falling back to the old
  // company|name pair until it does. That pair COLLIDES for two people with the
  // same name at one company — they share a browser bucket — which is why the
  // home endpoint carries an id at all. Empty until at least one of the two has
  // landed: an "|" key is nobody, and every bucket helper treats it as such
  // rather than parking one person's state where the next one reads it.
  const contactKey =
    home?.contact?.id
    || ((context.companyName || context.contactName)
      ? `${context.companyName || ''}|${context.contactName || ''}`
      : '');

  // Read state and the welcome hero belong to the CONTACT, not the browser, so
  // they can only be loaded once we know who is looking.
  const welcomeDismissed = useRef(false);
  useEffect(() => {
    if (!contactKey) return;
    setSeen(getSeen(contactKey));
    // Never re-show a hero this session's client has already waved away, even
    // if `contactKey` sharpens from the name pair to the real contact id.
    if (!welcomeDismissed.current) setShowWelcome(!readWelcomed(contactKey));
  }, [contactKey]);

  /**
   * Restore the remembered tab once we know which tabs actually exist.
   *
   * EXACTLY ONCE per visit, and that is the whole point of the ref. `channels` is a
   * brand-new object on every 20-second poll, so an unguarded effect re-fired
   * every 20 seconds — and anything that had put the client back on Requests
   * without writing a preference (opening a service, the "All services" button)
   * was silently undone mid-read, over and over, for anyone who had ever
   * opened Mail.
   */
  const tabRestored = useRef(false);
  useEffect(() => {
    // `homeLoaded` first: `contactKey` sharpens from the name pair to the real
    // contact id when the home payload lands, and restoring against the coarse
    // key would spend the one shot on the wrong bucket.
    if (!channels || !homeLoaded || !contactKey || tabRestored.current) return;
    tabRestored.current = true;
    const modes = new Set();
    (channels.workstreams || []).forEach((w) => (w.surfaces || []).forEach((s) => modes.add(s.mode)));
    const pref = readTabPref(contactKey);
    if (pref !== 'chat' && pref !== 'mail') return;
    if (!modes.has(pref)) return;
    // `replace`: restoring a remembered tab is not a place the client navigated
    // to, so Back should not walk them through it.
    if (tab === 'tasks') navigateTo({ tab: pref }, { replace: true });
  }, [channels, contactKey, homeLoaded, tab, navigateTo]);

  const selectTab = (next) => { navigateTo({ tab: next }); writeTabPref(contactKey, next); };

  const onLiveMessage = useCallback(({ channelId, message }) => {
    liveSeq.current += 1;
    setLive({ seq: liveSeq.current, channelId, message });
    // The open room clears its own badge the moment it marks read; everything
    // else gets a count immediately rather than waiting for the next poll.
    if (!message?.mine) {
      setUnread((u) => ({ ...u, [channelId]: (u[channelId] || 0) + 1 }));
    }
  }, []);

  usePortalStream(!expired && (hasChat || hasMail), onLiveMessage);

  // A tab can vanish between renders (the team turns a surface off), so what
  // actually renders is always re-checked against what exists.
  const activeTab = (tab === 'chat' && hasChat) || (tab === 'mail' && hasMail) ? tab : 'tasks';
  const activeChat = chatStreams.find((w) => w.id === chatWs) || null;
  const activeMail = mailStreams.find((w) => w.id === mailWs) || null;

  // The badges on the tab bar count THIS service's room and nothing else. The
  // tab bar only ever renders inside one service, so an account-wide total sat
  // next to that service's name claiming unread the client could not find —
  // and opening the room cleared none of it, because the messages were in a
  // different service. The service table already shows the per-service counts;
  // these two now agree with it.
  const chatUnread = activeChat ? (unread[activeChat.surface.id] || 0) : 0;
  const mailUnread = activeMail ? (unread[activeMail.surface.id] || 0) : 0;

  const setChannelUnread = useCallback((channelId, count) => {
    setUnread((u) => (u[channelId] === count ? u : { ...u, [channelId]: count }));
  }, []);
  const onChatUnread = useCallback(
    (count) => activeChat && setChannelUnread(activeChat.surface.id, count),
    [activeChat, setChannelUnread]
  );
  const onMailUnread = useCallback(
    (count) => activeMail && setChannelUnread(activeMail.surface.id, count),
    [activeMail, setChannelUnread]
  );

  const openIssue = (id) => {
    markSeen(contactKey, id);
    setSeen(getSeen(contactKey));
    navigateTo({ request: id });
  };
  const dismissWelcome = () => {
    welcomeDismissed.current = true;
    writeWelcomed(contactKey);
    setShowWelcome(false);
  };
  const logout = () => { clearPortalToken(); setExpired(true); };
  // Stable identity: IssueDetail keeps this in a ref, and a fresh arrow on
  // every render would be a fresh `load` on every render.
  const handleExpired = useCallback(() => setExpired(true), []);

  const selected = issues.find((i) => i.id === selectedId) || null;

  // The client's service lines, from the server. Empty (or one) means there is
  // nothing to choose between, and the picker/grouping stay hidden.
  const workstreams = Array.isArray(context.workstreams) ? context.workstreams : [];
  const manyWorkstreams = workstreams.length > 1;

  // Workstream is applied BEFORE the state counts, so "3 open" means three open
  // in the workstream you are looking at rather than across the whole account.
  const inWorkstream =
    workstream === 'all'
      ? issues
      : issues.filter((i) => i.workstream?.id === workstream);

  const counts = {
    open: inWorkstream.filter((i) => i.state === 'open').length,
    ongoing: inWorkstream.filter((i) => i.state === 'ongoing').length,
    resolved: inWorkstream.filter((i) => i.state === 'resolved').length,
  };
  const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
  const q = query.trim().toLowerCase();
  let visible = filter === 'all' ? inWorkstream : inWorkstream.filter((i) => i.state === filter);
  if (typeFilter !== 'all') visible = visible.filter((i) => i.type === typeFilter);
  if (q) visible = visible.filter((i) => `${i.name} ${i.note} ${i.ref}`.toLowerCase().includes(q));
  visible = [...visible].sort((a, b) => {
    if (sort === 'priority') return (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
    const da = new Date(a.createdAt).getTime(); const db = new Date(b.createdAt).getTime();
    return sort === 'oldest' ? da - db : db - da;
  });

  // Both reads, not just the issue list. Dismissing the skeleton the moment the
  // ISSUES arrived handed the service table an empty `services` array, and it
  // rendered "Your portal is being set up" — a false statement about a working
  // account — until the second response landed. `homeError` is in the condition
  // so a failed home read falls through to the error card rather than spinning
  // forever.
  if (loading || (!homeLoaded && !homeError)) return <DashboardSkeleton />;

  if (expired) {
    return (
      <div className="mcp mcp-page mcp-shell">
        <div className="mcp-card-lg mcp-pop" style={{ maxWidth: 420, padding: 36, textAlign: 'center' }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#eff4ff', color: '#2563eb' }}>
            <LogOut size={24} />
          </div>
          <p style={{ fontSize: 17, fontWeight: 700, margin: '0 0 8px' }}>Your session has ended</p>
          <p style={{ fontSize: 14, color: '#64748B', margin: 0, lineHeight: 1.55 }}>
            {lastLink
              ? 'Sign back in to pick up where you left off.'
              : 'Please open your portal link again to sign back in.'}
          </p>
          {/* The link id is remembered separately from the session token, so we
              can usually offer the way back rather than sending them to hunt
              through their email for it. */}
          {lastLink && (
            <a
              href={`/portal/${lastLink}`}
              className="mcp-btn mcp-btn--primary mcp-btn--block"
              style={{ marginTop: 20, textDecoration: 'none' }}
            >
              Sign in again
            </a>
          )}
        </div>
      </div>
    );
  }

  const firstName = (context.contactName || '').trim().split(' ')[0];

  return (
    <div className="mcp mcp-page">
      <header className="mcp-topbar">
        <div className="mcp-container--wide" style={{ paddingTop: 14, paddingBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
            <span className="mcp-brand-mark">{PORTAL_BRAND_INITIAL}</span>
            <span style={{ fontSize: 15.5, fontWeight: 800, letterSpacing: '-0.02em' }}>
              {PORTAL_BRAND}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {/* The client's own switch for notification email.
                NOT a nicety: these go out over the team's own Gmail, and a
                client who cannot turn them off marks them as spam instead — a
                complaint against the sending domain is far more expensive than
                a missed notification. */}
            {notifyEmail !== null && (
              <label
                style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--p-muted-text)', cursor: 'pointer' }}
                title="Email me when the team sends a message"
              >
                <input
                  type="checkbox"
                  checked={notifyEmail}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setNotifyEmail(next);
                    // Optimistic, and reverted on failure — a toggle that
                    // silently does nothing is worse than one that flicks back.
                    updatePortalPreferences({ notifyEmail: next }).catch(() =>
                      setNotifyEmail(!next)
                    );
                  }}
                />
                Email me about new messages
              </label>
            )}
            <button type="button" onClick={logout} className="mcp-linkbtn"><LogOut size={15} /> Sign out</button>
          </div>
        </div>
      </header>

      <main className="mcp-container--wide" style={{ paddingTop: 30 }}>
        {selected ? (
          <div style={{ maxWidth: 860, margin: '0 auto' }}>
            <IssueDetail
              key={selected.id}
              issue={selected}
              orgName={context.orgName}
              contactKey={contactKey}
              onExpired={handleExpired}
              onBack={() => { navigateTo({ request: null }); loadIssues(); }}
            />
          </div>
        ) : !serviceId ? (
          /* ------------------------------------------------------------------
             THE SERVICE TABLE — the portal's home.

             A client company buys several things and each is run by a different
             person on their side. One flat list made all of it look like a
             single pile, so the first question this screen asks is "which
             service?" — and everything after it is scoped to the answer.
             ------------------------------------------------------------------ */
          <div className="mcp-rise">
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, marginBottom: 22, flexWrap: 'wrap' }}>
              <div>
                <h1 className="mcp-greet-name">
                  {firstName ? `Welcome back, ${firstName}` : 'Welcome back'}
                </h1>
                <p className="mcp-greet-sub" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span>Here&rsquo;s where everything stands.</span>
                  {context.companyName && (
                    <span className="mcp-company"><Building2 size={13} /> {context.companyName}</span>
                  )}
                </p>
              </div>
            </div>

            {/* One announcement per account, so it belongs on the account's
                screen rather than repeated on every service. */}
            {context.announcement && !annDismissed && (
              <div className="mcp-flash" style={{ marginBottom: 18 }}>
                <span className="mcp-flash-ico"><Megaphone size={15} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="mcp-flash-sub" style={{ whiteSpace: 'pre-wrap' }}>
                    {context.announcement}
                  </div>
                </div>
                <button
                  type="button"
                  className="mcp-flash-x"
                  onClick={() => setAnnDismissed(true)}
                  aria-label="Dismiss announcement"
                >
                  <X size={14} />
                </button>
              </div>
            )}

            <h2 style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--p-muted-text)', margin: '0 0 10px' }}>
              Your services
            </h2>

            {/* A read that failed must never be dressed up as an empty account:
                the table's own empty state says the portal is being set up,
                which is the one thing a client with a live account must not be
                told because the network hiccuped. */}
            {loadError && !services.length ? (
              <div className="mcp-card mcp-card-lg" style={{ textAlign: 'center' }}>
                <p style={{ fontWeight: 700, marginBottom: 6 }}>We couldn&rsquo;t load your portal</p>
                <p className="mcp-note" style={{ margin: '0 0 14px' }}>
                  {loadError} Your requests are safe &mdash; this is a connection problem, not your account.
                </p>
                <button
                  type="button"
                  className="mcp-btn mcp-btn--primary"
                  style={{ margin: '0 auto' }}
                  onClick={() => { loadIssues(); loadHome(); loadChannels(); }}
                >
                  <RefreshCw size={15} /> Try again
                </button>
              </div>
            ) : (
              <PortalServiceTable
                services={services}
                serverTime={home?.serverTime}
                onOpen={(id, next) => {
                  // A chip is an explicit tab choice, so it is remembered the
                  // same way clicking the tab itself would be.
                  navigateTo({ service: String(id), tab: next || 'tasks', request: null });
                  writeTabPref(contactKey, next || 'tasks');
                }}
              />
            )}

            {(context.faqs || []).length > 0 && (
              <div style={{ marginTop: 26 }}>
                <button
                  type="button"
                  className="mcp-linkbtn"
                  onClick={() => setShowHelp((v) => !v)}
                >
                  {showHelp ? 'Hide' : 'Help & FAQs'}
                </button>
                {showHelp && (
                  <div className="mcp-card" style={{ marginTop: 12 }}>
                    {context.faqs.map((f, i) => (
                      <div key={f.q || i} style={{ marginBottom: 12 }}>
                        <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 3 }}>{f.q}</div>
                        <div style={{ fontSize: 13, color: 'var(--p-muted-text)', lineHeight: 1.55 }}>{f.a}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Back to the table, then the service's own three interfaces.
                Deliberately NOT routed through `selectTab`: leaving a service
                is not a statement about which tab this client prefers, and
                writing 'tasks' here would wipe the remembered mailbox of
                anyone who ever used this button. */}
            <button
              type="button"
              className="mcp-svc-back"
              onClick={() => navigateTo({ service: null, tab: null, request: null })}
            >
              <ChevronLeft size={14} /> All services
            </button>

            <h1
              className="mcp-svc-title"
              style={{ '--p-svc': activeService?.color || 'var(--p-primary)' }}
            >
              {activeService?.name || 'Service'}
            </h1>

            {/* Requests | Chat | Mail — always all three. Chat and mail exist on
                every service now, so a missing tab would read as "they don't
                offer that" rather than "nobody has set it up". */}
            <div className="mcp-seg mcp-tabs">
              {[
                { key: 'tasks', label: 'Requests', Icon: ClipboardList, count: 0, on: true },
                { key: 'chat', label: 'Chat', Icon: MessageSquare, count: chatUnread, on: true },
                { key: 'mail', label: 'Mail', Icon: Mail, count: mailUnread, on: true },
              ].filter((t) => t.on).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className="mcp-seg-btn"
                  data-on={activeTab === t.key}
                  aria-pressed={activeTab === t.key}
                  onClick={() => selectTab(t.key)}
                >
                  <t.Icon size={15} /> {t.label}
                  {t.count > 0 && <span className="mcp-tab-count">{t.count > 99 ? '99+' : t.count}</span>}
                </button>
              ))}
            </div>

            {activeTab === 'chat' && !activeChat && (
              <div className="mcp-card" style={{ textAlign: 'center' }}>
                <p style={{ fontWeight: 700, marginBottom: 6 }}>Chat isn&rsquo;t switched on yet</p>
                <p className="mcp-note" style={{ margin: 0 }}>
                  Raise a request or send a message and the team will pick it up.
                </p>
              </div>
            )}

            {activeTab === 'mail' && !activeMail && (
              <div className="mcp-card" style={{ textAlign: 'center' }}>
                <p style={{ fontWeight: 700, marginBottom: 6 }}>Mail isn&rsquo;t switched on yet</p>
                <p className="mcp-note" style={{ margin: 0 }}>
                  Raise a request or use chat and the team will pick it up.
                </p>
              </div>
            )}

            {activeTab === 'chat' && activeChat && (
              <PortalChat
                key={activeChat.surface.id}
                channel={activeChat.surface}
                onUnreadChange={onChatUnread}
                liveMessage={live}
              />
            )}

            {activeTab === 'mail' && activeMail && (
              <PortalMail
                key={activeMail.surface.id}
                channel={activeMail.surface}
                onUnreadChange={onMailUnread}
                liveMessage={live}
              />
            )}

            {activeTab === 'tasks' && (
          <div className="mcp-rise">
            {/* No greeting here any more — the SERVICE TABLE greets, and this
                screen is already headed by the service's own name. Two
                headings, one of them generic, pushed the actual work below the
                fold on a phone. */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, marginBottom: 18, flexWrap: 'wrap' }}>
              <p className="mcp-greet-sub" style={{ margin: 0 }}>
                Everything you and the team are tracking together on this service.
              </p>
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
                      : 'The team has been notified and will reply here.'}
                  </div>
                </div>
                <button type="button" onClick={() => setFlash(null)} aria-label="Dismiss" className="mcp-flash-x">
                  <X size={16} />
                </button>
              </div>
            )}

            {/* The announcement moved to the service table. It comes from the
                board, so there is exactly ONE of them — repeating it on four
                service screens is four dismissals of the same sentence. */}

            {/* Welcome hero (first visit) */}
            {showWelcome && (
              <WelcomeHero
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
                workstreams={workstreams}
                defaultWorkstream={workstream !== 'all' ? workstream : ''}
                serviceName={activeService?.name || ''}
                onClose={() => setComposerOpen(false)}
                onCreated={(receipt) => {
                  setComposerOpen(false);
                  setFlash({ ref: '', uploaded: 0, failed: 0, ...(receipt || {}) });
                  loadIssues();
                }}
              />
            )}

            {/* The workstream picker used to live here. It is gone: the SERVICE
                TABLE picks the service before this screen renders, and asking
                again — on every tab — was the duplication the redesign removes. */}

            {/* Gated on THIS SERVICE's requests, not the account's. A brand new
                service used to inherit the heading, the search box and the sort
                dropdown from requests filed under a different service — chrome
                for a list that does not exist here. */}
            {inWorkstream.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 }}>
                <h2 style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', margin: 0, color: '#334155' }}>
                  {filter === 'all' ? 'All requests' : BUCKETS[filter].label}
                  <span style={{ color: 'var(--p-muted-text)', fontWeight: 600 }}>
                    {' '}· {visible.length}
                  </span>
                </h2>
                {filter !== 'all' && (
                  <button type="button" className="mcp-linkbtn" onClick={() => setFilter('all')}>
                    Show all
                  </button>
                )}
              </div>
            )}

            {/* Search / type filter / sort toolbar */}
            {inWorkstream.length > 0 && (
              <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
                <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
                  <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94A3B8' }} />
                  <input className="mcp-field" style={{ paddingLeft: 34 }} placeholder="Search requests…"
                    value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                {/* Only for requests raised BEFORE types were dropped. New
                    ones carry none, so on a portal with no legacy rows this
                    filter would match nothing and read as broken. */}
                {inWorkstream.some((i) => i.type) && (
                  <select className="mcp-field" style={{ width: 'auto', cursor: 'pointer' }} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                    <option value="all">All types</option>
                    {Object.entries(TYPES)
                      .filter(([k]) => inWorkstream.some((i) => i.type === k))
                      .map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
                  </select>
                )}
                <select className="mcp-field" style={{ width: 'auto', cursor: 'pointer' }} value={sort} onChange={(e) => setSort(e.target.value)}>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="priority">By priority</option>
                </select>
              </div>
            )}

            {/* Also this service's count: a client with a full SEO list opening
                a brand new Google Ads service got the bare "Nothing here right
                now." card instead of the first-request onboarding, which is
                exactly the moment that onboarding is for. */}
            {inWorkstream.length === 0 && !composerOpen ? (
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
                      {issue.fromTeam && <FromTeamBadge orgName={context.orgName} />}
                      {/* Which service line this belongs to. Only worth the
                          space when the client buys more than one — otherwise
                          every card would carry the same word. */}
                      {manyWorkstreams && issue.workstream && (
                        <span className="mcp-badge" style={{ '--bc': '#7C3AED' }}>
                          {issue.workstream.name}
                        </span>
                      )}
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
                        {issue.ref && ' · '}
                        {issue.fromTeam
                          ? `Shared ${formatShortDate(issue.sharedAt || issue.createdAt)}`
                          : `Raised ${formatShortDate(issue.createdAt)}`}
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
          </>
        )}
      </main>
    </div>
  );
};

/* ---- Welcome hero --------------------------------------------------------- */
const WelcomeHero = ({ hasIssues, onDismiss, onStart }) => {
  const steps = [
    { icon: Plus, title: 'Raise a request', body: 'Describe a bug, idea, requirement, or question — attach a screenshot if it helps.' },
    { icon: Timer, title: 'The team looks into it', body: 'Someone picks it up and keeps the status up to date as it moves along.' },
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
          One place for everything you need from the team.
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
const NewIssueForm = ({
  workstreams = [],
  defaultWorkstream = '',
  serviceName = '',
  onClose,
  onCreated,
}) => {
  // Which service line this request is for. A client with exactly one
  // workstream is never asked — the answer is not in doubt, and the server
  // accepts the omission in that case too. Otherwise it is required, because
  // filing an ads request into the SEO queue means the wrong person sees it.
  const onlyWorkstream = workstreams.length === 1 ? workstreams[0].id : '';
  // No setter: the service comes from the screen this form was opened on, and
  // is not the client's to change mid-request.
  const workstream = defaultWorkstream || onlyWorkstream;
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [priority, setPriority] = useState('medium');
  const [dueDate, setDueDate] = useState('');
  // idle → creating → uploading → (partial | done)
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  // 'request' — these files are part of the request itself, and stay pinned to it.
  const tray = useAttachmentTray('request');
  // The "Submitted" beat below is a timer, and the close button stays live
  // through it. Closing the form during that beat calls `onCreated` and
  // unmounts us; an uncleared timer then called it a SECOND time with a
  // different payload — replacing the receipt banner the client was reading,
  // with different upload counts on it, and re-fetching the list behind it.
  const doneTimer = useRef(null);
  useEffect(() => () => clearTimeout(doneTimer.current), []);
  // Set once the issue exists, so retrying a failed upload never re-creates it.
  const [created, setCreated] = useState(null);

  const failedCount = tray.items.filter((i) => i.status === 'error').length;
  const doneCount = tray.items.filter((i) => i.status === 'done').length;
  const busy = phase === 'creating' || phase === 'uploading';
  const locked = busy || phase === 'partial' || phase === 'done';

  const submit = async (e) => {
    e?.preventDefault?.();
    if (locked && phase !== 'partial') return;
    if (workstreams.length > 1 && !workstream) {
      // Cannot happen from the UI — the form is only reachable from inside a
      // service — but a request filed against no service would be invisible
      // under a per-service portal, so it is still refused.
      setError('Open a service first, then raise your request there.');
      return;
    }
    if (!name.trim()) { setError('Please describe your issue.'); return; }
    setError('');

    let issueInfo = created;
    if (!issueInfo) {
      setPhase('creating');
      try {
        const { issue } = await createMyIssue({
          name: name.trim(), note: note.trim(),
          // The server validates this against the board on the token — a group
          // id is never taken on trust.
          workstream: workstream || onlyWorkstream || undefined,
          // `type` and `category` are no longer sent: the server ignores them
          // and the pickers are gone. See the note above the form's fields.
          priority,
          dueDate: dateInputToISO(dueDate) || undefined,
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
    doneTimer.current = setTimeout(
      () => onCreated({ ref: issueInfo.ref, uploaded: uploaded.length }),
      950
    );
  };

  const finishWithoutFailed = () =>
    onCreated({ ref: created?.ref, uploaded: doneCount, failed: failedCount });

  const label = { fontSize: 12.5, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 7 };
  // The type-specific label sets went with the type picker. DEFAULT_FORM's
  // wording is deliberately service-agnostic, which is what a form inside a
  // known service wants anyway.
  const f = DEFAULT_FORM;

  return (
    <form onSubmit={submit} className="mcp-card-lg mcp-pop" style={{ padding: 22, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>Raise a new request</span>
        {/* Once the request exists, closing must still refresh the list and show
            the receipt — otherwise it looks like nothing was submitted. */}
        <button type="button" onClick={created ? finishWithoutFailed : onClose} disabled={busy}
          className="mcp-linkbtn" style={{ padding: 4 }} aria-label="Close"><X size={18} /></button>
      </div>

      {/* Neither a workstream picker nor a type picker — see the note above the
          component. The service is known from the screen this was opened on,
          and the type list was half service names. */}
      {serviceName && (
        <p className="mcp-note" style={{ marginTop: -4, marginBottom: 16 }}>
          This goes to the team working on <strong>{serviceName}</strong>.
        </p>
      )}

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

      {/* The Category picker was REMOVED, not wired up. Its value was never
          put in the create payload and `createMyIssue` does not accept the
          field — a client picked "Billing", submitted, and the choice went
          nowhere while nothing on screen said so. There is no server field to
          route it to, so the honest fix is to stop asking. Requests raised
          before categories were dropped still show theirs on the list card. */}

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
const IssueDetail = ({ issue, onBack, orgName = '', contactKey = '', onExpired }) => {
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');
  const [sentAt, setSentAt] = useState(0);
  const [busy, setBusy] = useState('');
  // Why the conversation is not on screen, when it is not. Distinct from
  // `postError`: that one belongs to the composer, this one replaces the thread.
  const [threadError, setThreadError] = useState('');
  // Reopen and Rate change nothing visible on this panel until `load()` comes
  // back, so a refusal has to say so here or success and failure look identical.
  const [actionError, setActionError] = useState('');
  const [hoverStar, setHoverStar] = useState(0);
  // 'thread' — files sent mid-conversation belong to their message, not to the
  // original request block above it.
  const tray = useAttachmentTray('thread');
  const scrollAnchor = useRef(null);
  const seenIds = useRef(new Set());
  // `load` is the dependency of both the initial fetch and the 9s poll, so it
  // must not change identity when the parent re-renders. The callback goes
  // through a ref rather than into the dependency list.
  const onExpiredRef = useRef(onExpired);
  useEffect(() => { onExpiredRef.current = onExpired; });

  const applyMessages = useCallback((incoming) => {
    setMessages(incoming.map((m) => ({ ...m, _fresh: !seenIds.current.has(m.id) })));
    incoming.forEach((m) => seenIds.current.add(m.id));
  }, []);

  const load = useCallback(async (opts = {}) => {
    try {
      const data = await getIssueThread(issue.id);
      if (data.issue) setDetail(data.issue);
      applyMessages(data.messages || []);
      setThreadError('');
    } catch (err) {
      // "Keep what we have" only holds for the poll. On the FIRST load there is
      // nothing to keep, and staying quiet rendered the empty state — "No
      // messages yet" — over replies the team had already sent, with no retry
      // and nothing saying the request had failed. A 401 in here was swallowed
      // too, and the list poll is paused while a request is open, so this was
      // the one place an expired session could go unnoticed.
      if (err?.response?.status === 401) { onExpiredRef.current?.(); return; }
      if (opts.initial) setThreadError(err?.response?.data?.error || "We couldn't load this conversation.");
    }
    finally { if (opts.initial) setLoading(false); }
  }, [issue.id, applyMessages]);

  const hasRequestBlock = !!(detail && (detail.note || (detail.attachments && detail.attachments.length)));
  // Falls back to the list card's copy of the flag so the header reads right on
  // the first frame, before the thread request has landed.
  const fromTeam = detail ? detail.fromTeam : issue.fromTeam;

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
      markSeen(contactKey, issue.id);
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

  // Both of these are refusable — already open, a rating out of range, the
  // 30/min thread limit — and both used to swallow the refusal, so the button
  // spun, came back, and the panel looked exactly as it had before. A client
  // who cannot tell whether it worked clicks again, which is how they meet the
  // rate limiter.
  const doReopen = async () => {
    setBusy('reopen');
    setActionError('');
    try { await reopenIssue(issue.id); await load(); }
    catch (err) { setActionError(err?.response?.data?.error || "We couldn't reopen this request. Please try again."); }
    finally { setBusy(''); }
  };
  const doRate = async (n) => {
    setBusy('rate');
    setActionError('');
    try { await rateIssue(issue.id, n); await load(); }
    catch (err) { setActionError(err?.response?.data?.error || "We couldn't save your rating. Please try again."); }
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
            {fromTeam && <FromTeamBadge orgName={orgName} />}
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
            {/* The opening block. On a request the client raised it is their own
                words, right-aligned like the rest of their messages; on an item
                the team shared it is the team's, and has to sit on the team's
                side or the client reads their own name over an ask they never
                made. */}
            {hasRequestBlock && (
              fromTeam ? (
                <div className="mcp-msg-row">
                  <div className="mcp-msg-head">
                    <Avatar name={detail.authorLabel} />
                    <span className="mcp-msg-author" style={{ margin: 0 }}>
                      {detail.authorLabel} · what we need from you
                    </span>
                  </div>
                  <div className="mcp-bubble them">
                    {detail.note}
                    {renderAttachments(detail.attachments)}
                  </div>
                </div>
              ) : (
                <div className="mcp-msg-row mine">
                  <span className="mcp-msg-author">{detail.authorLabel || 'You'} · original request</span>
                  <div className="mcp-bubble mine">
                    {detail.note}
                    {renderAttachments(detail.attachments)}
                  </div>
                </div>
              )
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

            {threadError && !detail ? (
              <div style={{ textAlign: 'center', padding: '10px 0 22px' }}>
                <div style={{ width: 46, height: 46, borderRadius: 12, margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fef2f2', color: '#dc2626' }}>
                  <AlertCircle size={22} />
                </div>
                <p style={{ fontSize: 13.5, color: '#64748B', margin: '0 0 14px', lineHeight: 1.5 }}>
                  {threadError} Nothing has been lost &mdash; your messages are still here.
                </p>
                <button type="button" className="mcp-btn mcp-btn--ghost" style={{ height: 36, fontSize: 13, margin: '0 auto' }}
                  onClick={() => { setLoading(true); load({ initial: true }); }}>
                  <RefreshCw size={14} /> Try again
                </button>
              </div>
            ) : null}

            {!threadError && !hasRequestBlock && messages.length === 0 && (
              <div style={{ textAlign: 'center', padding: '10px 0 22px' }}>
                <div style={{ width: 46, height: 46, borderRadius: 12, margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#eff4ff', color: '#2563eb' }}>
                  <MessageSquare size={22} />
                </div>
                <p style={{ fontSize: 13.5, color: '#64748B', margin: 0, lineHeight: 1.5 }}>
                  No messages yet. Add a comment and the team will reply right here.
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
            {actionError && <p className="mcp-inline-error"><AlertCircle size={13} /> {actionError}</p>}
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
