type PreferenceListener = (allowed: boolean) => void;

interface PreferenceRegistry {
  allowed: boolean;
  dispose: () => void;
  listeners: Set<PreferenceListener>;
}

let registry: PreferenceRegistry | undefined;

/**
 * One preference source drives both optical backends. Chromium can omit a MediaQueryList
 * change event during SVG image/style work, so a cheap state check also catches silent changes.
 * No rendering or capture is requested when the three preference booleans are unchanged.
 */
export function watchGlassPreferences(listener: PreferenceListener) {
  if (!registry) {
    const reduced = matchMedia('(prefers-reduced-transparency: reduce)');
    const contrast = matchMedia('(prefers-contrast: more)');
    const read = () => !reduced.matches && !contrast.matches && !document.hidden;
    const current: PreferenceRegistry = {
      allowed: read(),
      dispose: () => {},
      listeners: new Set(),
    };
    const refresh = () => {
      const allowed = read();
      if (allowed === current.allowed) return;
      // Events update the same state as the poll, including disable/restore within one interval.
      current.allowed = allowed;
      for (const subscriber of current.listeners) subscriber(allowed);
    };
    reduced.addEventListener('change', refresh);
    contrast.addEventListener('change', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 100);
    current.dispose = () => {
      window.clearInterval(timer);
      reduced.removeEventListener('change', refresh);
      contrast.removeEventListener('change', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
    registry = current;
  }
  const current = registry;
  current.listeners.add(listener);
  listener(current.allowed);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    current.listeners.delete(listener);
    if (!current.listeners.size) {
      current.dispose();
      if (registry === current) registry = undefined;
    }
  };
}
