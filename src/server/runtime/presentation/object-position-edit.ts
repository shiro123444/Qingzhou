import { z } from 'zod';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type {
  PresentationMessageInput,
  PresentationPlan,
} from '../../../../packages/runtime-contracts/src';
import {
  type CanvasMove,
  type CanvasRect,
  moveCanvasObject,
} from '../../../../packages/runtime-contracts/src/canvas';
import { renderSemanticBlocks, semanticAuthoringSvg, semanticBlockSchema } from './semantic-blocks';

export const objectPositionPatchSchema = z
  .object({
    blockId: z.string().regex(/^[\w-]{1,80}$/u),
    expectedVersionId: z.string().min(1).max(128),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
  })
  .strict();

export function canvasMoveForSlide(
  plan: PresentationPlan | undefined,
  target: PresentationMessageInput['target'],
  patch: z.infer<typeof objectPositionPatchSchema>,
) {
  const slide = target.type === 'slide' ? plan?.slides[target.slideNumber - 1] : undefined;
  if (!slide) throw new Error('找不到要修改的页面');
  const blocks = z.array(semanticBlockSchema).parse(slide.metadata?.contentBlocks ?? []);
  const viewBox = parseString(slide.svg)
    .documentElement.getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (
    viewBox?.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    viewBox[2] <= 0 ||
    viewBox[3] <= 0
  )
    throw new Error('无法读取页面尺寸');
  const [x, y, width, height] = viewBox;
  const move: CanvasMove = {
    bounds: { x, y, width, height },
    objects: blocks.map(({ id, rect }) => ({ id, ...rect })),
    id: patch.blockId,
    x: patch.x,
    y: patch.y,
  };
  return { slide, blocks, move };
}

export async function applyObjectPositionPatch(
  plan: PresentationPlan,
  message: PresentationMessageInput,
  moveObject: (move: CanvasMove) => CanvasRect | Promise<CanvasRect> = moveCanvasObject,
) {
  const patch = objectPositionPatchSchema.parse(message.objectPositionPatch);
  const { slide, blocks, move } = canvasMoveForSlide(plan, message.target, patch);
  const rect = await moveObject(move);
  const rendered = await renderSemanticBlocks(
    semanticAuthoringSvg(slide.svg, blocks),
    blocks.map((block) => (block.id === patch.blockId ? { ...block, rect } : block)),
  );
  // Single-object envelopes in learned layouts declare native bounds as well.
  const document = parseString(rendered.svg);
  const group = Array.from(document.getElementsByTagName('g')).find(
    (node) =>
      node.getAttribute('data-content-id') === patch.blockId ||
      node.getAttribute('data-scientific-diagram') === patch.blockId,
  );
  const parent = group?.parentNode as Element | undefined;
  const previous = blocks.find((block) => block.id === patch.blockId)!.rect;
  if (
    parent
      ?.getAttribute?.('data-pptx-bounds')
      ?.trim()
      .split(/[\s,]+/u)
      .map(Number)
      .join(' ') === [previous.x, previous.y, previous.width, previous.height].join(' ') &&
    Array.from(parent.childNodes).filter((child) => child.nodeType === 1).length === 1
  )
    parent.setAttribute('data-pptx-bounds', [rect.x, rect.y, rect.width, rect.height].join(' '));
  const page = {
    ...slide,
    svg: document.toString(),
    metadata: {
      ...slide.metadata,
      contentBlocks: rendered.blocks,
      canvasPosition: { id: patch.blockId, x: rect.x, y: rect.y },
    },
  };
  return {
    slideId: slide.slideId,
    plan: { ...plan, slides: plan.slides.map((item) => (item === slide ? page : item)) },
  };
}
