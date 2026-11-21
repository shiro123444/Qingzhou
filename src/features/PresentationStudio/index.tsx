'use client';

export type {
  PresentationJobEvent,
  RuntimePresentationClient,
  RuntimePresentationStreamClient,
  SubscribePresentationJobOptions,
} from '../../services/runtime/client';
export { default as AnnotationBar } from './AnnotationBar';
export { default as ArtifactPanel } from './ArtifactPanel';
export type { PresentationDemoOptions } from './demo/presentationDemoClient';
export {
  createPresentationDemoClient,
  defaultPresentationDemoClient,
} from './demo/presentationDemoClient';
export { default as ExportMenu } from './ExportMenu';
export { useJobPolling } from './hooks/useJobPolling';
export { usePresentationStudio } from './hooks/usePresentationStudio';
export { default as JobStateTag } from './JobStateTag';
export { default as PresentationJobList } from './PresentationJobList';
export { default as PresentationProgress } from './PresentationProgress';
export type { PresentationStudioProps } from './PresentationStudio';
export { default } from './PresentationStudio';
export { PresentationStudio } from './PresentationStudio';
export { default as SlideInspector } from './SlideInspector';
export { default as SlideNavigator } from './SlideNavigator';
export { default as SlidePreview } from './SlidePreview';
export {
  createPresentationStudioStore,
  type PresentationClient,
  type PresentationErrorInfo,
  type PresentationPendingAction,
  type PresentationStoreOptions,
  type PresentationStreamClient,
  type PresentationStreamStatus,
  type PresentationStudioStore,
  type PresentationStudioStoreHook,
  type PresentationTransportMode,
  toPresentationError,
  usePresentationStudioStore,
} from './store/presentationStore';
export {
  aggregateJobStreamStatus,
  projectArtifactSnapshot,
  projectJobSnapshot,
  projectPresentationEventData,
} from './store/presentationStore';
export { styles as presentationStudioStyles } from './style';
