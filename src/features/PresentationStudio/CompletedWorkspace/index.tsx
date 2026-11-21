import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { panelMotionStyle } from '@/features/GlassMotion/panelMotion';
import { PanelToggle } from '@/features/GlassMotion/PanelToggle';
import type { CanvasControls } from '@/features/SpatialCanvas';
import { glassSurface, liquidGlass } from '@/styles/liquidGlass';

import SlideNavigator from '../SlideNavigator';
import ArchitectureDrawer from './ArchitectureDrawer';
import CapsuleHeader from './CapsuleHeader';
import PanoramaGrid from './PanoramaGrid';
import SlideFocusStage from './SlideFocusStage';
import { styles } from './style';
import type { CompletedViewMode, CompletedWorkspaceProps } from './types';

export const CompletedWorkspace = memo<CompletedWorkspaceProps>(
  ({
    activity,
    activityHistory,
    canExport,
    collaboration,
    dismissSlotError,
    effectiveSelectedArtifactId,
    exporting,
    exportFeedback,
    jobTitles,
    jobs,
    onBack,
    onDeleteJob,
    onSelectJob,
    onSendMessage,
    dataError,
    onExport,
    onJobChanged,
    onTrialVersionCreated,
    onNewPresentation,
    onRetryJob,
    onSelectArtifact,
    resolveArtifactUri,
    retryPendingKeys,
    retrySlot,
    selectedJob,
    selectedJobArtifacts,
    selectedJobSlots,
    selectedSlide,
    showInspector = true,
    showSidebarReopen = false,
    slideArtifacts,
  }) => {
    const { t } = useTranslation('common');
    const studentHandout = selectedJobArtifacts.find(
      (artifact) =>
        artifact.status === 'ready' && artifact.metadata?.artifactRole === 'student-handout',
    );
    const [viewMode, setViewMode] = useState<CompletedViewMode>('focus');
    const [focused, setFocused] = useState(true);
    useEffect(() => {
      const query = window.matchMedia?.('(max-width: 768px)');
      const expand = (event: MediaQueryListEvent) => {
        if (event.matches) setFocused(true);
      };
      query?.addEventListener?.('change', expand);
      return () => query?.removeEventListener?.('change', expand);
    }, []);
    const mount = useRef<HTMLDivElement>(null);
    const [host] = useState(() => {
      if (typeof document === 'undefined') return undefined;
      const node = document.createElement('div');
      node.style.display = 'contents';
      return node;
    });
    useLayoutEffect(() => {
      if (!mount.current || !host) return;
      const themeRoot = mount.current.closest('.ant-app') ?? document.body;
      const previousFocus = document.activeElement;
      const restoreFocus = previousFocus instanceof HTMLElement && host.contains(previousFocus);
      (focused ? themeRoot : mount.current).appendChild(host);
      if (restoreFocus) previousFocus.focus({ preventScroll: true });
      const background = [...themeRoot.children].find(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child !== host && child.contains(mount.current),
      );
      if (!focused || !background) return;
      const originallyInert = background.inert;
      background.inert = true;
      return () => {
        background.inert = originallyInert;
      };
    }, [focused, host]);
    useLayoutEffect(
      () => () => {
        host?.remove();
      },
      [host],
    );
    useEffect(() => {
      if (!focused) return;
      const escape = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if (
          event.target instanceof Element &&
          event.target.closest(
            'input, textarea, select, [contenteditable=true], [role=menu], [data-studio-layers]',
          )
        )
          return;
        if (
          [
            ...document.querySelectorAll<HTMLElement>(
              '[role="dialog"], [data-studio-layers] [role="menu"], [data-studio-layers] [role="listbox"]',
            ),
          ].some((dialog) => dialog.getClientRects().length)
        )
          return;
        setFocused(false);
      };
      window.addEventListener('keydown', escape);
      return () => window.removeEventListener('keydown', escape);
    }, [focused]);
    const canvas = useRef<CanvasControls>(null);
    const filmstrip = useRef<HTMLDivElement>(null);
    const filmstripId = useId();
    const drawerId = useId();
    const drawerTrigger = useRef<HTMLButtonElement>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [filmstripOpen, setFilmstripOpen] = useState(false);
    useLayoutEffect(() => {
      const rail = filmstrip.current;
      const active = rail?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!filmstripOpen || !rail || !active) return;
      // Move only the filmstrip; scrollIntoView also scrolls the surrounding chat.
      const visible = rail.getBoundingClientRect();
      const page = active.getBoundingClientRect();
      if (page.top < visible.top) rail.scrollTop += page.top - visible.top;
      else if (page.bottom > visible.bottom) rail.scrollTop += page.bottom - visible.bottom;
    }, [effectiveSelectedArtifactId, filmstripOpen]);
    const [annotating, setAnnotating] = useState(false);
    const [annotationDock, setAnnotationDock] = useState<HTMLDivElement | null>(null);
    const totalSlides = slideArtifacts.length;
    const currentIndex = useMemo(() => {
      if (!selectedSlide) return 0;
      const idx = slideArtifacts.findIndex((s) => s.artifactId === selectedSlide.artifactId);
      return idx >= 0 ? idx : 0;
    }, [selectedSlide, slideArtifacts]);

    const handlePrev = useCallback(() => {
      if (currentIndex > 0) {
        onSelectArtifact(slideArtifacts[currentIndex - 1].artifactId);
      }
    }, [currentIndex, onSelectArtifact, slideArtifacts]);

    const handleNext = useCallback(() => {
      if (currentIndex < totalSlides - 1) {
        onSelectArtifact(slideArtifacts[currentIndex + 1].artifactId);
      }
    }, [currentIndex, onSelectArtifact, slideArtifacts, totalSlides]);

    const handleBentoSelect = useCallback(
      (artifactId: string) => {
        onSelectArtifact(artifactId);
        setViewMode('focus');
      },
      [onSelectArtifact],
    );

    const revision = selectedJob.revisions?.findLast(
      ({ versionId }) => versionId === selectedJob.versionId,
    );
    const exportArtifacts = revision
      ? selectedJobArtifacts.filter((artifact) =>
          revision.artifactIds.includes(artifact.artifactId),
        )
      : selectedJobArtifacts;
    const deckArtifact = exportArtifacts.findLast(
      (artifact) => artifact.type === 'pptx' && artifact.status === 'ready',
    );
    const handleQuickExport = useCallback(() => {
      if (deckArtifact && canExport) {
        onExport(deckArtifact.artifactId, 'pptx');
      }
    }, [canExport, onExport, deckArtifact]);

    const rawJobTitle = selectedJob ? jobTitles[selectedJob.jobId] : undefined;
    const jobTitle = rawJobTitle
      ? rawJobTitle
          .split(/\r?\n/u, 1)[0]
          ?.trim()
          .replace(/^(?:演示文稿主题|主题)[:：]\s*/u, '')
          .slice(0, 48)
      : undefined;
    const latestPendingMessage = selectedJob.messages?.findLast(
      (message) => message.status !== 'applied',
    );
    const paintInterrupted =
      selectedJob.state === 'failed' && latestPendingMessage?.status === 'failed';
    const painting =
      selectedJob.state === 'running' || selectedJob.state === 'queued' || paintInterrupted;
    const savingCanvas =
      painting &&
      !paintInterrupted &&
      Boolean(
        latestPendingMessage?.canvasCommand ||
        latestPendingMessage?.objectPositionPatch ||
        latestPendingMessage?.annotation?.textRuns ||
        latestPendingMessage?.tableDataPatch ||
        latestPendingMessage?.chartDataPatch,
      );
    const paintingSlideNumber =
      latestPendingMessage?.target.type === 'slide'
        ? latestPendingMessage.target.slideNumber
        : undefined;
    const focusPainting =
      painting && (!paintingSlideNumber || paintingSlideNumber === currentIndex + 1);

    const workspace = (
      <div
        className={`${liquidGlass} ${styles.workspaceRoot}`}
        style={panelMotionStyle}
        data-focused={focused}
        data-testid="presentation-completed-workspace"
      >
        {collaboration && <div className={styles.collaborationSlot}>{collaboration}</div>}
        <CapsuleHeader
          activity={savingCanvas ? t('presentationCanvas.saving') : activity}
          activityHistory={activityHistory}
          canExport={canExport}
          canQuickExport={canExport && Boolean(deckArtifact)}
          drawerOpen={drawerOpen}
          drawerTrigger={drawerTrigger}
          exporting={exporting}
          focused={focused}
          handoutId={studentHandout?.artifactId}
          job={selectedJob}
          jobTitle={jobTitle}
          jobs={jobs}
          showSidebarReopen={showSidebarReopen}
          viewMode={viewMode}
          availableFormats={exportArtifacts
            .filter((artifact) => artifact.status === 'ready')
            .map((artifact) => artifact.type)}
          slideId={
            typeof selectedSlide?.metadata?.slideId === 'string'
              ? selectedSlide.metadata.slideId
              : undefined
          }
          onBack={onBack}
          onDeleteJob={onDeleteJob}
          onJobChanged={onJobChanged}
          onNewPresentation={onNewPresentation}
          onQuickExport={handleQuickExport}
          onRetryJob={() => onRetryJob(selectedJob.jobId)}
          onSelectJob={onSelectJob}
          onToggleDrawer={() => setDrawerOpen((prev) => !prev)}
          onToggleFocus={() => setFocused((value) => !value)}
          onTrialVersionCreated={onTrialVersionCreated}
          onExport={(format) => {
            const artifact =
              format === 'svg'
                ? selectedSlide
                : exportArtifacts.findLast(
                    (item) => item.type === format && item.status === 'ready',
                  );
            if (artifact) onExport(artifact.artifactId, format);
          }}
          onToggleViewMode={() => {
            setAnnotating(false);
            setViewMode((prev) => (prev === 'focus' ? 'lightbox' : 'focus'));
          }}
        />

        {exportFeedback}
        <div className={styles.mainLayout}>
          <div
            className={`${glassSurface} ${styles.filmstripContainer}`}
            data-open={filmstripOpen ? 'true' : 'false'}
          >
            <div className={styles.filmstripHeader}>
              <PanelToggle
                aria-controls={filmstripId}
                expanded={filmstripOpen}
                side="left"
                label={
                  filmstripOpen
                    ? t('panel.filmstripClose', '收起胶卷')
                    : t('panel.filmstripOpen', '展开胶卷')
                }
                onToggle={() => setFilmstripOpen((prev) => !prev)}
              />
            </div>

            <div
              className={styles.filmstripBody}
              id={filmstripId}
              ref={filmstrip}
              style={{
                display: filmstripOpen ? 'block' : 'none',
              }}
            >
              <SlideNavigator
                compact
                hasSelection={Boolean(selectedJob)}
                selectedArtifactId={effectiveSelectedArtifactId}
                slides={slideArtifacts}
                onSelect={(id) => {
                  canvas.current?.fitPage();
                  onSelectArtifact(id);
                  if (window.matchMedia?.('(max-width: 768px)').matches) setFilmstripOpen(false);
                }}
              />
            </div>
          </div>

          <div className={styles.editorColumn}>
            {/* Central Stage: Slide Focus Mode vs Panorama Lightbox Grid */}
            {viewMode === 'focus' ? (
              <SlideFocusStage
                onFocusPage={() => setFocused(true)}
                job={selectedJob}
                annotating={annotating}
                annotationDock={annotationDock}
                canEditObjects={selectedJob.state === 'completed'}
                canvas={canvas}
                currentIndex={currentIndex}
                dataError={dataError}
                jobId={selectedJob.jobId}
                paintInterrupted={paintInterrupted}
                painting={focusPainting && !savingCanvas}
                selectedSlide={selectedSlide}
                setAnnotating={setAnnotating}
                slides={slideArtifacts}
                totalSlides={totalSlides}
                versionId={selectedJob.versionId}
                onNext={handleNext}
                onPrev={handlePrev}
                onSelectSlide={onSelectArtifact}
                onSendMessage={onSendMessage}
              />
            ) : (
              <PanoramaGrid
                paintInterrupted={paintInterrupted}
                painting={painting}
                paintingSlideNumber={paintingSlideNumber}
                selectedArtifactId={effectiveSelectedArtifactId}
                slides={slideArtifacts}
                onSelectSlide={handleBentoSelect}
              />
            )}

            <div hidden={viewMode !== 'focus' || !annotating} ref={setAnnotationDock} />
          </div>

          {/* Right Architecture & Assets Drawer */}
          <ArchitectureDrawer
            currentIndex={currentIndex}
            dismissSlotError={dismissSlotError}
            exporting={exporting}
            id={drawerId}
            jobId={selectedJob.jobId}
            jobState={selectedJob.state}
            open={drawerOpen}
            resolveArtifactUri={resolveArtifactUri}
            retryPendingKeys={retryPendingKeys}
            retrySlot={retrySlot}
            selectedArtifactId={effectiveSelectedArtifactId}
            selectedJobArtifacts={selectedJobArtifacts}
            selectedJobSlots={selectedJobSlots}
            selectedSlide={selectedSlide}
            showInspector={showInspector}
            onExport={onExport}
            onSelectArtifact={onSelectArtifact}
            onClose={() => {
              setDrawerOpen(false);
              drawerTrigger.current?.focus({ preventScroll: true });
            }}
          />
        </div>
      </div>
    );
    return (
      <div className={styles.workspaceMount} ref={mount}>
        {host ? createPortal(workspace, host) : workspace}
      </div>
    );
  },
);

CompletedWorkspace.displayName = 'CompletedWorkspace';

export default CompletedWorkspace;
