import { Button } from '@lobehub/ui';
import { Alert, Select, Spin } from 'antd';
import { createStaticStyles } from 'antd-style';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { presentationValidationClient } from '@/services/runtime/trialClient';
import type { TrialValidationView, ValidationTargetOption } from '@/types/presentationValidation';

const styles = createStaticStyles(({ css }) => ({
  panel: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
  `,
  picker: css`
    width: 100%;
    max-width: 720px;
  `,
}));

export default function TrialValidation({ episodeId }: { episodeId: string }) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false),
    [targets, setTargets] = useState<ValidationTargetOption[]>([]),
    [selected, setSelected] = useState<string[]>([]);
  const [studies, setStudies] = useState<{ validationId: string }[]>([]),
    [validationId, setValidationId] = useState<string>(),
    [view, setView] = useState<TrialValidationView>();
  const [pending, setPending] = useState(false),
    [failed, setFailed] = useState(false),
    [revision, setRevision] = useState(0);
  const current = useRef(episodeId);
  current.current = episodeId;
  const request = useRef<{ signature: string; requestId: string } | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setPending(true);
    setFailed(false);
    setView(undefined);
    setSelected([]);
    setValidationId(undefined);
    void presentationValidationClient
      .options(episodeId, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setTargets(value.targets);
        setStudies(value.validations);
        setValidationId(value.validations[0]?.validationId);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => controller.abort();
  }, [episodeId, open, revision]);
  const active = view && ['running', 'cancelling'].includes(view.state);
  useEffect(() => {
    if (!open || !validationId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value = await presentationValidationClient.status(validationId, controller.signal);
        if (controller.signal.aborted) return;
        setView(value);
        setFailed(false);
        if (['running', 'cancelling'].includes(value.state))
          timer = setTimeout(() => void poll(), 1000);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, validationId, active]);
  const chosen = selected.map((value) => targets[Number(value)]).filter(Boolean);
  const mutate = async (operation: () => Promise<TrialValidationView>) => {
    const identity = episodeId;
    setPending(true);
    setFailed(false);
    try {
      const result = await operation();
      if (current.current !== identity) return;
      setView(result);
      setValidationId(result.validationId);
      setStudies((items) =>
        items.some((item) => item.validationId === result.validationId)
          ? items
          : [...items, { validationId: result.validationId }],
      );
    } catch {
      if (current.current === identity) setFailed(true);
    } finally {
      if (current.current === identity) setPending(false);
    }
  };
  const create = () => {
    const input = chosen.map(({ jobId, expectedVersionId, slideId }) => ({
      jobId,
      expectedVersionId,
      slideId,
    }));
    const signature = JSON.stringify([episodeId, input]);
    if (request.current?.signature !== signature) {
      try {
        const cached = JSON.parse(sessionStorage.getItem(`heldout-create:${episodeId}`) ?? 'null');
        if (cached?.signature === signature) request.current = cached;
      } catch {
        /* Browser storage is optional. */
      }
      if (request.current?.signature !== signature)
        request.current = { signature, requestId: crypto.randomUUID() };
      try {
        sessionStorage.setItem(`heldout-create:${episodeId}`, JSON.stringify(request.current));
      } catch {
        /* The server still enforces one-shot execution. */
      }
    }
    void mutate(() =>
      presentationValidationClient.create({
        episodeId,
        requestId: request.current!.requestId,
        targets: input,
        confirmed: true,
      }),
    );
  };
  return (
    <section aria-label={t('presentationTrial.validation.title')} className={styles.panel}>
      <Button size="small" onClick={() => setOpen((value) => !value)}>
        {t('presentationTrial.validation.title')}
      </Button>
      {open && (
        <>
          <p>{t('presentationTrial.validation.boundary')}</p>
          {pending && <Spin size="small" />}
          {failed && (
            <Alert role="alert" title={t('presentationTrial.validation.error')} type="warning" />
          )}
          <Button
            disabled={pending || Boolean(active)}
            size="small"
            onClick={() => setRevision((value) => value + 1)}
          >
            {t('presentationTrial.validation.refresh')}
          </Button>
          {!active && (
            <>
              <Select
                aria-label={t('presentationTrial.validation.targets')}
                className={styles.picker}
                disabled={pending}
                maxCount={2}
                mode="multiple"
                placeholder={t('presentationTrial.validation.targets')}
                value={selected}
                options={targets.map((target, index) => ({
                  value: String(index),
                  label: `${target.title} · ${t('presentationTrial.validation.page', { page: target.pageNumber })}`,
                }))}
                onChange={setSelected}
              />
              <Button
                disabled={
                  pending ||
                  chosen.length !== 2 ||
                  new Set(chosen.map((target) => target.jobId)).size !== 2
                }
                onClick={create}
              >
                {t('presentationTrial.validation.freeze')}
              </Button>
            </>
          )}
          {studies.length > 0 && (
            <Select
              aria-label={t('presentationTrial.validation.studies')}
              className={styles.picker}
              disabled={pending || Boolean(active)}
              placeholder={t('presentationTrial.validation.studies')}
              value={validationId}
              options={studies.map((study, index) => ({
                value: study.validationId,
                label: t('presentationTrial.validation.study', { number: index + 1 }),
              }))}
              onChange={(value) => {
                setView(undefined);
                setValidationId(value);
              }}
            />
          )}
          {view && (
            <>
              <p role="status">
                {t(
                  `presentationTrial.validation.state.${view.state}` as 'presentationTrial.validation.state.prepared',
                )}
              </p>
              <p>
                {t('presentationTrial.validation.budget', {
                  tokens: view.budget.maxTokens,
                  seconds: view.budget.maxDurationMs / 1000,
                })}
              </p>
              {view.state === 'prepared' && (
                <Button
                  disabled={pending}
                  onClick={() =>
                    void mutate(() => presentationValidationClient.start(view.validationId))
                  }
                >
                  {t('presentationTrial.validation.start')}
                </Button>
              )}
              {(view.state === 'prepared' || active) && (
                <Button
                  disabled={pending || view.state === 'cancelling'}
                  onClick={() =>
                    void mutate(() => presentationValidationClient.cancel(view.validationId))
                  }
                >
                  {t('presentationTrial.validation.cancel')}
                </Button>
              )}
              <p>
                {t(
                  `presentationTrial.validation.verdict.${view.verdict}` as 'presentationTrial.validation.verdict.pending',
                )}
              </p>
              <ul>
                {view.targets.map((target) => (
                  <li key={`${target.jobId}:${target.slideId}`}>
                    {target.title} ·{' '}
                    {t('presentationTrial.validation.page', { page: target.pageNumber })}:{' '}
                    {t(
                      `presentationTrial.validation.outcome.${target.outcome}` as 'presentationTrial.validation.outcome.not-started',
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
