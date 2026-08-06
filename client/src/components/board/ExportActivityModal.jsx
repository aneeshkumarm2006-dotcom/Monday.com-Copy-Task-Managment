import { useMemo, useState } from 'react';
import { Download, FileSpreadsheet, FileText, AlertTriangle } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Spinner from '../ui/Spinner';
import DatePickerPopover from '../ui/DatePickerPopover';
import useToastStore from '../../store/toastStore';
import { getActivityExport } from '../../services/boardService';
import { downloadExport } from '../../utils/activityExport';

/**
 * ExportActivityModal — pick a window and a format, get a file.
 *
 * The app has no range picker, only the single-date DatePickerPopover and the
 * fixed 7d/30d/all dropdowns used by analytics. Neither fits: an audit export
 * needs arbitrary windows ("what happened in March"), so this pairs the common
 * presets with two of the existing single-date pickers for anything else,
 * rather than inventing a dual-month calendar for one screen.
 */

const toValue = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

const PRESETS = [
  { key: '7d', label: 'Last 7 days', range: () => [daysAgo(6), new Date()] },
  { key: '30d', label: 'Last 30 days', range: () => [daysAgo(29), new Date()] },
  {
    key: 'thisMonth',
    label: 'This month',
    range: () => {
      const now = new Date();
      return [new Date(now.getFullYear(), now.getMonth(), 1), now];
    },
  },
  {
    key: 'lastMonth',
    label: 'Last month',
    range: () => {
      const now = new Date();
      return [
        new Date(now.getFullYear(), now.getMonth() - 1, 1),
        // Day 0 of this month is the last day of the previous one.
        new Date(now.getFullYear(), now.getMonth(), 0),
      ];
    },
  },
  { key: 'custom', label: 'Custom range', range: null },
];

const FORMATS = [
  { key: 'csv', label: 'CSV', icon: FileSpreadsheet, hint: 'Spreadsheet' },
  { key: 'pdf', label: 'PDF', icon: FileText, hint: 'Printable report' },
];

const Field = ({ label, children }) => (
  <div className="flex-1 min-w-0">
    <p
      className="font-body text-[11px] uppercase tracking-wide text-[color:var(--color-text-muted)] mb-1.5"
    >
      {label}
    </p>
    {children}
  </div>
);

const ExportActivityModal = ({ isOpen, onClose, board }) => {
  const toastError = useToastStore((s) => s.error);

  const [presetKey, setPresetKey] = useState('30d');
  const [format, setFormat] = useState('csv');
  const [customFrom, setCustomFrom] = useState(toValue(daysAgo(29)));
  const [customTo, setCustomTo] = useState(toValue(new Date()));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const { from, to } = useMemo(() => {
    if (presetKey === 'custom') return { from: customFrom, to: customTo };
    const preset = PRESETS.find((p) => p.key === presetKey);
    const [start, end] = preset.range();
    return { from: toValue(start), to: toValue(end) };
  }, [presetKey, customFrom, customTo]);

  const rangeInvalid = !from || !to || from > to;

  const handleClose = () => {
    if (busy) return;
    setResult(null);
    onClose();
  };

  const handleExport = async () => {
    if (rangeInvalid) return;
    setBusy(true);
    setResult(null);
    try {
      const payload = await getActivityExport(board._id, { from, to });
      setResult(payload);
      if (payload.totalCount === 0) return; // Nothing to write — say so instead.
      downloadExport(payload, format);
    } catch (err) {
      // The endpoint distinguishes "you lack the capability" from "the feature
      // is switched off", and the second is actionable — surface its wording
      // rather than a generic failure.
      toastError(
        err?.response?.data?.error || 'Could not export this board. Please try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Export board activity"
      maxWidth={540}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={busy ? undefined : Download}
            onClick={handleExport}
            disabled={busy || rangeInvalid}
          >
            {busy ? (
              <Spinner size={16} color="#FFFFFF" label="Exporting" />
            ) : (
              `Export ${format.toUpperCase()}`
            )}
          </Button>
        </>
      }
    >
      <p className="font-body text-[13px] text-[color:var(--color-text-secondary)] mb-5">
        Downloads everything recorded on <strong>{board?.name}</strong> in the
        selected window — task changes, checklist edits, files, updates and
        client messages, across every group.
      </p>

      {/* Range presets */}
      <Field label="Time period">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => {
            const active = presetKey === preset.key;
            return (
              <button
                key={preset.key}
                type="button"
                onClick={() => {
                  setPresetKey(preset.key);
                  setResult(null);
                }}
                className="font-body transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{
                  height: 32,
                  padding: '0 12px',
                  fontSize: 13,
                  fontWeight: active ? 600 : 500,
                  borderRadius: 'var(--radius-md)',
                  border: `1.5px solid ${active ? 'var(--color-accent)' : 'var(--color-border-strong)'}`,
                  background: active ? 'var(--color-accent-light)' : 'transparent',
                  color: active
                    ? 'var(--color-accent-text)'
                    : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </Field>

      {presetKey === 'custom' && (
        <div className="flex items-start gap-3 mt-4">
          <Field label="From">
            <DatePickerPopover
              value={customFrom}
              onChange={(v) => {
                setCustomFrom(v);
                setResult(null);
              }}
              placeholder="Start date"
            />
          </Field>
          <Field label="To">
            <DatePickerPopover
              value={customTo}
              onChange={(v) => {
                setCustomTo(v);
                setResult(null);
              }}
              placeholder="End date"
            />
          </Field>
        </div>
      )}

      {rangeInvalid && (
        <p className="font-body text-[12.5px] mt-2" style={{ color: '#DC2626' }}>
          The start date must be on or before the end date.
        </p>
      )}

      {/* Format */}
      <div className="mt-5">
        <Field label="Format">
          <div className="flex gap-2">
            {FORMATS.map((f) => {
              const Icon = f.icon;
              const active = format === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFormat(f.key)}
                  aria-pressed={active}
                  className="flex-1 flex items-center gap-3 text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                  style={{
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-md)',
                    border: `1.5px solid ${active ? 'var(--color-accent)' : 'var(--color-border-strong)'}`,
                    background: active ? 'var(--color-accent-light)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <Icon
                    size={18}
                    aria-hidden="true"
                    color={
                      active ? 'var(--color-accent)' : 'var(--color-text-secondary)'
                    }
                  />
                  <span className="min-w-0">
                    <span
                      className="block font-body text-[13px]"
                      style={{
                        fontWeight: 600,
                        color: active
                          ? 'var(--color-accent-text)'
                          : 'var(--color-text-primary)',
                      }}
                    >
                      {f.label}
                    </span>
                    <span className="block font-body text-[11.5px] text-[color:var(--color-text-muted)]">
                      {f.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </Field>
      </div>

      {/* Outcome */}
      {result && result.totalCount === 0 && (
        <p className="font-body text-[13px] text-[color:var(--color-text-muted)] mt-5">
          No activity was recorded on this board between {from} and {to}.
        </p>
      )}
      {result && result.totalCount > 0 && (
        <p className="font-body text-[13px] text-[color:var(--color-text-secondary)] mt-5">
          Exported {result.totalCount} event
          {result.totalCount === 1 ? '' : 's'}.
        </p>
      )}
      {result?.truncated && (
        <p
          className="font-body text-[12.5px] mt-2 flex items-start gap-2"
          style={{ color: '#B45309' }}
        >
          <AlertTriangle size={14} aria-hidden="true" style={{ marginTop: 2 }} />
          <span>
            Hit the {result.maxRows}-event limit — narrow the date range to get
            the rest.
          </span>
        </p>
      )}
    </Modal>
  );
};

export default ExportActivityModal;
