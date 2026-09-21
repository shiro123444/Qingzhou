import type {
  ArtifactSnapshot,
  PresentationExportFormat,
  PresentationJob,
  PresentationMessageInput,
} from '../../../../packages/runtime-contracts/src/index';
import type { PresentationSlotState } from '../store/presentationStore';

export type CompletedViewMode = 'focus' | 'lightbox';

export interface CompletedWorkspaceProps {
  /** Live generation overlay on retained slides while a template/edit is running. */
  activity?: string;
  activityHistory?: { id: string; text: string }[];
  canExport: boolean;
  defaultLanguage?: string;
  defaultNotebookId?: string;
  defaultSourceVersionIds?: string[];
  dismissSlotError: (jobId: string, slideId: string, slotId: string) => void;
  effectiveSelectedArtifactId: string | null;
  exported: { artifactId: string; format: PresentationExportFormat; uri?: string } | null;
  exporting: boolean | string | null;
  jobs?: PresentationJob[];
  jobTitles: Record<string, string>;
  onCancel?: (jobId: string) => Promise<void>;
  onDeleteJob?: (jobId: string) => Promise<void> | void;
  onExport: (artifactId: string, format: PresentationExportFormat) => void;
  onJobChanged?: () => Promise<void>;
  onNewPresentation?: () => void;
  onRetryJob: (jobId: string) => void;
  onSelectArtifact: (artifactId: string) => void;
  onSelectJob?: (jobId: string) => void;
  onSendMessage?: (jobId: string, input: PresentationMessageInput) => Promise<boolean>;
  resolveArtifactUri?: (artifactId: string) => string | undefined;
  retryPendingKeys: Record<string, boolean>;
  retrySlot: (jobId: string, slideId: string, slotId: string) => Promise<void>;
  selectedJob: PresentationJob;
  selectedJobArtifacts: ArtifactSnapshot[];
  selectedJobSlots: PresentationSlotState[];
  selectedSlide: ArtifactSnapshot | null;
  showAnnotationBar?: boolean;
  showInspector?: boolean;
  showSidebarReopen?: boolean;
  slideArtifacts: ArtifactSnapshot[];
}
