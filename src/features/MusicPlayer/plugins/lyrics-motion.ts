import { activeLyric, type LyricLine, lyricWordProgress } from '../lyrics';

export const LYRICS_FOLLOW_DELAY = 5000;

/** Local optical updates only: this loop never writes playback or plugin stores. */
export function createLyricsMotion({
  container,
  getPositionMs,
  isPlaying,
  lines,
  onFollowingChange,
}: {
  container: HTMLDivElement;
  getPositionMs: () => number;
  isPlaying: () => boolean;
  lines: readonly Readonly<LyricLine>[];
  onFollowingChange: (following: boolean) => void;
}) {
  const rows = [...container.querySelectorAll<HTMLElement>('[data-lyric-line]')];
  const words = rows.map((row) => [...row.querySelectorAll<HTMLElement>('[data-lyric-word]')]);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let active = true;
  let frame = 0;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let following = true;
  let current = -2;
  let velocity = 0;
  let target = container.scrollTop;
  let writtenScroll = container.scrollTop;
  let lastFrame = 0;
  let lastPosition = 0;
  let needsTarget = true;
  let firstCenter = true;

  const paintWord = (element: HTMLElement | undefined, progress: number, state: string) => {
    if (!element) return;
    const value = (progress * 100).toFixed(2) + '%';
    if (element.style.getPropertyValue('--lyric-progress') !== value)
      element.style.setProperty('--lyric-progress', value);
    if (element.dataset.state !== state) element.dataset.state = state;
  };
  const wake = () => {
    if (active && !document.hidden && !frame) frame = requestAnimationFrame(tick);
  };
  const resume = () => {
    if (!active) return;
    clearTimeout(resumeTimer);
    following = true;
    velocity = 0;
    needsTarget = true;
    writtenScroll = container.scrollTop;
    onFollowingChange(true);
    wake();
  };
  const suspend = () => {
    if (!active) return;
    clearTimeout(resumeTimer);
    following = false;
    velocity = 0;
    writtenScroll = container.scrollTop;
    onFollowingChange(false);
    resumeTimer = setTimeout(resume, LYRICS_FOLLOW_DELAY);
  };
  function tick(now: number) {
    frame = 0;
    if (!active || document.hidden) return;
    let position: number;
    try {
      position = getPositionMs();
    } catch {
      return;
    }
    if (!Number.isFinite(position)) return;
    const index = activeLyric(lines, position);
    if (Math.abs(position - lastPosition) > 1500) velocity = 0;
    lastPosition = position;
    if (index !== current) {
      current = index;
      needsTarget = true;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        const state = rowIndex < current ? 'past' : rowIndex === current ? 'current' : 'future';
        if (row.dataset.lineState === state) continue;
        row.dataset.lineState = state;
        row.setAttribute('aria-current', String(rowIndex === current));
        if (rowIndex !== current)
          for (const word of words[rowIndex])
            paintWord(word, rowIndex < current ? 1 : 0, rowIndex < current ? 'sung' : 'future');
      }
    }
    for (let wordIndex = 0; wordIndex < (lines[current]?.words?.length ?? 0); wordIndex++) {
      const word = lines[current].words![wordIndex];
      paintWord(
        words[current]?.[wordIndex],
        lyricWordProgress(word, position),
        position < word.timeMs
          ? 'future'
          : position < word.timeMs + word.durationMs
            ? 'current'
            : 'sung',
      );
    }
    if (following && needsTarget) {
      const row = rows[current];
      const height = container.clientHeight;
      container.style.setProperty('--lyrics-center-padding', `${height / 2}px`);
      target = row
        ? Math.max(
            0,
            Math.min(
              container.scrollHeight - height,
              container.scrollTop +
                row.getBoundingClientRect().top -
                container.getBoundingClientRect().top +
                row.getBoundingClientRect().height / 2 -
                height / 2,
            ),
          )
        : 0;
      needsTarget = false;
    }
    let moving = false;
    if (following) {
      const currentScroll = container.scrollTop;
      const delta = target - currentScroll;
      if (firstCenter || reduced.matches || (Math.abs(delta) < 0.35 && Math.abs(velocity) < 2)) {
        container.scrollTop = target;
        velocity = 0;
        firstCenter = false;
      } else {
        const dt = Math.min(0.032, Math.max(0.001, (now - (lastFrame || now - 16)) / 1000));
        velocity += (180 * delta - 23 * velocity) * dt;
        container.scrollTop = currentScroll + velocity * dt;
        moving = true;
      }
      writtenScroll = container.scrollTop;
    }
    lastFrame = now;
    if (isPlaying() || moving) wake();
  }
  const onScroll = () => {
    if (Math.abs(container.scrollTop - writtenScroll) > 1) suspend();
  };
  const onKey = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key))
      suspend();
  };
  const visibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
    } else {
      needsTarget = true;
      wake();
    }
  };
  const resize = () => {
    needsTarget = true;
    wake();
  };
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
  observer?.observe(container);
  container.addEventListener('wheel', suspend, { passive: true });
  container.addEventListener('touchstart', suspend, { passive: true });
  container.addEventListener('scroll', onScroll, { passive: true });
  container.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', visibility);
  reduced.addEventListener('change', resize);
  wake();
  return {
    resume,
    wake,
    dispose() {
      active = false;
      cancelAnimationFrame(frame);
      clearTimeout(resumeTimer);
      observer?.disconnect();
      container.removeEventListener('wheel', suspend);
      container.removeEventListener('touchstart', suspend);
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', visibility);
      reduced.removeEventListener('change', resize);
    },
  };
}
