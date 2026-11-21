import { Button } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { ChevronRight, Download } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import Link from '@/components/Link';
import { runtimeClient } from '@/services/runtime/client';
import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';

import { type PresentationChatOrigin, presentationCreatorHref } from './origin';

const styles = createStaticStyles(({ css, cssVar }) => ({
  card: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(100%, 340px);
    margin-block: 12px;
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 16px;
    background: color-mix(in srgb, ${cssVar.colorBgContainer} 88%, transparent);
    backdrop-filter: blur(16px);
  `,
  cover: css`
    display: block;
    width: 100%;
    aspect-ratio: 16/9;
    object-fit: contain;
    border-radius: 8px;
    background: ${cssVar.colorFillQuaternary};
  `,
  open: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-radius: 8px;
    color: ${cssVar.colorText};
    text-decoration: none;

    &:any-link:hover {
      color: ${cssVar.colorPrimary};
    }
    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }
  `,
  title: css`
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    > strong {
      min-width: 0;
      overflow-wrap: anywhere;
    }
  `,
  openLabel: css`
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    gap: 2px;
    font-size: 12px;
  `,
  actions: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  `,
  meta: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

// Only the message that initiated this generation mounts a receipt. Once resolved,
// refresh the individual job instead of enumerating the owner's work on each poll.
export default function DeliveryCard({
  origin,
  jobId,
}: {
  origin: PresentationChatOrigin;
  jobId?: string;
}) {
  const { t } = useTranslation('common');
  const labelId = useId();
  const owner = useUserStore(userProfileSelectors.userId);
  const lookup = useSWR(
    owner && !jobId
      ? ['presentation-delivery-origin', owner, origin.agentId, origin.topicId, origin.messageId]
      : null,
    async () => (await runtimeClient.listPresentationJobs(origin))[0] ?? null,
    { refreshInterval: (job) => (job ? 0 : 5000), revalidateOnFocus: false },
  );
  const id = jobId || lookup.data?.jobId;
  const live = useSWR(
    id && owner ? ['presentation-delivery-job', owner, id] : null,
    () => runtimeClient.getPresentationJob(id!),
    {
      refreshInterval: (job) => {
        if (job?.state === 'waiting_input') return 10000;
        return !job || job.state === 'running' || job.state === 'queued' ? 3000 : 0;
      },
    },
  );
  const candidate = live.data === undefined ? lookup.data : live.data;
  const job =
    candidate?.chatOrigin?.messageId === origin.messageId &&
    candidate.chatOrigin.topicId === origin.topicId &&
    candidate.chatOrigin.agentId === origin.agentId
      ? candidate
      : undefined;
  const ready = job?.state === 'completed' && job.delivery?.versionId === job.versionId;
  const delivery = ready ? job.delivery : undefined;
  // A job-bound card can mount before SWR has resolved its owner and message.
  // Keep that loading surface inert instead of linking to a fresh, unrelated brief.
  const url = job
    ? `/presentation?jobId=${encodeURIComponent(job.jobId)}`
    : !id && lookup.data === null && !lookup.error
      ? presentationCreatorHref(origin.agentId, origin.topicId)
      : undefined;
  const Surface = url ? Link : 'div';
  const state = job?.state;
  return (
    <article
      aria-label={t('presentationDelivery.label')}
      className={styles.card}
      data-testid="presentation-chat-delivery"
    >
      <Surface
        aria-labelledby={url ? `${labelId}-open ${labelId}-title` : undefined}
        className={styles.open}
        href={url}
      >
        {delivery?.coverId && (
          <img
            alt={t('presentationDelivery.cover')}
            className={styles.cover}
            src={`/api/runtime/presentation/artifacts/${encodeURIComponent(delivery.coverId)}?raw=true`}
          />
        )}
        <span className={styles.title}>
          <strong id={`${labelId}-title`}>{job?.title || t('presentationDelivery.label')}</strong>
          {url && (
            <span className={styles.openLabel} id={`${labelId}-open`}>
              {t('presentationDelivery.open')}
              <ChevronRight aria-hidden size={14} />
            </span>
          )}
        </span>
      </Surface>
      <div className={styles.actions}>
        <span className={styles.meta} role="status">
          {lookup.error || live.error
            ? t('presentationDelivery.syncError')
            : state
              ? t(`presentationDelivery.state.${state}`)
              : lookup.isLoading || live.isLoading
                ? t('presentationDelivery.loading')
                : t('presentationDelivery.unsubmitted')}
          {job?.slideCount
            ? ` · ${t('presentationDelivery.pages', { count: job.slideCount })}`
            : ''}
        </span>
        {delivery?.pptxId && (
          <Button
            download
            href={`/api/runtime/presentation/artifacts/${encodeURIComponent(delivery.pptxId)}/download`}
            icon={Download}
            size="small"
          >
            {t('presentationDelivery.download')}
          </Button>
        )}
      </div>
    </article>
  );
}
