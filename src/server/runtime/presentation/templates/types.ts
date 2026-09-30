import type { PresentationLearningStatus } from '@/types/presentationLearning';

import type { PresentationPlan } from '../../../../../packages/runtime-contracts/src';
import type { TemplateVisualProfile } from './visual-types';

/** Geometry is relative to the slide viewport, independent of PPTX/SVG units. */
export interface TemplateBox {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface TemplateElement {
  box: TemplateBox;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  kind: 'text' | 'image' | 'shape';
  role: 'title' | 'body' | 'image' | 'decoration';
  textCapacity?: number;
}

export interface TemplateAssetSlot {
  aspectRatio: number;
  box: TemplateBox;
  fit: 'contain' | 'cover';
  reference?: string;
  slotId: string;
}

/** Embedded media is recorded as evidence; source bytes remain inside the owned PPTX. */
export interface TemplateMediaReference {
  box?: TemplateBox;
  kind: 'audio' | 'video';
  mediaId: string;
  mimeType?: string;
  page: number;
  path: string;
  posterReference?: string;
  relationshipId: string;
  sizeBytes: number;
}

export interface TemplateLayout {
  assetSlots: TemplateAssetSlot[];
  elements: TemplateElement[];
  kind: 'cover' | 'text' | 'two-column' | 'image-left' | 'image-right' | 'image-led';
  layoutId: string;
  notes?: string;
  referenceSvg: string;
  sourceSlideId: string;
  textCapacity: number;
}

export interface TemplateConstraints {
  aspectRatio: string;
  fontFamilies: string[];
  /** Relative to the normalized 960-pixel-wide viewport. */
  fontSizes: number[];
  palette: string[];
  spacing: {
    horizontalGaps: number[];
    /** x=left, y=top, width=right, height=bottom; fractions of the viewport. */
    margins: TemplateBox;
    verticalGaps: number[];
  };
}

export interface TemplateProfile {
  constraints: TemplateConstraints;
  createdAt: string;
  designSpec?: Record<string, unknown>;
  layouts: TemplateLayout[];
  media?: TemplateMediaReference[];
  name: string;
  schemaVersion: 1;
  source: { kind: 'plan' | 'pptx'; planId?: string; sha256?: string };
  templateId: string;
  versionId: string;
  warnings: string[];
}

export type TemplateSummary = Omit<TemplateProfile, 'layouts' | 'designSpec' | 'media'> & {
  learning?: Pick<
    PresentationLearningStatus,
    'state' | 'observedPages' | 'remainingPages' | 'totalPages'
  >;
  layoutCount: number;
  mediaCount: number;
  videoCount: number;
};

export interface TemplateReference {
  templateId: string;
  versionId?: string;
}

export interface TemplateApplication {
  constraints: TemplateConstraints;
  layouts: TemplateLayout[];
  media?: TemplateMediaReference[];
  name: string;
  templateId: string;
  versionId: string;
  visual?: TemplateVisualProfile;
}

export interface LearnTemplateInput {
  name: string;
  plan: PresentationPlan;
  templateId?: string;
}

export interface ImportTemplateInput {
  bytes: Uint8Array;
  name: string;
  templateId?: string;
}

export class PresentationTemplateError extends Error {
  readonly code = 'PRESENTATION_INVALID';
}
