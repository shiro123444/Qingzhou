import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import { initServerConfigStore, Provider } from '@/store/serverConfig/store';

import { builtinPluginElement } from '.';

afterEach(cleanup);

it('does not import a disabled route, blocks direct URLs, and permits enabled routes', async () => {
  const store = initServerConfigStore({
    serverConfig: { aiProvider: {}, builtinPlugins: [], telemetry: {} },
  });
  const load = vi.fn(async () => ({ default: () => <div>music workspace</div> }));
  const tree = () => (
    <Provider createStore={() => store}>
      <MemoryRouter initialEntries={['/music']}>
        <Routes>
          <Route element={<div>home</div>} path="/" />
          <Route element={builtinPluginElement('music', load)} path="/music" />
        </Routes>
      </MemoryRouter>
    </Provider>
  );
  const view = render(tree());
  await screen.findByText('home');
  expect(load).not.toHaveBeenCalled();
  view.unmount();
  store.setState({ serverConfig: { aiProvider: {}, builtinPlugins: ['music'], telemetry: {} } });
  render(tree());
  await screen.findByText('music workspace');
  expect(load).toHaveBeenCalledTimes(1);
  act(() =>
    store.setState({ serverConfig: { aiProvider: {}, builtinPlugins: [], telemetry: {} } }),
  );
  await screen.findByText('home');
});

it('waits for server bootstrap instead of activating the default profile early', async () => {
  const store = initServerConfigStore({ serverConfigInit: false });
  const load = vi.fn(async () => ({ default: () => <div>ready</div> }));
  render(
    <Provider createStore={() => store}>
      <MemoryRouter>{builtinPluginElement('music', load)}</MemoryRouter>
    </Provider>,
  );
  expect(load).not.toHaveBeenCalled();
  act(() => store.setState({ serverConfigInit: true }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  await screen.findByText('ready');
});
