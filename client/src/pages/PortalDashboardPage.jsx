import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, Paperclip, Send, ArrowLeft, LogOut, Loader2, CheckCircle2,
  CircleDot, MessageSquare, X, Inbox, Timer, Building2, ChevronRight,
  Bug, Sparkles, ClipboardList, HelpCircle, Star, RotateCcw, Hand,
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
  bug: { label: 'Bug', icon: Bug, color: '#DC2626' },
  feature: { label: 'Feature request', icon: Sparkles, color: '#7C3AED' },
  requirement: { label: 'Requirement', icon: ClipboardList, color: '#2563EB' },
  question: { label: 'Question', icon: HelpCircle, color: '#0891B2' },
};
const PRIORITIES = {
  low: { label: 'Low', color: '#64748B' },
  medium: { label: 'Medium', color: '#2563EB' },
  high: { label: 'High', color: '#EA580C' },
  critical: { label: 'Urgent', color: '#DC2626' },
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

  const openIssue = (id) => { markSeen(id); setSeen(getSeen()); setSelectedId(id); };
  const dismissWelcome = () => { localStorage.setItem(WELCOME_KEY, '1'); setShowWelcome(false); };
  const logout = () => { clearPortalToken(); setExpired(true); };

  const selected = issues.find((i) => i.id === selectedId) || null;
  const counts = {
    open: issues.filter((i) => i.state === 'open').length,
    ongoing: issues.filter((i) => i.state === 'ongoing').length,
    resolved: issues.filter((i) => i.state === 'resolved').length,
  };
  const visible = filter === 'all' ? issues : issues.filter((i) => i.state === filter);

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

            {/* Welcome hero (first visit) */}
            {showWelcome && (
              <WelcomeHero
                orgName={context.orgName}
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
                onCreated={() => { setComposerOpen(false); loadIssues(); }}
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
                    </div>

                    <div className="mcp-tcard-foot">
                      <span>Raised {formatShortDate(issue.createdAt)}</span>
                      <ChevronRight size={16} className="mcp-item-chev" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

/* ---- Welcome hero --------------------------------------------------------- */
const WelcomeHero = ({ orgName, onDismiss, onStart }) => {
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
        <Plus size={16} /> Raise your first request
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
  const [category, setCategory] = useState('');
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!name.trim()) { setError('Please describe your issue.'); return; }
    setSubmitting(true);
    setError('');
    try {
      const { issue } = await createMyIssue({
        name: name.trim(), note: note.trim(),
        type: type || undefined, priority,
        category: category || undefined,
      });
      if (file) { try { await uploadIssueAttachment(issue.id, file); } catch { /* non-fatal */ } }
      onCreated();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit. Please try again.');
      setSubmitting(false);
    }
  };

  const label = { fontSize: 12.5, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 7 };

  return (
    <form onSubmit={submit} className="mcp-card-lg mcp-pop" style={{ padding: 22, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>Raise a new request</span>
        <button type="button" onClick={onClose} className="mcp-linkbtn" style={{ padding: 4 }} aria-label="Close"><X size={18} /></button>
      </div>

      {/* Type */}
      <label style={label}>What kind of request is this?</label>
      <div className="mcp-seg" style={{ marginBottom: 16 }}>
        {Object.entries(TYPES).map(([k, t]) => {
          const Icon = t.icon; const on = type === k;
          return (
            <button key={k} type="button" className="mcp-seg-btn" data-on={on}
              onClick={() => setType(on ? '' : k)}
              style={on ? { color: t.color, borderColor: t.color, background: `${t.color}12`, boxShadow: `0 0 0 4px ${t.color}22` } : undefined}>
              <Icon size={15} /> {t.label}
            </button>
          );
        })}
      </div>

      <label style={label}>Title</label>
      <input className="mcp-field" style={{ marginBottom: 16 }} placeholder="e.g. Login page not loading"
        value={name} onChange={(e) => setName(e.target.value)} autoFocus />

      <label style={label}>Details</label>
      <textarea className="mcp-field" style={{ marginBottom: 16, minHeight: 104 }}
        placeholder="Describe what's happening, your requirement, or your question — and anything that helps us."
        value={note} onChange={(e) => setNote(e.target.value)} />

      {/* Priority */}
      <label style={label}>How urgent is it?</label>
      <div className="mcp-seg" style={{ marginBottom: 16 }}>
        {Object.entries(PRIORITIES).map(([k, p]) => {
          const on = priority === k;
          return (
            <button key={k} type="button" className="mcp-seg-btn" data-on={on}
              onClick={() => setPriority(k)}
              style={on ? { color: p.color, borderColor: p.color, background: `${p.color}12`, boxShadow: `0 0 0 4px ${p.color}22` } : undefined}>
              <span className="mcp-prio-dot" style={{ '--bc': p.color }} /> {p.label}
            </button>
          );
        })}
      </div>

      {Array.isArray(categories) && categories.length > 0 && (
        <>
          <label style={label}>Category <span style={{ fontWeight: 400, color: '#94A3B8' }}>(optional)</span></label>
          <select className="mcp-field" style={{ marginBottom: 16, cursor: 'pointer' }} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Select a category</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={(e) => setFile(e.target.files?.[0] || null)} />
          <button type="button" onClick={() => fileRef.current?.click()} className="mcp-btn mcp-btn--ghost" style={{ height: 38, fontSize: 13 }}>
            <Paperclip size={14} /> {file ? 'Change file' : 'Attach a screenshot'}
          </button>
          {file && <span style={{ fontSize: 12.5, color: '#64748B', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>{file.name}</span>}
        </div>
        <button type="submit" disabled={submitting} className="mcp-btn mcp-btn--primary">
          {submitting ? <><Loader2 size={15} className="mcp-spin" /> Submitting…</> : <><Send size={14} /> Submit request</>}
        </button>
      </div>
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
  const [file, setFile] = useState(null);
  const [posting, setPosting] = useState(false);
  const [busy, setBusy] = useState('');
  const [hoverStar, setHoverStar] = useState(0);
  const fileRef = useRef(null);
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
    if (!text.trim() && !file) return;
    setPosting(true);
    try {
      let attachments;
      if (file) { const { attachment } = await uploadIssueAttachment(issue.id, file); attachments = [attachment]; }
      const { message } = await postThreadMessage(issue.id, { bodyText: text.trim(), attachments });
      seenIds.current.add(message.id);
      setMessages((m) => [...m, { ...message, _fresh: true }]);
      setText(''); setFile(null);
      markSeen(issue.id);
    } catch { /* keep composer state */ }
    finally { setPosting(false); }
  };

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

  const renderAttachments = (list) =>
    (Array.isArray(list) ? list : []).map((a, i) =>
      isImage(a) ? (
        <a key={i} href={a.url} target="_blank" rel="noreferrer">
          <img className="mcp-thumb" src={a.url} alt={a.name || 'attachment'} />
        </a>
      ) : (
        <a key={i} href={a.url} target="_blank" rel="noreferrer" className="mcp-attach">
          <Paperclip size={12} /> {a.name || 'Attachment'}
        </a>
      )
    );

  return (
    <div className="mcp-rise">
      <button type="button" onClick={onBack} className="mcp-linkbtn" style={{ marginBottom: 14 }}>
        <ArrowLeft size={15} /> Back to my requests
      </button>

      <div className="mcp-card-lg" style={{ padding: '17px 20px', marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em' }}>{issue.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8, flexWrap: 'wrap' }}>
            <TypeBadge type={detail?.type ?? issue.type} />
            <PriorityBadge priority={detail?.priority ?? issue.priority} />
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
                  {detail.note || 'Attached the following:'}
                  {renderAttachments(detail.attachments, true)}
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
                    {renderAttachments(m.attachments, m.mine)}
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
        <form onSubmit={post} style={{ borderTop: '1px solid #eef2f9', paddingTop: 16 }}>
          <textarea className="mcp-field" style={{ minHeight: 66, marginBottom: 12 }} placeholder="Write a message…"
            value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') post(e); }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={(e) => setFile(e.target.files?.[0] || null)} />
              <button type="button" onClick={() => fileRef.current?.click()} className="mcp-btn mcp-btn--ghost" style={{ height: 38, fontSize: 13 }}>
                <Paperclip size={14} /> {file ? 'Change file' : 'Attach'}
              </button>
              {file && <span style={{ fontSize: 12.5, color: '#64748B', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>{file.name}</span>}
            </div>
            <button type="submit" disabled={posting || (!text.trim() && !file)} className="mcp-btn mcp-btn--primary">
              {posting ? <><Loader2 size={14} className="mcp-spin" /> Sending…</> : <><Send size={14} /> Send</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PortalDashboardPage;
