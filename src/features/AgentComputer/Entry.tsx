import { ActionIcon } from '@lobehub/ui';
import { Monitor } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useServerConfigStore } from '@/store/serverConfig';
import { useUserStore } from '@/store/user';

const Panel = lazy(() => import('./Panel'));
export function AgentComputerButton({ agentId }: { agentId: string }) {
  const { t } = useTranslation('chat'),
    [open, setOpen] = useState(false);
  const enabled = useServerConfigStore(
    (s) => s.serverConfig.agentRuntimeMode === 'native' && s.serverConfig.agentComputerEnabled,
  );
  const ownerId = useUserStore((s) => (s.isSignedIn ? s.user?.id : undefined));
  if (!enabled || !ownerId || !agentId) return null;
  return (
    <>
      <ActionIcon
        aria-label={t('computer.open')}
        icon={Monitor}
        size={{ blockSize: 28, size: 16 }}
        title={t('computer.open')}
        onClick={() => setOpen(true)}
      />
      {open && (
        <Suspense fallback={null}>
          <Panel agentId={agentId} key={ownerId} ownerId={ownerId} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
