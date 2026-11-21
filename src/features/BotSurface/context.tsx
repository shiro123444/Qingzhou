import { Button } from '@lobehub/ui';
import { createContext, use } from 'react';
import { useTranslation } from 'react-i18next';

import type { BuiltinPluginId } from '@/config/builtinPlugins';

export const BotSurfaceContext = createContext<null | {
  agentId: string;
  ownerId: string;
  plugin?: BuiltinPluginId;
  name: string;
  open: () => void;
}>(null);
export function BotMentionButton() {
  const surface = use(BotSurfaceContext);
  const { t } = useTranslation('chat');
  return (
    surface && (
      <Button
        aria-label={t('botMention.ask', { name: surface.name })}
        size="small"
        type="text"
        onClick={surface.open}
      >
        @{surface.name}
      </Button>
    )
  );
}
