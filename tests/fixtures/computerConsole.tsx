import { ThemeProvider } from '@lobehub/ui';
import { createInstance } from 'i18next';
import { createRoot } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { SWRConfig } from 'swr';

import Panel from '@/features/AgentComputer/Panel';
import chat from '@/locales/default/chat';

const i18n = createInstance();
await i18n
  .use(initReactI18next)
  .init({ lng: 'en', resources: { en: { chat } }, interpolation: { escapeValue: false } });
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <I18nextProvider i18n={i18n}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <Panel agentId="fixture" ownerId="fixture-owner" onClose={() => undefined} />
      </SWRConfig>
    </I18nextProvider>
  </ThemeProvider>,
);
