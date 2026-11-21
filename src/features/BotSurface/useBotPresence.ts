import { useContext } from 'react';
import useSWR from 'swr';

import { lambdaClient } from '@/libs/trpc/client';
import { useServerConfigStore } from '@/store/serverConfig';

import { BotSurfaceContext } from './context';

/** Optional read-only subscription. No browser frames, model calls or background timer after unmount. */
export function useBotPresence() {
  const surface = useContext(BotSurfaceContext);
  const native = useServerConfigStore((s) => s.serverConfig.agentRuntimeMode === 'native');
  return useSWR(
    surface && native ? ['botPresence', surface.ownerId, surface.agentId] : null,
    ([, , agentId]) => lambdaClient.aiAgent.botPresence.query({ agentId }),
    { refreshInterval: 5000, shouldRetryOnError: false },
  );
}
