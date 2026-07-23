import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, Paperclip, Send, ArrowLeft, LogOut, Loader2, CheckCircle2,
  CircleDot, MessageSquare, X, Inbox, Timer, Building2,
} from 'lucide-react';
import {
  getMyIssues, createMyIssue, uploadIssueAttachment,
  getIssueThread, postThreadMessage, getPortalToken, clearPortalToken,
} from '../services/portalService';
import '../styles/portal.css';

/* fixed semantic colours for the three buckets */
const BUCKETS = {
  open: { label: 'Open', color: '#B45309', icon: CircleDot },
  ongoing: { label: 'In progress', color: '#2563EB', icon: Timer },
  resolved: { label: 'Resolved', color: '#059669', icon: CheckCircle2 },
};

/* per-issue chip using the board's real status name + colour */
const StatusChip = ({ label, color }) => (
  <span className="mcp-status" style={{ '--sc': color || '#64748B' }}>
    <span className="mcp-status-dot" />
    {label || 'Open'}
  </span>
);

/* poll cadences (ms) — cheap, paused while the tab is hidden */
const LIST_POLL = 20000;
const THREAD_POLL = 9000;

const PortalDashboardPage = () => {
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const [context, setContext] = useState({ orgName: '', companyName: '', contactName: '', categories: [] });
  const [issues, setIssues] = useState([]);
  const [filter, setFilter] = useState('all'); // all | open | ongoing | resolved

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
    if (!getPortalToken()) {
      setExpired(true);
      setLoading(false);
      return;
    }
    loadIssues();
  }, [loadIssues]);

  useEffect(() => {
    if (expired || selectedId) return undefined;
    const tick = () => document.visibilityState === 'visible' && loadIssues();
    const id = setInterval(tick, LIST_POLL);
    return () => clearInterval(id);
  }, [expired, selectedId, loadIssues]);

  const logout = () => {
    clearPortalToken();
    setExpired(true);
  };

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
          <div
            style={{
              width: 52, height: 52, borderRadius: 14, margin: '0 auto 16px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#eff4ff', color: '#2563eb',
            }}
          >
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
      {/* Header */}
      <header className="mcp-topbar">
        <div
          className="mcp-container"
          style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
            <span className="mcp-brand-mark">{orgInitial}</span>
            <span style={{ fontSize: 15.5, fontWeight: 800, letterSpacing: '-0.02em' }}>
              {context.orgName || 'Support portal'}
            </span>
          </div>
          <button type="button" onClick={logout} className="mcp-linkbtn">
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </header>

      <main className="mcp-container" style={{ paddingTop: 26 }}>
        {selected ? (
          <IssueDetail
            key={selected.id}
            issue={selected}
            orgName={context.orgName}
            onBack={() => { setSelectedId(null); loadIssues(); }}
          />
        ) : (
          <div className="mcp-rise">
            {/* Greeting */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, marginBottom: 22, flexWrap: 'wrap' }}>
              <div>
                <h1 className="mcp-greet-name">
                  {firstName ? `Welcome back, ${firstName}` : 'Welcome back'}
                </h1>
                <p className="mcp-greet-sub" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span>Here's everything you've raised with {context.orgName || 'us'}.</span>
                  {context.companyName && (
                    <span className="mcp-company"><Building2 size={13} /> {context.companyName}</span>
                  )}
                </p>
              </div>
              <button type="button" className="mcp-btn mcp-btn--primary" onClick={() => setComposerOpen(true)}>
                <Plus size={16} /> Raise a request
              </button>
            </div>

            {/* Stat cards (also act as filters) */}
            <div className="mcp-stats">
              {['open', 'ongoing', 'resolved'].map((k) => {
                const b = BUCKETS[k];
                const Icon = b.icon;
                const active = filter === k;
                return (
                  <button
                    key={k}
                    type="button"
                    className="mcp-stat"
                    data-active={active}
                    onClick={() => setFilter(active ? 'all' : k)}
                    style={{ color: b.color }}
                    aria-pressed={active}
                  >
                    <span className="mcp-stat-ico" style={{ background: `${b.color}18`, color: b.color }}>
                      <Icon size={17} />
                    </span>
                    <div className="mcp-stat-num">{counts[k]}</div>
                    <div className="mcp-stat-label">{b.label}</div>
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

            {/* Section heading + active filter */}
            {issues.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 }}>
                <h2 style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', margin: 0, color: '#334155' }}>
                  {filter === 'all' ? 'All requests' : BUCKETS[filter].label}
                  <span style={{ color: '#94A3B8', fontWeight: 600 }}> · {visible.length}</span>
                </h2>
                {filter !== 'all' && (
                  <button type="button" className="mcp-linkbtn" onClick={() => setFilter('all')}>Show all</button>
                )}
              </div>
            )}

            {/* List / empty */}
            {issues.length === 0 && !composerOpen ? (
              <div className="mcp-card-lg" style={{ padding: '48px 32px', textAlign: 'center' }}>
                <div
                  style={{
                    width: 60, height: 60, borderRadius: 16, margin: '0 auto 16px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: '#eff4ff', color: '#2563eb',
                  }}
                >
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {visible.map((issue, i) => (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => setSelectedId(issue.id)}
                    className="mcp-item mcp-rise"
                    style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', marginBottom: issue.category ? 7 : 0 }}>
                          {issue.name}
                        </div>
                        {issue.category && <span className="mcp-tag">{issue.category}</span>}
                      </div>
                      <StatusChip label={issue.statusLabel} color={issue.statusColor} />
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

/* ---- Loading skeleton ----------------------------------------------------- */
const DashboardSkeleton = () => (
  <div className="mcp mcp-page">
    <header className="mcp-topbar">
      <div className="mcp-container" style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 11 }}>
        <div className="mcp-skel" style={{ width: 40, height: 40, borderRadius: 11 }} />
        <div className="mcp-skel" style={{ width: 150, height: 20 }} />
      </div>
    </header>
    <main className="mcp-container" style={{ paddingTop: 26 }}>
      <div className="mcp-skel" style={{ width: 240, height: 30, marginBottom: 10 }} />
      <div className="mcp-skel" style={{ width: 320, height: 16, marginBottom: 24 }} />
      <div className="mcp-stats">
        {[0, 1, 2].map((i) => <div key={i} className="mcp-skel" style={{ height: 96 }} />)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {[0, 1, 2].map((i) => <div key={i} className="mcp-skel" style={{ height: 64 }} />)}
      </div>
    </main>
  </div>
);

/* ---- New issue form ------------------------------------------------------- */
const NewIssueForm = ({ categories, onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
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
        name: name.trim(),
        note: note.trim(),
        category: category || undefined,
      });
      if (file) {
        try { await uploadIssueAttachment(issue.id, file); } catch { /* non-fatal */ }
      }
      onCreated();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="mcp-card-lg mcp-pop" style={{ padding: 22, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>Raise a new request</span>
        <button type="button" onClick={onClose} className="mcp-linkbtn" style={{ padding: 4 }} aria-label="Close">
          <X size={18} />
        </button>
      </div>

      <label style={{ fontSize: 12.5, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 6 }}>Title</label>
      <input
        className="mcp-field"
        style={{ marginBottom: 14 }}
        placeholder="e.g. Login page not loading"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />

      <label style={{ fontSize: 12.5, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 6 }}>Details</label>
      <textarea
        className="mcp-field"
        style={{ marginBottom: 14, minHeight: 104 }}
        placeholder="Describe what's happening, and anything that helps us reproduce it."
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      {Array.isArray(categories) && categories.length > 0 && (
        <>
          <label style={{ fontSize: 12.5, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 6 }}>
            Category <span style={{ fontWeight: 400, color: '#94A3B8' }}>(optional)</span>
          </label>
          <select
            className="mcp-field"
            style={{ marginBottom: 14, cursor: 'pointer' }}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
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
          {file && (
            <span style={{ fontSize: 12.5, color: '#64748B', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>
              {file.name}
            </span>
          )}
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
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [posting, setPosting] = useState(false);
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
      applyMessages(data.messages || []);
    } catch { /* keep what we have */ }
    finally { if (opts.initial) setLoading(false); }
  }, [issue.id, applyMessages]);

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
      if (file) {
        const { attachment } = await uploadIssueAttachment(issue.id, file);
        attachments = [attachment];
      }
      const { message } = await postThreadMessage(issue.id, { bodyText: text.trim(), attachments });
      seenIds.current.add(message.id);
      setMessages((m) => [...m, { ...message, _fresh: true }]);
      setText('');
      setFile(null);
    } catch { /* keep composer state so the client can retry */ }
    finally { setPosting(false); }
  };

  return (
    <div className="mcp-rise">
      <button type="button" onClick={onBack} className="mcp-linkbtn" style={{ marginBottom: 14 }}>
        <ArrowLeft size={15} /> Back to my requests
      </button>

      <div className="mcp-card-lg" style={{ padding: '17px 20px', marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em', minWidth: 0 }}>{issue.name}</span>
        <StatusChip label={issue.statusLabel} color={issue.statusColor} />
      </div>

      <div className="mcp-card-lg" style={{ padding: 20 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Loader2 size={22} color="#2563EB" className="mcp-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '18px 0 26px' }}>
            <div
              style={{
                width: 46, height: 46, borderRadius: 12, margin: '0 auto 12px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: '#eff4ff', color: '#2563eb',
              }}
            >
              <MessageSquare size={22} />
            </div>
            <p style={{ fontSize: 13.5, color: '#64748B', margin: 0, lineHeight: 1.5 }}>
              No messages yet. Add a comment and {orgName || 'the team'} will reply right here.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 15, marginBottom: 18 }}>
            {messages.map((m) => (
              <div key={m.id} className={`mcp-msg-row ${m.mine ? 'mine' : ''} ${m._fresh ? 'mcp-rise' : ''}`}>
                <span className="mcp-msg-author">{m.authorLabel}</span>
                <div className={`mcp-bubble ${m.mine ? 'mine' : 'them'}`}>
                  {m.bodyText}
                  {Array.isArray(m.attachments) && m.attachments.map((a, i) => (
                    <a key={i} href={a.url} target="_blank" rel="noreferrer" className="mcp-attach">
                      <Paperclip size={12} /> {a.name || 'Attachment'}
                    </a>
                  ))}
                </div>
              </div>
            ))}
            <div ref={scrollAnchor} />
          </div>
        )}

        <form onSubmit={post} style={{ borderTop: '1px solid #eef2f9', paddingTop: 16 }}>
          <textarea
            className="mcp-field"
            style={{ minHeight: 66, marginBottom: 12 }}
            placeholder="Write a message…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') post(e); }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={(e) => setFile(e.target.files?.[0] || null)} />
              <button type="button" onClick={() => fileRef.current?.click()} className="mcp-btn mcp-btn--ghost" style={{ height: 38, fontSize: 13 }}>
                <Paperclip size={14} /> {file ? 'Change file' : 'Attach'}
              </button>
              {file && (
                <span style={{ fontSize: 12.5, color: '#64748B', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>
                  {file.name}
                </span>
              )}
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
