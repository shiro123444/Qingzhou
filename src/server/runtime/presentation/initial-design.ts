import type {
  PresentationJobInput,
  PresentationPlan,
} from '../../../../packages/runtime-contracts/src';

/** Structured design envelopes used before any SVG composition or image generation. */
export const initialDesignPlan = (input: PresentationJobInput): PresentationPlan | undefined => {
  const outline = input.options?.outline;
  if (!Array.isArray(outline) || !outline.length || outline.length !== input.slideCount) return;
  const ratio = input.aspectRatio ?? '16:9';
  const height = ratio === '4:3' ? 720 : 540;
  const storyboard = input.options?.visualStoryboard as
    | { slides?: Array<Record<string, unknown>> }
    | undefined;
  return {
    planId: 'initial-design',
    title: input.title,
    aspectRatio: ratio,
    sourceVersionIds: [...input.sourceVersionIds],
    slides: outline.map((slide, index) => ({
      order: index + 1,
      slideId: `slide-${index + 1}`,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${height}"><rect width="960" height="${height}" fill="#ffffff"/></svg>`,
      metadata: {
        ...slide,
        title: slide.title,
        designOnly: true,
        ...(storyboard?.slides?.[index] ? { visualDirection: storyboard.slides[index] } : {}),
      },
      notes: slide.speakerNotes,
    })),
  };
};
