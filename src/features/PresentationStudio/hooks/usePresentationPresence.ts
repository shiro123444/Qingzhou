import { useEffect, useRef } from 'react';

import type { PresentationStudioStoreHook } from '../store/presentationStore';

/** Presence belongs to the selected work, not merely an open application tab. */
export function usePresentationPresence(store: PresentationStudioStoreHook, jobId?: string | null) {
  const tabId = useRef(crypto.randomUUID()).current;
  useEffect(() => {
    if (!jobId) return;
    let queue = Promise.resolve();
    const publish = (leaving = false) => {
      const input = {
        tabId,
        visible: !leaving && document.visibilityState === 'visible',
        focused: !leaving && document.hasFocus(),
      };
      queue = queue.then(async () => {
        await store.getState().updatePresence(jobId, input);
      });
    };
    const update = () => publish();
    const leave = () => publish(true);
    publish();
    const timer = setInterval(update, 20_000);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    window.addEventListener('pagehide', leave);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [store, jobId, tabId]);
  return tabId;
}
