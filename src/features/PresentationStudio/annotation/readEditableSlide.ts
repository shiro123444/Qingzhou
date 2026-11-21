import type { PresentationSlidePlan } from '../../../../packages/runtime-contracts/src';
import { annotationElements } from '../../../../packages/utils/src/presentationAnnotation';
import { measureAnnotationElements } from './geometry';

export async function readEditableSlide(
  jobId: string,
  page: number,
  versionId: string,
  signal: AbortSignal,
) {
  const response = await fetch('/api/runtime/presentation/tools/presentation.page.read', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId, page }),
    signal,
  });
  if (!response.ok) throw new Error('presentationAnnotation.readFailed');
  const body = await response.json();
  if (body.versionId !== versionId) throw new Error('presentationAnnotation.stale');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.slide.svg));
  const boxes = measureAnnotationElements(body.slide.svg);
  const elements = annotationElements(body.slide.svg);
  if (!boxes.length || boxes.length !== elements.length)
    throw new Error('presentationAnnotation.unsupported');

  return {
    slide: body.slide as PresentationSlidePlan,
    versionId,
    boxes,
    elements,
    hash: Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join(''),
  };
}
export type EditableSlide = Awaited<ReturnType<typeof readEditableSlide>>;
