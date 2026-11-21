import { Input, Modal } from 'antd';
import { useRef,useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import type { BuiltinPluginId } from '@/config/builtinPlugins';
import { lambdaClient } from '@/libs/trpc/client';

import { useBotPresence } from './useBotPresence';

export default function BotQuestion({
  agentId,
  name,
  source,
  close,
}: {
  agentId: string;
  name: string;
  source?: BuiltinPluginId;
  close: () => void;
}) {
  const { t } = useTranslation('chat');
  const { t: common } = useTranslation('common');
  const [prompt, setPrompt] = useState(''),
    [pending, setPending] = useState(false),
    [error, setError] = useState(false),
    [result, setResult] = useState('');
  const busy = useRef(false);
  const { data: activity } = useBotPresence();
  const send = async () => {
    if (!prompt.trim() || busy.current || result) return;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const receipt = await lambdaClient.aiAgent.mentionBot.mutate({
        agentId,
        source,
        prompt: prompt.trim(),
      });
      setResult(
        '/agent/' + encodeURIComponent(agentId) + '/' + encodeURIComponent(receipt.topicId),
      );
    } catch {
      setError(true);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return (
    <Modal
      open
      cancelText={common('cancel')}
      closable={{ 'aria-label': common('close') }}
      confirmLoading={pending}
      footer={result ? null : undefined}
      okButtonProps={{ disabled: !prompt.trim() }}
      okText={t('botMention.send')}
      title={t('botMention.ask', { name })}
      onCancel={close}
      onOk={send}
    >
      <div data-bot-compose>
        {activity && !result && (
          <p role="status">
            <Link
              to={
                '/agent/' + encodeURIComponent(agentId) + '/' + encodeURIComponent(activity.topicId)
              }
              onClick={close}
            >
              {t(`computer.rail.task.${activity.phase}`)}
            </Link>
          </p>
        )}
        {result ? (
          <Link to={result} onClick={close}>
            {t('botMention.thread')}
          </Link>
        ) : (
          <Input.TextArea
            autoFocus
            aria-label={t('botMention.prompt')}
            autoSize={{ minRows: 3, maxRows: 7 }}
            disabled={pending}
            maxLength={8000}
            placeholder={t('botMention.prompt')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        )}
        {error && <p role="alert">{t('botMention.failed')}</p>}
      </div>
    </Modal>
  );
}
