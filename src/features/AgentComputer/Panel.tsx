import { Button, Drawer } from '@lobehub/ui';
import { Alert, Input, Spin } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { z } from 'zod';

import { MotionGlyph } from '@/features/GlassMotion/MotionGlyph';
import { agentComputerService } from '@/services/agentComputer';
import { readUiAttention } from '@/store/uiAttention';
import type { computerHumanCommandSchema } from '@/types/agentComputer';

import { BrowserConsole } from './Console';
import { ControlPresence, GlassComputer } from './ControlPresence';
import { styles } from './style';

type HumanCommand = z.infer<typeof computerHumanCommandSchema>;
export default function AgentComputerPanel({
  agentId,
  ownerId,
  onClose,
}: {
  agentId: string;
  ownerId: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('chat');
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    ['agentComputer', ownerId, agentId],
    () => agentComputerService.get(agentId),
    { refreshInterval: 5000, shouldRetryOnError: false },
  );
  const [pendingKind, setPendingKind] = useState<HumanCommand['kind'] | 'receipt'>();
  const [failed, setFailed] = useState(false),
    [unconfirmed, setUnconfirmed] = useState(false),
    [details, setDetails] = useState(false);
  const [composing, setComposing] = useState(false),
    [taskPrompt, setTaskPrompt] = useState(''),
    [starting, setStarting] = useState(false),
    [taskLink, setTaskLink] = useState<string>();
  const session = data?.session,
    pending = !!pendingKind;
  const disabled =
    !data?.enabled ||
    !session ||
    session.busy ||
    session.state === 'unknown' ||
    !!data.bindingChanged ||
    pending ||
    !!error;
  const status = error
    ? 'unavailable'
    : !session || session.state === 'new'
      ? 'off'
      : session.state === 'unknown'
        ? 'unknown'
        : session.state === 'sleeping'
          ? 'sleeping'
          : session.busy || pending
            ? 'busy'
            : session.control === 'human'
              ? 'human'
              : 'viewing';
  const needsReview = !!data?.commands.some((command) => command.status === 'unknown');
  const manage = async (command: HumanCommand) => {
    setPendingKind(command.kind);
    setFailed(false);
    try {
      const result = await agentComputerService.manage({
        agentId,
        command,
        expectedRevision: session?.revision ?? 0,
        requestId: crypto.randomUUID(),
      });
      if (result.actionFailed) setFailed(true);
      await mutate(result, { revalidate: true });
    } catch {
      setFailed(true);
      await mutate();
    } finally {
      setPendingKind(undefined);
    }
  };
  // A deliberate "Open computer" click starts a fresh manual workspace; inspection never does.
  const openComputer = async () => {
    if (
      !data?.enabled ||
      pending ||
      error ||
      data.bindingChanged ||
      (session && (session.state !== 'new' || session.busy))
    )
      return;
    setPendingKind('ensure');
    setFailed(false);
    try {
      let result = await agentComputerService.manage({
        agentId,
        command: { kind: 'ensure' },
        expectedRevision: session?.revision ?? 0,
        requestId: crypto.randomUUID(),
      });
      if (
        result.actionFailed ||
        result.bindingChanged ||
        result.session?.state !== 'ready' ||
        result.session.busy
      )
        throw new Error('COMPUTER_NOT_READY');
      result = await agentComputerService.manage({
        agentId,
        command: { kind: 'control', target: 'human' },
        expectedRevision: result.session.revision,
        requestId: crypto.randomUUID(),
      });
      if (
        result.actionFailed ||
        result.bindingChanged ||
        result.session?.state !== 'ready' ||
        result.session.control !== 'human' ||
        result.session.busy
      )
        throw new Error('COMPUTER_CONTROL_UNCONFIRMED');
      result = await agentComputerService.manage({
        agentId,
        command: { kind: 'browser', input: { action: 'start' } },
        expectedRevision: result.session.revision,
        requestId: crypto.randomUUID(),
      });
      if (result.actionFailed) throw new Error('COMPUTER_BROWSER_UNCONFIRMED');
      await mutate(result, { revalidate: true });
    } catch {
      setFailed(true);
      await mutate();
    } finally {
      setPendingKind(undefined);
    }
  };
  const reconcile = async (id: string) => {
    setPendingKind('receipt');
    setFailed(false);
    setUnconfirmed(false);
    try {
      const result = await agentComputerService.reconcile(agentId, id);
      setUnconfirmed(result.receiptStatus !== 'done');
      await mutate(result, { revalidate: true });
    } catch {
      setFailed(true);
    } finally {
      setPendingKind(undefined);
    }
  };
  return (
    <Drawer
      destroyOnHidden
      open
      closeIconProps={{ 'aria-label': t('computer.close'), 'size': { blockSize: 30, size: 16 } }}
      containerMaxWidth="100%"
      size={1080}
      classNames={{
        wrapper: styles.window,
        section: styles.surface,
        header: styles.windowHeader,
        body: styles.drawerBody,
        bodyContent: styles.drawerContent,
      }}
      extra={
        <>
          <Button
            aria-label={t('computer.refresh')}
            icon={<MotionGlyph name="refresh" size={18} />}
            loading={isValidating}
            size="small"
            title={t('computer.refresh')}
            type="text"
            onClick={() => void mutate()}
          />
          <Button
            aria-expanded={details || needsReview}
            aria-label={t('computer.workbench.details')}
            icon={<MotionGlyph name="menu" size={18} />}
            size="small"
            title={t('computer.workbench.details')}
            type="text"
            onClick={() => setDetails(!details)}
          />
        </>
      }
      styles={{
        wrapper: {
          insetBlockStart: 16,
          insetBlockEnd: 'auto',
          insetInlineEnd: 16,
          height: 'auto',
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100dvh - 32px)',
          background: 'transparent',
        },
        extra: { top: 8, right: 10 },
        title: { padding: 0 },
        body: { padding: 0 },
        section: { background: 'transparent', maxHeight: 'calc(100dvh - 32px)' },
      }}
      title={
        <div className={styles.windowTitle}>
          <span>{t('computer.title')}</span>
        </div>
      }
      onClose={onClose}
    >
      <section
        data-computer-workbench
        aria-label={t('computer.title')}
        className={styles.body}
        data-qz-attention="computer"
      >
        <ControlPresence state={data?.bindingChanged ? 'unavailable' : status} />
        {error && <Alert showIcon title={t('computer.loadError')} type="error" />}
        {failed && <Alert showIcon title={t('computer.actionError')} type="warning" />}
        {unconfirmed && <Alert showIcon title={t('computer.receiptUnconfirmed')} type="warning" />}
        {data?.bindingChanged && (
          <Alert showIcon title={t('computer.bindingChanged')} type="warning" />
        )}
        {session?.busy && <p className={styles.notice}>{t('computer.workbench.busy')}</p>}
        {session?.state === 'unknown' && (
          <Alert showIcon title={t('computer.unknownHelp')} type="warning" />
        )}
        {isLoading ? (
          <div className={styles.emptyStage}>
            <Spin />
          </div>
        ) : data && !data.enabled ? (
          <div className={styles.emptyStage}>
            <MotionGlyph name="computer" size={32} />
            <p>{t('computer.disabled')}</p>
          </div>
        ) : session?.state === 'ready' && !error && !data?.bindingChanged ? (
          <BrowserConsole
            agentId={agentId}
            blocked={disabled}
            ownerId={ownerId}
            session={session}
            onChanged={() => mutate()}
            onControl={() =>
              void manage({
                kind: 'control',
                target: session.control === 'human' ? 'agent' : 'human',
              })
            }
          />
        ) : (
          <div className={styles.emptyStage}>
            <GlassComputer />
            <p>
              {t(
                session?.state === 'sleeping'
                  ? 'computer.workbench.asleep'
                  : session?.state === 'unknown'
                    ? 'computer.workbench.review'
                    : 'computer.workbench.empty',
              )}
            </p>
            {session?.state === 'sleeping' ? (
              <Button
                className={styles.launchButton}
                disabled={disabled}
                loading={pendingKind === 'wake'}
                onClick={() => void manage({ kind: 'wake' })}
              >
                {t('computer.wake')}
              </Button>
            ) : (
              (!session || session.state === 'new') && (
                <Button
                  className={styles.launchButton}
                  disabled={!data?.enabled || !!error || pending || !!data.bindingChanged}
                  icon={<MotionGlyph name="arrow" size={18} />}
                  loading={pendingKind === 'ensure'}
                  type="primary"
                  onClick={() => void openComputer()}
                >
                  {t('computer.initialize')}
                </Button>
              )
            )}
          </div>
        )}
        {session?.state === 'ready' && data?.reasoningModel && (
          <div className={styles.taskArea}>
            {!composing ? (
              <Button
                icon={<MotionGlyph name="plus" size={18} />}
                size="small"
                type="text"
                onClick={() => setComposing(true)}
              >
                {t('computer.workbench.addTask')}
              </Button>
            ) : (
              <form
                className={styles.taskComposer}
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (starting || !taskPrompt.trim()) return;
                  setStarting(true);
                  setFailed(false);
                  try {
                    const result = await agentComputerService.startTask(
                      agentId,
                      taskPrompt,
                      readUiAttention(ownerId, agentId),
                    );
                    if (!result.success) throw new Error('COMPUTER_TASK_NOT_STARTED');
                    setTaskLink(
                      `/agent/${encodeURIComponent(agentId)}/${encodeURIComponent(result.topicId)}`,
                    );
                    setTaskPrompt('');
                    setComposing(false);
                  } catch {
                    setFailed(true);
                  } finally {
                    setStarting(false);
                  }
                }}
              >
                <Input.TextArea
                  data-bot-mention
                  aria-label={t('computer.taskPrompt')}
                  autoSize={{ minRows: 1, maxRows: 3 }}
                  disabled={starting}
                  maxLength={8000}
                  placeholder={t('computer.taskPrompt')}
                  value={taskPrompt}
                  onChange={(event) => setTaskPrompt(event.target.value)}
                />
                <Button
                  aria-label={t('computer.startTask')}
                  disabled={!taskPrompt.trim() || starting || !data.enabled}
                  htmlType="submit"
                  icon={<MotionGlyph name="arrow" size={18} />}
                  loading={starting}
                  shape="circle"
                  title={t('computer.startTask')}
                  type="primary"
                />
              </form>
            )}
            {taskLink && <a href={taskLink}>{t('computer.openTask')}</a>}
          </div>
        )}
        {(details || needsReview) && (
          <section aria-label={t('computer.workbench.details')} className={styles.details}>
            <div className={styles.detailHeading}>
              <span>{t('computer.workbench.details')}</span>
              {session?.state === 'ready' && (
                <Button
                  disabled={disabled}
                  loading={pendingKind === 'sleep'}
                  size="small"
                  onClick={() => void manage({ kind: 'sleep' })}
                >
                  {t('computer.sleep')}
                </Button>
              )}
            </div>
            {data?.reasoningModel && (
              <p className={styles.detail}>
                {t('computer.reasoningModel', { model: data.reasoningModel.model })}
              </p>
            )}
            {!!data?.commands.length && (
              <ul className={styles.list}>
                {data.commands.map((command) => (
                  <li className={styles.receipt} key={command.id}>
                    <div>
                      <span>{t(`computer.kind.${command.kind}`)}</span>
                      <small>
                        {t(`computer.commandStatus.${command.status}`)} ·{' '}
                        {new Date(command.createdAt).toLocaleTimeString(i18n.language, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        {command.exitCode !== undefined &&
                          ` · ${t('computer.exitCode', { code: command.exitCode })}`}
                      </small>
                    </div>
                    {command.status === 'unknown' && (
                      <Button
                        disabled={pending || !!data.bindingChanged}
                        loading={pendingKind === 'receipt'}
                        size="small"
                        onClick={() => void reconcile(command.id)}
                      >
                        {t('computer.checkReceipt')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </section>
    </Drawer>
  );
}
