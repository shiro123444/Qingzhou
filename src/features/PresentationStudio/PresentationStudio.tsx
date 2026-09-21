import { Button, Flexbox, Icon, Tag } from '@lobehub/ui';
import { Alert, Dropdown, Spin } from 'antd';
import { FlaskConical } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import ToggleLeftPanelButton from '@/features/NavPanel/ToggleLeftPanelButton';
import type { PresentationTemplateSummary } from '@/services/runtime/templateClient';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';

import type {
  ArtifactSnapshot,
  PresentationExportFormat,
  PresentationJob,
  PresentationJobInput,
} from '../../../packages/runtime-contracts/src/index';
import PresentationAgentFlow from './AgentFlow';
import type { OutlineSlide } from './AgentFlow/OutlineWorkspace';
import {
  createPresentationAgentClient,
  type PresentationAgentClient,
} from './AgentFlow/presentationAgentClient';
import AnnotationBar from './AnnotationBar';
import ArtifactPanel from './ArtifactPanel';
import AssetSlotPanel from './AssetSlotPanel';
import CompletedWorkspace from './CompletedWorkspace';
import TemplateLibraryButton from './CompletedWorkspace/TemplateLibraryButton';
import { ConversationPanel } from './ConversationPanel';
import { defaultPresentationDemoClient } from './demo/presentationDemoClient';
import type { UseJobPollingOptions } from './hooks/useJobPolling';
import { usePresentationStudio } from './hooks/usePresentationStudio';
import PresentationComposer from './PresentationComposer';
import PresentationGenerationWorkspace from './PresentationGenerationWorkspace';
import PresentationJobList from './PresentationJobList';
import PresentationProgress from './PresentationProgress';
import PresentationRecoveryWorkspace from './PresentationRecoveryWorkspace';
import { currentSlideArtifacts } from './slideArtifacts';
import SlideNavigator from './SlideNavigator';
import SlidePreview from './SlidePreview';
import {
  createPresentationStudioStore,
  type PresentationClient,
  type PresentationTransportMode,
} from './store/presentationStore';
import { styles } from './style';

const updatePresentationLocation = (jobId: string | null) => {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (jobId) url.searchParams.set('jobId', jobId);
    else url.searchParams.delete('jobId');
    window.history.replaceState(null, '', url.toString());
  } catch {
    // Browser history can be unavailable in embedded or test environments.
  }
};

export interface PresentationStudioProps {
  /** Injectable Cordis conversation/outline transport; production uses HTTP. */
  agentClient?: PresentationAgentClient;
  className?: string;
  /**
   * Injectable transport seam (C-15-L / C-60). Real HTTP RuntimeClient by
   * default; pass `client` explicitly to override. `transportMode="demo"`
   * without a client wires the explicitly labeled demo transport — demo data
   * is never presented as a real provider.
   */
  client?: PresentationClient;
  defaultLanguage?: string;
  defaultNotebookId?: string;
  defaultSourceVersionIds?: string[];
  /** Job ids persisted by the backend to restore on mount. */
  initialJobIds?: string[];
  initialTopic?: string;
  pollIntervalMs?: number;
  /**
   * Optional slot prompt resolver (C-99). Used by the default HTTP retry
   * adapter to supply prompts directly into the request body without storing
   * them in Zustand, the DOM, or logs.
   */
  resolveSlotPrompt?: (input: {
    jobId: string;
    slideId: string;
    slotId: string;
  }) => string | undefined;
  /** Phase 2 feature — hidden by default, never a fake editing surface. */
  showAnnotationBar?: boolean;
  /** Phase 2 feature — inspector is phase-1 read-only metadata. */
  showInspector?: boolean;
  /** Stream reconnect backoff tuning (C-64/66), optional; default 3/1000ms. */
  streamReconnectOptions?: Omit<UseJobPollingOptions, 'enabled' | 'pollIntervalMs'>;
  transportMode?: PresentationTransportMode;
}

export const PresentationStudio = memo<PresentationStudioProps>(
  ({
    agentClient,
    className,
    client,
    defaultLanguage,
    defaultNotebookId,
    defaultSourceVersionIds,
    initialJobIds,
    initialTopic: initialTopicProp = '',
    pollIntervalMs,
    resolveSlotPrompt,
    showAnnotationBar = false,
    showInspector = true,
    streamReconnectOptions = {},
    transportMode = 'http',
  }) => {
    const effectiveInitialJobIds = useMemo(() => {
      if (initialJobIds !== undefined) return initialJobIds;
      if (typeof window !== 'undefined') {
        try {
          const paramId = new URLSearchParams(window.location.search).get('jobId');
          if (paramId) return [paramId];
        } catch {
          // URL access can be unavailable in privacy-restricted contexts.
        }
      }
      // Opening /presentation always starts from the creator. Saved works stay
      // available in history and resume only after an explicit selection.
      return [];
    }, [initialJobIds]);

    const [store] = useState(() =>
      createPresentationStudioStore(
        client ?? (transportMode === 'demo' ? defaultPresentationDemoClient : undefined),
        {
          initialJobIds: effectiveInitialJobIds,
          initialLoading: Boolean(effectiveInitialJobIds && effectiveInitialJobIds.length > 0),
          resolveSlotPrompt,
          transportMode,
        },
      ),
    );

    usePresentationStudio(store, {
      initialJobIds: effectiveInitialJobIds,
      pollIntervalMs,
      ...streamReconnectOptions,
    });

    // Keep selectors primitive/reference-stable (zustand v5); derive with useMemo.
    const jobOrder = store((s) => s.jobOrder);
    const jobsById = store((s) => s.jobs);
    const jobTitles = store((s) => s.jobTitles);
    const selectedJobId = store((s) => s.selectedJobId);
    const pendingAction = store((s) =>
      s.selectedJobId ? s.pendingActions[s.selectedJobId] : undefined,
    );
    const generationProgressByJob = store((s) => s.generationProgressByJob);
    const selectedJob = store((s) => (s.selectedJobId ? s.jobs[s.selectedJobId] : undefined));
    const artifacts = store((s) => s.artifacts);
    const selectedArtifactId = store((s) => s.selectedArtifactId);
    const exporting = store((s) => s.exporting);
    const clientError = store((s) => s.clientError);
    const exportError = store((s) => s.exportError);
    const exported = store((s) => s.exported);
    const initialLoading = store((s) => s.initialLoading);
    // C-76: resubmit recovery for a provider-unavailable create failure.
    const resubmitLastInput = store((s) => s.resubmitLastInput);
    const resubmitting = store((s) => s.resubmitting);
    const { t } = useTranslation('common');
    const showLeftPanel = useGlobalStore(systemStatusSelectors.showLeftPanel);
    const [showQuickComposer, setShowQuickComposer] = useState(false);
    const [selectedTemplate, setSelectedTemplate] = useState<PresentationTemplateSummary | null>(
      null,
    );
    const [creating, setCreating] = useState(false);
    const [initialTopic, setInitialTopic] = useState(initialTopicProp || '');
    const presentationAgentClient = useMemo(
      () => agentClient ?? createPresentationAgentClient(),
      [agentClient],
    );
    const handleTemplateSelection = useCallback((template: PresentationTemplateSummary | null) => {
      setSelectedTemplate(template);
      // Template learning belongs to the conversation. Selecting or importing one
      // from the compact creator returns to the Agent workspace immediately.
      if (template) setShowQuickComposer(false);
    }, []);

    // C-66: generation UI consumes the selected job's stream status only.
    const selectedStreamStatus = store((s) =>
      s.selectedJobId ? (s.streamStatusByJob[s.selectedJobId] ?? null) : null,
    );

    // R1-B/R4-B: Attach real backend generation progress projection to generating job
    const generatingJob = useMemo(() => {
      if (!selectedJob) return undefined;
      const progress = generationProgressByJob[selectedJob.jobId];
      if (!progress) return selectedJob;
      const current = selectedJob as unknown as Record<string, unknown>;
      return {
        ...selectedJob,
        activity: progress.activity ?? current.activity,
        artifactIds:
          progress.artifactIds && progress.artifactIds.length > 0
            ? progress.artifactIds
            : selectedJob.artifactIds,
        currentSlide: progress.currentSlide ?? current.currentSlide,
        phase: progress.phase ?? current.phase,
        progress: progress.progress ?? current.progress,
        slideId: progress.slideId ?? current.slideId,
        stage: progress.stage ?? current.stage,
        totalSlides: progress.totalSlides ?? current.totalSlides,
      };
    }, [selectedJob, generationProgressByJob]);

    // R1-B: Suppress full user prompt from being the generation center visual;
    // only concise titles (<= 30 chars, single line) are shown as title.
    const conciseTitle = useMemo(() => {
      if (!selectedJob) return undefined;
      const raw = jobTitles[selectedJob.jobId]?.trim();
      if (!raw) return undefined;
      const firstLine = raw.split(/\r?\n/u, 1)[0]?.trim() || raw;
      return firstLine.replace(/^(?:演示文稿主题|主题)[:：]\s*/u, '').slice(0, 48);
    }, [selectedJob, jobTitles]);

    const jobs = useMemo(
      () =>
        jobOrder.map((id) => jobsById[id]).filter((job): job is PresentationJob => Boolean(job)),
      [jobOrder, jobsById],
    );
    const jobState = selectedJob?.state;

    const createJob = store((s) => s.createJob);
    const createJobWithTemplate = async (input: PresentationJobInput) => {
      const jobId = await createJob(
        selectedTemplate
          ? {
              ...input,
              options: { ...input.options, templateVersionId: selectedTemplate.versionId },
              template: selectedTemplate.templateId,
            }
          : input,
      );
      if (jobId) updatePresentationLocation(jobId);
      return jobId;
    };
    const cancelJob = store((s) => s.cancelJob);
    const retryJob = store((s) => s.retryJob);

    useEffect(() => {
      const errorCode = selectedJob?.error?.code;
      const unfinished = selectedJob?.messages?.findLast((message) => message.status !== 'applied');
      const isRecoverableAnnotationPatch =
        Boolean(unfinished?.annotation) &&
        (errorCode === 'PRESENTATION_ANNOTATION_PATCH_INVALID' ||
          (errorCode === 'PRESENTATION_INTERNAL_ERROR' &&
            selectedJob?.error?.message === 'Unsafe annotation patch'));
      if (
        selectedJob?.state !== 'failed' ||
        !errorCode ||
        (!['IMAGE_UNAVAILABLE', 'PRESENTATION_WORKER_FAILED'].includes(errorCode) &&
          !isRecoverableAnnotationPatch)
      ) {
        return;
      }
      if (!unfinished) return;

      const resumeKey = `presentation_studio_auto_resume:${selectedJob.jobId}:${unfinished.requestId}:${errorCode}`;
      try {
        if (window.sessionStorage.getItem(resumeKey)) return;
        window.sessionStorage.setItem(resumeKey, '1');
      } catch {
        return;
      }
      void retryJob(selectedJob.jobId);
    }, [retryJob, selectedJob]);
    // C-87: material slot actions for the selected job.
    const slots = store((s) => s.slots);
    const slotRetryPending = store((s) => s.slotRetryPending);
    const retrySlot = store((s) => s.retrySlot);
    const dismissSlotError = store((s) => s.dismissSlotError);
    const selectJob = (jobId: string | null) => {
      store.getState().selectJob(jobId);
      updatePresentationLocation(jobId);
      if (jobId) void store.getState().refreshJob(jobId);
    };
    const handleDeleteJob = async (jobId: string) => {
      const deleted = await store.getState().deleteJob(jobId);
      if (deleted && selectedJobId === jobId) updatePresentationLocation(null);
    };
    const selectArtifact = store((s) => s.selectArtifact);
    const exportArtifact = store((s) => s.exportArtifact);
    const dismissError = store((s) => s.dismissError);
    const dismissExport = store((s) => s.dismissExport);
    const selectedJobArtifacts = useMemo<ArtifactSnapshot[]>(() => {
      if (!selectedJob) return [];
      return (selectedJob.artifactIds ?? [])
        .map((id) => artifacts[id])
        .filter((a): a is ArtifactSnapshot => Boolean(a));
    }, [artifacts, selectedJob]);
    const selectedJobArtifactMap = useMemo<Record<string, ArtifactSnapshot>>(
      () =>
        Object.fromEntries(selectedJobArtifacts.map((artifact) => [artifact.artifactId, artifact])),
      [selectedJobArtifacts],
    );

    const isJobRunning = jobState === 'queued' || jobState === 'running';
    const isHydratingArtifacts =
      jobState === 'completed' &&
      Boolean(selectedJob?.artifactIds?.length) &&
      selectedJobArtifacts.length < (selectedJob?.artifactIds?.length ?? 0);
    const isGenerating = isJobRunning || isHydratingArtifacts;

    const slideArtifacts = useMemo(
      () => currentSlideArtifacts(selectedJobArtifacts),
      [selectedJobArtifacts],
    );

    const selectedArtifact =
      selectedJobArtifacts.find((a) => a.artifactId === selectedArtifactId) ??
      slideArtifacts.find(
        (a) =>
          a.metadata?.slideNumber ===
          (selectedArtifactId ? artifacts[selectedArtifactId]?.metadata?.slideNumber : undefined),
      ) ??
      selectedJobArtifacts.find((a) => a.status === 'ready') ??
      selectedJobArtifacts[0];

    const effectiveSelectedArtifactId = selectedArtifact?.artifactId ?? selectedArtifactId;

    const selectedSlide =
      slideArtifacts.find((a) => a.artifactId === effectiveSelectedArtifactId) ?? slideArtifacts[0];

    const busyState =
      pendingAction === 'cancel' || pendingAction === 'retry' ? pendingAction : null;

    // C-87: slots of the selected job, flattened in stable key order.
    const selectedJobSlots = useMemo(
      () =>
        Object.values(slots).filter(
          (slot) => slots[`${selectedJobId}:${slot.slideId}:${slot.slotId}`],
        ),
      [selectedJobId, slots],
    );
    const retryPendingKeys = useMemo(() => {
      const prefix = `${selectedJobId}:`;
      const keys: Record<string, boolean> = {};
      for (const [key, pending] of Object.entries(slotRetryPending)) {
        if (pending && key.startsWith(prefix)) {
          const [, slideId, slotId] = key.split(':');
          keys[`${slideId}:${slotId}`] = true;
        }
      }
      return keys;
    }, [selectedJobId, slotRetryPending]);

    // C-93: slot thumbnails resolve through the selected job's artifacts map only.
    const resolveArtifactUri = useMemo(() => {
      if (!selectedJobId) return undefined;
      const job = jobsById[selectedJobId];
      const scopedIds = new Set(job?.artifactIds ?? []);
      return (artifactId: string): string | undefined =>
        scopedIds.has(artifactId) ? artifacts[artifactId]?.uri : undefined;
    }, [artifacts, jobsById, selectedJobId]);

    const handleExport = (artifactId: string, format: PresentationExportFormat) => {
      exportArtifact(artifactId, format);
    };

    const handleResubmit = async () => {
      if (creating || resubmitting) return;
      setCreating(true);
      try {
        const jobId = await resubmitLastInput();
        if (jobId) selectJob(jobId);
      } finally {
        setCreating(false);
      }
    };

    const handleOutlineAiRewrite = async (input: {
      allSlides: OutlineSlide[];
      index?: number;
      mode: 'all' | 'slide';
      slide?: OutlineSlide;
      topic: string;
      audience: string;
      style: string;
    }): Promise<Partial<OutlineSlide> | OutlineSlide[] | void> => {
      const response = await fetch('/api/runtime/presentation/outline', {
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) throw new Error(`Outline provider unavailable (${response.status})`);
      const payload = (await response.json()) as {
        slide?: Partial<OutlineSlide>;
        slides?: OutlineSlide[];
      };
      return input.mode === 'all' ? payload.slides : payload.slide;
    };

    const selectedReady = Boolean(selectedArtifact && selectedArtifact.status === 'ready');
    const hasReadyDeck = selectedJobArtifacts.some(
      (artifact) => artifact.type === 'pptx' && artifact.status === 'ready',
    );
    const canExport =
      !exporting &&
      ((jobState === 'completed' && selectedReady) ||
        ((jobState === 'failed' || jobState === 'cancelled') && hasReadyDeck));
    const handleNewPresentation = () => {
      selectJob(null);
      setShowQuickComposer(false);
      setSelectedTemplate(null);
      setInitialTopic('');
      dismissError();
      dismissExport();
    };

    const templatePicker = (
      <Flexbox horizontal align="center" gap={6}>
        <TemplateLibraryButton
          selectedTemplate={selectedTemplate}
          onSelectTemplate={handleTemplateSelection}
        />
        {selectedTemplate && (
          <span
            title={selectedTemplate.name}
            style={{
              fontSize: 12,
              maxWidth: 180,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {selectedTemplate.name}
          </span>
        )}
      </Flexbox>
    );

    const emptyState =
      !selectedJob || initialLoading ? (
        initialLoading ? (
          <div
            aria-label="Restoring presentation jobs"
            className={styles.emptyArea}
            data-testid="studio-loading"
            role="status"
          >
            <Spin size="large" />
            <p className={styles.emptyDescription}>正在恢复演示文稿任务…</p>
          </div>
        ) : showQuickComposer ? (
          <Flexbox horizontal align="center" gap={8} justify="center">
            <Button type="text" onClick={() => setShowQuickComposer(false)}>
              {t('presentationConversation.backToPlanning')}
            </Button>
            {templatePicker}
          </Flexbox>
        ) : (
          <div className={styles.emptyArea} data-testid="studio-empty-state">
            <div className={styles.emptyHeader}>
              <Flexbox horizontal align="center" gap={8}>
                {!showLeftPanel && (
                  <div data-testid="presentation-sidebar-reopen">
                    <ToggleLeftPanelButton />
                  </div>
                )}
                <Button type="text" onClick={() => setShowQuickComposer(true)}>
                  {t('presentationConversation.quickCreate')}
                </Button>
                {templatePicker}
              </Flexbox>
              {jobs.length > 0 && (
                <Dropdown
                  trigger={['click']}
                  popupRender={() => (
                    <div className={styles.worksPanel} data-testid="presentation-works-panel">
                      <PresentationJobList
                        jobs={jobs}
                        selectedJobId={selectedJobId}
                        titles={jobTitles}
                        onDelete={handleDeleteJob}
                        onSelect={selectJob}
                      />
                    </div>
                  )}
                >
                  <Button className={styles.emptyWorks} type="text">
                    我的作品
                  </Button>
                </Dropdown>
              )}
            </div>
            <PresentationAgentFlow
              agentClient={presentationAgentClient}
              creating={creating}
              defaultLanguage={defaultLanguage}
              defaultNotebookId={defaultNotebookId}
              defaultSourceVersionIds={defaultSourceVersionIds}
              initialTopic={initialTopic}
              selectedTemplate={selectedTemplate ?? undefined}
              onOutlineAiRewrite={handleOutlineAiRewrite}
              onCreate={async (input) => {
                if (creating) return;
                setCreating(true);
                try {
                  await createJobWithTemplate(input);
                } finally {
                  setCreating(false);
                }
              }}
            />
          </div>
        )
      ) : null;

    const showCompletedWorkspace = Boolean(
      selectedJob && !emptyState && (jobState === 'completed' || slideArtifacts.length > 0),
    );
    const showGenerationWorkspace = Boolean(isGenerating && selectedJob && !showCompletedWorkspace);
    const liveActivity =
      typeof (generatingJob as Record<string, unknown> | undefined)?.activity === 'string'
        ? ((generatingJob as Record<string, unknown>).activity as string)
        : undefined;

    return (
      <div
        className={className ? `${styles.studio} ${className}` : styles.studio}
        data-testid="presentation-studio"
      >
        <header aria-label="Presentation studio header" className={styles.srOnly}>
          <h1 className={styles.title}>PPT 工作台</h1>
          {transportMode === 'demo' ? (
            <Tag
              className={styles.demoBadge}
              color="gold"
              data-testid="presentation-demo-badge"
              icon={<Icon icon={FlaskConical} size={12} />}
            >
              Demo data — fake transport, no real provider
            </Tag>
          ) : (
            <Tag color="default" data-testid="presentation-transport-badge">
              运行时连接
              <span className={styles.srOnly}>Runtime HTTP transport</span>
            </Tag>
          )}
        </header>

        {/* C-80: while a dedicated export-failure alert is showing, the generic
            clientError alert is suppressed for export-origin codes. */}
        {clientError && !(exportError && clientError.code === exportError.code) && (
          <div className={styles.errorBox} data-testid="presentation-client-error">
            {clientError.code === 'PROVIDER_UNAVAILABLE' ? (
              <Alert
                closable
                showIcon
                data-testid="presentation-provider-unavailable"
                role="alert"
                type="warning"
                action={
                  <Flexbox gap={8}>
                    <Button
                      aria-busy={creating || resubmitting}
                      aria-label="Resubmit the last presentation request"
                      data-testid="presentation-provider-resubmit"
                      disabled={creating || resubmitting}
                      loading={creating || resubmitting}
                      size="small"
                      onClick={() => {
                        void handleResubmit();
                      }}
                    >
                      Try again
                    </Button>
                    <Button
                      aria-label="Focus the presentation creator"
                      size="small"
                      onClick={() => {
                        document.getElementById('presentation-composer-title')?.focus();
                      }}
                    >
                      Edit request
                    </Button>
                  </Flexbox>
                }
                description={
                  <span id="presentation-provider-unavailable-description">
                    演示文稿生成服务暂未就绪，你的草稿已保存在左侧表单中，请稍后重试。
                    <span style={{ display: 'none' }}>
                      Presentation generation is unavailable because the PPT provider is not
                      configured on this deployment. Your request is kept in the composer — check
                      the provider configuration or contact the administrator, then try again. No
                      progress is shown because no job was created.
                    </span>
                  </span>
                }
                message={
                  <span>
                    演示文稿生成服务当前不可用
                    <span style={{ display: 'none' }}>
                      Presentation generation is currently unavailable
                    </span>
                  </span>
                }
                onClose={dismissError}
              />
            ) : (
              <Alert
                closable
                showIcon
                description={clientError.message}
                role="alert"
                type="error"
                message={
                  <span>
                    运行时错误: {clientError.code}
                    <span style={{ display: 'none' }}>
                      Presentation runtime error: {clientError.code}
                    </span>
                  </span>
                }
                onClose={dismissError}
              />
            )}
          </div>
        )}

        {exportError && (
          <div className={styles.errorBox} data-testid="presentation-export-error">
            <Alert
              closable
              showIcon
              role="alert"
              type="error"
              action={
                <Button
                  aria-busy={Boolean(exporting)}
                  aria-label="Retry the failed export"
                  data-testid="presentation-export-retry"
                  disabled={Boolean(exporting)}
                  loading={Boolean(exporting)}
                  size="small"
                  onClick={() => {
                    void exportArtifact(exportError.artifactId, exportError.format);
                  }}
                >
                  Retry export
                </Button>
              }
              description={
                <span>
                  {`导出 "${exportError.artifactId}" (${exportError.format}) 失败: ${exportError.message} — 表单和选择已保留，未产生无效下载。`}
                  <span style={{ display: 'none' }}>
                    {`The export of "${exportError.artifactId}" (${exportError.format}) failed: ${exportError.message} — your selection and drafts are kept, and nothing was downloaded.`}
                  </span>
                </span>
              }
              message={
                <span>
                  {`导出失败: ${exportError.code}`}
                  <span style={{ display: 'none' }}>{`Export failed: ${exportError.code}`}</span>
                </span>
              }
              onClose={dismissExport}
            />
          </div>
        )}

        {exported && (
          <div className={styles.exportNotice} data-testid="presentation-export-notice">
            <Alert
              closable
              showIcon
              type="success"
              description={
                exported.uri ? (
                  <a download data-testid="presentation-export-download" href={exported.uri}>
                    下载文件
                  </a>
                ) : undefined
              }
              message={
                <span>
                  {`${exported.format.toUpperCase()} 已就绪`}
                  <span style={{ display: 'none' }}>
                    {`Export created (${exported.format}): ${exported.artifactId}`}
                  </span>
                </span>
              }
              onClose={dismissExport}
            />
          </div>
        )}

        <div className={styles.conversationLayout}>
          <div className={`${styles.conversationMain} ${styles.conversationMainFill}`}>
            {emptyState ? (
              <div className={styles.emptyShell} data-testid="presentation-empty-shell">
                <div className={showQuickComposer ? styles.columnMain : styles.srOnly}>
                  <Button
                    aria-label="Focus the presentation creator"
                    className={styles.srOnly}
                    size="small"
                    onClick={() => document.getElementById('presentation-composer-title')?.focus()}
                  >
                    开始创建
                  </Button>
                  <PresentationComposer
                    defaultLanguage={defaultLanguage}
                    defaultNotebookId={defaultNotebookId}
                    defaultSourceVersionIds={defaultSourceVersionIds}
                    onCreate={createJobWithTemplate}
                  />
                </div>
                {emptyState}
              </div>
            ) : showGenerationWorkspace && selectedJob ? (
              <>
                {!showLeftPanel && (
                  <div data-testid="presentation-sidebar-reopen">
                    <ToggleLeftPanelButton />
                  </div>
                )}
                <PresentationGenerationWorkspace
                  activityHistory={generationProgressByJob[selectedJob.jobId]?.activityHistory}
                  artifacts={selectedJobArtifactMap}
                  busyState={busyState}
                  job={generatingJob ?? selectedJob}
                  streamStatus={selectedStreamStatus}
                  title={conciseTitle}
                  onCancel={cancelJob}
                />
                <div className={styles.srOnly}>
                  <PresentationJobList
                    jobs={jobs}
                    selectedJobId={selectedJobId}
                    titles={jobTitles}
                    onDelete={handleDeleteJob}
                    onSelect={selectJob}
                  />
                  <PresentationComposer
                    defaultLanguage={defaultLanguage}
                    defaultNotebookId={defaultNotebookId}
                    defaultSourceVersionIds={defaultSourceVersionIds}
                    onCreate={createJobWithTemplate}
                  />
                  <ArtifactPanel
                    artifacts={selectedJobArtifacts}
                    exporting={Boolean(exporting)}
                    jobState={jobState ?? null}
                    selectedArtifactId={effectiveSelectedArtifactId}
                    onExport={handleExport}
                    onSelect={selectArtifact}
                  />
                  {selectedJobId && (
                    <AssetSlotPanel
                      resolveArtifactUri={resolveArtifactUri}
                      retryPendingKeys={retryPendingKeys}
                      slots={selectedJobSlots}
                      onDismissError={(slideId, slotId) => {
                        dismissSlotError(selectedJobId, slideId, slotId);
                      }}
                      onRetry={(slideId, slotId) => {
                        void retrySlot(selectedJobId, slideId, slotId);
                      }}
                    />
                  )}
                  <SlideNavigator
                    hasSelection={Boolean(selectedJob)}
                    selectedArtifactId={effectiveSelectedArtifactId}
                    slides={slideArtifacts}
                    onSelect={selectArtifact}
                  />
                  <SlidePreview artifact={selectedSlide ?? null} />
                </div>
              </>
            ) : showCompletedWorkspace && selectedJob ? (
              <div className={styles.completedMain}>
                <CompletedWorkspace
                  activity={liveActivity}
                  activityHistory={generationProgressByJob[selectedJob.jobId]?.activityHistory}
                  canExport={canExport}
                  dismissSlotError={dismissSlotError}
                  effectiveSelectedArtifactId={effectiveSelectedArtifactId}
                  exported={exported}
                  exporting={exporting}
                  jobTitles={jobTitles}
                  jobs={jobs}
                  resolveArtifactUri={resolveArtifactUri}
                  retryPendingKeys={retryPendingKeys}
                  selectedJob={selectedJob}
                  selectedJobArtifacts={selectedJobArtifacts}
                  selectedJobSlots={selectedJobSlots}
                  selectedSlide={selectedSlide ?? null}
                  showInspector={showInspector}
                  showSidebarReopen={!showLeftPanel}
                  slideArtifacts={slideArtifacts}
                  retrySlot={async (...args) => {
                    await retrySlot(...args);
                  }}
                  onCancel={cancelJob}
                  onDeleteJob={handleDeleteJob}
                  onExport={handleExport}
                  onJobChanged={() => store.getState().refreshJob(selectedJob!.jobId)}
                  onNewPresentation={handleNewPresentation}
                  onRetryJob={retryJob}
                  onSelectArtifact={selectArtifact}
                  onSelectJob={selectJob}
                  onSendMessage={store.getState().sendMessage}
                />

                <div className={styles.srOnly}>
                  <PresentationJobList
                    jobs={jobs}
                    selectedJobId={selectedJobId}
                    titles={jobTitles}
                    onDelete={handleDeleteJob}
                    onSelect={selectJob}
                  />
                  <PresentationComposer
                    defaultLanguage={defaultLanguage}
                    defaultNotebookId={defaultNotebookId}
                    defaultSourceVersionIds={defaultSourceVersionIds}
                    onCreate={createJobWithTemplate}
                  />
                  <PresentationProgress
                    busyState={busyState}
                    job={selectedJob ?? null}
                    streamStatus={selectedStreamStatus}
                    title={selectedJob ? jobTitles[selectedJob.jobId] : undefined}
                    onCancel={cancelJob}
                    onRetry={retryJob}
                  />
                  {showAnnotationBar && <AnnotationBar />}
                </div>
              </div>
            ) : (
              selectedJob && (
                <PresentationRecoveryWorkspace
                  busy={Boolean(busyState)}
                  job={selectedJob}
                  showSidebarReopen={!showLeftPanel}
                  title={conciseTitle}
                  history={
                    <Dropdown
                      trigger={['click']}
                      popupRender={() => (
                        <div className={styles.worksPanel}>
                          <PresentationJobList
                            jobs={jobs}
                            selectedJobId={selectedJobId}
                            titles={jobTitles}
                            onDelete={handleDeleteJob}
                            onSelect={selectJob}
                          />
                        </div>
                      )}
                    >
                      <Button type="text">{t('presentationTemplates.history')}</Button>
                    </Dropdown>
                  }
                  onNew={handleNewPresentation}
                  onRetry={retryJob}
                />
              )
            )}
          </div>
          {!emptyState && !showCompletedWorkspace && selectedJob && (
            <ConversationPanel
              job={selectedJob}
              key={selectedJob.jobId}
              selectedPage={Number(selectedSlide?.metadata?.slideNumber) || undefined}
              onCancel={cancelJob}
              onRetry={retryJob}
              onSend={store.getState().sendMessage}
            />
          )}
        </div>
      </div>
    );
  },
);

PresentationStudio.displayName = 'PresentationStudio';

export default PresentationStudio;
