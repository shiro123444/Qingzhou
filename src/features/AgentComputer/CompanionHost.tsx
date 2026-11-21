import { lazy, type PropsWithChildren, Suspense } from 'react';

import { useAgentStore } from '@/store/agent';
import { agentSelectors, builtinAgentSelectors } from '@/store/agent/selectors';
import { useServerConfigStore } from '@/store/serverConfig';
import { useUserStore } from '@/store/user';

import { CompanionLayout } from './CompanionLayout';

const Companion = lazy(() => import('./Companion'));

export default function CompanionHost({ children }: PropsWithChildren) {
  const enabled = useServerConfigStore(
    (s) => s.serverConfig.agentRuntimeMode === 'native' && s.serverConfig.agentComputerEnabled,
  );
  const ownerId = useUserStore((s) => (s.isSignedIn ? s.user?.id : undefined));
  const agentId = useAgentStore((s) => s.activeAgentId || builtinAgentSelectors.inboxAgentId(s));
  const name = useAgentStore((s) =>
    agentId ? agentSelectors.getAgentMetaById(agentId)(s)?.title : undefined,
  );
  return (
    <CompanionLayout
      rail={
        enabled && ownerId && agentId ? (
          <Suspense fallback={null}>
            <Companion
              agentId={agentId}
              key={`${ownerId}:${agentId}`}
              name={name ?? undefined}
              ownerId={ownerId}
            />
          </Suspense>
        ) : undefined
      }
    >
      {children}
    </CompanionLayout>
  );
}
