import { Modal } from 'antd';
import { type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Both native data editors keep one request id per unchanged draft, including retries. */
export function DataEditorModal({
  title,
  draft,
  canSave,
  onSave,
  onCancel,
  children,
  failureMessage,
  width,
}: {
  title: string;
  draft: object;
  canSave: boolean;
  onSave: (requestId: string) => Promise<boolean>;
  onCancel: () => void;
  children: (saving: boolean) => ReactNode;
  failureMessage?: string;
  width?: number;
}) {
  const { t } = useTranslation('common');
  const [saving, setSaving] = useState(false);
  const [failedDraft, setFailedDraft] = useState<object>();
  const request = useRef<{ draft: object; id: string }>(undefined);
  const busy = useRef(false);
  return (
    <Modal
      open
      cancelButtonProps={{ disabled: saving }}
      cancelText={t('presentationCanvas.cancel')}
      closable={!saving}
      confirmLoading={saving}
      keyboard={!saving}
      maskClosable={!saving}
      okButtonProps={{ disabled: !canSave }}
      okText={t('presentationCanvas.apply')}
      title={title}
      width={width}
      onCancel={onCancel}
      onOk={async () => {
        if (!canSave || busy.current) return;
        busy.current = true;
        setSaving(true);
        setFailedDraft(undefined);
        try {
          if (request.current?.draft !== draft)
            request.current = { draft, id: crypto.randomUUID() };
          if (await onSave(request.current.id)) onCancel();
          else setFailedDraft(draft);
        } catch {
          setFailedDraft(draft);
        } finally {
          busy.current = false;
          setSaving(false);
        }
      }}
    >
      {children(saving)}
      {failedDraft === draft && (
        <p role="alert">{failureMessage || t('presentationCanvas.saveFailed')}</p>
      )}
    </Modal>
  );
}
