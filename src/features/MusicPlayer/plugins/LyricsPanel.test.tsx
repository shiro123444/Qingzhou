import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import music from '@/locales/default/music';

import { AudioEngine } from '../engine';
import { parseKrc, parseLrc } from '../lyrics';
import { MusicPluginsProvider } from './context';
import { LYRICS_FOLLOW_DELAY } from './lyrics-motion';
import LyricsPanel from './LyricsPanel';
import { MusicPluginHost } from './runtime';
import { type LyricsPluginView } from './types';

let frameId = 0;
let now = 0;
let frames: Map<number, FrameRequestCallback>;
let hidden = false;
let reduced = false;
const engines: AudioEngine[] = [];
beforeEach(() => {
  i18n.addResourceBundle('zh-CN', 'music', music);
  vi.useFakeTimers();
  frames = new Map();
  hidden = false;
  reduced = false;
  now = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.spyOn(window, 'matchMedia').mockImplementation(
    () =>
      ({
        get matches() {
          return reduced;
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  cleanup();
  engines.splice(0).forEach((engine) => engine.dispose());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function step(count = 1) {
  act(() => {
    for (let frame = 0; frame < count; frame++) {
      now += 16;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(now));
    }
  });
}
function setup(wordTimed = true) {
  let position = 0;
  const engine = new AudioEngine({
    storage: { getItem: () => null, removeItem: () => {}, setItem: () => {} },
  });
  engines.push(engine);
  const host = new MusicPluginHost(engine, { storage: null });
  const lines = wordTimed
    ? parseKrc('[0,2000]<0,1000,0>Hello <1000,1000,0>world\n[3000,2000]<0,2000,0>Next')
    : parseLrc('[00:00]Hello world\n[00:03]Next');
  const seekLine = vi.fn((index: number) => {
    position = lines[index].timeMs;
    host.store.setState({ lyrics: { ...host.store.getState().lyrics!, positionMs: position } });
  });
  const getPositionMs = vi.fn(() => position);
  const lyrics: LyricsPluginView = {
    currentLine: 0,
    durationMs: 5000,
    getPositionMs,
    lines,
    playbackStatus: 'playing',
    positionMs: 0,
    retry: vi.fn(),
    seekLine,
    source: 'kugou',
    status: 'ready',
    trackId: 'song',
    trackName: 'Song',
  };
  host.store.setState({ status: 'active', userId: 'listener', lyrics });
  const page = (visible: boolean) => (
    <I18nextProvider i18n={i18n}>
      <MusicPluginsProvider host={host}>
        <LyricsPanel visible={visible} />
      </MusicPluginsProvider>
    </I18nextProvider>
  );
  const view = render(page(true));
  const container = screen.getByLabelText(music.lyrics) as HTMLDivElement;
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 });
  Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 900 });
  vi.spyOn(container, 'getBoundingClientRect').mockImplementation(
    () => ({ top: 0, height: 300 }) as DOMRect,
  );
  const rows = [...container.querySelectorAll<HTMLElement>('[data-lyric-line]')];
  rows.forEach((row, index) =>
    vi
      .spyOn(row, 'getBoundingClientRect')
      .mockImplementation(
        () => ({ top: 150 + index * 180 - container.scrollTop, height: 60 }) as DOMRect,
      ),
  );
  return {
    container,
    getPositionMs,
    host,
    page,
    rows,
    seekLine,
    setPosition: (value: number) => {
      position = value;
    },
    view,
  };
}

it('fills only real KRC word groups from the precise clock without publishing global state', () => {
  const { container, host, rows, setPosition } = setup();
  const before = host.store.getState();
  setPosition(500);
  step();
  const words = container.querySelectorAll<HTMLElement>('[data-lyric-word]');
  expect(rows[0]).toHaveAttribute('aria-current', 'true');
  expect(words[0]).toHaveAttribute('data-state', 'current');
  expect(words[0].style.getPropertyValue('--lyric-progress')).toBe('50.00%');
  setPosition(1500);
  step();
  expect(words[0]).toHaveAttribute('data-state', 'sung');
  expect(words[1].style.getPropertyValue('--lyric-progress')).toBe('50.00%');
  setPosition(250);
  step();
  expect(words[0].style.getPropertyValue('--lyric-progress')).toBe('25.00%');
  expect(words[1]).toHaveAttribute('data-state', 'future');
  expect(host.store.getState()).toBe(before);
});

it('centers with a spring, lets manual scrolling rest, and resumes on request or after the delay', async () => {
  const { container, setPosition } = setup();
  step();
  expect(container.scrollTop).toBe(30);
  setPosition(3500);
  step();
  expect(container.scrollTop).toBeGreaterThan(30);
  expect(container.scrollTop).toBeLessThan(210);
  step(100);
  expect(container.scrollTop).toBeCloseTo(210, 0);
  fireEvent.wheel(container, { deltaY: -120 });
  container.scrollTop = 50;
  fireEvent.scroll(container);
  step(10);
  expect(container.scrollTop).toBe(50);
  fireEvent.click(screen.getByRole('button', { name: music.lyricsResumeFollowing }));
  step(100);
  expect(container.scrollTop).toBeCloseTo(210, 0);
  fireEvent.wheel(container);
  expect(screen.getByRole('button', { name: music.lyricsResumeFollowing })).toBeVisible();
  await act(() => vi.advanceTimersByTimeAsync(LYRICS_FOLLOW_DELAY));
  expect(
    screen.queryByRole('button', { name: music.lyricsResumeFollowing }),
  ).not.toBeInTheDocument();
});

it('stops hidden and paused animation, wakes precisely on paused seeks, and respects reduced motion', () => {
  const { container, getPositionMs, host, page, rows, setPosition, view } = setup();
  step();
  hidden = true;
  fireEvent(document, new Event('visibilitychange'));
  expect(frames.size).toBe(0);
  const calls = getPositionMs.mock.calls.length;
  step(60);
  expect(getPositionMs).toHaveBeenCalledTimes(calls);
  hidden = false;
  reduced = true;
  setPosition(3500);
  act(() =>
    host.store.setState({
      lyrics: { ...host.store.getState().lyrics!, playbackStatus: 'paused', positionMs: 3500 },
    }),
  );
  fireEvent(document, new Event('visibilitychange'));
  step();
  expect(rows[1]).toHaveAttribute('aria-current', 'true');
  expect(container.scrollTop).toBe(210);
  expect(frames.size).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: 'Hello world' }));
  step();
  expect(rows[0]).toHaveAttribute('aria-current', 'true');
  expect(container.scrollTop).toBe(30);
  expect(frames.size).toBe(0);
  view.rerender(page(false));
  expect(frames.size).toBe(0);
});

it('keeps LRC at line level without fabricated word timing', () => {
  const { container, rows, setPosition } = setup(false);
  setPosition(3500);
  step();
  expect(rows[1]).toHaveAttribute('aria-current', 'true');
  expect(container.querySelector('[data-lyric-word]')).toBeNull();
});
