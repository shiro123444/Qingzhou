import { z } from 'zod';

import { measureSlideText } from './text-measurement';

/** Local escaping keeps this module a leaf: importing semantic-blocks here would cycle. */
const escapeSvgText = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

/**
 * Generated artwork is good at "looking like the thing", and bad at exact relations:
 * arrow directions, tangency, collinearity and label spelling. A visual can therefore
 * declare its precise relations as annotations positioned in asset-local coordinates
 * (0..1 of the generated image box). The bitmap only carries objects, and the server
 * draws these vectors and labels over it, so the geometry stays deterministic and editable.
 */
const normalizedPoint = z
  .object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) })
  .strict();
const annotationLabel = z.string().trim().min(1).max(24);
const annotationColor = z.string().regex(/^#[a-f\d]{6}$/iu);
const annotationAnchor = z.enum(['start', 'middle', 'end']);

const segment = {
  color: annotationColor.optional(),
  from: normalizedPoint,
  label: annotationLabel.optional(),
  to: normalizedPoint,
};

/** A segment shorter than this cannot express a direction and is a model mistake. */
const MIN_SEGMENT = 0.02;
const directed = <T extends { from: { x: number; y: number }; to: { x: number; y: number } }>(
  value: T,
  context: z.RefinementCtx,
) => {
  const length = Math.hypot(value.to.x - value.from.x, value.to.y - value.from.y);
  if (length < MIN_SEGMENT)
    context.addIssue({ code: 'custom', message: 'An annotation segment needs a direction' });
};

export const assetAnnotationSchema = z.union([
  z
    .object({ ...segment, type: z.literal('vector') })
    .strict()
    .superRefine(directed),
  z
    .object({ ...segment, type: z.literal('guide') })
    .strict()
    .superRefine(directed),
  z
    .object({
      anchor: annotationAnchor.default('middle'),
      at: normalizedPoint,
      color: annotationColor.optional(),
      text: annotationLabel,
      type: z.literal('label'),
    })
    .strict(),
]);
export type AssetAnnotation = z.output<typeof assetAnnotationSchema>;
/** Callers may omit defaulted fields; the renderer normalizes them. */
export type AssetAnnotationInput = z.input<typeof assetAnnotationSchema>;

/** A model-authored annotation is optional metadata: never let a malformed one fail a deck. */
export const MAX_ANNOTATIONS = 8;

/**
 * Coordinates are asset-local 0..1, but models also emit percentages or clamp slightly
 * outside the box. Both are unambiguous enough to normalize; anything with an unknown
 * basis is unusable rather than guessable.
 */
const normalizePoint = (raw: unknown): { x: number; y: number } | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { x, y } = raw as { x?: unknown; y?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y))
    return undefined;
  const magnitude = Math.max(Math.abs(x), Math.abs(y));
  const scale = magnitude <= 1 ? 1 : magnitude <= 100 ? 100 : undefined;
  if (!scale) return undefined;
  return { x: Math.min(1, Math.max(0, x / scale)), y: Math.min(1, Math.max(0, y / scale)) };
};

/**
 * A model can cut its own label mid-gloss ("零对偶间隙 (Ze" reached a real slide), so a half-open
 * parenthetical is never rendered even when the label is short.
 */
const dropDanglingGroup = (text: string): string => {
  const open = Math.max(text.lastIndexOf('('), text.lastIndexOf('（'));
  if (open < 0) return text;
  const close = Math.max(text.lastIndexOf(')'), text.lastIndexOf('）'));
  if (close > open) return text;
  return (
    text
      .slice(0, open)
      .replace(/[\s，、,;；:：]+$/u, '')
      .trim() || text
  );
};

/**
 * A model can also exceed the 24-character label budget, and cutting mid-token shipped labels like
 * "支撑超平面 (Supporting Hyperp" onto real slides, so cut at a readable boundary instead. A hard cut
 * remains the last resort for a single unbroken token: a slightly long label still beats dropping
 * the annotation.
 */
export const truncateAnnotationLabel = (raw: string, limit = 24): string => {
  const clean = dropDanglingGroup(raw.trim().replaceAll(/\s+/gu, ' '));
  if (clean.length <= limit) return clean;
  const clipped = clean.slice(0, limit);
  const open = Math.max(clipped.lastIndexOf('('), clipped.lastIndexOf('（'));
  const close = Math.max(clipped.lastIndexOf(')'), clipped.lastIndexOf('）'));
  const withoutDanglingGroup = open > close ? clipped.slice(0, open) : clipped;
  const boundary = Math.max(
    withoutDanglingGroup.lastIndexOf(' '),
    withoutDanglingGroup.lastIndexOf('，'),
    withoutDanglingGroup.lastIndexOf('、'),
    withoutDanglingGroup.lastIndexOf(')'),
  );
  const head = (boundary > 0 ? withoutDanglingGroup.slice(0, boundary + 1) : withoutDanglingGroup)
    .replace(/[\s，、,;；:：]+$/u, '')
    .trim();
  return head || withoutDanglingGroup.trim();
};

const normalizeLabel = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const text = truncateAnnotationLabel(raw);
  return text.length ? text : undefined;
};

const normalizeColor = (raw: unknown): string | undefined =>
  typeof raw === 'string' && /^#[a-f\d]{6}$/iu.test(raw) ? raw : undefined;

/**
 * Accept the shapes the model actually produces: `label` as an alias for `text`,
 * `anchor: center` for `middle`, percentages, and slightly out-of-range coordinates.
 */
const coerceAnnotation = (raw: unknown): Record<string, unknown> | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type.trim().toLowerCase() : undefined;
  const text = normalizeLabel(record.text ?? record.label ?? record.name);
  const color = normalizeColor(record.color);
  const anchor = typeof record.anchor === 'string' ? record.anchor.trim().toLowerCase() : undefined;
  const normalizedAnchor = anchor === 'center' ? 'middle' : anchor;
  if (type === 'label' || (type === undefined && record.at !== undefined)) {
    const at = normalizePoint(record.at);
    if (!at || !text) return undefined;
    return {
      at,
      ...(color ? { color } : {}),
      ...(normalizedAnchor && ['start', 'middle', 'end'].includes(normalizedAnchor)
        ? { anchor: normalizedAnchor }
        : {}),
      text,
      type: 'label',
    };
  }
  const from = normalizePoint(record.from);
  const to = normalizePoint(record.to);
  if (!from || !to) return undefined;
  return {
    ...(color ? { color } : {}),
    from,
    ...(text ? { label: text } : {}),
    to,
    type: type === 'guide' ? 'guide' : 'vector',
  };
};

const parseAnnotation = (raw: unknown): AssetAnnotation | undefined => {
  const direct = assetAnnotationSchema.safeParse(raw);
  if (direct.success) return direct.data;
  const coerced = coerceAnnotation(raw);
  if (!coerced) return undefined;
  const retried = assetAnnotationSchema.safeParse(coerced);
  return retried.success ? retried.data : undefined;
};

/**
 * Declared relations for one visual. Invalid entries are dropped with the rest kept,
 * so a partially malformed declaration still improves the page instead of failing it.
 */
export const assetAnnotationsSchema = z
  .array(z.unknown())
  .transform((items) =>
    items.slice(0, MAX_ANNOTATIONS).flatMap((item) => parseAnnotation(item) ?? []),
  )
  .optional();

export interface AnnotationBox {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

const FONT_PX = 16;
const EDGE_PX = 4;
const VECTOR_COLOR = '#dc2626';
const GUIDE_COLOR = '#64748b';
const LABEL_COLOR = '#172554';

const number = (value: number): string => String(Math.round(value * 1000) / 1000);

/** Asset-local fraction to canvas pixels; annotations never drift from the artwork box. */
const project = (box: AnnotationBox, point: { x: number; y: number }) => ({
  x: box.x + point.x * box.width,
  y: box.y + point.y * box.height,
});

/** Keep a label inside its own artwork box; the artwork is the space it describes. */
const placeLabel = (
  text: string,
  anchor: 'start' | 'middle' | 'end',
  target: { x: number; y: number },
  box: AnnotationBox,
): { anchor: 'start' | 'middle' | 'end'; x: number; y: number } => {
  const width = measureSlideText(text, FONT_PX);
  const left = { end: target.x - width, middle: target.x - width / 2, start: target.x }[anchor];
  const clamped = Math.min(
    Math.max(left, box.x + EDGE_PX),
    Math.max(box.x + EDGE_PX, box.x + box.width - EDGE_PX - width),
  );
  return {
    anchor,
    x: clamped + (anchor === 'end' ? width : anchor === 'middle' ? width / 2 : 0),
    y: Math.min(
      Math.max(target.y, box.y + FONT_PX),
      Math.max(box.y + FONT_PX, box.y + box.height - EDGE_PX),
    ),
  };
};

const labelMarkup = (
  text: string,
  anchor: 'start' | 'middle' | 'end',
  at: { x: number; y: number },
  color: string,
): string =>
  `<text x="${number(at.x)}" y="${number(at.y)}" font-size="${FONT_PX}" font-family="Arial, Microsoft YaHei" text-anchor="${anchor}" fill="${color}">${escapeSvgText(text)}</text>`;

/** Deterministic vector markup for one visual: arrows, guides and their labels. */
export const renderAssetAnnotations = (
  annotations: readonly AssetAnnotationInput[],
  box: AnnotationBox,
  visualId: string,
): string => {
  if (!annotations.length || box.width <= 0 || box.height <= 0) return '';
  const body: string[] = [];
  for (const annotation of annotations) {
    if (annotation.type === 'label') {
      const color = annotation.color ?? LABEL_COLOR;
      const at = placeLabel(
        annotation.text,
        annotation.anchor ?? 'middle',
        project(box, annotation.at),
        box,
      );
      body.push(labelMarkup(annotation.text, at.anchor, { x: at.x, y: at.y }, color));
      continue;
    }
    const from = project(box, annotation.from);
    const to = project(box, annotation.to);
    const color = annotation.color ?? (annotation.type === 'vector' ? VECTOR_COLOR : GUIDE_COLOR);
    const dashed = annotation.type === 'guide' ? ' stroke-dasharray="6 5"' : '';
    body.push(
      `<path d="M ${number(from.x)} ${number(from.y)} L ${number(to.x)} ${number(to.y)}" fill="none" stroke="${color}" stroke-width="3"${dashed}/>`,
    );
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (annotation.type === 'vector' && length > 0) {
      const ux = (to.x - from.x) / length;
      const uy = (to.y - from.y) / length;
      const head = Math.min(14, Math.max(9, length * 0.18));
      body.push(
        `<path d="M ${number(to.x - head * ux - head * 0.45 * uy)} ${number(to.y - head * uy + head * 0.45 * ux)} L ${number(to.x)} ${number(to.y)} L ${number(to.x - head * ux + head * 0.45 * uy)} ${number(to.y - head * uy - head * 0.45 * ux)}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round"/>`,
      );
    }
    if (annotation.label) {
      const at = placeLabel(
        annotation.label,
        'middle',
        { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 10 },
        box,
      );
      body.push(labelMarkup(annotation.label, at.anchor, { x: at.x, y: at.y }, color));
    }
  }
  return `<g data-asset-annotations="${escapeSvgText(visualId)}">${body.join('')}</g>`;
};

export interface AnnotatedAsset {
  readonly annotations?: readonly AssetAnnotationInput[];
  readonly layout?: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly visualId: string;
}

/** Page-space box of a placed asset; identical mapping to the composer's own placement. */
export const assetPlacementBox = (
  viewBox: readonly number[],
  layout: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  },
): AnnotationBox => {
  const [minX = 0, minY = 0, width = 960, height = 540] = viewBox;
  return {
    height: layout.height * height,
    width: layout.width * width,
    x: minX + layout.x * width,
    y: minY + layout.y * height,
  };
};

/** Draw every declared relation over the artwork it describes; never guess a placement. */
export const overlayAssetAnnotations = (
  svg: string,
  viewBox: readonly number[],
  assets: readonly AnnotatedAsset[],
): string => {
  const markup = assets
    .filter((asset) => asset.layout && asset.annotations?.length)
    .map((asset) =>
      renderAssetAnnotations(
        asset.annotations!,
        assetPlacementBox(viewBox, asset.layout!),
        asset.visualId,
      ),
    )
    .join('');
  if (!markup) return svg;
  const insertion = svg.lastIndexOf('</svg>');
  return insertion < 0 ? svg : `${svg.slice(0, insertion)}${markup}${svg.slice(insertion)}`;
};
