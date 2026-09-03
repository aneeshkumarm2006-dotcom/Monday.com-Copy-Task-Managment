import api from './api';

/**
 * Web Push subscription plumbing.
 *
 * The browser owns the subscription; the server only stores it. Everything here
 * is about keeping those two in step — including the case nobody thinks about,
 * where the browser still holds a subscription the server has since forgotten
 * (a pruned dead row, a restored profile), which is why `syncSubscription`
 * re-posts an existing subscription rather than assuming it is known.
 */

/** VAPID keys travel as base64url and the browser wants raw bytes. */
const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
};

/**
 * Can this browser do push at all?
 *
 * On iOS this is false in a Safari TAB and true in the installed home-screen
 * app — the single most confusing thing about web push, and the reason the UI
 * has to explain itself rather than just hiding a button.
 */
export const isPushSupported = () =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export const getPermission = () =>
  isPushSupported() ? Notification.permission : 'unsupported';

/** Is the app running as an installed PWA rather than in a browser tab? */
export const isStandalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true);

/** Whether the server has VAPID keys, plus the public one. */
export const getPushConfig = async () => {
  const { data } = await api.get('/api/notifications/push/key');
  return data;
};

/** A rough device name, so Settings can tell one row from another. */
const describeDevice = () => {
  const ua = navigator.userAgent || '';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac/.test(ua)
        ? 'Mac'
        : /Windows/.test(ua)
          ? 'Windows'
          : 'Device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Safari\//.test(ua)
        ? 'Safari'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : 'Browser';
  return `${browser} on ${os}`;
};

const postSubscription = async (subscription) => {
  const json = subscription.toJSON();
  await api.post('/api/notifications/push/subscribe', {
    endpoint: json.endpoint,
    keys: json.keys,
    deviceLabel: describeDevice(),
  });
};

/**
 * Ask for permission and subscribe this browser.
 *
 * Only ever call this from a real click. A permission prompt fired on load is
 * dismissed by reflex, and a dismissal is REMEMBERED — the browser will not ask
 * again, and there is no way back except the site settings panel most people
 * never find. One badly-timed prompt costs the feature permanently.
 *
 * Returns 'granted' | 'denied' | 'default' | 'unsupported' | 'unconfigured'.
 */
export const enablePush = async () => {
  if (!isPushSupported()) return 'unsupported';

  const { enabled, publicKey } = await getPushConfig();
  if (!enabled || !publicKey) return 'unconfigured';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;

  const registration = await navigator.serviceWorker.ready;
  // Reuse an existing subscription: re-subscribing mints a new endpoint and
  // orphans the old row, so the same browser ends up counted twice.
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ||
    (await registration.pushManager.subscribe({
      // Required to be true by every browser: a push must always be visible to
      // the user. Silent background pushes are not permitted.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await postSubscription(subscription);
  return 'granted';
};

/**
 * Unsubscribe this browser: dropped at the browser AND at the server.
 *
 * Both, in that order, because a subscription the browser has forgotten but the
 * server still holds is a push that will be sent, fail, and only then be pruned
 * — a notification the person explicitly turned off, delivered once more.
 */
export const disablePush = async () => {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const { endpoint } = subscription.toJSON();
  try {
    await subscription.unsubscribe();
  } finally {
    await api.delete('/api/notifications/push/subscribe', { data: { endpoint } });
  }
};

/** Is this browser currently subscribed? */
export const getSubscription = async () => {
  if (!isPushSupported() || Notification.permission !== 'granted') return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
};

/**
 * Re-post an existing subscription on boot.
 *
 * Silent and best-effort. It exists for the drift case: the browser is still
 * subscribed but the server no longer has the row — pruned after a run of
 * failures, or lost with the account. Without this the person sees a UI saying
 * notifications are ON and never receives one again.
 */
export const syncSubscription = async () => {
  try {
    const subscription = await getSubscription();
    if (subscription) await postSubscription(subscription);
  } catch {
    /* never let this surface: it is a repair, not a feature */
  }
};
