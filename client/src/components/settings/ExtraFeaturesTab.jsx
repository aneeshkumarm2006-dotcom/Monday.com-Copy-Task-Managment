import { useMemo, useState } from 'react';
import Switch from '../ui/Switch';
import useAuthStore from '../../store/authStore';
import useToastStore from '../../store/toastStore';
import usePermissions from '../../hooks/usePermissions';
import { updateFeatures } from '../../services/profileService';
import { availableExtraFeatures } from '../../utils/extraFeatures';

/**
 * Extra features — the switches for the opt-in tools catalogued in
 * [extraFeatures.js](../../utils/extraFeatures.js). Everything specific to a
 * given feature lives in that table; this component is generic over it, and only
 * renders the ones the viewer's role actually permits.
 */
const ExtraFeaturesTab = () => {
  const user = useAuthStore((s) => s.user);
  const fetchCurrentUser = useAuthStore((s) => s.fetchCurrentUser);
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);
  const { can } = usePermissions();

  const features = useMemo(() => availableExtraFeatures(can), [can]);

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
        {features.map((feature, i) => {
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
