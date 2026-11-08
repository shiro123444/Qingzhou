/** Browser-only fixture: real M2 components and M1 client, fixture-owned HTTP storage/auth. */
import { ThemeProvider } from '@lobehub/ui';
import { cx } from 'antd-style';
import i18n from 'i18next';
import { StrictMode, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';

import LiquidGlass from '@/features/LiquidGlass';
import { MusicPlayerProvider } from '@/features/MusicPlayer/context';
import { AudioEngine } from '@/features/MusicPlayer/engine';
import PlayerShell from '@/features/MusicPlayer/PlayerShell';
import { useMusicPlugins } from '@/features/MusicPlayer/plugins/context';
import { type MusicPluginHost } from '@/features/MusicPlayer/plugins/runtime';
import MusicStudio from '@/features/MusicStudio';
import music from '@/locales/default/music';
import { MusicClient } from '@/services/music/client';
import { glassSurface, liquidGlass, liquidGlassBackdrop } from '@/styles/liquidGlass';

import GlassLab from './glassLab';

void i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { music } },
  defaultNS: 'music',
  interpolation: { escapeValue: false },
});

const test = {
  audio: undefined as HTMLAudioElement | undefined,
  audioCount: 0,
  engine: undefined as AudioEngine | undefined,
  plugins: undefined as MusicPluginHost | undefined,
};
const client = new MusicClient(fetch, {
  upload: async (file, controller) => {
    const response = await fetch('/fixture/upload', {
      method: 'PUT',
      body: await file.arrayBuffer(),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('upload');
    return response.json();
  },
  register: async (input) => {
    const response = await fetch('/fixture/register', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return response.json();
  },
});
const engine = new AudioEngine({
  client,
  createAudio: () => {
    test.audioCount++;
    return (test.audio = new Audio());
  },
});
test.engine = engine;
Object.assign(window, { musicTest: test });

function PluginProbe() {
  const plugins = useMusicPlugins();
  useLayoutEffect(() => {
    test.plugins = plugins;
  }, [plugins]);
  return null;
}

function Fixture() {
  const [userId, setUserId] = useState<string | null>('alice');
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider
        appearance="light"
        defaultAppearance="light"
        defaultThemeMode="light"
        theme={{ cssVar: { key: 'lobe-vars' } }}
      >
        <BrowserRouter>
          <LiquidGlass />
          <div
            data-qz-glass-scene
            className={cx(liquidGlass, liquidGlassBackdrop)}
            style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}
          >
            <nav style={{ display: 'flex', gap: 20, padding: 12 }}>
              <Link to="/music">Music</Link>
              <Link to="/chat">Chat</Link>
              <Link to="/presentation">Presentation</Link>
              <button onClick={() => setUserId(null)}>Sign out</button>
            </nav>
            <div
              className={glassSurface}
              data-qz-glass="shell"
              style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}
            >
              <MusicPlayerProvider engine={engine} userId={userId}>
                <PluginProbe />
                <PlayerShell>
                  <Routes>
                    <Route element={<GlassLab />} path="/glass-lab" />
                    <Route element={<MusicStudio />} path="/music" />
                    <Route
                      path="/chat"
                      element={
                        <>
                          <h1>Chat workspace</h1>
                          <div
                            data-music-player-avoid="composer"
                            style={{
                              position: 'fixed',
                              right: 20,
                              bottom: 20,
                              width: 'min(640px, calc(100vw - 40px))',
                              height: 148,
                              border: '1px solid #c8d8db',
                              borderRadius: 24,
                              background: '#f5f9f9',
                            }}
                          >
                            Chat input
                          </div>
                        </>
                      }
                    />
                    <Route element={<h1>Presentation workspace</h1>} path="/presentation" />
                  </Routes>
                </PlayerShell>
              </MusicPlayerProvider>
            </div>
          </div>
        </BrowserRouter>
      </ThemeProvider>
    </I18nextProvider>
  );
}

createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
