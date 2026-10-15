import { Button, Flexbox, Icon } from '@lobehub/ui';
import { Drawer, Segmented } from 'antd';
import { BookOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { TeachingSelection } from '@/types/presentationTeaching';

import { TeachingMemoryWorkspace } from './TeachingMemoryWorkspace';

export type PresentationCreationMode = 'presentation' | 'lesson';

export function CreationContextBar({
  disabled,
  mode,
  onModeChange,
  onSelectionChange,
  selection,
  template,
}: {
  disabled?: boolean;
  mode: PresentationCreationMode;
  onModeChange: (mode: PresentationCreationMode) => void;
  onSelectionChange: (selection: TeachingSelection) => void;
  selection: TeachingSelection;
  template?: { templateId: string; versionId?: string };
}) {
  const { t } = useTranslation('common');
  const [memoryOpened, setMemoryOpened] = useState(false);
  return (
    <Flexbox horizontal align="center" gap={12} paddingBlock={8} paddingInline={16} wrap="wrap">
      <Segmented
        aria-label={t('presentationCreation.mode')}
        disabled={disabled}
        value={mode}
        options={[
          { label: t('presentationCreation.presentation'), value: 'presentation' },
          { label: t('presentationCreation.lesson'), value: 'lesson' },
        ]}
        onChange={(next) => onModeChange(next as PresentationCreationMode)}
      />
      <Button
        disabled={disabled}
        icon={<Icon icon={BookOpen} size={16} />}
        size="small"
        type="text"
        onClick={() => setMemoryOpened(true)}
      >
        {selection.ids.length
          ? t('presentationCreation.memoriesSelected', { count: selection.ids.length })
          : t('presentationCreation.memories')}
      </Button>
      <Drawer
        open={memoryOpened}
        size={520}
        title={t('presentationTeaching.title')}
        onClose={() => setMemoryOpened(false)}
      >
        {memoryOpened && (
          <TeachingMemoryWorkspace
            disabled={disabled}
            selection={selection}
            template={template}
            onChange={(next) => {
              onSelectionChange(next);
              if (next.ids.length) onModeChange('lesson');
            }}
          />
        )}
      </Drawer>
    </Flexbox>
  );
}
