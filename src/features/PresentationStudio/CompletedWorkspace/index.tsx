import { Button, Icon } from '@lobehub/ui';
import { Tooltip } from 'antd';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConversationPanel } from '../ConversationPanel';
import SlideNavigator from '../SlideNavigator';
import ArchitectureDrawer from './ArchitectureDrawer';
import CapsuleHeader from './CapsuleHeader';
import PanoramaGrid from './PanoramaGrid';
import SlideFocusStage from './SlideFocusStage';
import { revealSrcsForSlide } from './slidePaint';
import { styles } from './style';
import type { CompletedViewMode, CompletedWorkspaceProps } from './types';

export const CompletedWorkspace = memo<CompletedWorkspaceProps>(
  ({
    activity,
    activityHistory,
    canExport,
    dismissSlotError,
    effectiveSelectedArtifactId,
    exported,
    exporting,
    jobTitles,
    jobs,
    onDeleteJob,
    onSelectJob,
    onCancel,
    onSendMessage,
    onExport,
    onJobChanged,
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
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [filmstripOpen, setFilmstripOpen] = useState(false);
    const [conversationOpen, setConversationOpen] = useState(false);
    const [conversationFocus, setConversationFocus] = useState(0);

    const openConversation = useCallback(() => {
      setConversationOpen(true);
      setConversationFocus((value) => value + 1);
    }, []);

    const toggleConversation = useCallback(() => {
      if (conversationOpen) {
        setConversationOpen(false);
        return;
      }
      openConversation();
    }, [conversationOpen, openConversation]);

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

    const deckArtifact = selectedJobArtifacts.find(
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
    const presentationStyle =
      typeof selectedSlide?.metadata?.style === 'string' ? selectedSlide.metadata.style : undefined;
    const latestPendingMessage = selectedJob.messages?.findLast(
      (message) => message.status !== 'applied',
    );
    const paintInterrupted =
      selectedJob.state === 'failed' && latestPendingMessage?.status === 'failed';
    const painting =
      selectedJob.state === 'running' || selectedJob.state === 'queued' || paintInterrupted;
    const paintingSlideNumber =
      latestPendingMessage?.target.type === 'slide'
        ? latestPendingMessage.target.slideNumber
        : undefined;
    const focusPainting =
      painting && (!paintingSlideNumber || paintingSlideNumber === currentIndex + 1);
    const focusRevealSrcs = revealSrcsForSlide(selectedSlide, selectedJobSlots, resolveArtifactUri);

    return (
      <div className={styles.workspaceRoot} data-testid="presentation-completed-workspace">
        {/* Top Capsule Floating Bar */}
        <CapsuleHeader
          activity={activity}
          activityHistory={activityHistory}
          canExport={canExport}
          canQuickExport={canExport && Boolean(deckArtifact)}
          conversationOpen={conversationOpen}
          currentIndex={currentIndex}
          drawerOpen={drawerOpen}
          exported={exported}
          exporting={exporting}
          job={selectedJob}
          jobTitle={jobTitle}
          jobs={jobs}
          presentationStyle={presentationStyle}
          showSidebarReopen={showSidebarReopen}
          slideCount={totalSlides}
          viewMode={viewMode}
          availableFormats={selectedJobArtifacts
            .filter((artifact) => artifact.status === 'ready')
            .map((artifact) => artifact.type)}
          onDeleteJob={onDeleteJob}
          onJobChanged={onJobChanged}
          onNewPresentation={onNewPresentation}
          onOpenConversation={openConversation}
          onQuickExport={handleQuickExport}
          onRetryJob={() => onRetryJob(selectedJob.jobId)}
          onSelectJob={onSelectJob}
          onToggleDrawer={() => setDrawerOpen((prev) => !prev)}
          onToggleViewMode={() => setViewMode((prev) => (prev === 'focus' ? 'lightbox' : 'focus'))}
          onExport={(format) => {
            const artifact =
              format === 'svg'
                ? selectedSlide
                : selectedJobArtifacts.find(
                    (item) => item.type === format && item.status === 'ready',
                  );
            if (artifact) onExport(artifact.artifactId, format);
          }}
        />

        {/* Main Body Layout: Collapsible Filmstrip + Stage + Architecture Drawer */}
        {studentHandout && (
          <div>
            <a
              download="student-handout.md"
              href={`/api/runtime/presentation/artifacts/${encodeURIComponent(studentHandout.artifactId)}?raw=true`}
            >
              {t('presentationLesson.handout')}
            </a>
            <span> · {t('presentationLesson.exportNotice')}</span>
          </div>
        )}
        <div className={styles.mainLayout}>
          {/* Collapsible Slide Filmstrip Dock (defaults collapsed) */}
          <div className={styles.filmstripContainer} data-open={filmstripOpen ? 'true' : 'false'}>
            <div className={styles.filmstripHeader}>
              <Tooltip title={filmstripOpen ? '收起胶卷' : '展开胶卷'}>
                <Button
                  aria-expanded={filmstripOpen}
                  aria-label={filmstripOpen ? '收起胶卷' : '展开胶卷'}
                  className={styles.iconButton}
                  type="text"
                  icon={
                    <Icon
                      aria-hidden
                      icon={filmstripOpen ? PanelLeftClose : PanelLeftOpen}
                      size={22}
                    />
                  }
                  onClick={() => setFilmstripOpen((prev) => !prev)}
                />
              </Tooltip>
            </div>

            <div
              className={styles.filmstripBody}
              style={{
                display: filmstripOpen ? 'block' : 'none',
              }}
            >
              <SlideNavigator
                compact
                hasSelection={Boolean(selectedJob)}
                selectedArtifactId={effectiveSelectedArtifactId}
                slides={slideArtifacts}
                onSelect={onSelectArtifact}
              />
            </div>
          </div>

          {/* Central Stage: Slide Focus Mode vs Panorama Lightbox Grid */}
          {viewMode === 'focus' ? (
            <SlideFocusStage
              conversationOpen={conversationOpen}
              currentIndex={currentIndex}
              jobId={selectedJob.jobId}
              paintInterrupted={paintInterrupted}
              painting={focusPainting}
              revealSrcs={focusRevealSrcs}
              selectedSlide={selectedSlide}
              totalSlides={totalSlides}
              versionId={selectedJob.versionId}
              onNext={handleNext}
              onOpenDrawer={() => setDrawerOpen(true)}
              onPrev={handlePrev}
              onSendMessage={onSendMessage}
              onToggleConversation={onSendMessage ? toggleConversation : undefined}
            />
          ) : (
            <PanoramaGrid
              paintInterrupted={paintInterrupted}
              painting={painting}
              paintingSlideNumber={paintingSlideNumber}
              resolveArtifactUri={resolveArtifactUri}
              selectedArtifactId={effectiveSelectedArtifactId}
              slides={slideArtifacts}
              slots={selectedJobSlots}
              onSelectSlide={handleBentoSelect}
            />
          )}

          {/* Right Architecture & Assets Drawer */}
          <ArchitectureDrawer
            currentIndex={currentIndex}
            dismissSlotError={dismissSlotError}
            exporting={exporting}
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
            onClose={() => setDrawerOpen(false)}
            onExport={onExport}
            onSelectArtifact={onSelectArtifact}
          />
        </div>

        {onSendMessage && (
          <ConversationPanel
            hideTrigger
            focusKey={conversationFocus}
            job={selectedJob}
            key={selectedJob.jobId}
            open={conversationOpen}
            selectedPage={Number(selectedSlide?.metadata?.slideNumber) || undefined}
            onCancel={onCancel ?? (async () => undefined)}
            onOpenChange={setConversationOpen}
            onRetry={async (jobId) => onRetryJob(jobId)}
            onSend={onSendMessage}
          />
        )}
      </div>
    );
  },
);

CompletedWorkspace.displayName = 'CompletedWorkspace';

export default CompletedWorkspace;
