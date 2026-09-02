import { useEffect, useState, useCallback } from 'react';
import {
  getInstallState,
  promptInstall,
  onInstallStateChange,
} from '../utils/installPrompt';
import useToastStore from '../store/toastStore';

/**
 * The "Install app" affordance, shared by the avatar menu, the More sheet and
 * Settings. `state` is one of installed | prompt | ios | manual; `install()`
 * fires the real browser prompt when we hold one and otherwise explains the
 * manual route (iOS has no prompt API at all).
 */
export default function useInstallApp() {
  const [state, setState] = useState(getInstallState);

  useEffect(() => onInstallStateChange(() => setState(getInstallState())), []);

  const install = useCallback(async () => {
    const toast = useToastStore.getState();
    if (state === 'prompt') {
      const accepted = await promptInstall();
      if (accepted) toast.success('Macan is installing — check your home screen or dock.');
      return;
    }
    if (state === 'ios') {
      toast.info(
        'To install: tap the Share button in Safari, then "Add to Home Screen".',
        { duration: 8000 }
      );
      return;
    }
    toast.info(
      'To install: open your browser menu and choose "Install Macan" (or "Add to Home screen").',
      { duration: 8000 }
    );
  }, [state]);

  return { state, canOffer: state !== 'installed', install };
}
