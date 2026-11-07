import { Button } from '@lobehub/ui';
import { Alert, Checkbox, Space, Spin } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { presentationTrialClient, TrialRequestError } from '@/services/runtime/trialClient';
import type { TrialWorkspaceStatus } from '@/types/presentationTrial';

export default function TrialLaunch({
  jobId,
  versionId,
  slideId,
  visible,
  disabled,
  onCompleted,
  onLearningRecorded,
}: {
  jobId: string;
  versionId?: string;
  slideId?: string;
  visible: boolean;
  disabled?: boolean;
  onCompleted: (runId: string) => void;
  onLearningRecorded?: (episodeId: string) => void;
}) {
  const { t } = useTranslation('common');
  const [serial, setSerial] = useState(false);
  const [status, setStatus] = useState<TrialWorkspaceStatus>(),
    [error, setError] = useState<string>(),
    [pollError, setPollError] = useState<string>(),
    [pending, setPending] = useState(false),
    [ready, setReady] = useState(false),
    [refresh, setRefresh] = useState(0);
  const busy = useRef(false),
    seen = useRef<string | undefined>(undefined);
  const context = `${jobId}:${versionId}:${slideId}${serial ? ':serial' : ''}`;
  const current = useRef(context);
  current.current = context;
  const intent = useRef<string | undefined>(undefined);
  const seenLearning = useRef<string | undefined>(undefined);
  const storageKey = `qingzhou-page-trial:${context}`;
  const remember = (requestId?: string) => {
    intent.current = requestId;
    try {
      if (requestId) sessionStorage.setItem(storageKey, requestId);
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* Storage may be disabled; the server still deduplicates request identities. */
    }
  };
  useEffect(() => {
    setStatus(undefined);
    setReady(false);
    setError(undefined);
    seen.current = undefined;
    seenLearning.current = undefined;
    intent.current = undefined;
  }, [context]);
  useEffect(() => {
    if (!visible || !slideId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value = await presentationTrialClient.status(jobId, slideId, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(value);
        setReady(true);
        setPollError(undefined);
        const execution = value.execution;
        if (execution && ['running', 'cancelling'].includes(execution.state))
          setSerial(execution.mode === 'serial');
        if (execution?.learningEpisodeId && seenLearning.current !== execution.learningEpisodeId) {
          seenLearning.current = execution.learningEpisodeId;
          onLearningRecorded?.(execution.learningEpisodeId);
        }
        if (
          execution?.state === 'completed' &&
          execution.runId &&
          seen.current !== execution.runId
        ) {
          seen.current = execution.runId;
          onCompleted(execution.runId);
        }
        if (execution && ['running', 'cancelling'].includes(execution.state))
          timer = setTimeout(() => void poll(), 1000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setReady(false);
        setPollError(
          t(
            cause instanceof TrialRequestError && cause.status === 404
              ? 'presentationTrial.launchUnavailable'
              : 'presentationTrial.error',
          ),
        );
        if (!(cause instanceof TrialRequestError && cause.status === 404))
          timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [visible, jobId, versionId, slideId, refresh, onCompleted, onLearningRecorded, t, serial]);
  const active = status?.execution && ['running', 'cancelling'].includes(status.execution.state);
  const start = async () => {
    if (busy.current || active || !ready || !versionId || !slideId || disabled) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    const target = context;
    try {
      if (!intent.current) {
        try {
          intent.current = sessionStorage.getItem(storageKey) ?? undefined;
        } catch {
          /* Optional local recovery. */
        }
      }
      if (!intent.current) remember(crypto.randomUUID());
      const value = await presentationTrialClient.start({
        jobId,
        expectedVersionId: versionId,
        slideId,
        requestId: intent.current!,
        confirmed: true,
        ...(serial ? { mode: 'serial' as const } : {}),
      });
      if (current.current !== target) return;
      setStatus(value);
      remember(undefined);
      setRefresh((count) => count + 1);
    } catch (cause) {
      if (current.current !== target) return;
      setError(
        t(
          cause instanceof TrialRequestError && cause.code === 'PRESENTATION_CONFLICT'
            ? 'presentationTrial.conflict'
            : 'presentationTrial.error',
        ),
      );
      setRefresh((count) => count + 1);
    } finally {
      busy.current = false;
      if (current.current === target) setPending(false);
    }
  };
  const cancel = async () => {
    if (busy.current || !status?.execution) return;
    const target = context;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      const value = await presentationTrialClient.cancel(status.execution.executionId);
      if (current.current === target) {
        setStatus(value);
        setRefresh((count) => count + 1);
      }
    } catch {
      if (current.current === target) {
        setError(t('presentationTrial.error'));
        setRefresh((count) => count + 1);
      }
    } finally {
      busy.current = false;
      if (current.current === target) setPending(false);
    }
  };
  const execution = status?.execution;
  const budget = serial
    ? (status?.serialBudget ?? status?.budget)
    : (status?.singleBudget ?? status?.budget);
  return (
    <section aria-label={t('presentationTrial.launchTitle')}>
      <Checkbox
        checked={serial}
        disabled={!status?.serialBudget || pending || Boolean(active)}
        onChange={(event) => setSerial(event.target.checked)}
      >
        {t('presentationTrial.serial.enable')}
      </Checkbox>
      {serial && <p>{t('presentationTrial.serial.boundary')}</p>}
      {status && (
        <p>
          {t(serial ? 'presentationTrial.serial.budget' : 'presentationTrial.launchBudget', {
            tokens: budget!.maxTokens,
            seconds: budget!.maxDurationMs / 1000,
          })}
        </p>
      )}
      <Space wrap>
        <Button
          disabled={disabled || !versionId || !slideId || !ready || Boolean(active)}
          loading={pending && !active}
          onClick={() => void start()}
        >
          {t('presentationTrial.start')}
        </Button>
        {active && (
          <Button
            disabled={pending || execution?.state === 'cancelling'}
            onClick={() => void cancel()}
          >
            {t('presentationTrial.cancel')}
          </Button>
        )}
        {active && (
          <>
            <Spin size="small" />
            <span role="status">
              {execution?.mode === 'serial' &&
                execution.round &&
                t('presentationTrial.serial.round', { round: execution.round })}
              {t(
                execution?.state === 'cancelling'
                  ? 'presentationTrial.execution.cancelling'
                  : (`presentationTrial.phase.${execution?.phase}` as 'presentationTrial.phase.preparing'),
              )}
            </span>
          </>
        )}
      </Space>
      {execution?.learningStatus === 'pending' && !active && (
        <div>
          <Alert title={t('presentationTrial.learning.attemptPending')} type="warning" />
          <Button size="small" onClick={() => setRefresh((value) => value + 1)}>
            {t('presentationTrial.learning.retryArchive')}
          </Button>
        </div>
      )}
      {(error || pollError) && <Alert role="alert" title={error || pollError} type="error" />}
      {execution && !active && execution.state !== 'completed' && (
        <Alert
          role="status"
          type="warning"
          title={t(
            execution.errorCode === 'TRIAL_SOURCE_CHANGED'
              ? 'presentationTrial.conflict'
              : execution.errorCode === 'TRIAL_VISION_REQUIRED'
                ? 'presentationTrial.visionRequired'
                : (`presentationTrial.execution.${execution.state}` as 'presentationTrial.execution.failed'),
          )}
        />
      )}
    </section>
  );
}
