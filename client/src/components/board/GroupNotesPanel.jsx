import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, Plus, StickyNote, Trash2, X } from 'lucide-react';
import RichEditor from './RichEditor';
import { ReadOnlyRichBody } from './UpdatesTab';
import useTaskStore from '../../store/taskStore';
import useToastStore from '../../store/toastStore';
import * as noteService from '../../services/noteService';
import { timeAgo } from '../../utils/dateUtils';

const PANEL_WIDTH = 600;
const SAVE_DEBOUNCE_MS = 800;

/** Collapse a rich note's plain text into a single trimmed line. */
const oneLine = (text) => (text || '').replace(/\s+/g, ' ').trim();
const firstLine = (text) => (text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

/** Heading shown in the list: the title, else the first line, else a fallback. */
const noteHeading = (note) => {
  const t = (note.title || '').trim();
  if (t) return t;
  return firstLine(note.bodyText) || 'Untitled note';
};

/** One-line preview under the heading; avoids repeating the heading text. */
const notePreview = (note) => {
  const hasTitle = !!(note.title || '').trim();
  const text = oneLine(note.bodyText);
  if (!text) return '';
  if (!hasTitle) {
    // Heading already shows the first line — preview the remainder.
    const first = firstLine(note.bodyText);
    const rest = oneLine((note.bodyText || '').slice((note.bodyText || '').indexOf(first) + first.length));
    return rest;
  }
  return text;
};

const draftIsEmpty = (draft) =>
  !(draft.title || '').trim() && !(draft.bodyText || '').trim();

/**
 * GroupNotesPanel — a right-side slide-in drawer holding a group's rich-text
 * notes. Single-column: a scrollable list of notes; clicking one opens it
 * full-width in the same panel (back arrow returns). Notes auto-save
 * (debounced). Board editors can create/edit/delete; viewers read only.
 *
 * Mirrors CommentPanel's drawer mechanics (portal + backdrop + <aside> + ESC /
 * scroll-lock) with independently-named `macan-np-*` styles.
 */
const GroupNotesPanel = ({ isOpen, group, canEdit = false, onClose }) => {
  const groupId = group?._id || null;

  const notes = useTaskStore((s) => (groupId ? s.notesByGroup[groupId] : undefined));
  const fetchNotes = useTaskStore((s) => s.fetchNotes);
  const addNoteLocal = useTaskStore((s) => s.addNoteLocal);
  const updateNoteLocal = useTaskStore((s) => s.updateNoteLocal);
  const removeNoteLocal = useTaskStore((s) => s.removeNote);

  const [loading, setLoading] = useState(false);
  const [view, setView] = useState('list'); // 'list' | 'note'
  const [activeNoteId, setActiveNoteId] = useState(null); // null = unsaved draft
  const [title, setTitle] = useState('');
  const [saveState, setSaveState] = useState('idle'); // 'idle' | 'saving' | 'saved'
  const [editorSessionKey, setEditorSessionKey] = useState(0);
  const [editorInitialContent, setEditorInitialContent] = useState('');

  // Persistence working copy + machinery (refs so the debounced timer reads
  // fresh values without re-closing).
  const draftRef = useRef({ title: '', body: null, bodyText: '' });
  const currentNoteIdRef = useRef(null); // persisted _id, or null while unsaved
  const saveTimer = useRef(null);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const titleInputRef = useRef(null);

  // ----- ESC to close + body scroll lock (mirrors CommentPanel) -----
  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener('keydown', handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, onClose]);

  // ----- Load notes lazily when the panel opens on a group -----
  useEffect(() => {
    if (!isOpen || !groupId) return;
    // Reset to the list view whenever we (re)open on a group.
    setView('list');
    setActiveNoteId(null);
    setSaveState('idle');
    let cancelled = false;
    setLoading(true);
    fetchNotes(groupId)
      .catch(() => {
        if (!cancelled) {
          useToastStore.getState().error('Could not load notes. Please try again.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, groupId, fetchNotes]);

  // ----- Persistence -----
  const persist = useCallback(async () => {
    if (!canEdit || !groupId) return;
    const payload = draftRef.current;
    if (draftIsEmpty(payload)) return; // never save an empty note
    if (inFlightRef.current) {
      queuedRef.current = true; // coalesce — run once the in-flight save lands
      return;
    }
    inFlightRef.current = true;
    setSaveState('saving');
    try {
      if (currentNoteIdRef.current == null) {
        const created = await noteService.createNote(groupId, {
          title: payload.title,
          body: payload.body,
          bodyText: payload.bodyText,
        });
        currentNoteIdRef.current = created._id;
        setActiveNoteId(created._id);
        addNoteLocal(groupId, created);
      } else {
        const updated = await noteService.updateNote(currentNoteIdRef.current, {
          title: payload.title,
          body: payload.body,
          bodyText: payload.bodyText,
        });
        updateNoteLocal(groupId, updated);
      }
      setSaveState('saved');
    } catch {
      setSaveState('idle');
      useToastStore.getState().error('Could not save note. Please try again.');
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        persist(); // flush the edits that arrived mid-save
      }
    }
  }, [canEdit, groupId, addNoteLocal, updateNoteLocal]);

  const scheduleSave = useCallback(() => {
    if (!canEdit) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState('saving');
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      persist();
    }, SAVE_DEBOUNCE_MS);
  }, [canEdit, persist]);

  // Clear any pending debounce and persist immediately (best-effort).
  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (!draftIsEmpty(draftRef.current)) persist();
    }
  }, [persist]);

  // Flush a pending save when the panel unmounts.
  useEffect(() => () => flushSave(), [flushSave]);

  // ----- View transitions -----
  const enterNote = useCallback((note) => {
    flushSave();
    setActiveNoteId(note?._id || null);
    currentNoteIdRef.current = note?._id || null;
    const t = note?.title || '';
    setTitle(t);
    draftRef.current = {
      title: t,
      body: note?.body || null,
      bodyText: note?.bodyText || '',
    };
    setEditorInitialContent(note?.body || '');
    setEditorSessionKey((k) => k + 1);
    setSaveState(note?._id ? 'saved' : 'idle');
    setView('note');
  }, [flushSave]);

  const handleNewNote = useCallback(() => {
    enterNote(null);
    setTimeout(() => titleInputRef.current?.focus(), 0);
  }, [enterNote]);

  const backToList = useCallback(() => {
    flushSave();
    setView('list');
    setActiveNoteId(null);
  }, [flushSave]);

  // ----- Editors' change handlers -----
  const handleTitleChange = (e) => {
    const v = e.target.value;
    setTitle(v);
    draftRef.current = { ...draftRef.current, title: v };
    scheduleSave();
  };

  const handleBodyChange = useCallback(({ json, text }) => {
    draftRef.current = { ...draftRef.current, body: json, bodyText: text };
    scheduleSave();
  }, [scheduleSave]);

  // ----- Delete -----
  const handleDelete = useCallback(async (note) => {
    if (!canEdit || !groupId || !note?._id) return;
    if (!window.confirm('Delete this note? This cannot be undone.')) return;
    // Optimistic remove; resync from server on failure.
    removeNoteLocal(groupId, note._id);
    if (activeNoteId === note._id) {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      setView('list');
      setActiveNoteId(null);
    }
    try {
      await noteService.deleteNote(note._id);
    } catch {
      useToastStore.getState().error('Could not delete note. Please try again.');
      fetchNotes(groupId).catch(() => {});
    }
  }, [canEdit, groupId, activeNoteId, removeNoteLocal, fetchNotes]);

  if (!isOpen || !group) return null;

  const list = Array.isArray(notes) ? notes : [];
  const activeNote = activeNoteId ? list.find((n) => n._id === activeNoteId) : null;

  const saveLabel =
    saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : '';

  const panel = (
    <>
      {/* Backdrop — click to close */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="macan-np-backdrop"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.15)',
          zIndex: 99,
          animation: 'macan-np-backdrop 200ms ease-out',
        }}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Notes for group ${group.name}`}
        className="macan-notes-panel macan-np-aside bg-white flex flex-col"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: PANEL_WIDTH,
          maxWidth: '100vw',
          zIndex: 100,
          borderLeft: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-lg)',
          animation: 'macan-np-slide 300ms cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2"
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--color-border)',
            flexShrink: 0,
          }}
        >
          {view === 'note' ? (
            <button
              type="button"
              onClick={backToList}
              aria-label="Back to notes list"
              className="inline-flex items-center gap-1 font-body transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{
                height: 32,
                padding: '0 8px',
                background: 'transparent',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--color-text-secondary)',
              }}
            >
              <ChevronLeft size={16} aria-hidden="true" />
              All notes
            </button>
          ) : (
            <span className="inline-flex items-center gap-2" style={{ minWidth: 0 }}>
              <StickyNote size={16} color="var(--color-text-secondary)" aria-hidden="true" />
              <span
                className="font-display truncate"
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  letterSpacing: '0.02em',
                  color: 'var(--color-text-primary)',
                }}
              >
                Notes · {group.name}
              </span>
            </span>
          )}

          <div className="flex-1" />

          {view === 'note' && saveLabel && (
            <span
              className="font-body"
              style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
            >
              {saveLabel}
            </span>
          )}
          {view === 'note' && canEdit && activeNote && (
            <button
              type="button"
              onClick={() => handleDelete(activeNote)}
              aria-label="Delete note"
              className="inline-flex items-center justify-center transition-colors duration-150 hover:bg-[#FFF0F0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-status-stuck)]"
              style={{ width: 32, height: 32, borderRadius: 'var(--radius-sm)' }}
            >
              <Trash2 size={16} color="var(--color-status-stuck)" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{ width: 32, height: 32 }}
          >
            <X size={18} color="var(--color-text-secondary)" aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {view === 'list' ? (
            <ListView
              loading={loading}
              notes={list}
              canEdit={canEdit}
              onNew={handleNewNote}
              onOpen={enterNote}
              onDelete={handleDelete}
            />
          ) : (
            <NoteEditorView
              canEdit={canEdit}
              activeNote={activeNote}
              title={title}
              titleInputRef={titleInputRef}
              onTitleChange={handleTitleChange}
              editorSessionKey={editorSessionKey}
              editorInitialContent={editorInitialContent}
              onBodyChange={handleBodyChange}
            />
          )}
        </div>
      </aside>

      <style>{`
        @keyframes macan-np-slide {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
        @keyframes macan-np-backdrop {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @media (max-width: 767px) {
          .macan-notes-panel { width: 100vw !important; }
        }
        @media (prefers-reduced-motion: reduce) {
          .macan-np-aside, .macan-np-backdrop { animation: none !important; }
        }
        .macan-notes-panel *::-webkit-scrollbar { width: 8px; height: 8px; }
        .macan-notes-panel *::-webkit-scrollbar-track { background: transparent; }
        .macan-notes-panel *::-webkit-scrollbar-thumb {
          background: var(--color-border-strong);
          border-radius: 8px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        .macan-notes-panel *::-webkit-scrollbar-thumb:hover { background: var(--color-text-muted); }
        .macan-notes-panel *::-webkit-scrollbar-button,
        .macan-notes-panel *::-webkit-scrollbar-corner { display: none; }
        .macan-notes-panel * { scrollbar-width: thin; scrollbar-color: var(--color-border-strong) transparent; }
      `}</style>
    </>
  );

  return createPortal(panel, document.body);
};

/** List of note cards + "New note" affordance / empty state. */
const ListView = ({ loading, notes, canEdit, onNew, onOpen, onDelete }) => {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {canEdit && (
        <div style={{ padding: '12px 16px', flexShrink: 0 }}>
          <button
            type="button"
            onClick={onNew}
            className="inline-flex items-center justify-center gap-2 font-body w-full transition-colors duration-150 hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              height: 38,
              background: 'var(--color-accent)',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <Plus size={16} aria-hidden="true" />
            New note
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 16px 16px 16px' }}>
        {loading && notes.length === 0 ? (
          <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '8px 4px' }}>
            Loading…
          </p>
        ) : notes.length === 0 ? (
          <div
            className="font-body flex flex-col items-center justify-center text-center"
            style={{ gap: 8, padding: '48px 24px', color: 'var(--color-text-muted)' }}
          >
            <StickyNote size={28} color="var(--color-border-strong)" aria-hidden="true" />
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
              No notes yet
            </p>
            <p style={{ fontSize: 12.5, maxWidth: 260 }}>
              {canEdit
                ? 'Jot down anything about this group — meeting notes, checklists, links, ideas.'
                : 'This group has no notes yet.'}
            </p>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {notes.map((note) => (
              <NoteCard
                key={note._id}
                note={note}
                canEdit={canEdit}
                onOpen={() => onOpen(note)}
                onDelete={() => onDelete(note)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

/** A single note row in the list. */
const NoteCard = ({ note, canEdit, onOpen, onDelete }) => {
  const preview = notePreview(note);
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
        className="group/note-card transition-colors duration-150 hover:border-[color:var(--color-border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          padding: '12px 14px',
          background: 'var(--color-bg-surface, #FFFFFF)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          cursor: 'pointer',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            className="font-body truncate"
            style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}
          >
            {noteHeading(note)}
          </p>
          {preview && (
            <p
              className="font-body truncate"
              style={{ fontSize: 12.5, color: 'var(--color-text-muted)', margin: '2px 0 0 0' }}
            >
              {preview}
            </p>
          )}
          <p
            className="font-body"
            style={{ fontSize: 11, color: 'var(--color-text-muted)', margin: '6px 0 0 0' }}
          >
            {note.lastEditedBy?.name || note.author?.name
              ? `${note.lastEditedBy?.name || note.author?.name} · `
              : ''}
            {timeAgo(note.updatedAt || note.createdAt)}
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label="Delete note"
            className="inline-flex items-center justify-center opacity-0 group-hover/note-card:opacity-100 transition-opacity duration-150 hover:bg-[#FFF0F0] focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-status-stuck)]"
            style={{ width: 28, height: 28, borderRadius: 'var(--radius-sm)', flexShrink: 0 }}
          >
            <Trash2 size={14} color="var(--color-status-stuck)" aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
};

/** The single-note editor (or read-only render for viewers). */
const NoteEditorView = ({
  canEdit,
  activeNote,
  title,
  titleInputRef,
  onTitleChange,
  editorSessionKey,
  editorInitialContent,
  onBodyChange,
}) => {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 24px 20px' }}>
      {canEdit ? (
        <>
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            onChange={onTitleChange}
            placeholder="Note title"
            className="font-display w-full"
            style={{
              display: 'block',
              width: '100%',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 20,
              fontWeight: 700,
              color: 'var(--color-text-primary)',
              padding: 0,
              marginBottom: 12,
            }}
          />
          <RichEditor
            key={editorSessionKey}
            placeholder="Start writing…"
            initialContent={editorInitialContent}
            onChange={onBodyChange}
          />
        </>
      ) : (
        <>
          <h2
            className="font-display"
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: 'var(--color-text-primary)',
              margin: '0 0 12px 0',
            }}
          >
            {activeNote ? noteHeading(activeNote) : 'Untitled note'}
          </h2>
          <ReadOnlyRichBody body={activeNote?.body} fallbackText={activeNote?.bodyText} />
        </>
      )}
    </div>
  );
};

export default GroupNotesPanel;
