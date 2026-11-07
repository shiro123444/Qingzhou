import { Button } from '@lobehub/ui';
import { Alert, Select, Spin, Tag } from 'antd';
import { createStaticStyles } from 'antd-style';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { presentationLearningClient } from '@/services/runtime/trialClient';
import type { LearningEpisodeView } from '@/types/presentationTrial';

import TrialValidation from './TrialValidation';

const styles = createStaticStyles(({ css, cssVar }) => ({
  preview: css`
    width: 100%;
    max-width: 520px;
    border: 1px solid ${cssVar.colorBorderSecondary};
  `,
}));
const safePreview = (uri?: string) =>
  uri &&
  /^\/api\/runtime\/presentation\/artifacts\/learning-preview-[a-f0-9]{64}\?raw=true$/u.test(uri);
export default function TrialLearningHistory({
  jobId,
  slideId,
  visible,
  revision,
}: {
  jobId: string;
  slideId?: string;
  visible: boolean;
  revision: number;
}) {
  const { t } = useTranslation('common');
  const [episodes, setEpisodes] = useState<
    Pick<LearningEpisodeView, 'episodeId' | 'kind' | 'status' | 'outcome'>[]
  >([]);
  const [episodeId, setEpisodeId] = useState<string>(),
    [view, setView] = useState<LearningEpisodeView>();
  const [loading, setLoading] = useState(false),
    [failed, setFailed] = useState(false),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!visible || !slideId) return;
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    setEpisodes([]);
    setEpisodeId(undefined);
    setView(undefined);
    void presentationLearningClient
      .list(jobId, slideId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setEpisodes(value.episodes);
          setEpisodeId(value.episodes[0]?.episodeId);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [jobId, slideId, visible, revision, refresh]);
  useEffect(() => {
    if (!visible || !episodeId) return;
    const controller = new AbortController();
    setView(undefined);
    setFailed(false);
    setLoading(true);
    void presentationLearningClient
      .read(episodeId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setView(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [episodeId, visible, revision, refresh]);
  return (
    <section aria-label={t('presentationTrial.learning.title')}>
      <h3>{t('presentationTrial.learning.title')}</h3>
      <p>{t('presentationTrial.learning.boundary')}</p>
      <Button size="small" onClick={() => setRefresh((value) => value + 1)}>
        {t('presentationTrial.learning.refresh')}
      </Button>
      {loading && <Spin size="small" />}
      {failed && (
        <Alert role="alert" title={t('presentationTrial.learning.unavailable')} type="warning" />
      )}
      {!loading && !failed && episodes.length === 0 && (
        <p>{t('presentationTrial.learning.empty')}</p>
      )}
      {episodes.length > 0 && (
        <Select
          aria-label={t('presentationTrial.learning.select')}
          value={episodeId}
          options={episodes.map((item, index) => ({
            value: item.episodeId,
            label: `${index + 1}. ${t(`presentationTrial.learning.outcome.${item.outcome}` as 'presentationTrial.learning.outcome.failed')}`,
          }))}
          onChange={setEpisodeId}
        />
      )}
      {view && (
        <div>
          <Tag>{t('presentationTrial.learning.pending')}</Tag>
          <p>
            {t(
              `presentationTrial.learning.outcome.${view.outcome}` as 'presentationTrial.learning.outcome.failed',
            )}
          </p>
          <p>
            {t('presentationTrial.learning.cue', {
              title: view.cue.title ?? view.source.slideId,
              page: view.cue.slideNumber ?? view.source.slideId,
              ratio: view.cue.aspectRatio ?? '',
            })}
          </p>
          {view.failureCode && (
            <p>{t('presentationTrial.learning.failure', { code: view.failureCode })}</p>
          )}
          <p>
            {view.reasonProvided
              ? t('presentationTrial.learning.reason', { reason: view.reason })
              : t('presentationTrial.learning.noReason')}
          </p>
          {view.result && (
            <p>
              {t('presentationTrial.learning.version', {
                jobId: view.result.jobId,
                versionId: view.result.versionId,
              })}
            </p>
          )}
          {view.kind === 'decision' && view.outcome === 'candidate-adopted' && (
            <TrialValidation episodeId={view.episodeId} key={view.episodeId} />
          )}
          <ul>
            {view.variants.map((variant) => (
              <li key={variant.id}>
                {variant.id === 'baseline' ? t('presentationTrial.original') : variant.id}:{' '}
                {t('presentationTrial.learning.materials', {
                  configuration: variant.available.configuration
                    ? t('presentationTrial.learning.saved')
                    : t('presentationTrial.learning.missing'),
                  preview: variant.available.preview
                    ? t('presentationTrial.learning.saved')
                    : t('presentationTrial.learning.missing'),
                  evaluation: variant.available.evaluation
                    ? t('presentationTrial.learning.saved')
                    : t('presentationTrial.learning.missing'),
                })}
                {variant.configurationCompared && (
                  <p>
                    {t('presentationTrial.learning.delta', {
                      paths:
                        variant.changedPaths.join(', ') ||
                        t('presentationTrial.learning.unchanged'),
                    })}
                  </p>
                )}
                {variant.pageChanged !== undefined && (
                  <p>
                    {t(
                      variant.pageChanged
                        ? 'presentationTrial.learning.pageChanged'
                        : 'presentationTrial.learning.pageUnchanged',
                    )}
                  </p>
                )}
                {safePreview(variant.previewUri) && (
                  <img
                    alt={t('presentationTrial.learning.preview', { variant: variant.id })}
                    className={styles.preview}
                    src={variant.previewUri}
                  />
                )}
                <ul>
                  {Object.entries(variant.quality ?? {}).map(([name, value]) => (
                    <li key={name}>
                      {t(
                        `presentationTrial.dimension.${name}` as 'presentationTrial.dimension.readability',
                      )}
                      : {value.score}/4 — {value.evidence}
                    </li>
                  ))}
                  {Object.entries(variant.gates ?? {}).map(([name, value]) => (
                    <li key={name}>
                      {t(`presentationTrial.gate.${name}` as 'presentationTrial.gate.facts')}:{' '}
                      {t(
                        `presentationTrial.status.${value.status}` as 'presentationTrial.status.passed',
                      )}{' '}
                      — {value.evidence}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
