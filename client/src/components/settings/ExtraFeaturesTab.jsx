import { useState } from 'react';
import { FileDown } from 'lucide-react';
import Switch from '../ui/Switch';
import useAuthStore from '../../store/authStore';
import useToastStore from '../../store/toastStore';
import { updateFeatures } from '../../services/profileService';

/**
 * Extra features — opt-in tools that stay off until someone asks for them.
 *
 * These are not permissions. Reaching this tab already means you hold the
 * capability; the switch records that you actually want the thing. The two are
 * deliberately separate, and BOTH are re-checked on the server, so flipping a
 * switch here can never grant anything a role did not already allow.
 *
 * To add a feature: append to FEATURES, add the key to FEATURE_KEYS in
 * server/src/controllers/profileController.js, and add the field to
 * `User.features`. Everything else here is generic.
 */
const FEATURES = [
  {
    key: 'activityExport',
    icon: FileDown,
    label: 'Board activity export',
    hint:
      'Adds an Export button to boards you can open, for downloading everything ' +
      'that happened on the board over a date range as a CSV or PDF.',
  },
];

const ExtraFeaturesTab = () => {
  const user = useAuthStore((s) => s.user);
  const fetchCurrentUser = useAuthStore((s) => s.fetchCurrentUser);
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  // Optimistic local overlay on top of the store's user, so the switch responds
  // immediately instead of waiting on the round-trip plus the /auth/me refetch.
  const [pending, setPending] = useState({});
  const valueOf = (key) =>
    pending[key] !== undefined ? pending[key] : !!user?.features?.[key];

  const toggle = async (feature, next) => {
    setPending((p) => ({ ...p, [feature.key]: next }));
    try {
      await updateFeatures({ [feature.key]: next });
      // Re-read the user so every other screen (the board toolbar, chiefly)
      // sees the change without a reload.
      await fetchCurrentUser();
      setPending((p) => {
        const { [feature.key]: _drop, ...rest } = p;
        return rest;
      });
      toastSuccess(`${feature.label} turned ${next ? 'on' : 'off'}.`);
    } catch {
      setPending((p) => {
        const { [feature.key]: _drop, ...rest } = p;
        return rest;
      });
      toastError('Could not save that. Please try again.');
    }
  };

  return (
    <div>
      <header className="mb-5">
        <h1
          className="font-display font-bold text-[color:var(--color-text-primary)]"
          style={{ fontSize: 22 }}
        >
          Extra features
        </h1>
        <p className="font-body text-[13px] text-[color:var(--color-text-secondary)] mt-1">
          Optional tools, off by default for everyone. Turning one on affects
          only your own account.
        </p>
      </header>

      <div
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
        }}
      >
        {FEATURES.map((feature, i) => {
          const Icon = feature.icon;
          const checked = valueOf(feature.key);
          return (
            <div
              key={feature.key}
              className="flex items-start gap-3 px-4 py-4"
              style={{
                borderTop: i === 0 ? 'none' : '1px solid var(--color-border)',
              }}
            >
              <div
                aria-hidden="true"
                className="flex items-center justify-center shrink-0"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-bg-subtle)',
                  color: 'var(--color-text-secondary)',
                  marginTop: 1,
                }}
              >
                <Icon size={17} />
              </div>

              <div className="flex-1 min-w-0">
                <p className="font-body text-[14px] font-semibold text-[color:var(--color-text-primary)]">
                  {feature.label}
                </p>
                <p className="font-body text-[12.5px] text-[color:var(--color-text-muted)] mt-0.5">
                  {feature.hint}
                </p>
              </div>

              <div className="shrink-0 pt-1">
                <Switch
                  checked={checked}
                  onChange={(v) => toggle(feature, v)}
                  label={feature.label}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ExtraFeaturesTab;
