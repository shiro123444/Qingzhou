export const spring = (x: number, k: number, damping: number) => ({
  x,
  v: 0,
  target: x,
  k,
  damping,
});
export function advance(s: ReturnType<typeof spring>, dt: number) {
  s.v += (-s.k * (s.x - s.target) - s.damping * s.v) * dt;
  s.x += s.v * dt;
}

/** Read Along's independently sprung edges, driven by real text/lyric progress instead of a demo timer. */
export function createReadAlong(root: HTMLElement, pill: HTMLElement) {
  const left = spring(0, 520, 40),
    right = spring(0, 520, 40),
    top = spring(0, 600, 48),
    opacity = spring(0, 300, 30);
  const values = [left, right, top, opacity];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let current: HTMLElement | null = null,
    row: number | undefined,
    frame = 0,
    last = 0,
    disposed = false;
  const paint = () => {
    pill.style.transform = `translate(${left.x}px, ${top.x}px)`;
    pill.style.width = `${Math.max(0, right.x - left.x)}px`;
    pill.style.opacity = String(Math.min(1, Math.max(0, opacity.x)));
  };
  const tick = (now: number) => {
    frame = 0;
    if (disposed || document.hidden) return;
    const dt = Math.min((now - (last || now - 16)) / 1000, 1 / 30);
    last = now;
    for (let step = 0; step < 4; step++) values.forEach((value) => advance(value, dt / 4));
    paint();
    if (values.some((value) => Math.abs(value.x - value.target) > 0.01 || Math.abs(value.v) > 0.1))
      frame = requestAnimationFrame(tick);
    else last = 0;
  };
  const focus = (element: HTMLElement | null) => {
    if (disposed) return;
    if (current !== element) {
      current?.removeAttribute('data-read-current');
      current = element;
      current?.setAttribute('data-read-current', 'true');
    }
    opacity.target = element ? 1 : 0;
    if (element) {
      const parent = root.getBoundingClientRect(),
        box = element.getBoundingClientRect();
      const em = parseFloat(getComputedStyle(element).fontSize) || 14;
      const x = box.left - parent.left + root.scrollLeft - em * 0.16;
      const y = box.top - parent.top + root.scrollTop + (box.height - em * 1.3) / 2;
      const forward = x >= left.target;
      left.k = forward ? 210 : 520;
      left.damping = forward ? 26 : 40;
      right.k = forward ? 520 : 210;
      right.damping = forward ? 40 : 26;
      if (row === undefined || Math.abs(y - row) > 2 || opacity.x < 0.05) {
        left.x = x;
        left.v = 0;
        right.x = x;
        right.v = 0;
        top.x = y;
        top.v = 0;
      }
      row = y;
      left.target = x;
      right.target = x + box.width + em * 0.32;
      top.target = y;
      pill.style.height = `${em * 1.3}px`;
    }
    if (reduced.matches) {
      values.forEach((value) => {
        value.x = value.target;
        value.v = 0;
      });
      paint();
    } else if (!frame && !document.hidden) frame = requestAnimationFrame(tick);
  };
  const resize = () => focus(current);
  const visibility = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
    if (!document.hidden) resize();
  };
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
  observer?.observe(root);
  reduced.addEventListener('change', resize);
  document.addEventListener('visibilitychange', visibility);
  return {
    focus,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      current?.removeAttribute('data-read-current');
      reduced.removeEventListener('change', resize);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
