import { Alert, Input, Modal, Radio, Spin } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import { backgroundActivityService } from '@/services/backgroundActivity';
import {
  type ActivityItem,
  REVIEW_DECISIONS,
  type ReviewDecision,
} from '@/types/backgroundActivity';

import { styles } from './style';

export default function ReviewDialog({
  item,
  ownerId,
  onCancel,
  onSaved,
}: {
  item: ActivityItem;
  ownerId: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation('chat');
  const [decision, setDecision] = useState<ReviewDecision>();
  const [evidence, setEvidence] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const readOnly = !!item.review || !item.incidentToken;
  const { data: history, error: historyError } = useSWR(
    ['backgroundActivityHistory', ownerId, item.category, item.id],
    () => backgroundActivityService.reviewHistory({ category: item.category, id: item.id }),
    { shouldRetryOnError: false },
  );
  const valid =
    !!decision &&
    [...evidence.trim()].length >= 10 &&
    evidence.length <= 2000 &&
    !!item.incidentToken &&
    !readOnly;
  const submit = async () => {
    if (!valid || !decision || !item.incidentToken || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await backgroundActivityService.recordReview({
        category: item.category,
        id: item.id,
        incidentToken: item.incidentToken,
        decision,
        evidence: evidence.trim(),
      });
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      cancelText={t('backgroundActivity.review.cancel')}
      closable={!saving}
      confirmLoading={saving}
      footer={readOnly ? null : undefined}
      maskClosable={!saving}
      okButtonProps={{ disabled: !valid }}
      okText={t('backgroundActivity.review.save')}
      title={t(readOnly ? 'backgroundActivity.review.view' : 'backgroundActivity.review.title')}
      onOk={() => void submit()}
      onCancel={() => {
        if (!saving) onCancel();
      }}
    >
      <div className={styles.form}>
        <Alert showIcon title={t('backgroundActivity.review.help')} type={'info'} />
        {!readOnly && (
          <>
            <Radio.Group
              aria-label={t('backgroundActivity.review.decision')}
              value={decision}
              onChange={(event) => setDecision(event.target.value)}
            >
              {REVIEW_DECISIONS.map((value) => (
                <Radio key={value} value={value}>
                  {t(`backgroundActivity.review.decision.${value}`)}
                </Radio>
              ))}
            </Radio.Group>
            <label className={styles.detail} htmlFor={'background-activity-evidence'}>
              {t('backgroundActivity.review.evidence')}
            </label>
            <Input.TextArea
              autoSize={{ minRows: 3, maxRows: 8 }}
              id={'background-activity-evidence'}
              maxLength={2000}
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
            />
          </>
        )}
        {failed && <Alert showIcon title={t('backgroundActivity.review.error')} type={'error'} />}
        <h4 className={styles.title}>{t('backgroundActivity.review.history')}</h4>
        {historyError ? (
          <Alert title={t('backgroundActivity.review.historyError')} type={'warning'} />
        ) : !history ? (
          <Spin size={'small'} />
        ) : !history.length ? (
          <p className={styles.detail}>{t('backgroundActivity.review.noHistory')}</p>
        ) : (
          <ol className={styles.list}>
            {history.map((entry, index) => (
              <li className={styles.detail} key={`${entry.reviewedAt}:${index}`}>
                {t(`backgroundActivity.review.decision.${entry.decision}`)} ·{' '}
                {new Date(entry.reviewedAt).toLocaleString(i18n.language)}
                <br />
                {entry.evidence}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  );
}
