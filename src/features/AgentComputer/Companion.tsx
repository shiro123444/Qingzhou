import { cx } from 'antd-style';
import { motion, useReducedMotion } from 'motion/react';
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import useSWR from 'swr';

import { type GlyphName, MotionGlyph } from '@/features/GlassMotion/MotionGlyph';
import { PanelToggle } from '@/features/GlassMotion/PanelToggle';
import { panelMotionStyle } from '@/features/GlassMotion/panelMotion';
import { springs } from '@/features/GlassMotion/springs';
import { agentComputerService } from '@/services/agentComputer';
import { useUiAttentionStore } from '@/store/uiAttention';
import { glassSurface } from '@/styles/liquidGlass';
import { formatUiAttention } from '@/types/uiAttention';

import { companionStyles as styles } from './companion.style';
import { companionState } from './companionState';
import { useCompanionAwareness } from './useCompanionAwareness';

const Avatar = lazy(() => import('./CompanionAvatar'));
const Panel = lazy(() => import('./Panel'));
const tabs = ['activity', 'review', 'companion'] as const;
const tabIcons: Record<(typeof tabs)[number], GlyphName> = {
  activity: 'tasks',
  review: 'document',
  companion: 'awareness',
};

export default function Companion({
  ownerId,
  agentId,
  name,
}: {
  ownerId: string;
  agentId: string;
  name?: string;
}) {
  const { t, i18n } = useTranslation('chat');
  const reduced = useReducedMotion(),
    id = useId();
  const avatar = useRef<HTMLSpanElement>(null);
  const [collapsed, setCollapsed] = useState(false),
    [open, setOpen] = useState(false),
    [aware, setAware] = useState(true),
    [tab, setTab] = useState<(typeof tabs)[number]>('activity');
  const gaze = useCompanionAwareness({ ownerId, agentId, avatar, enabled: aware && !collapsed });
  const signal = useUiAttentionStore((s) =>
    s.ownerId === ownerId && s.agentId === agentId ? s.signal : undefined,
  );
  const { data, error, isLoading } = useSWR(
    ['agentComputer', ownerId, agentId],
    () => agentComputerService.get(agentId),
    {
      refreshInterval: collapsed ? 5000 : 2500,
      shouldRetryOnError: false,
      revalidateOnFocus: true,
    },
  );
  const {
    data: taskPage,
    error: tasksError,
    isLoading: tasksLoading,
  } = useSWR(
    !collapsed && tab === 'activity' && data?.enabled ? ['companionTasks', ownerId, agentId] : null,
    () => agentComputerService.tasks(agentId),
    { refreshInterval: 15000, shouldRetryOnError: false },
  );
  const state = companionState(data, !!error);
  const session = data?.session;
  const activity = data?.activity ?? data?.botActivity;
  const unknown = data?.commands.filter((command) => command.status === 'unknown') ?? [];
  const reviewCount = unknown.length + (activity?.phase === 'approval' ? 1 : 0);
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (collapsed) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [collapsed]);
  const hint = signal && formatUiAttention(signal, clock) ? signal : undefined;
  const computerStatus =
    error || data?.bindingChanged || session?.state === 'unknown'
      ? 'unavailable'
      : !session || session.state === 'new'
        ? 'off'
        : session.state === 'sleeping'
          ? 'sleeping'
          : session.control === 'human'
            ? 'human'
            : 'viewing';
  const time = (date: string) =>
    new Date(date).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
  const title = name || t('computer.rail.bot');

  return (
    <aside
      data-computer-companion
      aria-label={t('computer.rail.title')}
      className={cx(glassSurface, styles.rail)}
      data-collapsed={collapsed}
      data-qz-glass="sidebar"
      style={panelMotionStyle}
    >
      <header className={styles.topbar}>
        {!collapsed && <span>{t('computer.rail.title')}</span>}
        <PanelToggle
          aria-controls={`${id}-contents`}
          expanded={!collapsed}
          label={t(collapsed ? 'computer.rail.expand' : 'computer.rail.collapse')}
          side="right"
          onToggle={() => setCollapsed((value) => !value)}
        />
      </header>
      <div className={styles.scroll} id={`${id}-contents`} inert={collapsed}>
        <section className={styles.identity}>
          <button
            aria-label={t('computer.companion.open')}
            className={styles.avatarButton}
            type="button"
            onClick={() => setOpen(true)}
          >
            <span className={styles.avatar} ref={avatar}>
              <Suspense fallback={<MotionGlyph name="computer" size={28} />}>
                <Avatar state={state} gaze={gaze} tracking={aware && !collapsed && !open} />
              </Suspense>
            </span>
            {!collapsed && (
              <span aria-hidden className={styles.avatarHint}>
                <MotionGlyph name="expand" size={15} />
              </span>
            )}
          </button>
          {!collapsed && (
            <>
              <h2 className={styles.name}>{title}</h2>
              <p className={styles.presence} data-state={state}>
                {t(isLoading ? 'computer.companion.connecting' : `computer.companion.${state}`)}
              </p>
            </>
          )}
        </section>
        {!collapsed && (
          <>
            <button
              aria-label={t('computer.companion.viewControl')}
              className={styles.computerEntry}
              data-qz-attention="computer"
              type="button"
              onClick={() => setOpen(true)}
            >
              <span className={styles.computerGlyph}>
                <MotionGlyph name="computer" size={24} />
              </span>
              <span>
                <strong>{t('computer.rail.computer')}</strong>
                <small>{t(`computer.workbench.status.${computerStatus}`)}</small>
              </span>
              <MotionGlyph name="expand" size={16} />
            </button>
            <div aria-label={t('computer.rail.tabs.label')} className={styles.tabs} role="tablist">
              {tabs.map((item, index) => (
                <button
                  aria-controls={`${id}-panel`}
                  aria-selected={tab === item}
                  id={`${id}-${item}`}
                  key={item}
                  role="tab"
                  tabIndex={tab === item ? 0 : -1}
                  onClick={() => setTab(item)}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const direction =
                      getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1;
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? 2
                          : (index + (event.key === 'ArrowRight' ? direction : -direction) + 3) % 3;
                    setTab(tabs[next]);
                    document.getElementById(`${id}-${tabs[next]}`)?.focus();
                  }}
                >
                  {tab === item && (
                    <motion.span
                      aria-hidden
                      className={styles.tabPlate}
                      layoutId={`${id}-selection`}
                      transition={reduced ? { duration: 0 } : { type: 'spring', ...springs.soft }}
                    />
                  )}
                  <MotionGlyph active={tab === item} name={tabIcons[item]} size={16} />
                  <span>{t(`computer.rail.tabs.${item}`)}</span>
                  {item === 'review' && reviewCount > 0 && <b>{reviewCount}</b>}
                </button>
              ))}
            </div>
            <section
              aria-labelledby={`${id}-${tab}`}
              className={styles.sections}
              id={`${id}-panel`}
              role="tabpanel"
            >
              {tab === 'activity' && (
                <>
                  {activity && (
                    <Link
                      className={styles.currentTask}
                      data-qz-attention={activity.phase === 'approval' ? 'approval' : 'tasks'}
                      to={`/agent/${encodeURIComponent(agentId)}/${encodeURIComponent(activity.topicId)}`}
                    >
                      <span className={styles.taskIcon}>
                        <MotionGlyph
                          name={activity.phase === 'approval' ? 'document' : 'tasks'}
                          size={22}
                        />
                      </span>
                      <span>
                        <small>{t('computer.rail.currentTask')}</small>
                        <strong>{t(`computer.rail.task.${activity.phase}`)}</strong>
                      </span>
                      <MotionGlyph name="arrow" size={16} />
                    </Link>
                  )}
                  <div className={styles.sectionHeading}>
                    <h3>{t('computer.rail.plans')}</h3>
                    <Link aria-label={t('computer.rail.allTasks')} to="/tasks">
                      <MotionGlyph name="arrow" size={16} />
                    </Link>
                  </div>
                  {tasksLoading ? (
                    <p className={styles.quiet}>{t('computer.rail.loading')}</p>
                  ) : tasksError ? (
                    <p className={styles.quiet}>{t('computer.rail.taskError')}</p>
                  ) : taskPage?.items.length ? (
                    <div className={styles.taskList}>
                      {taskPage.items.map((task) => (
                        <Link key={task.id} to={`/task/${encodeURIComponent(task.id)}`}>
                          <span className={styles.taskIcon}>
                            <MotionGlyph name={task.mode ? 'refresh' : 'document'} size={19} />
                          </span>
                          <span>
                            <strong>{task.title}</strong>
                            <small>
                              {task.status === 'paused'
                                ? t('computer.rail.paused')
                                : task.mode === 'heartbeat' && task.intervalSeconds
                                  ? t('computer.rail.everyMinutes', {
                                      minutes: Math.round(task.intervalSeconds / 60),
                                    })
                                  : task.mode === 'schedule'
                                    ? t('computer.rail.scheduled')
                                    : t('computer.rail.assigned')}
                            </small>
                          </span>
                        </Link>
                      ))}
                    </div>
                  ) : (
                    <Link className={styles.emptyTask} to="/tasks">
                      <MotionGlyph name="plus" size={20} />
                      <span>{t('computer.rail.addTask')}</span>
                    </Link>
                  )}
                  <div className={styles.sectionHeading}>
                    <h3>{t('computer.activityHistory')}</h3>
                  </div>
                  {data?.commands.length ? (
                    <ol className={styles.history}>
                      {data.commands.slice(0, 5).map((command) => (
                        <li key={command.id}>
                          <span
                            className={styles.receiptIcon}
                            data-uncertain={command.status === 'unknown'}
                          >
                            <MotionGlyph
                              size={17}
                              name={
                                command.kind === 'browser'
                                  ? 'computer'
                                  : command.kind === 'control'
                                    ? 'awareness'
                                    : 'document'
                              }
                            />
                          </span>
                          <span>
                            <strong>{t(`computer.kind.${command.kind}`)}</strong>
                            <small>
                              {command.actor === 'human' ? t('computer.rail.you') : title}
                              {command.status === 'unknown' &&
                                ` · ${t('computer.workbench.status.unknown')}`}
                            </small>
                          </span>
                          <time dateTime={command.createdAt}>{time(command.createdAt)}</time>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className={styles.quiet}>{t('computer.rail.noActivity')}</p>
                  )}
                </>
              )}
              {tab === 'review' && (
                <div className={styles.reviewPanel}>
                  {activity?.phase === 'approval' && (
                    <Link
                      className={styles.reviewCard}
                      data-qz-attention="approval"
                      to={`/agent/${encodeURIComponent(agentId)}/${encodeURIComponent(activity.topicId)}`}
                    >
                      <MotionGlyph name="document" size={23} />
                      <strong>{t('computer.rail.awaitingDecision')}</strong>
                      <span>{t('computer.companion.review')}</span>
                    </Link>
                  )}
                  {unknown.length > 0 && (
                    <button
                      className={styles.reviewCard}
                      type="button"
                      onClick={() => setOpen(true)}
                    >
                      <MotionGlyph name="refresh" size={23} />
                      <strong>{t('computer.workbench.status.unknown')}</strong>
                      <span>{t('computer.rail.checkAction')}</span>
                    </button>
                  )}
                  {reviewCount === 0 && (
                    <div className={styles.calmState}>
                      <MotionGlyph name="tasks" size={26} />
                      <strong>{t('computer.rail.noReview')}</strong>
                      <p>{t('computer.rail.reviewHelp')}</p>
                    </div>
                  )}
                </div>
              )}
              {tab === 'companion' && (
                <div className={styles.senses}>
                  <div className={styles.sectionHeading}>
                    <h3>{t('computer.attention.label')}</h3>
                  </div>
                  <button
                    aria-description={t('computer.attention.contextHelp')}
                    aria-pressed={aware}
                    className={styles.senseToggle}
                    type="button"
                    aria-label={t(
                      aware ? 'computer.attention.disable' : 'computer.attention.enable',
                    )}
                    onClick={() => setAware(!aware)}
                  >
                    <MotionGlyph active={aware} name="awareness" size={24} />
                    <span>
                      <strong>{t('computer.rail.pointerTracking')}</strong>
                      <small>{t(aware ? 'computer.rail.on' : 'computer.rail.off')}</small>
                    </span>
                    <span aria-hidden className={styles.switch} data-on={aware}>
                      <i />
                    </span>
                  </button>
                  <p className={styles.senseHelp}>{t('computer.attention.contextHelp')}</p>
                  {aware && hint && (
                    <div className={styles.attention} data-attention-area={hint.area}>
                      <span>{t('computer.rail.noticed')}</span>
                      <strong>{t(`computer.attention.short.${hint.area}`)}</strong>
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </div>
      {aware && hint && !collapsed && tab !== 'companion' && (
        <div
          className={styles.attentionStrip}
          data-attention-area={hint.area}
          title={t('computer.attention.contextHelp')}
        >
          <MotionGlyph active name="awareness" size={14} />
          <span>{t(`computer.attention.short.${hint.area}`)}</span>
        </div>
      )}
      {open && (
        <Suspense fallback={null}>
          <Panel agentId={agentId} ownerId={ownerId} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </aside>
  );
}
