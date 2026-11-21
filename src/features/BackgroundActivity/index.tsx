import { ActionIcon } from '@lobehub/ui';
import { Activity } from 'lucide-react';
import { lazy, memo, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DESKTOP_HEADER_ICON_SMALL_SIZE } from '@/const/layoutTokens';
import { useServerConfigStore } from '@/store/serverConfig';
import { useUserStore } from '@/store/user';

const ActivityPanel = lazy(() => import('./Panel'));

export const BackgroundActivityButton = memo(() => {
  const { t } = useTranslation('chat');
  const enabled = useServerConfigStore((s) => s.serverConfig.agentRuntimeMode === 'native');
  const ownerId = useUserStore((s) => (s.isSignedIn ? s.user?.id : undefined));
  const [open, setOpen] = useState(false);

  if (!enabled || !ownerId) return null;
  return (
    <>
      <ActionIcon
        aria-label={t('backgroundActivity.title')}
        icon={Activity}
        size={DESKTOP_HEADER_ICON_SMALL_SIZE}
        title={t('backgroundActivity.title')}
        onClick={() => setOpen(true)}
      />
      {open && (
        <Suspense fallback={null}>
          <ActivityPanel key={ownerId} ownerId={ownerId} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
});
