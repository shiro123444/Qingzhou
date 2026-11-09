import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import LazyMusicSession from './LazyMusicSession';
import type { MusicSession } from './session';
import { useMusicActivation } from './session-context';

afterEach(cleanup);

const session = () => ({
  engine: { dispose: vi.fn(), flush: vi.fn(), setAccount: vi.fn() },
  plugins: { start: vi.fn(), stop: vi.fn() },
});

it('keeps music dormant until requested and preserves child state across activation and navigation', async () => {
  const runtime = session();
  const load = vi.fn().mockResolvedValue(runtime);
  const mount = vi.fn();
  const Child = () => {
    const [value, setValue] = useState('');
    useEffect(mount, []);
    return (
      <input aria-label="draft" value={value} onChange={(event) => setValue(event.target.value)} />
    );
  };
  const page = (active: boolean, userId = 'alice') => (
    <LazyMusicSession active={active} load={load} userId={userId}>
      <Child />
    </LazyMusicSession>
  );
  const view = render(page(false));
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'unfinished chat' } });
  expect(load).not.toHaveBeenCalled();
  view.rerender(page(true));
  await waitFor(() => expect(runtime.plugins.start).toHaveBeenCalledTimes(1));
  view.rerender(page(false));
  expect(load).toHaveBeenCalledTimes(1);
  expect(runtime.engine.dispose).not.toHaveBeenCalled();
  expect(screen.getByLabelText('draft')).toHaveValue('unfinished chat');
  expect(mount).toHaveBeenCalledTimes(1);
  view.rerender(page(false, 'bob'));
  expect(runtime.engine.setAccount).toHaveBeenLastCalledWith('bob');
  view.unmount();
  expect(runtime.engine.dispose).toHaveBeenCalledTimes(1);
  expect(runtime.plugins.stop).toHaveBeenCalledTimes(1);
});

it('releases a session whose lazy import finishes after unmount', async () => {
  const runtime = session();
  let resolve!: (value: MusicSession) => void;
  const load = () =>
    new Promise<MusicSession>((done) => {
      resolve = done;
    });
  const view = render(<LazyMusicSession active load={load} userId="alice" />);
  view.unmount();
  await act(async () => resolve(runtime as unknown as MusicSession));
  expect(runtime.engine.setAccount).not.toHaveBeenCalled();
  expect(runtime.plugins.start).not.toHaveBeenCalled();
  expect(runtime.plugins.stop).toHaveBeenCalledTimes(1);
  expect(runtime.engine.dispose).toHaveBeenCalledTimes(1);
});

it('lets an unsuccessful activation retry without resetting the application', async () => {
  const runtime = session();
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error('chunk unavailable'))
    .mockResolvedValue(runtime);
  const Status = () => {
    const state = useMusicActivation();
    return (
      <button onClick={state.retry}>
        {state.error ? 'retry' : state.ready ? 'ready' : 'loading'}
      </button>
    );
  };
  render(
    <LazyMusicSession active load={load} userId="alice">
      <Status />
    </LazyMusicSession>,
  );
  fireEvent.click(await screen.findByText('retry'));
  await screen.findByText('ready');
  expect(load).toHaveBeenCalledTimes(2);
});
