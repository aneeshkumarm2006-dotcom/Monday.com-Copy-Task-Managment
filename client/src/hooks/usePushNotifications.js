import { useCallback, useEffect, useState } from 'react';
import {
  disablePush,
  enablePush,
  getPermission,
  getPushConfig,
  getSubscription,
  isPushSupported,
  isStandalone,
} from '../services/pushService';

/** iOS only allows push from the installed app, never from a Safari tab. */
const isIos = () =>
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ reports as a Mac; the touch points give it away.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/**
 * Everything the UI needs to offer push honestly.
 *
 * The states are deliberately distinct rather than one `enabled` boolean,
 * because the reasons push is unavailable need DIFFERENT things from the
 * person: install the app (iOS in a tab), un-block us in site settings
 * (denied — we cannot prompt again, ever), or nothing at all (the server has
 * no keys, which is ours to fix and not theirs to hear about).
 */
const usePushNotifications = () => {
  const [permission, setPermission] = useState(getPermission);
  const [subscribed, setSubscribed] = useState(false);
  const [serverReady, setServerReady] = useState(null); // null = still asking
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const supported = isPushSupported();
  // On iOS the API only exists inside the installed app, so an iPhone in Safari
  // reports "unsupported" — true, but useless as an explanation.
  const needsInstall = !supported && isIos() && !isStandalone();

  useEffect(() => {
    let cancelled = false;
    if (!supported) {
      setServerReady(false);
      return undefined;
    }
    getPushConfig()
      .then((cfg) => {
        if (!cancelled) setServerReady(Boolean(cfg.enabled));
      })
      .catch(() => {
        if (!cancelled) setServerReady(false);
      });
    getSubscription()
      .then((sub) => {
        if (!cancelled) setSubscribed(Boolean(sub));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const enable = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const result = await enablePush();
      setPermission(getPermission());
      if (result === 'granted') {
        setSubscribed(true);
      } else if (result === 'denied') {
        setError(
          'Your browser is blocking notifications for Macan. Turn them back on in your browser’s site settings for this page.'
        );
      } else if (result === 'unconfigured') {
        setError('Push notifications are not set up on the server yet.');
      } else if (result === 'unsupported') {
        setError('This browser cannot show notifications.');
      }
      return result;
    } catch {
      setError('Could not turn on notifications.');
      return 'error';
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await disablePush();
      setSubscribed(false);
    } catch {
      setError('Could not turn off notifications.');
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    supported,
    needsInstall,
    serverReady,
    permission,
    // Permission alone is not enough: a browser can hold permission with no
    // live subscription (cleared site data, a pruned row), and the UI must say
    // OFF in that case or it promises something that will not arrive.
    enabled: subscribed && permission === 'granted',
    blocked: permission === 'denied',
    busy,
    error,
    enable,
    disable,
  };
};

export default usePushNotifications;
