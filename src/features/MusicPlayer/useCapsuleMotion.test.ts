import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { CAPSULE_MOTION_MS, useCapsuleMotion } from './useCapsuleMotion';

class MotionPreference extends EventTarget {
  matches = false;
}

let media: MotionPreference;

beforeEach(() => {
  vi.useFakeTimers();
  media = new MotionPreference();
  vi.spyOn(window, 'matchMedia').mockImplementation(() => media as unknown as MediaQueryList);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('keeps optics live through an interrupted morph and the full replacement popup spring', () => {
  const { result, rerender } = renderHook(
    ({ collapsed, open }) => useCapsuleMotion(collapsed, open),
    {
      initialProps: { collapsed: true, open: false },
    },
  );
  expect(result.current).toBe(false);
  rerender({ collapsed: false, open: false });
  expect(result.current).toBe(true);
  act(() => vi.advanceTimersByTime(300));
  rerender({ collapsed: false, open: true });
  act(() => vi.advanceTimersByTime(CAPSULE_MOTION_MS - 1));
  expect(result.current).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(result.current).toBe(false);
});

it('honours reduced motion immediately and cancels animation work on unmount', () => {
  const { result, rerender, unmount } = renderHook(
    ({ collapsed }) => useCapsuleMotion(collapsed, false),
    {
      initialProps: { collapsed: true },
    },
  );
  rerender({ collapsed: false });
  expect(result.current).toBe(true);
  act(() => {
    media.matches = true;
    media.dispatchEvent(new Event('change'));
  });
  expect(result.current).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  rerender({ collapsed: true });
  expect(result.current).toBe(false);
  act(() => {
    media.matches = false;
    media.dispatchEvent(new Event('change'));
  });
  rerender({ collapsed: false });
  expect(result.current).toBe(true);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('waits for a late-starting CSS transition and its final layout before ending the optical loop', () => {
  const animation = { pending: false, playState: 'running' };
  const element = document.createElement('section');
  Object.defineProperty(element, 'getAnimations', { value: () => [animation] });
  const dock = { current: element };
  const { result, rerender } = renderHook(
    ({ collapsed }) => useCapsuleMotion(collapsed, false, dock),
    {
      initialProps: { collapsed: true },
    },
  );
  rerender({ collapsed: false });
  act(() => vi.advanceTimersByTime(CAPSULE_MOTION_MS + 40));
  expect(result.current).toBe(true);
  animation.playState = 'finished';
  act(() => vi.advanceTimersToNextFrame());
  expect(result.current).toBe(true);
  act(() => vi.advanceTimersToNextFrame());
  expect(result.current).toBe(true);
  act(() => vi.advanceTimersToNextFrame());
  expect(result.current).toBe(false);
});
