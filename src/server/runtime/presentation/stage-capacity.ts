import { lessonPlanSchema, lessonStages } from '@/types/presentationLesson';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type {
  PresentationJobInput,
  PresentationPlan,
} from '../../../../packages/runtime-contracts/src';
import {
  contentInputFingerprint,
  isNativeVisual,
  isRasterVisual,
  readContentIntents,
  type SlideContentIntent,
  slideContentIntentSchema,
  visualRequirements,
} from './content-intent';
import { compileLessonInput, readLessonPlan } from './lesson';
import { formulasFitWithFigure } from './page-budget';

/**
 * Turn an impossible mixed-media frame into two teacher-advanced stages before
 * artwork, storyboard and layout planning. The teacher's facts and frame order
 * remain intact; a locked beat is never changed by this automatic pass.
 */
export function rebalanceMixedLessonStages(input: PresentationJobInput): PresentationJobInput {
  const lesson = readLessonPlan(input);
  const intents = readContentIntents(input);
  if (!lesson || intents.length !== lesson.beats.flatMap((beat) => beat.frames).length)
    return input;
  const newIntents: SlideContentIntent[] = [];
  const oldToNewSlideId = new Map<string, string>();
  const splitFrameIds: string[] = [];
  const usedIds = new Set(lesson.beats.flatMap((beat) => beat.frames.map((frame) => frame.id)));
  let oldIndex = 0;
  const beats = lesson.beats.map((beat) => {
    let splitInBeat = 0;
    return {
      ...beat,
      frames: beat.frames.flatMap((frame) => {
        const intent = intents[oldIndex++];
        oldToNewSlideId.set(intent.slideId, `slide-${newIntents.length + 1}`);
        const visuals = visualRequirements(intent);
        const raster = visuals.filter(isRasterVisual);
        const native = visuals.filter(isNativeVisual);
        const canSplit =
          !beat.locked &&
          beat.frames.length + splitInBeat < 8 &&
          raster.length > 0 &&
          native.length > 0 &&
          frame.visibleContent.length >= 4 &&
          lesson.beats.flatMap((item) => item.frames).length + splitFrameIds.length < 100;
        const measuredHeights = intent.formulas.flatMap((formula) =>
          formula.measurement ? [formula.measurement.minRectHeight] : [],
        );
        const figureOverflow =
          !canSplit &&
          !beat.locked &&
          beat.frames.length + splitInBeat < 8 &&
          raster.length > 0 &&
          measuredHeights.length === intent.formulas.length &&
          measuredHeights.length > 0 &&
          !formulasFitWithFigure(measuredHeights) &&
          lesson.beats.flatMap((item) => item.frames).length + splitFrameIds.length < 100;
        if (!canSplit && !figureOverflow) {
          newIntents.push({ ...intent, slideId: `slide-${newIntents.length + 1}` });
          return [frame];
        }
        if (figureOverflow) {
          let continuationId = `${frame.id.slice(0, 63)}-figure`;
          while (usedIds.has(continuationId)) continuationId = `${continuationId.slice(0, 76)}-2`;
          usedIds.add(continuationId);
          splitFrameIds.push(frame.id);
          splitInBeat++;
          const derivation = {
            ...frame,
            visualCue: '本页只写下公式与推导，图解在下一页。'.slice(0, 2000),
          };
          const figure = {
            ...frame,
            id: continuationId,
            title: `${frame.title} · 图解`.slice(0, 2000),
            visibleContent: frame.visibleContent.slice(0, 2),
            visualCue: raster
              .map((visual) => visual.brief)
              .join('；')
              .slice(0, 2000),
          };
          newIntents.push(
            slideContentIntentSchema.parse({
              ...intent,
              slideId: `slide-${newIntents.length + 1}`,
              visualKind: 'none',
              visualReason: '公式需要完整字号，图解放到下一页',
              visuals: [],
            }),
          );
          newIntents.push(
            slideContentIntentSchema.parse({
              ...intent,
              slideId: `slide-${newIntents.length + 1}`,
              formulas: [],
              visualKind: raster[0].kind,
              visualReason: raster
                .map((visual) => visual.brief)
                .join('；')
                .slice(0, 1200),
              visuals: raster,
            }),
          );
          oldToNewSlideId.set(intent.slideId, `slide-${newIntents.length}`);
          return [derivation, figure];
        }
        const midpoint = Math.ceil(frame.visibleContent.length / 2);
        let continuationId = `${frame.id.slice(0, 63)}-continuation`;
        while (usedIds.has(continuationId)) continuationId = `${continuationId.slice(0, 76)}-2`;
        usedIds.add(continuationId);
        splitFrameIds.push(frame.id);
        splitInBeat++;
        const first = {
          ...frame,
          visibleContent: frame.visibleContent.slice(0, midpoint),
          visualCue: raster
            .map((visual) => visual.brief)
            .join('；')
            .slice(0, 2000),
          withheldContent: [
            ...new Set([...frame.withheldContent, ...frame.visibleContent.slice(midpoint)]),
          ].slice(0, 12),
        };
        const second = {
          ...frame,
          id: continuationId,
          title: `${frame.title} · 图解比较`.slice(0, 2000),
          visibleContent: frame.visibleContent.slice(midpoint),
          visualCue: native
            .map((visual) => visual.brief)
            .join('；')
            .slice(0, 2000),
        };
        newIntents.push(
          slideContentIntentSchema.parse({
            ...intent,
            slideId: `slide-${newIntents.length + 1}`,
            visualKind: raster[0].kind,
            visualReason: raster
              .map((visual) => visual.brief)
              .join('；')
              .slice(0, 1200),
            visuals: raster,
          }),
        );
        newIntents.push(
          slideContentIntentSchema.parse({
            ...intent,
            slideId: `slide-${newIntents.length + 1}`,
            formulas: [],
            visualKind: native[0].kind,
            visualReason: native
              .map((visual) => visual.brief)
              .join('；')
              .slice(0, 1200),
            visuals: native,
          }),
        );
        return [first, second];
      }),
    };
  });
  if (!splitFrameIds.length) return input;
  const revisedLesson = lessonPlanSchema.parse({ ...lesson, beats });
  const remapSlots = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map((slot) =>
          slot && typeof slot === 'object' && typeof slot.slideId === 'string'
            ? { ...slot, slideId: oldToNewSlideId.get(slot.slideId) ?? slot.slideId }
            : slot,
        )
      : value;
  const compiled = compileLessonInput({
    ...input,
    options: {
      ...input.options,
      lessonPlan: revisedLesson,
      imageSlots: remapSlots(input.options?.imageSlots),
      generatedImageSlots: remapSlots(input.options?.generatedImageSlots),
    },
  });
  return {
    ...compiled,
    options: {
      ...compiled.options,
      contentIntents: { slides: newIntents, inputFingerprint: contentInputFingerprint(compiled) },
      layoutAutoSplits: splitFrameIds,
    },
  };
}

/** Rebase an editable old deck onto added teaching stages without copying an image to a new page. */
export function rebasePlanForLessonStages(
  plan: PresentationPlan,
  previousInput: PresentationJobInput,
  nextInput: PresentationJobInput,
): PresentationPlan {
  const previous = readLessonPlan(previousInput);
  const next = readLessonPlan(nextInput);
  if (!previous || !next || plan.slides.length !== lessonStages(previous).length) return plan;
  const originalByFrame = new Map(
    lessonStages(previous).map(({ frame }, index) => [frame.id, plan.slides[index]]),
  );
  const nativeIdsBySlide = new Map(
    readContentIntents(nextInput).map((intent) => [
      intent.slideId,
      new Set(
        visualRequirements(intent)
          .filter(isNativeVisual)
          .map((visual) => visual.id),
      ),
    ]),
  );
  const splitIds = new Set(
    Array.isArray(nextInput.options?.layoutAutoSplits)
      ? nextInput.options.layoutAutoSplits.filter((id): id is string => typeof id === 'string')
      : [],
  );
  const [w, h] = (nextInput.aspectRatio ?? '16:9').split(':').map(Number);
  const canvasHeight = w > 0 && h > 0 ? (960 * h) / w : 540;
  const slides = lessonStages(next).map(({ frame }, index) => {
    const slideId = `slide-${index + 1}`;
    const original = originalByFrame.get(frame.id);
    if (!original) {
      const sourceFrameId = [...originalByFrame.keys()].find(
        (id) => frame.id.startsWith(`${id}-continuation`) || frame.id.startsWith(`${id}-figure`),
      );
      const source = sourceFrameId ? originalByFrame.get(sourceFrameId) : undefined;
      const nativeIds = nativeIdsBySlide.get(slideId) ?? new Set<string>();
      const sourceBlocks = Array.isArray(source?.metadata?.contentBlocks)
        ? source.metadata.contentBlocks
        : [];
      const contentBlocks = sourceBlocks.filter(
        (block) =>
          block && typeof block === 'object' && 'id' in block && nativeIds.has(String(block.id)),
      );
      const carriedImages =
        source && frame.id.endsWith('-figure')
          ? Array.from(parseString(source.svg).getElementsByTagName('image')).map((image) =>
              image.toString(),
            )
          : [];
      return {
        slideId,
        order: index + 1,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${canvasHeight}"><rect x="0" y="72" width="960" height="${canvasHeight - 72}" fill="#fff"/>${carriedImages.join('')}${contentBlocks.map((block) => `<g data-scientific-diagram="${String(block.id)}"/>`).join('')}</svg>`,
        metadata: {
          title: frame.title,
          contentBlocks,
        },
      };
    }
    const allowedNative = nativeIdsBySlide.get(slideId) ?? new Set<string>();
    const doc = parseString(original.svg);
    for (const group of Array.from(doc.getElementsByTagName('g'))) {
      const id = group.getAttribute('data-scientific-diagram');
      if (id && !allowedNative.has(id)) group.parentNode?.removeChild(group);
    }
    if (splitIds.has(frame.id))
      for (const text of Array.from(doc.getElementsByTagName('text')))
        text.parentNode?.removeChild(text);
    const originalBlocks = Array.isArray(original.metadata?.contentBlocks)
      ? original.metadata.contentBlocks
      : [];
    const allowedFormula = new Set(
      readContentIntents(nextInput)[index]?.formulas.map((formula) => formula.id) ?? [],
    );
    return {
      ...original,
      slideId,
      order: index + 1,
      svg: doc.toString(),
      metadata: {
        ...original.metadata,
        title: frame.title,
        contentBlocks: originalBlocks.filter((block) =>
          block && typeof block === 'object' && 'kind' in block && 'id' in block
            ? block.kind === 'formula'
              ? allowedFormula.has(String(block.id))
              : allowedNative.has(String(block.id))
            : false,
        ),
      },
    };
  });
  const designSpec = { ...plan.designSpec };
  delete designSpec.templateVisualReview;
  return { ...plan, designSpec, slides };
}
