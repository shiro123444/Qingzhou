import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, expect, it, vi } from 'vitest';

import hotkey from '@/locales/default/hotkey';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';

import ToggleLeftPanelButton, {
  SIDEBAR_PANEL_ID,
  SidebarReopenButton,
} from './ToggleLeftPanelButton';

vi.hoisted(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    removeItem: (key: string) => entries.delete(key),
    setItem: (key: string, value: string) => entries.set(key, value),
  });
});

// Keep the real component and selectors; isolate account services and persisted preferences.
vi.mock('@/store/global', async () => {
  const { createWithEqualityFn } = await import('zustand/traditional');
  const { shallow } = await import('zustand/shallow');
  return {
    useGlobalStore: createWithEqualityFn(
      (set) => ({
        status: { showLeftPanel: true, zenMode: false },
        toggleLeftPanel: () =>
          set((state: { status: { showLeftPanel: boolean; zenMode: boolean } }) => ({
            status: { ...state.status, showLeftPanel: !state.status.showLeftPanel },
          })),
      }),
      shallow,
    ),
  };
});
vi.mock('@/store/user', () => ({ useUserStore: () => undefined }));
vi.mock('@/store/user/selectors', () => ({
  settingsSelectors: { getHotkeyById: () => () => undefined },
}));

function Workspace() {
  const expand = useGlobalStore(systemStatusSelectors.showLeftPanel);
  return (
    <>
      <aside aria-hidden={!expand} id={SIDEBAR_PANEL_ID} inert={!expand}>
        <ToggleLeftPanelButton />
      </aside>
      <header>
        <SidebarReopenButton />
      </header>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('offers one visible sidebar control and transfers keyboard focus when its location changes', async () => {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { hotkey } },
  });
  const rect = new DOMRect(0, 0, 32, 32);
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(
    Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) }),
  );
  render(
    <I18nextProvider i18n={i18n}>
      <Workspace />
    </I18nextProvider>,
  );
  expect(screen.getAllByRole('button')).toHaveLength(1);
  const collapse = screen.getByRole('button', { name: 'Collapse sidebar' });
  expect(collapse).toHaveAttribute('aria-expanded', 'true');
  collapse.focus();
  fireEvent.keyDown(collapse, { key: 'Enter' });
  const reopen = screen.getByRole('button', { name: 'Expand sidebar' });
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(reopen).toHaveAttribute('aria-controls', SIDEBAR_PANEL_ID);
  expect(reopen).toHaveAttribute('aria-expanded', 'false');
  await waitFor(() => expect(reopen).toHaveFocus());

  fireEvent.keyDown(reopen, { key: ' ' });
  await waitFor(() => expect(collapse).toHaveFocus());
  expect(screen.getAllByRole('button')).toHaveLength(1);
  fireEvent.click(collapse);
  expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
});
