import { Button } from '@lobehub/ui';
import { Alert, Input, Modal, Radio, Select, Spin, Tag } from 'antd';
import { createStaticStyles } from 'antd-style';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { presentationTrialClient, TrialRequestError } from '@/services/runtime/trialClient';
import type { TrialReviewView } from '@/types/presentationTrial';

import TrialLaunch from './TrialLaunch';
import TrialLearningHistory from './TrialLearningHistory';

const styles = createStaticStyles(({ css, cssVar }) => ({
  toolbar: css`
    display: flex;
    justify-content: flex-end;
  `,
  cards: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 16px;
    width: 100%;
  `,
  card: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
  `,
  preview: css`
    aspect-ratio: 16 / 9;
    width: 100%;
    object-fit: contain;
    background: ${cssVar.colorFillQuaternary};
  `,
  evidence: css`
    margin: 0;
    padding-inline-start: 20px;
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
  space: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
}));
const previewUri = (value?: string) =>
  value && /^\/api\/runtime\/presentation\/artifacts\/[\w-]+\?raw=true$/u.test(value)
    ? value
    : undefined;
export default function TrialComparison({
  jobId,
  versionId,
  slideId,
  disabled,
  onCreated,
}: {
  jobId: string;
  versionId?: string;
  slideId?: string;
  disabled?: boolean;
  onCreated?: (jobId: string) => Promise<void> | void;
}) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [pending, setPending] = useState(false);
  const [trials, setTrials] = useState<{ runId: string }[]>([]),
    [runId, setRunId] = useState<string>();
  const [review, setReview] = useState<TrialReviewView>(),
    [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>(),
    [notice, setNotice] = useState<string>(),
    [blocked, setBlocked] = useState(false);
  const [reason, setReason] = useState(''),
    [learningRevision, setLearningRevision] = useState(0);
  const [loadedImages, setLoadedImages] = useState<Set<string>>(() => new Set());
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
  const revision = useRef(0),
    busy = useRef(false),
    request = useRef<{ key: string; id: string } | undefined>(undefined);
  useEffect(() => {
    setOpen(false);
    setReview(undefined);
    setSelected(undefined);
    setRunId(undefined);
    setBlocked(false);
    setNotice(undefined);
    request.current = undefined;
  }, [jobId, versionId, slideId]);
  useEffect(() => {
    if (!open || !slideId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setTrials([]);
    setRunId(undefined);
    void presentationTrialClient
      .list(jobId, slideId, controller.signal)
      .then(({ trials }) => {
        if (!controller.signal.aborted) {
          setTrials((previous) => [
            ...previous,
            ...trials.filter((item) => !previous.some((existing) => existing.runId === item.runId)),
          ]);
          setRunId((previous) => previous ?? trials[0]?.runId);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(t('presentationTrial.error'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, jobId, slideId, t]);
  useEffect(() => {
    const current = ++revision.current,
      controller = new AbortController();
    setReview(undefined);
    setSelected(undefined);
    setReason('');
    setFailedImages(new Set());
    setLoadedImages(new Set());
    setNotice(undefined);
    setError(undefined);
    setBlocked(false);
    if (open && runId) {
      setLoading(true);
      void presentationTrialClient
        .read(runId, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted && current === revision.current) setReview(value);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(t('presentationTrial.error'));
        })
        .finally(() => {
          if (!controller.signal.aborted && current === revision.current) setLoading(false);
        });
    }
    return () => {
      revision.current = current + 1;
      controller.abort();
    };
  }, [open, runId, jobId, versionId, slideId, t]);
  const trialCompleted = useCallback((completedRunId: string) => {
    setTrials((previous) => [
      { runId: completedRunId },
      ...previous.filter((item) => item.runId !== completedRunId),
    ]);
    setRunId(completedRunId);
    setLearningRevision((value) => value + 1);
  }, []);
  const learningRecorded = useCallback(() => setLearningRevision((value) => value + 1), []);
  const stale = Boolean(
    review &&
    (review.source.jobId !== jobId ||
      review.source.versionId !== versionId ||
      review.source.slideId !== slideId),
  );
  const chosen = review?.variants.find(({ id }) => id === selected);
  const confirm = async () => {
    if (
      !review ||
      !chosen?.selectable ||
      busy.current ||
      stale ||
      blocked ||
      failedImages.size ||
      review.variants.some(({ id }) => !loadedImages.has(id))
    )
      return;
    const current = revision.current;
    const key = JSON.stringify([review.evidenceDigest, selected, reason.trim()]);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      const result = await presentationTrialClient.choose({
        jobId,
        runId: review.runId,
        evidenceDigest: review.evidenceDigest,
        expectedVersionId: review.source.versionId,
        variantId: chosen.id,
        requestId: request.current.id,
        confirmed: true,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      if (current !== revision.current) return;
      setBlocked(true);
      setLearningRevision((value) => value + 1);
      setNotice(
        t(result.status === 'created' ? 'presentationTrial.created' : 'presentationTrial.kept'),
      );
      if (result.learningStatus === 'pending')
        setError(t('presentationTrial.learning.pendingWrite'));
      if (result.status === 'created') {
        try {
          await onCreated?.(result.jobId);
        } catch {
          setError(t('presentationTrial.openFailed'));
        }
      }
    } catch (cause) {
      if (current !== revision.current) return;
      const conflict = cause instanceof TrialRequestError && cause.code === 'PRESENTATION_CONFLICT';
      if (conflict) setBlocked(true);
      setError(t(conflict ? 'presentationTrial.conflict' : 'presentationTrial.error'));
    } finally {
      busy.current = false;
      if (current === revision.current) setPending(false);
    }
  };
  return (
    <div className={styles.toolbar}>
      <Button disabled={disabled || !versionId || !slideId} onClick={() => setOpen(true)}>
        {t('presentationTrial.open')}
      </Button>
      <Modal
        closable={!pending}
        mask={{ closable: !pending }}
        open={open}
        title={t('presentationTrial.title')}
        width={1100}
        footer={[
          <Button disabled={pending} key="close" onClick={() => setOpen(false)}>
            {t('presentationTrial.close')}
          </Button>,
          <Button
            key="confirm"
            loading={pending}
            type="primary"
            disabled={
              !chosen?.selectable ||
              stale ||
              blocked ||
              loading ||
              failedImages.size > 0 ||
              review?.variants.some(({ id }) => !loadedImages.has(id)) ||
              review?.variants.some((variant) => !previewUri(variant.previewUri))
            }
            onClick={() => void confirm()}
          >
            {t(
              selected === 'baseline'
                ? 'presentationTrial.confirmKeep'
                : 'presentationTrial.confirmCreate',
            )}
          </Button>,
        ]}
        onCancel={() => {
          if (!busy.current) setOpen(false);
        }}
      >
        <div className={styles.space}>
          <p>{t('presentationTrial.hint')}</p>
          <TrialLaunch
            disabled={disabled || pending}
            jobId={jobId}
            slideId={slideId}
            versionId={versionId}
            visible={open}
            onCompleted={trialCompleted}
            onLearningRecorded={learningRecorded}
          />
          {trials.length > 1 && (
            <Select
              aria-label={t('presentationTrial.selectRun')}
              disabled={pending}
              value={runId}
              options={trials.map(({ runId }, index) => ({
                value: runId,
                label: t('presentationTrial.run', { number: index + 1 }),
              }))}
              onChange={setRunId}
            />
          )}
          {loading && <Spin />}
          {!loading && !trials.length && !error && <p>{t('presentationTrial.empty')}</p>}
          {(stale || error) && (
            <Alert
              role="alert"
              title={stale ? t('presentationTrial.conflict') : error}
              type="error"
            />
          )}
          {notice && <Alert role="status" title={notice} type="success" />}
          {review && (
            <Input.TextArea
              showCount
              aria-label={t('presentationTrial.learning.reasonLabel')}
              disabled={pending || blocked || stale}
              maxLength={1000}
              placeholder={t('presentationTrial.learning.reasonPlaceholder')}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
          <TrialLearningHistory
            jobId={jobId}
            revision={learningRevision}
            slideId={slideId}
            visible={open}
          />
          {review?.proposal && (
            <Alert
              description={review.proposal.rationale}
              type="info"
              title={t('presentationTrial.proposal.title', {
                dimension: t(
                  `presentationTrial.proposal.${review.proposal.dimension}` as 'presentationTrial.proposal.layoutStrategy',
                ),
                value: t(
                  `presentationTrial.proposal.${review.proposal.value}` as 'presentationTrial.proposal.grouped',
                ),
                count: review.proposal.experienceCount,
              })}
            />
          )}
          {review?.improvement && (
            <Alert
              type="info"
              description={
                review.improvement.refinementFailed
                  ? t('presentationTrial.serial.fallback')
                  : t('presentationTrial.serial.incumbentGuide')
              }
              title={t('presentationTrial.serial.review', {
                round: review.improvement.selectedRound,
                tokens: review.improvement.charged.tokens,
              })}
            />
          )}
          <Radio.Group
            aria-label={t('presentationTrial.choice')}
            className={styles.cards}
            disabled={pending || stale || blocked}
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {review?.variants.map((variant, index) => (
              <section className={styles.card} key={variant.id}>
                <Radio
                  value={variant.id}
                  disabled={
                    pending ||
                    stale ||
                    blocked ||
                    !variant.selectable ||
                    failedImages.has(variant.id)
                  }
                >
                  {variant.id === 'baseline'
                    ? t('presentationTrial.original')
                    : t('presentationTrial.candidate', { number: index })}
                </Radio>
                {review.recommendedId === variant.id && (
                  <Tag>{t('presentationTrial.recommended')}</Tag>
                )}
                {previewUri(variant.previewUri) ? (
                  <img
                    className={styles.preview}
                    src={variant.previewUri}
                    alt={
                      variant.id === 'baseline'
                        ? t('presentationTrial.original')
                        : t('presentationTrial.candidate', { number: index })
                    }
                    onLoad={() => setLoadedImages((previous) => new Set([...previous, variant.id]))}
                    onError={() =>
                      setFailedImages((previous) => new Set([...previous, variant.id]))
                    }
                  />
                ) : (
                  <Alert title={t('presentationTrial.previewUnavailable')} type="warning" />
                )}
                {failedImages.has(variant.id) && (
                  <Alert title={t('presentationTrial.previewUnavailable')} type="warning" />
                )}
                <ul className={styles.evidence}>
                  {Object.entries(variant.quality ?? {}).map(([name, quality]) => (
                    <li key={name}>
                      {t(
                        `presentationTrial.dimension.${name}` as 'presentationTrial.dimension.readability',
                      )}
                      : {quality.score}/4 — {quality.evidence}
                    </li>
                  ))}
                  {Object.entries(variant.gates ?? {}).map(([name, gate]) => (
                    <li key={name}>
                      {t(`presentationTrial.gate.${name}` as 'presentationTrial.gate.facts')}:{' '}
                      {t(
                        `presentationTrial.status.${gate.status}` as 'presentationTrial.status.passed',
                      )}{' '}
                      — {gate.evidence}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </Radio.Group>
        </div>
      </Modal>
    </div>
  );
}
