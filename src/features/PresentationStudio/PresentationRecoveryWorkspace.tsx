import { Button } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { JUMI_AVATAR, JUMI_NAME } from '@/const/jumi';
import ToggleLeftPanelButton from '@/features/NavPanel/ToggleLeftPanelButton';

import type { PresentationJob } from '../../../packages/runtime-contracts/src';

const styles = createStaticStyles(({ css, cssVar }) => ({
  workspace: css`
    display: flex;
    flex: 1;
    flex-direction: column;

    width: 100%;
    min-height: 0;
  `,
  header: css`
    display: flex;
    flex-shrink: 0;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding: 12px;

    font-size: 13px;
    color: ${cssVar.colorTextSecondary};

    span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  center: css`
    overflow: auto;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 20px;
    align-items: center;
    justify-content: center;

    min-height: 0;
    padding: 24px;

    text-align: center;

    img {
      width: 64px;
      height: 64px;
      object-fit: contain;
    }

    h2 {
      margin: 0;
      font-size: 22px;
      font-weight: 500;
    }

    p {
      max-width: 420px;
      margin: 0;

      font-size: 14px;
      line-height: 1.8;
      color: ${cssVar.colorTextSecondary};
    }
  `,
}));

export default function PresentationRecoveryWorkspace({
  job,
  title,
  busy,
  history,
  onRetry,
  onNew,
  showSidebarReopen,
}: {
  busy: boolean;
  history: ReactNode;
  job: PresentationJob;
  onNew: () => void;
  onRetry: (jobId: string) => Promise<void>;
  showSidebarReopen?: boolean;
  title?: string;
}) {
  const { t } = useTranslation('common');
  return (
    <section
      className={styles.workspace}
      data-state={job.state}
      data-testid="presentation-recovery-workspace"
    >
      <header className={styles.header}>
        {showSidebarReopen && <ToggleLeftPanelButton />}
        <span title={title}>{title}</span>
        {history}
      </header>
      <div className={styles.center} role="status">
        <img alt={JUMI_NAME} src={JUMI_AVATAR} />
        <h2>
          {t(
            job.state === 'cancelled'
              ? 'presentationRecovery.paused'
              : 'presentationRecovery.interrupted',
          )}
        </h2>
        <p>{t('presentationRecovery.preserved')}</p>
        <Button
          aria-label="Retry presentation job"
          disabled={busy}
          loading={busy}
          type="primary"
          onClick={() => void onRetry(job.jobId)}
        >
          {t('presentationRecovery.resume')}
        </Button>
        <Button type="text" onClick={onNew}>
          {t('presentationTemplates.newPresentation')}
        </Button>
      </div>
    </section>
  );
}
