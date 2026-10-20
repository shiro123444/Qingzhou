import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { PresentationMaterials } from '@/types/presentationMaterial';

export const MaterialContextPanel = memo<{ materials?: PresentationMaterials }>(({ materials }) => {
  const { t } = useTranslation('common');
  if (!materials) return null;
  return (
    <details>
      <summary>{t('presentationStoryboard.materials')}</summary>
      {materials.documents.map((document) => (
        <p key={document.sourceId}>
          {document.name} ·{' '}
          {t('presentationStoryboard.materialCoverage', {
            read: materials.segments.filter((segment) => segment.sourceId === document.sourceId)
              .length,
            total: document.totalSegments,
          })}
        </p>
      ))}
      {materials.artifacts?.map((artifact) => (
        <p key={artifact.id}>
          <a download={artifact.name} href={artifact.url}>
            {artifact.name}
          </a>
        </p>
      ))}
    </details>
  );
});

MaterialContextPanel.displayName = 'MaterialContextPanel';
