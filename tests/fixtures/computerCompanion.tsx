import { Markdown, ThemeProvider } from '@lobehub/ui';
import { createInstance } from 'i18next';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { BrowserRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';

import Companion from '@/features/AgentComputer/Companion';
import { CompanionLayout } from '@/features/AgentComputer/CompanionLayout';
import { StreamingReply, StreamingWord, streamWords } from '@/features/GlassMotion/StreamingReply';
import chat from '@/locales/default/chat';
import { liquidGlass } from '@/styles/liquidGlass';

import zhChat from '../../locales/zh-CN/chat.json';

const i18n = createInstance();
await i18n.use(initReactI18next).init({
  lng: new URLSearchParams(location.search).get('lang') ?? 'en',
  resources: { 'en': { chat }, 'zh-CN': { chat: zhChat } },
  interpolation: { escapeValue: false },
});
function Workspace() {
  const [reply, setReply] = useState('');
  return (
    <main
      data-qz-glass-scene
      className={liquidGlass}
      style={{
        height: '100vh',
        color: 'var(--ant-color-text)',
        background: location.search.includes('dark')
          ? 'linear-gradient(135deg, #23352f, #161b19 65%)'
          : 'linear-gradient(135deg, #e3eeea, #f6f7f6 65%)',
      }}
    >
      <CompanionLayout rail={<Companion agentId="fixture" name="Jumi" ownerId="fixture-owner" />}>
        <div style={{ padding: 40 }}>
          <p style={{ fontSize: 10, letterSpacing: '.16em', color: '#708078' }}>
            QINGZHOU · ISOLATED BROWSER VALIDATION
          </p>
          <h1 style={{ fontWeight: 500 }}>A companion, beside your work.</h1>
          <p>Real React components and an isolated container browser.</p>
          <textarea
            aria-label="Test composer"
            placeholder="Talk with your companion"
            style={{ width: 'min(100%, 500px)', minHeight: 80, marginTop: 24 }}
          />
          <p>
            <button data-qz-attention="music" type="button">
              Music workspace
            </button>
          </p>
          <button
            type="button"
            onClick={async () => {
              setReply('');
              for (const chunk of [
                '你好，',
                '我正在',
                '检查电脑。',
                '\n\nThe browser ',
                'is ready.',
                '\n\n```js\nconst status = "ready";\n```',
              ]) {
                await new Promise((resolve) => setTimeout(resolve, 70));
                setReply((value) => value + chunk);
              }
            }}
          >
            Validate streaming motion
          </button>
          <div style={{ maxWidth: 620, paddingTop: 24 }}>
            <StreamingReply streaming={!!reply}>
              <Markdown
                enableStream
                animated={false}
                components={{ span: StreamingWord }}
                rehypePlugins={[streamWords]}
              >
                {reply}
              </Markdown>
            </StreamingReply>
          </div>
        </div>
      </CompanionLayout>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <ThemeProvider appearance={location.search.includes('dark') ? 'dark' : 'light'}>
    <I18nextProvider i18n={i18n}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <BrowserRouter>
          <Workspace />
        </BrowserRouter>
      </SWRConfig>
    </I18nextProvider>
  </ThemeProvider>,
);
