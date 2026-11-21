import {
  lazy,
  type PropsWithChildren,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

import {
  BUILTIN_PLUGINS,
  builtinPluginForPath,
  isBuiltinPluginEnabled,
} from '@/config/builtinPlugins';
import { useAgentStore } from '@/store/agent';
import { agentSelectors, builtinAgentSelectors } from '@/store/agent/selectors';
import { builtinPluginSelectors, useServerConfigStore } from '@/store/serverConfig';
import { useUserStore } from '@/store/user';

import { BotSurfaceContext } from './context';
import { attachBotTrigger } from './trigger';

const BotQuestion = lazy(() => import('./BotQuestion'));

// The provider is keyed by identity and surface: pending UI and draft text never travel with a route or account switch.
export default function BotSurfaceHost({ children }: PropsWithChildren) {
  const { pathname } = useLocation();
  const source = builtinPluginForPath(pathname);
  const profile = useServerConfigStore(builtinPluginSelectors.enabled);
  const owner = useUserStore((s) => (s.isSignedIn ? s.user?.id : undefined));
  const active = useAgentStore((s) => s.activeAgentId || builtinAgentSelectors.inboxAgentId(s));
  const name = useAgentStore((s) =>
    active ? agentSelectors.getAgentMetaById(active)(s)?.title : undefined,
  );
  const enabled =
    !!owner &&
    !!active &&
    (!source || (isBuiltinPluginEnabled(source, profile) && BUILTIN_PLUGINS[source].botMention));
  const [request, setRequest] = useState<string>();
  const scope = JSON.stringify([owner, active, pathname, enabled]);
  const open = useCallback(() => setRequest(scope), [scope]);
  const { t } = useTranslation('chat');
  const surface = useMemo(
    () =>
      enabled && active && owner
        ? {
            agentId: active,
            ownerId: owner,
            plugin: source,
            name: name || t('computer.rail.bot'),
            open,
          }
        : null,
    [enabled, active, owner, source, name, open, t],
  );
  // Scope change dismisses an old request even when navigating back to the same URL.
  useEffect(() => {
    setRequest(undefined);
  }, [scope]);
  useEffect(() => {
    if (!enabled) return;
    return attachBotTrigger(open);
  }, [enabled, open]);
  return (
    <BotSurfaceContext value={surface}>
      {children}
      {surface && active && request === scope && (
        <Suspense fallback={null}>
          <BotQuestion
            agentId={active}
            close={() => setRequest(undefined)}
            key={scope}
            name={surface.name}
            source={source}
          />
        </Suspense>
      )}
    </BotSurfaceContext>
  );
}
