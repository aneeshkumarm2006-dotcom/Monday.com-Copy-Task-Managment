import { useEffect, useRef, useState } from 'react';
import {
  Plus, Paperclip, Send, ArrowLeft, LogOut, Loader2, CheckCircle2,
  CircleDot, MessageSquare, X,
} from 'lucide-react';
import {
  getMyIssues, createMyIssue, uploadIssueAttachment,
  getIssueThread, postThreadMessage, getPortalToken, clearPortalToken,
} from '../services/portalService';

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif";
const page = { minHeight: '100vh', background: '#F3F4F8', fontFamily: FONT };
const container = { maxWidth: 720, margin: '0 auto', padding: '0 20px 60px' };
const card = { background: '#FFF', border: '1px solid #E5E7EB', borderRadius: 12 };
const btnPrimary = {
  height: 40, padding: '0 16px', border: 'none', borderRadius: 8,
  background: '#2563EB', color: '#FFF', fontSize: 14, fontWeight: 600,
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7,
};
const inputBase = {
  width: '100%', border: '1.5px solid #E5E7EB', borderRadius: 8, padding: '10px 12px',
  fontSize: 14, color: '#111827', outline: 'none', background: '#F9FAFB', fontFamily: FONT,
  boxSizing: 'border-box',
};

const StatusPill = ({ resolved }) => (
  <span
    style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600,
      padding: '3px 10px', borderRadius: 9999,
      color: resolved ? '#16A34A' : '#D97706',
      background: resolved ? '#ECFDF5' : '#FFFBEB',
    }}
  >
    {resolved ? <CheckCircle2 size={13} /> : <CircleDot size={13} />}
    {resolved ? 'Resolved' : 'Open'}
  </span>
);

const PortalDashboardPage = () => {
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const [context, setContext] = useState({ orgName: '', clientName: '', categories: [] });
  const [issues, setIssues] = useState([]);

  const [composerOpen, setComposerOpen] = useState(false);
  const [selected, setSelected] = useState(null); // issue in detail view

  const loadIssues = async () => {
    try {
      const data = await getMyIssues();
      setContext(data.context || { orgName: '', clientName: '', categories: [] });
      setIssues(data.issues || []);
    } catch (err) {
      if (err.response?.status === 401) setExpired(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!getPortalToken()) {
      setExpired(true);
      setLoading(false);
      return;
    }
    loadIssues();
  }, []);

  const logout = () => {
    clearPortalToken();
    setExpired(true);
  };

  if (loading) {
    return (
      <div style={{ ...page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 size={26} color="#2563EB" style={{ animation: 'spin 1s linear infinite' }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (expired) {
    return (
      <div style={{ ...page, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ ...card, padding: 32, textAlign: 'center', maxWidth: 420 }}>
          <p style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: '0 0 8px' }}>
            Your session has ended
          </p>
          <p style={{ fontSize: 14, color: '#6B7280', margin: 0, lineHeight: 1.5 }}>
            Please open your portal link again to sign back in.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={page}>
      {/* Header */}
      <div style={{ background: '#FFF', borderBottom: '1px solid #E5E7EB' }}>
        <div style={{ ...container, padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: '#111827', letterSpacing: '-0.02em' }}>
              {context.orgName || 'Support portal'}
            </div>
            <div style={{ fontSize: 13, color: '#6B7280' }}>{context.clientName}</div>
          </div>
          <button
            type="button" onClick={logout}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: '#6B7280', fontSize: 13, cursor: 'pointer', fontFamily: FONT }}
          >
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </div>

      <div style={{ ...container, paddingTop: 24 }}>
        {selected ? (
          <IssueDetail
            issue={selected}
            orgName={context.orgName}
            onBack={() => { setSelected(null); loadIssues(); }}
          />
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>My issues</h1>
              <button type="button" style={btnPrimary} onClick={() => setComposerOpen(true)}>
                <Plus size={16} /> Raise an issue
              </button>
            </div>

            {composerOpen && (
              <NewIssueForm
                categories={context.categories}
                onClose={() => setComposerOpen(false)}
                onCreated={() => { setComposerOpen(false); loadIssues(); }}
              />
            )}

            {issues.length === 0 && !composerOpen ? (
              <div style={{ ...card, padding: 40, textAlign: 'center' }}>
                <MessageSquare size={28} color="#9CA3AF" style={{ margin: '0 auto 10px' }} />
                <p style={{ fontSize: 15, fontWeight: 600, color: '#374151', margin: '0 0 4px' }}>No issues yet</p>
                <p style={{ fontSize: 13.5, color: '#6B7280', margin: 0 }}>
                  Raise an issue and the team will get straight on it.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {issues.map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => setSelected(issue)}
                    style={{ ...card, padding: '14px 16px', textAlign: 'left', cursor: 'pointer', fontFamily: FONT }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 600, color: '#111827', marginBottom: 4 }}>
                          {issue.name}
                        </div>
                        {issue.category && (
                          <span style={{ fontSize: 11.5, fontWeight: 600, color: '#6B7280', background: '#F3F4F6', borderRadius: 6, padding: '2px 8px' }}>
                            {issue.category}
                          </span>
                        )}
                      </div>
                      <StatusPill resolved={issue.resolved} />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
};

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
    <form onSubmit={submit} style={{ ...card, padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>Raise a new issue</span>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF' }}>
          <X size={18} />
        </button>
      </div>

      <input
        style={{ ...inputBase, marginBottom: 10 }}
        placeholder="Short title (e.g. Login page not loading)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <textarea
        style={{ ...inputBase, marginBottom: 10, minHeight: 96, resize: 'vertical' }}
        placeholder="Describe what's happening, and anything that helps us reproduce it."
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      {Array.isArray(categories) && categories.length > 0 && (
        <select
          style={{ ...inputBase, marginBottom: 10 }}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Category (optional)</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <input
            ref={fileRef} type="file" style={{ display: 'none' }}
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: '1.5px solid #E5E7EB', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#374151', cursor: 'pointer', fontFamily: FONT }}
          >
            <Paperclip size={14} /> {file ? 'Change file' : 'Attach a screenshot'}
          </button>
          {file && <span style={{ fontSize: 12.5, color: '#6B7280', marginLeft: 10 }}>{file.name}</span>}
        </div>
        <button type="submit" disabled={submitting} style={{ ...btnPrimary, opacity: submitting ? 0.7 : 1 }}>
          {submitting ? 'Submitting…' : 'Submit issue'}
        </button>
      </div>
      {error && <p style={{ fontSize: 13, color: '#DC2626', margin: '12px 0 0' }}>{error}</p>}
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

  const load = async () => {
    try {
      const data = await getIssueThread(issue.id);
      setMessages(data.messages || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.id]);

  const post = async (e) => {
    e?.preventDefault?.();
    if (!text.trim() && !file) return;
    setPosting(true);
    try {
      let attachments;
      if (file) {
        // Attachments post to the issue's attachment endpoint; then reference them
        // in the message so the team sees the file inline in the thread.
        const { attachment } = await uploadIssueAttachment(issue.id, file);
        attachments = [attachment];
      }
      const { message } = await postThreadMessage(issue.id, {
        bodyText: text.trim(),
        attachments,
      });
      setMessages((m) => [...m, message]);
      setText('');
      setFile(null);
    } catch { /* keep composer state so the client can retry */ }
    finally { setPosting(false); }
  };

  return (
    <div>
      <button
        type="button" onClick={onBack}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: '#6B7280', fontSize: 13.5, cursor: 'pointer', marginBottom: 14, fontFamily: FONT }}
      >
        <ArrowLeft size={15} /> Back to my issues
      </button>

      <div style={{ ...card, padding: '16px 18px', marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>{issue.name}</span>
        <StatusPill resolved={issue.resolved} />
      </div>

      <div style={{ ...card, padding: 18 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 20 }}>
            <Loader2 size={20} color="#2563EB" style={{ animation: 'spin 1s linear infinite' }} />
          </div>
        ) : messages.length === 0 ? (
          <p style={{ fontSize: 13.5, color: '#6B7280', textAlign: 'center', margin: '10px 0 20px' }}>
            No messages yet. Add a comment and the {orgName || 'team'} will reply here.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 18 }}>
            {messages.map((m) => (
              <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: m.mine ? 'flex-end' : 'flex-start' }}>
                <div style={{ fontSize: 11.5, color: '#9CA3AF', marginBottom: 3 }}>{m.authorLabel}</div>
                <div
                  style={{
                    maxWidth: '80%', padding: '9px 13px', borderRadius: 10, fontSize: 14, lineHeight: 1.5,
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    background: m.mine ? '#2563EB' : '#F3F4F6',
                    color: m.mine ? '#FFF' : '#111827',
                  }}
                >
                  {m.bodyText}
                  {Array.isArray(m.attachments) && m.attachments.map((a, i) => (
                    <a
                      key={i} href={a.url} target="_blank" rel="noreferrer"
                      style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12.5, color: m.mine ? '#DBEAFE' : '#2563EB', textDecoration: 'underline' }}
                    >
                      <Paperclip size={12} /> {a.name || 'Attachment'}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Composer */}
        <form onSubmit={post} style={{ borderTop: '1px solid #F3F4F6', paddingTop: 14 }}>
          <textarea
            style={{ ...inputBase, minHeight: 64, resize: 'vertical', marginBottom: 10 }}
            placeholder="Write a message…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={(e) => setFile(e.target.files?.[0] || null)} />
              <button
                type="button" onClick={() => fileRef.current?.click()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: '1.5px solid #E5E7EB', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#374151', cursor: 'pointer', fontFamily: FONT }}
              >
                <Paperclip size={14} /> {file ? 'Change file' : 'Attach'}
              </button>
              {file && <span style={{ fontSize: 12.5, color: '#6B7280', marginLeft: 10 }}>{file.name}</span>}
            </div>
            <button type="submit" disabled={posting || (!text.trim() && !file)} style={{ ...btnPrimary, opacity: posting || (!text.trim() && !file) ? 0.6 : 1 }}>
              <Send size={14} /> {posting ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PortalDashboardPage;
