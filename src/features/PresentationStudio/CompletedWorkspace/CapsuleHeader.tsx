import { Button, Icon } from '@lobehub/ui';
import { Dropdown, type MenuProps, Modal } from 'antd';
import { ArrowLeft, Check, Download, Ellipsis, Pause, RefreshCw } from 'lucide-react';
import { memo, type Ref, useState } from 'react';
import { useTranslation } from 'react-i18next';

import Link from '@/components/Link';
import ToggleLeftPanelButton from '@/features/NavPanel/ToggleLeftPanelButton';
import { presentationChatHref } from '@/features/PresentationDelivery/origin';
import { glassSurface } from '@/styles/liquidGlass';

import type {
  PresentationExportFormat,
  PresentationJob,
} from '../../../../packages/runtime-contracts/src/index';
import { ActivityHistoryList } from '../ActivityHistory';
import PresentationJobList from '../PresentationJobList';
import TrialComparison from '../TrialComparison';
import { styles } from './style';
import TemplateLibraryButton from './TemplateLibraryButton';
import type { CompletedViewMode } from './types';

interface CapsuleHeaderProps {
  activity?: string;
  activityHistory?: { id: string; text: string }[];
  availableFormats: string[];
  canExport: boolean;
  canQuickExport: boolean;
  drawerOpen: boolean;
  drawerTrigger: Ref<HTMLButtonElement>;
  exporting: boolean | string | null;
  focused: boolean;
  handoutId?: string;
  job: PresentationJob;
  jobs?: PresentationJob[];
  jobTitle?: string;
  onBack?: () => void;
  onDeleteJob?: (jobId: string) => Promise<void> | void;
  onExport: (format: PresentationExportFormat) => void;
  onJobChanged?: () => Promise<void>;
  onNewPresentation?: () => void;
  onQuickExport: () => void;
  onRetryJob: () => void;
  onSelectJob?: (jobId: string) => void;
  onToggleDrawer: () => void;
  onToggleFocus: () => void;
  onToggleViewMode: () => void;
  onTrialVersionCreated?: (jobId: string) => Promise<void> | void;
  showSidebarReopen?: boolean;
  slideId?: string;
  viewMode: CompletedViewMode;
}

type EditorDialog = 'activity' | 'history' | 'templates' | 'trial';

export const CapsuleHeader = memo<CapsuleHeaderProps>(
  ({
    activity,
    activityHistory,
    availableFormats,
    canExport,
    canQuickExport,
    drawerTrigger,
    drawerOpen,
    exporting,
    focused,
    handoutId,
    job,
    jobTitle,
    jobs,
    onBack,
    onSelectJob,
    onDeleteJob,
    onExport,
    onJobChanged,
    onNewPresentation,
    onQuickExport,
    onRetryJob,
    onToggleDrawer,
    onToggleFocus,
    onToggleViewMode,
    onTrialVersionCreated,
    showSidebarReopen,
    slideId,
    viewMode,
  }) => {
    const { t } = useTranslation('common');
    const [dialog, setDialog] = useState<EditorDialog>();
    const working = job.state === 'running' || job.state === 'queued';
    const statusText = working
      ? activity?.trim() || '正在修改'
      : job.state === 'completed'
        ? '已完成'
        : job.state === 'cancelled'
          ? '已取消'
          : job.error?.code === 'CHAT_UNAVAILABLE'
            ? '模型繁忙，请稍后重试'
            : job.error?.code === 'IMAGE_PLAN_INVALID'
              ? '素材规划未完成，请再试一次'
              : job.error?.code === 'IMAGE_UNAVAILABLE'
                ? '素材生成未完成，请再试一次'
                : job.error?.code === 'CHAT_PAYLOAD_INVALID' ||
                    /empty response|parse multimodal|invalid JSON/iu.test(job.error?.message ?? '')
                  ? '排版未完成，请再试一次'
                  : job.error?.message?.trim()
                    ? job.error.message.trim().slice(0, 40)
                    : '未完成';
    const formats: { format: PresentationExportFormat; label: string }[] = [
      { format: 'pptx', label: 'PowerPoint (.pptx)' },
      { format: 'pdf', label: 'PDF (.pdf)' },
      { format: 'svg', label: 'SVG (.svg)' },
      { format: 'quality-report', label: t('presentationEditor.qualityReport') },
    ];
    const items: MenuProps['items'] = [
      ...(job.chatOrigin
        ? [
            {
              key: 'chat',
              label: (
                <Link href={presentationChatHref(job.chatOrigin)}>
                  {t('presentationEditor.chat')}
                </Link>
              ),
            },
          ]
        : []),
      ...(onNewPresentation
        ? [
            {
              key: 'new',
              label: t('presentationTemplates.newPresentation'),
              onClick: onNewPresentation,
            },
          ]
        : []),
      ...(jobs && onSelectJob
        ? [
            {
              key: 'history',
              label: t('presentationTemplates.history'),
              onClick: () => setDialog('history'),
            },
          ]
        : []),
      {
        key: 'templates',
        label: t('presentationTemplates.title'),
        onClick: () => setDialog('templates'),
      },
      { type: 'divider' },
      {
        key: 'focus',
        label: t(focused ? 'presentationCanvas.leaveFocus' : 'presentationCanvas.enterFocus'),
        onClick: onToggleFocus,
      },
      {
        key: 'view',
        label: t(
          viewMode === 'focus' ? 'presentationEditor.gridView' : 'presentationEditor.slideView',
        ),
        onClick: onToggleViewMode,
      },
      {
        key: 'assets',
        label: t(drawerOpen ? 'panel.assetsHide' : 'panel.assetsOpen'),
        onClick: onToggleDrawer,
      },
      {
        key: 'trial',
        label: t('presentationTrial.open'),
        disabled: job.state !== 'completed' || !job.versionId || !slideId,
        onClick: () => setDialog('trial'),
      },
      {
        key: 'activity',
        label: t('presentationTemplates.activityHistory'),
        onClick: () => setDialog('activity'),
      },
      {
        key: 'retry',
        label: t('presentationEditor.regenerate'),
        disabled: working,
        onClick: onRetryJob,
      },
      ...(!availableFormats.length
        ? []
        : [
            {
              key: 'formats',
              type: 'group' as const,
              label: t('presentationEditor.exportFormats'),
              children: formats
                .filter(({ format }) => availableFormats.includes(format))
                .map(({ format, label }) => ({
                  key: format,
                  label,
                  disabled: !canExport || Boolean(exporting),
                  onClick: () => onExport(format),
                })),
            },
          ]),
      ...(handoutId
        ? [
            {
              key: 'handout',
              label: (
                <a
                  download="student-handout.md"
                  href={`/api/runtime/presentation/artifacts/${encodeURIComponent(handoutId)}?raw=true`}
                  title={t('presentationLesson.exportNotice')}
                >
                  {t('presentationLesson.handout')}
                </a>
              ),
            },
          ]
        : []),
    ];
    return (
      <header
        aria-label={t('presentationEditor.toolbar')}
        className={`${glassSurface} ${styles.capsuleHeader}`}
        data-testid="presentation-editor-toolbar"
      >
        <div className={styles.capsuleGroupLeft}>
          {onBack && (
            <Button
              aria-label={t('back')}
              data-testid="presentation-back-to-home"
              icon={<ArrowLeft aria-hidden size={17} />}
              type="text"
              onClick={onBack}
            >
              {t('back')}
            </Button>
          )}
          {showSidebarReopen && (
            <div data-testid="presentation-sidebar-reopen">
              <ToggleLeftPanelButton />
            </div>
          )}
          <span className={styles.capsuleTitle} title={jobTitle}>
            {jobTitle || t('presentationEditor.untitled')}
          </span>
          <span
            aria-live="polite"
            className={styles.capsuleStatus}
            data-testid="presentation-completed-tag"
            title={job.error?.message}
          >
            <Icon
              aria-hidden
              icon={working ? RefreshCw : job.state === 'completed' ? Check : Pause}
              size={14}
              spin={working}
            />
            <span>{statusText}</span>
          </span>
        </div>
        <div className={styles.capsuleGroupRight}>
          <Button
            aria-busy={Boolean(exporting)}
            data-testid="presentation-editor-export"
            className={styles.exportButton}
            disabled={!canQuickExport || Boolean(exporting)}
            icon={<Download aria-hidden size={16} />}
            loading={Boolean(exporting)}
            type="text"
            onClick={onQuickExport}
          >
            {t('presentationEditor.export')}
          </Button>
          <Dropdown
            menu={{ items }}
            placement="bottomRight"
            styles={{ root: { maxHeight: '75dvh', overflowY: 'auto' } }}
            trigger={['click']}
          >
            <Button
              aria-haspopup="menu"
              data-testid="presentation-editor-more"
              icon={<Ellipsis aria-hidden size={16} />}
              ref={drawerTrigger}
              type="text"
            >
              {t('presentationEditor.more')}
            </Button>
          </Dropdown>
        </div>
        {jobs && onSelectJob && (
          <Modal
            footer={null}
            open={dialog === 'history'}
            title={t('presentationTemplates.history')}
            onCancel={() => setDialog(undefined)}
          >
            <PresentationJobList
              jobs={jobs}
              selectedJobId={job.jobId}
              titles={Object.fromEntries(
                jobs.map((item) => [item.jobId, item.title || t('presentationEditor.untitled')]),
              )}
              onDelete={onDeleteJob}
              onSelect={(id) => {
                setDialog(undefined);
                onSelectJob(id);
              }}
            />
          </Modal>
        )}
        <Modal
          footer={null}
          open={dialog === 'activity'}
          title={t('presentationTemplates.activityHistory')}
          onCancel={() => setDialog(undefined)}
        >
          <ActivityHistoryList history={activityHistory} />
        </Modal>
        <TemplateLibraryButton
          canLearn={job.state === 'completed'}
          dialogOpen={dialog === 'templates'}
          jobId={job.jobId}
          jobTitle={jobTitle}
          onDialogChange={(value) => setDialog(value ? 'templates' : undefined)}
          onJobChanged={onJobChanged}
        />
        <TrialComparison
          dialogOpen={dialog === 'trial'}
          jobId={job.jobId}
          slideId={slideId}
          versionId={job.versionId}
          onCreated={onTrialVersionCreated}
          onDialogChange={(value) => setDialog(value ? 'trial' : undefined)}
        />
      </header>
    );
  },
);

CapsuleHeader.displayName = 'CapsuleHeader';
export default CapsuleHeader;
