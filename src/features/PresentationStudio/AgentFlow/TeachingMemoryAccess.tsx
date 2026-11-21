import { Button, Icon } from '@lobehub/ui';
import { Drawer } from 'antd';
import { BookOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { TeachingSelection } from '@/types/presentationTeaching';

import { TeachingMemoryWorkspace } from './TeachingMemoryWorkspace';

export function TeachingMemoryAccess({
  disabled,
  selection,
  template,
  onChange,
}: {
  disabled?: boolean;
  selection: TeachingSelection;
  template?: { templateId: string; versionId?: string };
  onChange: (selection: TeachingSelection) => void;
}) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        disabled={disabled}
        icon={<Icon icon={BookOpen} />}
        type="text"
        onClick={() => setOpen(true)}
      >
        {selection.ids.length
          ? t('presentationCreation.memoriesSelected', { count: selection.ids.length })
          : t('presentationTeaching.title')}
      </Button>
      <Drawer
        open={open}
        size={520}
        title={t('presentationTeaching.title')}
        onClose={() => setOpen(false)}
      >
        {open && (
          <TeachingMemoryWorkspace
            disabled={disabled}
            selection={selection}
            onChange={onChange}
            template={template}
          />
        )}
      </Drawer>
    </>
  );
}
