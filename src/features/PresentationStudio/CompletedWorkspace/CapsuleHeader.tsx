import { Button, Flexbox, Icon } from '@lobehub/ui';
import { Dropdown, type MenuProps, Tooltip } from 'antd';
import {
  Check,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  History,
  Layers,
  LayoutGrid,
  PanelRightOpen,
  PanelsTopLeft,
  Pause,
  Plus,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import ToggleLeftPanelButton from '@/features/NavPanel/ToggleLeftPanelButton';

import type {
  PresentationExportFormat,
  PresentationJob,
} from '../../../../packages/runtime-contracts/src/index';
import ActivityHistory from '../ActivityHistory';
import PresentationJobList from '../PresentationJobList';
import { styles } from './style';
import TemplateLibraryButton from './TemplateLibraryButton';
import type { CompletedViewMode } from './types';

export interface CapsuleHeaderProps {
  activity?: string;
  activityHistory?: { id: string; text: string }[];
  availableFormats?: string[];
  canExport: boolean;
  canQuickExport?: boolean;
  conversationOpen?: boolean;
  currentIndex: number;
  drawerOpen: boolean;
  exported: { artifactId: string; format: PresentationExportFormat; uri?: string } | null;
  exporting: boolean | string | null;
  job: PresentationJob;
  jobs?: PresentationJob[];
  jobTitle?: string;
  onDeleteJob?: (jobId: string) => Promise<void> | void;
  onExport: (format: PresentationExportFormat) => void;
  onJobChanged?: () => Promise<void>;
  onNewPresentation?: () => void;
  onOpenConversation: () => void;
  onQuickExport: () => void;
  onRetryJob: () => void;
  onSelectJob?: (jobId: string) => void;
  onToggleDrawer: () => void;
  onToggleViewMode: () => void;
  presentationStyle?: string;
  showSidebarReopen?: boolean;
  slideCount: number;
  viewMode: CompletedViewMode;
}

const MORE_EXPORT_FORMATS: {
  format: PresentationExportFormat;
  icon: typeof FileSpreadsheet;
  label: string;
}[] = [
  { format: 'pptx', icon: FileSpreadsheet, label: 'PowerPoint (.pptx)' },
  { format: 'pdf', icon: FileText, label: 'PDF 文档 (.pdf)' },
  { format: 'svg', icon: Layers, label: '矢量切片 (.svg)' },
  { format: 'quality-report', icon: FileText, label: '质量分析报告' },
];

export const CapsuleHeader = memo<CapsuleHeaderProps>(
  ({
    activity,
    activityHistory,
    availableFormats,
    canExport,
    canQuickExport = canExport,
    conversationOpen = false,
    drawerOpen,
    exporting,
    job,
    jobTitle,
    jobs,
    onSelectJob,
    onDeleteJob,
    onExport,
    onJobChanged,
    onNewPresentation,
    onOpenConversation,
    onQuickExport,
    onRetryJob,
    onToggleDrawer,
    onToggleViewMode,
    showSidebarReopen = false,
    viewMode,
  }) => {
    const { t } = useTranslation('common');

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
    const viewLabel = viewMode === 'lightbox' ? '单页精研' : '全景网格';

    const moreExportMenu: MenuProps['items'] = MORE_EXPORT_FORMATS.filter(
      ({ format }) => !availableFormats || availableFormats.includes(format),
    ).map(({ format, icon, label }) => ({
      icon: <Icon aria-hidden icon={icon} size={18} />,
      key: format,
      label: (
        <span>
          导出 {label}
          <span style={{ display: 'none' }}>Export {label}</span>
        </span>
      ),
      onClick: () => onExport(format),
    }));

    return (
      <header
        aria-label="演示文稿完成态顶栏"
        className={styles.capsuleHeader}
        data-testid="presentation-editor-toolbar"
      >
        <div className={styles.capsuleGroupLeft}>
          {showSidebarReopen && (
            <div data-testid="presentation-sidebar-reopen">
              <ToggleLeftPanelButton />
            </div>
          )}
          <span className={styles.capsuleTitle} title={jobTitle ?? '演示文稿'}>
            {jobTitle ?? '演示文稿'}
          </span>

          <ActivityHistory history={activityHistory}>
            <button
              aria-label={t('presentationTemplates.activityHistory')}
              aria-live="polite"
              className={styles.capsuleStatus}
              data-testid="presentation-completed-tag"
              title={job.error?.message}
              type="button"
            >
              <Icon
                aria-hidden
                icon={working ? RefreshCw : job.state === 'completed' ? Check : Pause}
                size={14}
                spin={working}
              />
              <span key={statusText}>{statusText}</span>
            </button>
          </ActivityHistory>
        </div>

        <div className={styles.capsuleGroupRight}>
          {onNewPresentation && (
            <Tooltip title={t('presentationTemplates.newPresentation')}>
              <Button
                aria-label={t('presentationTemplates.newPresentation')}
                className={styles.iconButton}
                icon={<Icon aria-hidden icon={Plus} size={22} />}
                type="text"
                onClick={onNewPresentation}
              />
            </Tooltip>
          )}
          <Tooltip title={viewLabel}>
            <Button
              aria-label={viewLabel}
              aria-pressed={viewMode === 'lightbox'}
              className={styles.iconButton}
              type="text"
              icon={
                <Icon
                  aria-hidden
                  icon={viewMode === 'lightbox' ? PanelsTopLeft : LayoutGrid}
                  size={22}
                />
              }
              onClick={onToggleViewMode}
            />
          </Tooltip>

          <Tooltip title="架构与资产">
            <Button
              aria-label="查看架构与资产"
              aria-pressed={drawerOpen}
              className={styles.iconButton}
              icon={<Icon aria-hidden icon={PanelRightOpen} size={22} />}
              type="text"
              onClick={onToggleDrawer}
            />
          </Tooltip>

          {jobs && onSelectJob && (
            <Dropdown
              trigger={['click']}
              popupRender={() => (
                <div className={styles.historyPanel}>
                  <PresentationJobList
                    jobs={jobs}
                    selectedJobId={job.jobId}
                    titles={Object.fromEntries(
                      jobs.map((item) => [item.jobId, item.title ?? '未命名演示文稿']),
                    )}
                    onDelete={onDeleteJob}
                    onSelect={onSelectJob}
                  />
                </div>
              )}
            >
              <Button
                aria-label={t('presentationTemplates.history')}
                className={styles.iconButton}
                icon={<Icon icon={History} size={22} />}
                type="text"
              />
            </Dropdown>
          )}
          <TemplateLibraryButton
            canLearn={job.state === 'completed'}
            jobId={job.jobId}
            jobTitle={jobTitle}
            onJobChanged={onJobChanged}
          />

          <Tooltip title={conversationOpen ? undefined : 'AI 修改'}>
            <Button
              aria-expanded={conversationOpen}
              aria-label="Continue prompting AI"
              className={styles.iconButton}
              icon={<Icon aria-hidden icon={Sparkles} size={24} />}
              type="text"
              onClick={onOpenConversation}
            />
          </Tooltip>

          <Tooltip title="重新生成">
            <Button
              aria-label="Retry presentation job"
              className={styles.iconButton}
              icon={<Icon aria-hidden icon={RefreshCw} size={22} />}
              type="text"
              onClick={onRetryJob}
            />
          </Tooltip>

          <Flexbox horizontal align="center" className={styles.exportActions} gap={4}>
            <Tooltip title={exporting ? '导出中…' : '导出 PowerPoint'}>
              <Button
                aria-busy={Boolean(exporting)}
                aria-label="Quick export presentation"
                className={styles.iconButton}
                disabled={!canQuickExport}
                icon={<Icon aria-hidden icon={Download} size={22} />}
                loading={Boolean(exporting)}
                type="primary"
                onClick={onQuickExport}
              />
            </Tooltip>

            <Dropdown
              disabled={!canExport}
              menu={{ items: moreExportMenu }}
              placement="bottomRight"
              trigger={['click']}
            >
              <Tooltip title="其他格式">
                <Button
                  aria-busy={Boolean(exporting)}
                  aria-label="Export presentation artifact"
                  className={styles.iconButton}
                  disabled={!canExport}
                  icon={<Icon aria-hidden icon={ChevronDown} size={20} />}
                  type="text"
                />
              </Tooltip>
            </Dropdown>
          </Flexbox>
        </div>
      </header>
    );
  },
);

CapsuleHeader.displayName = 'CapsuleHeader';

export default CapsuleHeader;
