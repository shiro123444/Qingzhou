import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type {
  PlannerContext,
  PresentationJobInput,
  PresentationPlan,
  PresentationPlanner,
  PresentationSlidePlan,
} from '../../../../packages/runtime-contracts/src';

export type PresentationPlanErrorCode = 'PLAN_INVALID';

export class PresentationPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresentationPlanError';
    this.code = 'PLAN_INVALID';
  }

  readonly code: PresentationPlanErrorCode;
}

export interface PresentationPlanValidationOptions {
  readonly maxEmbeddedImageBytes?: number;
  readonly maxSlides?: number;
  /** SVG markup budget, excluding separately bounded raster payloads. */
  readonly maxSvgBytes?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const cloneWireValue = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((item) => cloneWireValue(item)) as T;
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const clone: Record<string, unknown> = Object.create(prototype) as Record<string, unknown>;
      for (const [key, nested] of Object.entries(value)) clone[key] = cloneWireValue(nested);
      return clone as T;
    }
  }
  return value;
};

const svgBytes = (svg: string): number => new TextEncoder().encode(svg).byteLength;

const measureSvgBytes = (svg: string) => {
  let imageBytes = 0;
  const markup = svg.replaceAll(
    /(\b(?:xlink:)?href\s*=\s*)(["'])(data:image\/(?:png|jpeg|webp);base64,)([A-Za-z0-9+/]*={0,2})\2/gu,
    (attribute, prefix: string, quote: string, header: string, payload: string) => {
      if (!payload.length || payload.length % 4 !== 0) return attribute;
      const decodedBytes =
        (payload.length / 4) * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
      if (decodedBytes > 8 * 1024 * 1024)
        throw new PresentationPlanError('Embedded image byte budget exceeded');
      imageBytes += decodedBytes;
      return `${prefix}${quote}${header}${quote}`;
    },
  );
  return { imageBytes, markupBytes: svgBytes(markup) };
};

const validSvg = (svg: unknown): svg is string => {
  if (
    !nonEmpty(svg) ||
    /<\s*(?:script|html|body|foreignObject)\b/i.test(svg) ||
    /<!DOCTYPE/i.test(svg) ||
    /\son[a-z]+\s*=/i.test(svg) ||
    /(?:href|src)\s*=\s*['"]\s*javascript:/i.test(svg)
  )
    return false;
  try {
    const document = parseString(svg);
    const parserError = document.getElementsByTagName('parsererror').length > 0;
    return !parserError && document.documentElement?.tagName?.toLowerCase() === 'svg';
  } catch {
    return false;
  }
};

export const validatePresentationPlan = (
  plan: PresentationPlan,
  options: PresentationPlanValidationOptions = {},
): PresentationPlan => {
  if (!isRecord(plan)) throw new PresentationPlanError('plan must be an object');
  const candidate = plan as PresentationPlan;
  if (!nonEmpty(candidate.planId)) throw new PresentationPlanError('planId must be non-empty');
  if (!nonEmpty(candidate.title)) throw new PresentationPlanError('title must be non-empty');
  if (!nonEmpty(candidate.aspectRatio))
    throw new PresentationPlanError('aspectRatio must be non-empty');
  if (
    !Array.isArray(candidate.sourceVersionIds) ||
    candidate.sourceVersionIds.some((id) => !nonEmpty(id))
  ) {
    throw new PresentationPlanError('sourceVersionIds must be a string array');
  }
  if (!Array.isArray(candidate.slides) || candidate.slides.length === 0) {
    throw new PresentationPlanError('slides must not be empty');
  }
  const maxSlides = options.maxSlides ?? 100;
  if (!Number.isInteger(maxSlides) || maxSlides <= 0) {
    throw new PresentationPlanError('maxSlides must be a positive integer');
  }
  if (candidate.slides.length > maxSlides)
    throw new PresentationPlanError('slide count exceeds budget');
  const maxSvgBytes = options.maxSvgBytes ?? 10 * 1024 * 1024;
  if (!Number.isInteger(maxSvgBytes) || maxSvgBytes <= 0) {
    throw new PresentationPlanError('maxSvgBytes must be a positive integer');
  }
  const maxEmbeddedImageBytes = options.maxEmbeddedImageBytes ?? 64 * 1024 * 1024;
  if (!Number.isInteger(maxEmbeddedImageBytes) || maxEmbeddedImageBytes <= 0)
    throw new PresentationPlanError('maxEmbeddedImageBytes must be a positive integer');
  const ids = new Set<string>();
  const orders = new Set<number>();
  const slides: PresentationSlidePlan[] = [];
  let orderStart: number | undefined;
  let totalBytes = 0;
  let totalImageBytes = 0;
  for (const [index, slide] of candidate.slides.entries()) {
    if (!isRecord(slide) || !nonEmpty(slide.slideId))
      throw new PresentationPlanError('slideId must be non-empty');
    const slideCandidate = slide as unknown as PresentationSlidePlan;
    if (ids.has(slideCandidate.slideId))
      throw new PresentationPlanError(`duplicate slideId: ${slideCandidate.slideId}`);
    ids.add(slideCandidate.slideId);
    if (!Number.isInteger(slideCandidate.order) || orders.has(slideCandidate.order))
      throw new PresentationPlanError('slide order must be unique integers');
    if (orderStart === undefined) {
      if (slideCandidate.order !== 0 && slideCandidate.order !== 1)
        throw new PresentationPlanError('slide order must start at 0 or 1');
      orderStart = slideCandidate.order;
    } else if (slideCandidate.order !== orderStart + index) {
      throw new PresentationPlanError('slide order must be continuous in input order');
    }
    orders.add(slideCandidate.order);
    if (!validSvg(slideCandidate.svg))
      throw new PresentationPlanError(`invalid SVG for slide: ${slideCandidate.slideId}`);
    const measured = measureSvgBytes(slideCandidate.svg);
    totalBytes += measured.markupBytes;
    totalImageBytes += measured.imageBytes;
    if (totalBytes > maxSvgBytes) throw new PresentationPlanError('SVG byte budget exceeded');
    if (totalImageBytes > maxEmbeddedImageBytes)
      throw new PresentationPlanError('Embedded image byte budget exceeded');
    slides.push({
      metadata: slideCandidate.metadata ? cloneWireValue(slideCandidate.metadata) : undefined,
      notes: slideCandidate.notes,
      order: slideCandidate.order,
      slideId: slideCandidate.slideId,
      svg: slideCandidate.svg,
    });
  }
  return {
    aspectRatio: plan.aspectRatio,
    designSpec: candidate.designSpec ? cloneWireValue(candidate.designSpec) : undefined,
    planId: candidate.planId,
    slides,
    sourceVersionIds: [...candidate.sourceVersionIds],
    title: candidate.title,
  };
};

export type PresentationPlanBuilder = (
  input: PresentationJobInput,
  context: PlannerContext,
) => PresentationPlan | Promise<PresentationPlan>;

export class InMemoryPresentationPlanner implements PresentationPlanner {
  constructor(
    private readonly builder: PresentationPlanBuilder,
    private readonly validation: PresentationPlanValidationOptions = {},
  ) {
    if (typeof builder !== 'function')
      throw new PresentationPlanError('planner builder is required');
  }

  async plan(input: PresentationJobInput, context: PlannerContext): Promise<PresentationPlan> {
    const candidate = await this.builder(input, context);
    return validatePresentationPlan(candidate, this.validation);
  }
}
