import { Button } from '@lobehub/ui';
import { Alert, Input } from 'antd';
import { ArrowLeft, RefreshCw, ScanEye } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { z } from 'zod';

import { GlassLens } from '@/features/GlassMotion/GlassLens';
import { MotionGlyph } from '@/features/GlassMotion/MotionGlyph';
import { GlassToolbar } from '@/features/GlassMotion/Toolbar';
import { agentComputerService } from '@/services/agentComputer';
import type { browserActionSchema, BrowserFrame, ComputerSessionView } from '@/types/agentComputer';

import { styles } from './style';

export function BrowserConsole({
  agentId,
  ownerId,
  session,
  blocked,
  onChanged,
  onControl,
}: {
  agentId: string;
  ownerId: string;
  session: ComputerSessionView;
  blocked: boolean;
  onChanged: () => Promise<unknown>;
  onControl?: () => void;
}) {
  const { t } = useTranslation('chat');
  const [pending, setPending] = useState(false),
    [failed, setFailed] = useState(false);
  const [url, setUrl] = useState(''),
    [text, setText] = useState('');
  const [lens, setLens] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined),
    dragged = useRef(false);
  const { data, error, mutate } = useSWR(
    !blocked && !pending ? ['computerFrame', ownerId, agentId, session.revision] : null,
    () => agentComputerService.observe(agentId, session.revision),
    { refreshInterval: 750, shouldRetryOnError: false, revalidateOnFocus: false },
  );
  const [previous, setPrevious] = useState<BrowserFrame>();
  useEffect(() => {
    if (data?.revision === session.revision) setPrevious(data.frame);
  }, [data, session.revision]);
  const fresh = !blocked && !pending && !error && data?.revision === session.revision;
  const frame = fresh ? data.frame : previous;
  const disabled = blocked || pending || session.control !== 'human';
  const screenDisabled = disabled || !fresh;
  const act = async (input: z.input<typeof browserActionSchema>) => {
    if (disabled) return false;
    setPending(true);
    setFailed(false);
    try {
      const result = await agentComputerService.manage({
        agentId,
        command: { kind: 'browser', input: input as z.infer<typeof browserActionSchema> },
        requestId: crypto.randomUUID(),
        expectedRevision: session.revision,
      });
      if (result.actionFailed) setFailed(true);
      await onChanged();
      await mutate();
      return !result.actionFailed;
    } catch {
      setFailed(true);
      await onChanged();
      return false;
    } finally {
      setPending(false);
    }
  };
  return (
    <section aria-label={t('computer.browserTitle')} className={styles.console}>
      {(failed || error) && <Alert title={t('computer.browserError')} type="warning" />}
      <div className={styles.browserShell}>
        {frame?.running && (
          <form
            className={styles.address}
            onSubmit={(event) => {
              event.preventDefault();
              void act({ action: 'navigate', url });
            }}
          >
            <Input
              aria-label={t('computer.browserAddress')}
              disabled={disabled || !frame?.running}
              placeholder={frame?.running ? frame.url : 'https://'}
              value={url}
              variant="borderless"
              onChange={(event) => setUrl(event.target.value)}
            />
            <Button
              aria-label={t('computer.browserGo')}
              disabled={disabled || !frame?.running || !/^https?:\/\//i.test(url)}
              htmlType="submit"
              icon={<MotionGlyph name="arrow" size={18} />}
              size="small"
              title={t('computer.browserGo')}
              type="text"
            />
          </form>
        )}
        {frame?.running ? (
          <div
            aria-disabled={screenDisabled}
            aria-label={t('computer.browserScreen')}
            className={styles.viewport}
            ref={viewport}
            role="application"
            tabIndex={screenDisabled ? -1 : 0}
            onClick={(event) => {
              if (dragged.current) {
                dragged.current = false;
                return;
              }
              if (screenDisabled) return;
              const rect = event.currentTarget.getBoundingClientRect();
              event.currentTarget.focus();
              void act({
                action: 'click',
                x: Math.min(1100, Math.max(0, ((event.clientX - rect.left) * 1100) / rect.width)),
                y: Math.min(700, Math.max(0, ((event.clientY - rect.top) * 700) / rect.height)),
              });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              if (screenDisabled) return;
              const r = event.currentTarget.getBoundingClientRect();
              void act({
                action: 'click',
                button: 'right',
                x: ((event.clientX - r.left) * 1100) / r.width,
                y: ((event.clientY - r.top) * 700) / r.height,
              });
            }}
            onKeyDown={(event) => {
              if (screenDisabled || event.nativeEvent.isComposing) return;
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
                event.preventDefault();
                void act({ action: 'key', key: 'a', modifiers: 2 });
                return;
              }
              const keys = [
                'Enter',
                'Tab',
                'Backspace',
                'Delete',
                'Escape',
                'ArrowUp',
                'ArrowDown',
                'ArrowLeft',
                'ArrowRight',
                'Home',
                'End',
                'PageUp',
                'PageDown',
              ];
              if (keys.includes(event.key)) {
                event.preventDefault();
                void act({
                  action: 'key',
                  key: event.key as 'Enter',
                  modifiers:
                    (event.altKey ? 1 : 0) +
                    (event.ctrlKey || event.metaKey ? 2 : 0) +
                    (event.shiftKey ? 8 : 0),
                });
              } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                void act({ action: 'text', text: event.key });
              }
            }}
            onPaste={(event) => {
              if (!screenDisabled) {
                event.preventDefault();
                void act({
                  action: 'text',
                  text: event.clipboardData.getData('text').slice(0, 8000),
                });
              }
            }}
            onPointerDown={(event) => {
              if (screenDisabled || event.button !== 0) return;
              const r = event.currentTarget.getBoundingClientRect();
              pointer.current = {
                x: ((event.clientX - r.left) * 1100) / r.width,
                y: ((event.clientY - r.top) * 700) / r.height,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerUp={(event) => {
              const start = pointer.current;
              pointer.current = undefined;
              if (screenDisabled || !start) return;
              const r = event.currentTarget.getBoundingClientRect(),
                x = Math.max(0, Math.min(1100, ((event.clientX - r.left) * 1100) / r.width)),
                y = Math.max(0, Math.min(700, ((event.clientY - r.top) * 700) / r.height));
              if (Math.hypot(x - start.x, y - start.y) > 5) {
                dragged.current = true;
                void act({ action: 'drag', ...start, endX: x, endY: y });
              }
            }}
            onWheel={(event) => {
              if (!screenDisabled)
                void act({
                  action: 'scroll',
                  deltaY: Math.max(-2000, Math.min(2000, event.deltaY)),
                  deltaX: Math.max(-2000, Math.min(2000, event.deltaX)),
                });
            }}
          >
            <img
              alt={frame.title || t('computer.browserScreen')}
              draggable={false}
              src={`data:image/jpeg;base64,${frame.image}`}
            />
            {!fresh && <span className={styles.frameStatus}>{t('computer.frameLoading')}</span>}
            <GlassLens
              enabled={lens}
              src={`data:image/jpeg;base64,${frame.image}`}
              viewport={viewport}
            />
          </div>
        ) : (
          <div className={styles.browserEmpty}>
            <MotionGlyph name="computer" size={30} />
            <span>{t('computer.workbench.browserClosed')}</span>
            {session.control === 'human' && (
              <Button
                disabled={disabled}
                icon={<MotionGlyph name="play" size={18} />}
                onClick={() => void act({ action: 'start' })}
              >
                {t('computer.browserStart')}
              </Button>
            )}
          </div>
        )}
      </div>
      <div className={styles.controlBar}>
        {frame?.running && (
          <GlassToolbar
            label={t('computer.toolbar')}
            items={[
              {
                id: 'back',
                icon: ArrowLeft,
                label: t('computer.browserBack'),
                disabled: disabled || !fresh,
                onClick: () => void act({ action: 'back' }),
              },
              {
                id: 'reload',
                icon: RefreshCw,
                label: t('computer.browserReload'),
                disabled: disabled || !fresh,
                onClick: () => void act({ action: 'reload' }),
              },
              {
                id: 'lens',
                icon: ScanEye,
                label: t('computer.lens'),
                active: lens,
                onClick: () => setLens(!lens),
              },
            ]}
          />
        )}
        {onControl && (
          <Button
            className={styles.handoffButton}
            disabled={blocked || pending}
            icon={<MotionGlyph name="awareness" size={18} />}
            type={session.control === 'human' ? 'default' : 'primary'}
            onClick={onControl}
          >
            {t(session.control === 'human' ? 'computer.returnControl' : 'computer.takeControl')}
          </Button>
        )}
      </div>
      {session.control === 'human' && frame?.running && (
        <form
          className={styles.entryForm}
          onSubmit={(event) => {
            event.preventDefault();
            const submitted = text;
            if (submitted)
              void act({ action: 'text', text: submitted }).then((ok) => {
                if (ok) setText((current) => (current === submitted ? '' : current));
              });
          }}
        >
          <Input
            aria-label={t('computer.browserText')}
            disabled={disabled || !frame?.running}
            maxLength={8000}
            placeholder={t('computer.workbench.typePlaceholder')}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button
            aria-label={t('computer.browserType')}
            disabled={disabled || !frame?.running || !text}
            htmlType="submit"
            icon={<MotionGlyph name="arrow" size={18} />}
            title={t('computer.browserType')}
          />
          <Button
            aria-label={t('computer.browserEnter')}
            disabled={disabled || !frame?.running}
            icon={<MotionGlyph name="enter" size={18} />}
            title={t('computer.browserEnter')}
            onClick={() => void act({ action: 'key', key: 'Enter' })}
          />
        </form>
      )}
    </section>
  );
}
