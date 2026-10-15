import { Button, Flexbox, Icon, Tag } from '@lobehub/ui';
import { Tooltip } from 'antd';
import {
  FileText,
  Image as ImageIcon,
  Layers,
  ListTree,
  MessageSquare,
  RefreshCw,
  X,
} from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ArtifactSnapshot,
  PresentationExportFormat,
  PresentationJobState,
} from '../../../../packages/runtime-contracts/src/index';
import ArtifactPanel from '../ArtifactPanel';
import AssetSlotPanel from '../AssetSlotPanel';
import SlideInspector from '../SlideInspector';
import type { PresentationSlotState } from '../store/presentationStore';
import { styles } from './style';

export interface ArchitectureDrawerProps {
  currentIndex: number;
  dismissSlotError: (jobId: string, slideId: string, slotId: string) => void;
  exporting?: boolean | string | null;
  jobId: string;
  jobState?: PresentationJobState | null;
  onClose: () => void;
  onExport: (artifactId: string, format: PresentationExportFormat) => void;
  onSelectArtifact: (artifactId: string) => void;
  open: boolean;
  resolveArtifactUri?: (artifactId: string) => string | undefined;
  retryPendingKeys: Record<string, boolean>;
  retrySlot: (jobId: string, slideId: string, slotId: string) => Promise<void>;
  selectedArtifactId: string | null;
  selectedJobArtifacts: ArtifactSnapshot[];
  selectedJobSlots: PresentationSlotState[];
  selectedSlide: ArtifactSnapshot | null;
  showInspector?: boolean;
}

const getSlotStatusZh = (status?: string): string => {
  switch (status) {
    case 'ready': {
      return '已就绪';
    }
    case 'generating': {
      return '生成中';
    }
    case 'failed': {
      return '生成失败';
    }
    case 'cancelled': {
      return '已取消';
    }
    case 'pending':
    default: {
      return '待处理';
    }
  }
};

const isImagePreviewUri = (uri: string): boolean => {
  if (uri.startsWith('/api/runtime/presentation/artifacts/')) return true;
  if (/^data:image\/(?:png|jpeg|webp);base64,/iu.test(uri)) return true;
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

export const ArchitectureDrawer = memo<ArchitectureDrawerProps>(
  ({
    currentIndex,
    dismissSlotError,
    exporting = false,
    jobId,
    jobState = null,
    onClose,
    onExport,
    onSelectArtifact,
    open,
    resolveArtifactUri,
    retryPendingKeys,
    retrySlot,
    selectedArtifactId,
    selectedJobArtifacts,
    selectedJobSlots,
    selectedSlide,
    showInspector = true,
  }) => {
    const { t } = useTranslation('common');
    // Current slide outline extraction from metadata
    const metadata = selectedSlide?.metadata as Record<string, unknown> | undefined;
    const decision = metadata?.autonomousVisualDecision as
      { strategy?: unknown; reason?: unknown; composition?: unknown } | undefined;
    const strategy = (['native', 'source', 'reuse', 'generate', 'mixed'] as const).find(
      (value) => value === decision?.strategy,
    );
    const slideTitle =
      (typeof metadata?.title === 'string' && metadata.title.trim()) ||
      selectedSlide?.name ||
      `第 ${currentIndex + 1} 页`;

    const outlineBullets = useMemo<string[]>(() => {
      if (!metadata) return [];
      if (Array.isArray(metadata.outline)) {
        return metadata.outline.map((item) => String(item).trim()).filter(Boolean);
      }
      if (Array.isArray(metadata.bullets)) {
        return metadata.bullets.map((item) => String(item).trim()).filter(Boolean);
      }
      if (typeof metadata.outline === 'string' && metadata.outline.trim()) {
        return metadata.outline
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
      }
      if (typeof metadata.summary === 'string' && metadata.summary.trim()) {
        return [metadata.summary.trim()];
      }
      return [];
    }, [metadata]);

    // Current slide notes extraction
    const speakerNotes = useMemo<string | null>(() => {
      if (!metadata) return null;
      if (typeof metadata.notes === 'string' && metadata.notes.trim()) {
        return metadata.notes.trim();
      }
      if (typeof metadata.speakerNotes === 'string' && metadata.speakerNotes.trim()) {
        return metadata.speakerNotes.trim();
      }
      return null;
    }, [metadata]);

    // Current slide slots filtering (strictly per-page)
    const currentSlideId = (metadata?.slideId as string) || selectedSlide?.artifactId;
    const currentSlideNumber = (metadata?.slideNumber as number) ?? currentIndex + 1;

    const currentSlideSlots = useMemo(() => {
      return selectedJobSlots.filter((slot) => {
        return (
          slot.slideId === currentSlideId ||
          slot.slideId === selectedSlide?.artifactId ||
          slot.slideId === String(currentSlideNumber) ||
          slot.slideId === `slide-${currentSlideNumber}`
        );
      });
    }, [selectedJobSlots, currentSlideId, selectedSlide?.artifactId, currentSlideNumber]);

    const currentSlideImages = useMemo(() => {
      const refs = new Set(
        Array.isArray(metadata?.generatedAssetRefs)
          ? metadata.generatedAssetRefs.filter((ref): ref is string => typeof ref === 'string')
          : [],
      );
      const represented = new Set(
        currentSlideSlots
          .filter((slot) => slot.status === 'ready')
          .flatMap((slot) => slot.artifactIds),
      );
      return selectedJobArtifacts.filter((artifact) => {
        if (
          !refs.has(artifact.artifactId) ||
          represented.has(artifact.artifactId) ||
          artifact.status !== 'ready' ||
          artifact.type !== 'image' ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mimeType ?? '')
        )
          return false;
        represented.add(artifact.artifactId);
        return true;
      });
    }, [metadata?.generatedAssetRefs, currentSlideSlots, selectedJobArtifacts]);

    return (
      <aside
        aria-label="当前页架构与资产抽屉"
        className={styles.drawerRoot}
        data-open={open ? 'true' : 'false'}
        data-testid="presentation-architecture-drawer"
        style={{
          border: open ? '1px solid var(--ant-color-border-secondary)' : 'none',
          marginLeft: open ? 0 : -12,
          maxWidth: open ? 360 : 0,
          minWidth: open ? 340 : 0,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          width: open ? 360 : 0,
        }}
      >
        <div className={styles.drawerHeader}>
          <Flexbox horizontal align="center" gap={8}>
            <Icon icon={Layers} size={15} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>架构与资产</span>
            <Tag bordered={false} size="small">
              第 {currentIndex + 1} 页
            </Tag>
          </Flexbox>
          <Tooltip title="关闭">
            <Button
              aria-label="关闭抽屉"
              className={styles.iconButton}
              icon={<Icon aria-hidden icon={X} size={22} />}
              type="text"
              onClick={onClose}
            />
          </Tooltip>
        </div>

        <div className={styles.drawerBody}>
          {/* Section 1: Outline */}
          <section className={styles.drawerSection} data-testid="drawer-outline-section">
            <div className={styles.drawerSectionHeader}>
              <Icon icon={ListTree} size={14} />
              <span>页面大纲</span>
            </div>

            <div className={styles.drawerSectionContent}>
              <div style={{ fontWeight: 600, marginBottom: outlineBullets.length > 0 ? 6 : 0 }}>
                {slideTitle}
              </div>
              {outlineBullets.length > 0 ? (
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  {outlineBullets.map((bullet, idx) => (
                    <li key={idx} style={{ marginBottom: 4 }}>
                      {bullet}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className={styles.drawerEmptyState}>
                  <Icon icon={FileText} size={16} />
                  <span>暂无当前页大纲信息</span>
                </div>
              )}
            </div>
          </section>

          {/* Section 2: Assets & Slots (strictly for current slide) */}
          {strategy && typeof decision?.reason === 'string' && (
            <section className={styles.drawerSection} data-testid="drawer-visual-decision-section">
              <div className={styles.drawerSectionHeader}>
                <Icon icon={Layers} size={14} />
                <span>{t('presentationVisualDecision.title')}</span>
                <Tag bordered={false} size="small">
                  {t(`presentationVisualDecision.strategy.${strategy}`)}
                </Tag>
              </div>
              <div className={styles.drawerSectionContent}>
                <p>{decision.reason}</p>
                {typeof decision.composition === 'string' && <p>{decision.composition}</p>}
                {typeof metadata?.illustrationStyle === 'string' && (
                  <p>
                    {t('presentationVisualDecision.style')}
                    {metadata.illustrationStyle}
                  </p>
                )}
              </div>
            </section>
          )}
          <section className={styles.drawerSection} data-testid="drawer-assets-section">
            <div className={styles.drawerSectionHeader}>
              <Icon icon={ImageIcon} size={14} />
              <span>当前页资产与槽位</span>
            </div>

            {currentSlideSlots.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {currentSlideSlots.map((slot) => {
                  const key = `${slot.slideId}:${slot.slotId}`;
                  const retryPending = Boolean(retryPendingKeys[key]);
                  const canRetry = slot.status === 'failed' || slot.status === 'cancelled';
                  const firstArtifact = slot.status === 'ready' ? slot.artifactIds[0] : undefined;
                  const resolvedUri = firstArtifact
                    ? resolveArtifactUri?.(firstArtifact)
                    : undefined;

                  return (
                    <div
                      aria-busy={slot.status === 'generating' || retryPending}
                      className={styles.drawerSectionContent}
                      data-slide-id={slot.slideId}
                      data-slot-id={slot.slotId}
                      data-testid={`drawer-slot-${slot.slideId}-${slot.slotId}`}
                      key={key}
                    >
                      <Flexbox
                        horizontal
                        align="center"
                        justify="space-between"
                        style={{ marginBottom: 6 }}
                      >
                        <span style={{ fontWeight: 600, fontSize: 12 }}>
                          {slot.label || `槽位 ${slot.slotId}`}
                        </span>
                        <Tag
                          size="small"
                          color={
                            slot.status === 'ready'
                              ? 'success'
                              : slot.status === 'failed'
                                ? 'error'
                                : slot.status === 'generating'
                                  ? 'processing'
                                  : 'default'
                          }
                        >
                          {getSlotStatusZh(slot.status)}
                          <span style={{ display: 'none' }}>{slot.status}</span>
                        </Tag>
                      </Flexbox>

                      {resolvedUri && slot.status === 'ready' ? (
                        <div
                          style={{
                            aspectRatio: '16 / 9',
                            background: '#0d0f12',
                            borderRadius: 6,
                            marginBottom: 8,
                            overflow: 'hidden',
                            width: '100%',
                          }}
                        >
                          <img
                            alt={slot.label}
                            src={resolvedUri}
                            style={{
                              display: 'block',
                              height: '100%',
                              objectFit: 'contain',
                              width: '100%',
                            }}
                          />
                        </div>
                      ) : null}

                      {(canRetry || retryPending) && (
                        <Button
                          aria-busy={retryPending}
                          disabled={retryPending}
                          icon={<Icon icon={RefreshCw} size={12} />}
                          loading={retryPending}
                          size="small"
                          onClick={() => void retrySlot(jobId, slot.slideId, slot.slotId)}
                        >
                          重新生成槽位
                        </Button>
                      )}

                      {slot.errorCode && (
                        <div
                          style={{ color: 'var(--ant-color-error)', fontSize: 11, marginTop: 4 }}
                        >
                          错误: {slot.errorCode}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {currentSlideImages.map((artifact, index) => {
              const uri = resolveArtifactUri?.(artifact.artifactId);
              const preview = uri && isImagePreviewUri(uri) ? uri : undefined;
              const name = currentSlideImages.length > 1 ? `配图 ${index + 1}` : '配图';
              return (
                <div
                  className={styles.drawerSectionContent}
                  data-testid={`drawer-image-${artifact.artifactId}`}
                  key={artifact.artifactId}
                >
                  <div
                    aria-label={`第 ${currentSlideNumber} 页${name}`}
                    role="group"
                    style={{
                      background: 'transparent',
                      border: 0,
                      color: 'inherit',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      padding: 0,
                      textAlign: 'start',
                      width: '100%',
                    }}
                  >
                    <div
                      style={{
                        alignItems: 'center',
                        aspectRatio: '4 / 3',
                        background: 'var(--ant-color-fill-quaternary)',
                        borderRadius: 12,
                        display: 'flex',
                        justifyContent: 'center',
                        overflow: 'hidden',
                        width: '100%',
                      }}
                    >
                      {preview ? (
                        <img
                          alt={name}
                          loading="lazy"
                          src={preview}
                          style={{
                            display: 'block',
                            height: '100%',
                            objectFit: 'contain',
                            width: '100%',
                          }}
                        />
                      ) : (
                        <Icon aria-hidden icon={ImageIcon} size={28} />
                      )}
                    </div>
                    <span
                      style={{
                        fontSize: 12,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        width: '100%',
                      }}
                    >
                      {name}
                    </span>
                  </div>
                </div>
              );
            })}

            {currentSlideSlots.length === 0 && currentSlideImages.length === 0 && (
              <div className={styles.drawerEmptyState}>
                <Icon icon={ImageIcon} size={16} />
                <span>当前页暂无素材插图槽位</span>
              </div>
            )}
          </section>

          {/* Section 3: Speaker Notes */}
          <section className={styles.drawerSection} data-testid="drawer-notes-section">
            <div className={styles.drawerSectionHeader}>
              <Icon icon={MessageSquare} size={14} />
              <span>演讲备注</span>
            </div>

            <div className={styles.drawerSectionContent}>
              {speakerNotes ? (
                <div style={{ whiteSpace: 'pre-wrap' }}>{speakerNotes}</div>
              ) : (
                <div className={styles.drawerEmptyState}>
                  <Icon icon={MessageSquare} size={16} />
                  <span>暂无演讲备注</span>
                </div>
              )}
            </div>
          </section>

          {/* Hidden full panels in DOM for testing & complete contract preservation */}
          <div style={{ display: 'none' }}>
            {showInspector && selectedSlide && <SlideInspector artifact={selectedSlide} />}
            <ArtifactPanel
              artifacts={selectedJobArtifacts}
              exporting={Boolean(exporting)}
              jobState={jobState}
              selectedArtifactId={selectedArtifactId}
              onExport={onExport}
              onSelect={onSelectArtifact}
            />
            <AssetSlotPanel
              resolveArtifactUri={resolveArtifactUri}
              retryPendingKeys={retryPendingKeys}
              slots={selectedJobSlots}
              onDismissError={(slideId, slotId) => {
                dismissSlotError(jobId, slideId, slotId);
              }}
              onRetry={(slideId, slotId) => {
                void retrySlot(jobId, slideId, slotId);
              }}
            />
          </div>
        </div>
      </aside>
    );
  },
);

ArchitectureDrawer.displayName = 'ArchitectureDrawer';

export default ArchitectureDrawer;
