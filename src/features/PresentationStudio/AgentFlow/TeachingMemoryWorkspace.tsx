import { Button, Flexbox } from '@lobehub/ui';
import { Alert, Checkbox, Input, InputNumber } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type TeachingRecord,
  type TeachingSelection,
  teachingSourceReferenceSchema,
} from '@/types/presentationTeaching';

import { teachingClient } from './teachingClient';
import { TeachingVisualEvidence } from './TeachingVisualEvidence';

interface Props {
  client?: typeof teachingClient;
  disabled?: boolean;
  onChange: (selection: TeachingSelection) => void;
  selection: TeachingSelection;
  template?: { templateId: string; versionId?: string };
}

function PatternReview({
  record,
  disabled,
  onReview,
}: {
  record: TeachingRecord;
  disabled: boolean;
  onReview: (
    action: 'confirm' | 'revoke',
    course: string,
    applicability: string,
    limitations: string,
  ) => Promise<void>;
}) {
  const { t } = useTranslation('common');
  const [course, setCourse] = useState(record.review?.course ?? '');
  const [applicability, setApplicability] = useState(
    record.review?.applicability ?? record.pattern.applicability,
  );
  const [limitations, setLimitations] = useState(
    record.review?.limitations ?? record.pattern.limitations,
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [visualReady, setVisualReady] = useState(!record.source.visualPages?.length);
  const pattern = record.pattern;
  return (
    <Flexbox gap={8}>
      <strong>
        {pattern.name} · {t(`presentationTeaching.status.${record.status}`)}
      </strong>
      <span>
        {record.source.name} · {t('presentationTeaching.sourceVersion')}: {record.source.versionId}
      </span>
      <span>
        {t('presentationTeaching.observation')}: {pattern.observation}
      </span>
      <span>
        {t('presentationTeaching.inference')}: {pattern.inference} ({pattern.confidence})
      </span>
      <span>
        {t('presentationTeaching.prerequisites')}: {pattern.prerequisites}
      </span>
      <span>
        {t('presentationTeaching.teacherAction')}: {pattern.teacherAction}
      </span>
      <span>
        {t('presentationTeaching.learnerAction')}: {pattern.learnerAction}
      </span>
      <ol>
        {pattern.sequence.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <details>
        <summary>{t('presentationTeaching.evidence')}</summary>
        {pattern.evidence.map((item, i) => (
          <blockquote key={i}>
            {t('presentationTeaching.page', { page: item.page })} · {item.field}: {item.quote}
          </blockquote>
        ))}
      </details>
      {record.source.visualPages?.length ? (
        <TeachingVisualEvidence record={record} onReady={setVisualReady} />
      ) : null}
      <label>
        {t('presentationTeaching.course')}
        <Input
          disabled={disabled}
          value={course}
          onChange={(e) => {
            setCourse(e.target.value);
            setAcknowledged(false);
          }}
        />
      </label>
      <label>
        {t('presentationTeaching.applicability')}
        <Input.TextArea
          disabled={disabled}
          value={applicability}
          onChange={(e) => {
            setApplicability(e.target.value);
            setAcknowledged(false);
          }}
        />
      </label>
      <label>
        {t('presentationTeaching.limitations')}
        <Input.TextArea
          disabled={disabled}
          value={limitations}
          onChange={(e) => {
            setLimitations(e.target.value);
            setAcknowledged(false);
          }}
        />
      </label>
      <Checkbox
        checked={acknowledged}
        disabled={disabled || !visualReady}
        onChange={(e) => setAcknowledged(e.target.checked)}
      >
        {t('presentationTeaching.acknowledge')}
      </Checkbox>
      <Flexbox horizontal gap={8}>
        <Button
          disabled={
            disabled ||
            !visualReady ||
            !acknowledged ||
            !applicability.trim() ||
            !limitations.trim()
          }
          onClick={() => void onReview('confirm', course, applicability, limitations)}
        >
          {t('presentationTeaching.confirm')}
        </Button>
        {record.status !== 'revoked' && (
          <Button
            disabled={disabled}
            onClick={() => void onReview('revoke', course, applicability, limitations)}
          >
            {t(
              record.status === 'pending'
                ? 'presentationTeaching.dismiss'
                : 'presentationTeaching.revoke',
            )}
          </Button>
        )}
      </Flexbox>
    </Flexbox>
  );
}

export function TeachingMemoryWorkspace({
  template,
  selection,
  onChange,
  disabled = false,
  client = teachingClient,
}: Props) {
  const { t } = useTranslation('common');
  const [records, setRecords] = useState<TeachingRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [windowStart, setWindowStart] = useState<number | null>(null);
  const [windowEnd, setWindowEnd] = useState<number | null>(null);
  const [visual, setVisual] = useState(false);
  const [pageList, setPageList] = useState('');
  const active = useRef(true);
  const requestVersion = useRef(0);
  useEffect(() => {
    active.current = true;
    const version = ++requestVersion.current;
    setBusy(true);
    void client
      .list()
      .then((next) => {
        if (active.current && requestVersion.current === version) setRecords(next);
      })
      .catch((error) => {
        if (active.current && requestVersion.current === version) setError(String(error.message));
      })
      .finally(() => {
        if (active.current && requestVersion.current === version) setBusy(false);
      });
    return () => {
      active.current = false;
    };
  }, [client]);
  const perform = async (action: () => Promise<TeachingRecord[]>) => {
    const version = ++requestVersion.current;
    setBusy(true);
    setError(undefined);
    onChange({ ...selection, ids: [] });
    try {
      const next = await action();
      if (active.current && requestVersion.current === version) {
        setRecords(next);
        // Any change of source/review invalidates the current selection and lesson confirmation.
        onChange({ ...selection, ids: [] });
      }
    } catch (cause) {
      if (active.current && requestVersion.current === version)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (active.current && requestVersion.current === version) setBusy(false);
    }
  };
  const eligible = records.filter(
    (record) =>
      record.status === 'confirmed' &&
      record.review &&
      (!record.review.course || record.review.course === selection.course.trim()),
  );
  const reference = template
    ? teachingSourceReferenceSchema.safeParse({
        templateId: template.templateId,
        versionId: template.versionId,
        visual,
        ...(visual && pageList.trim()
          ? {
              pages: pageList
                .split(/[,，\s]+/u)
                .filter(Boolean)
                .map(Number),
            }
          : {}),
        ...(windowStart !== null || windowEnd !== null
          ? { window: { start: windowStart, end: windowEnd } }
          : {}),
      })
    : undefined;
  return (
    <Flexbox data-testid="teaching-memory" gap={12}>
      <Alert message={t('presentationTeaching.hint')} type="info" />
      <label>
        {t('presentationTeaching.currentCourse')}
        <Input
          disabled={disabled || busy}
          value={selection.course}
          onChange={(e) => onChange({ course: e.target.value, ids: [] })}
        />
      </label>
      <span>{t('presentationTeaching.windowHint')}</span>
      <Checkbox
        checked={visual}
        disabled={disabled || busy || !template}
        onChange={(event) => setVisual(event.target.checked)}
      >
        {t('presentationTeaching.visualMode')}
      </Checkbox>
      {visual && (
        <label>
          {t('presentationTeaching.pageList')}
          <Input
            disabled={disabled || busy}
            value={pageList}
            onChange={(event) => setPageList(event.target.value)}
          />
        </label>
      )}
      <Flexbox horizontal gap={8}>
        <InputNumber
          aria-label={t('presentationTeaching.windowStart')}
          disabled={disabled || busy || !template}
          max={100}
          min={1}
          placeholder={t('presentationTeaching.windowStart')}
          value={windowStart}
          onChange={setWindowStart}
        />
        <InputNumber
          aria-label={t('presentationTeaching.windowEnd')}
          disabled={disabled || busy || !template}
          max={100}
          min={1}
          placeholder={t('presentationTeaching.windowEnd')}
          value={windowEnd}
          onChange={setWindowEnd}
        />
      </Flexbox>
      {visual && !reference?.success && (
        <span role="status">{t('presentationTeaching.visualSelectionHint')}</span>
      )}
      <Button
        disabled={disabled || busy || !reference?.success}
        loading={busy}
        onClick={() =>
          void perform(async () => {
            if (reference?.success) await client.analyze(reference.data);
            return client.list();
          })
        }
      >
        {t('presentationTeaching.analyze')}
      </Button>
      <Button disabled={disabled || busy} onClick={() => void perform(() => client.list())}>
        {t('presentationTeaching.refresh')}
      </Button>
      {error && <Alert message={error} role="alert" type="error" />}
      {eligible.map((record) => (
        <Checkbox
          checked={selection.ids.includes(record.id)}
          key={record.id}
          disabled={
            disabled || busy || (!selection.ids.includes(record.id) && selection.ids.length >= 6)
          }
          onChange={(e) =>
            onChange({
              ...selection,
              ids: e.target.checked
                ? [...selection.ids, record.id]
                : selection.ids.filter((id) => id !== record.id),
            })
          }
        >
          {t('presentationTeaching.use')}: {record.pattern.name}
        </Checkbox>
      ))}
      {records.length === 0 && <span>{t('presentationTeaching.empty')}</span>}
      {records.map((record) => (
        <details key={`${record.id}:${record.revision}`}>
          <summary>
            {record.pattern.name} · {t(`presentationTeaching.status.${record.status}`)}
          </summary>
          <PatternReview
            disabled={disabled || busy}
            record={record}
            onReview={(action, course, applicability, limitations) =>
              perform(async () => {
                await client.review({
                  id: record.id,
                  expectedRevision: record.revision,
                  action,
                  course,
                  applicability,
                  limitations,
                });
                return client.list();
              })
            }
          />
        </details>
      ))}
    </Flexbox>
  );
}
