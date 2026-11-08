import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { watchGlassPreferences } from './preferences';

class ControlledMedia extends EventTarget {
  matches = false;

  constructor(readonly media: string) {
    super();
  }

  set(matches: boolean, dispatch = true) {
    this.matches = matches;
    if (dispatch) this.dispatchEvent(new Event('change'));
  }
}

const CONTRAST = '(prefers-contrast: more)';
const REDUCED = '(prefers-reduced-transparency: reduce)';
let queries: Map<string, ControlledMedia>;
let cleanups: Array<() => void>;
let hidden = false;
const watch = (listener: (allowed: boolean) => void) => {
  const cleanup = watchGlassPreferences(listener);
  cleanups.push(cleanup);
  return cleanup;
};

beforeEach(() => {
  queries = new Map();
  cleanups = [];
  hidden = false;
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const media = new ControlledMedia(query);
    queries.set(query, media);
    return media as unknown as MediaQueryList;
  });
});

afterEach(() => {
  cleanups.forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('shared optical preferences', () => {
  it('updates both backends immediately using one pair of media queries', () => {
    const svg = vi.fn();
    const gpu = vi.fn();
    watch(svg);
    watch(gpu);
    expect(window.matchMedia).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    queries.get(CONTRAST)!.set(true);
    expect(svg.mock.calls).toEqual([[true], [false]]);
    expect(gpu.mock.calls).toEqual([[true], [false]]);
    queries.get(CONTRAST)!.set(false);
    expect(svg).toHaveBeenLastCalledWith(true);
    expect(gpu).toHaveBeenLastCalledWith(true);
  });

  it('detects silent disable and restore when the browser omits change events', () => {
    const listener = vi.fn();
    watch(listener);
    queries.get(REDUCED)!.set(true, false);
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenLastCalledWith(false);
    queries.get(REDUCED)!.set(false, false);
    vi.advanceTimersByTime(100);
    expect(listener.mock.calls).toEqual([[true], [false], [true]]);
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('recovers a silent restore even when disable/restore occurs within one polling interval', () => {
    const listener = vi.fn();
    watch(listener);
    queries.get(CONTRAST)!.set(true);
    queries.get(CONTRAST)!.set(false, false);
    vi.advanceTimersByTime(100);
    expect(listener.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('stops while hidden and releases every listener and timer after the last unsubscribe', () => {
    const svg = vi.fn();
    const gpu = vi.fn();
    const stopSvg = watch(svg);
    const stopGpu = watch(gpu);
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(gpu).toHaveBeenLastCalledWith(false);
    stopSvg();
    expect(vi.getTimerCount()).toBe(1);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(svg.mock.calls).toEqual([[true], [false]]);
    expect(gpu).toHaveBeenLastCalledWith(true);
    const oldContrast = queries.get(CONTRAST)!;
    stopGpu();
    stopGpu();
    expect(vi.getTimerCount()).toBe(0);
    oldContrast.set(true);
    expect(gpu.mock.calls).toEqual([[true], [false], [true]]);
    const remounted = vi.fn();
    watch(remounted);
    expect(remounted.mock.calls).toEqual([[true]]);
    expect(window.matchMedia).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);
  });
});
