import { createHash } from 'node:crypto';

import sharp from 'sharp';
import { z } from 'zod';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type {
  PresentationJobInput,
  PresentationPlan,
} from '../../../../packages/runtime-contracts/src';
import { escapeSvgText } from './semantic-blocks';
import type { TemplateApplication } from './templates';
import { measureSlideText } from './text-measurement';

const color = z.string().regex(/^#[a-f\d]{6}$/iu);
const rectangle = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});
export const deckVisualSystemSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    id: z.string().regex(/^deck-style-[a-f\d]{24}$/u),
    sourceTemplateId: z.string().optional(),
    width: z.literal(960),
    height: z.number().finite().min(400).max(1920),
    fontFamily: z.literal('Microsoft YaHei, Arial'),
    palette: z.array(color).min(3).max(12),
    colors: z.object({
      primary: color,
      accent: color,
      background: color,
      text: color,
      muted: color,
    }),
    typography: z.object({ title: z.literal(32), body: z.literal(24), label: z.literal(16) }),
    headerHeight: z.literal(40),
    body: rectangle,
    darkBody: rectangle,
    deckLabel: z.string().max(16),
  })
  .strict();
export type DeckVisualSystem = z.infer<typeof deckVisualSystemSchema>;
export type DeckPageRole = 'cover' | 'section' | 'content' | 'closing';

export function readDeckVisualSystem(input: PresentationJobInput): DeckVisualSystem | undefined {
  const value = input.options?.deckVisualSystem;
  return value === undefined ? undefined : deckVisualSystemSchema.parse(value);
}

/** Resolve one finite rendering contract, without importing source wording or secondary styling. */
export function createDeckVisualSystem(
  input: PresentationJobInput,
  template?: TemplateApplication,
): DeckVisualSystem | undefined {
  const existing = readDeckVisualSystem(input);
  if (existing?.schemaVersion === 2) return existing;
  if (!template && !input.options?.style) return;
  const primary = (input.options?.templateStyleVisual ??
    template?.visual) as TemplateApplication['visual'];
  const palette = (primary?.designProgram?.tokens?.palette ?? template?.constraints?.palette ?? [])
    .filter((value) => color.safeParse(value).success)
    .map((value) => value.toUpperCase());
  const luminance = (value: string) =>
    [1, 3, 5].reduce(
      (sum, offset, index) =>
        sum +
        Number.parseInt(value.slice(offset, offset + 2), 16) * [0.2126, 0.7152, 0.0722][index],
      0,
    );
  const primaryColor =
    palette.find(
      (value) =>
        luminance(value) > 20 &&
        luminance(value) < 110 &&
        Math.max(
          ...[1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)),
        ) -
          Math.min(
            ...[1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)),
          ) >
          35,
    ) ?? '#1D3E6B';
  const accent =
    palette.find((value) => {
      const [r, g, b] = [1, 3, 5].map((offset) =>
        Number.parseInt(value.slice(offset, offset + 2), 16),
      );
      return r > 150 && g > 100 && b < g * 0.8;
    }) ?? '#F2C24C';
  const [w, h] = (input.aspectRatio ?? '16:9').split(':').map(Number);
  const height = (960 * h) / w;
  const style = {
    schemaVersion: 2 as const,
    sourceTemplateId: template?.compositionPolicy?.primaryTemplateId ?? template?.templateId,
    width: 960 as const,
    height,
    fontFamily: 'Microsoft YaHei, Arial' as const,
    palette: [
      ...new Set([...palette, primaryColor, accent, '#FFFFFF', '#1A1A1A', '#64748B']),
    ].slice(0, 12),
    colors: {
      primary: primaryColor,
      accent,
      background: '#FFFFFF',
      text: '#1A1A1A',
      muted: '#64748B',
    },
    typography: { title: 32 as const, body: 24 as const, label: 16 as const },
    headerHeight: 40 as const,
    body: { x: 48, y: 136, width: 864, height: height - 176 },
    darkBody: { x: 48, y: 320, width: 864, height: height - 388 },
    deckLabel: input.title
      .split(/20\d{2}|[暨（(]/u)[0]
      .trim()
      .slice(0, 16),
  };
  return deckVisualSystemSchema.parse({
    ...style,
    id: `deck-style-${createHash('sha256').update(JSON.stringify(style)).digest('hex').slice(0, 24)}`,
  });
}

export function deckPageRole(
  input: PresentationJobInput,
  slideId: string,
  order: number,
): DeckPageRole {
  const outline = input.options?.outline as { title?: string }[] | undefined;
  if (
    Array.isArray(outline) &&
    order === outline.length &&
    /^(?:感谢(?:聆听|各位)|谢谢|汇报完毕|敬请|致谢|thanks?\b)/iu.test(outline.at(-1)?.title ?? '')
  )
    return 'closing';
  const storyboard = input.options?.visualStoryboard as
    { slides?: { slideId: string; role: string }[] } | undefined;
  const role = storyboard?.slides?.find((slide) => slide.slideId === slideId)?.role;
  return role === 'cover' || role === 'section' || role === 'closing'
    ? role
    : !role && order === 1
      ? 'cover'
      : 'content';
}

export const deckBodyRegion = (system: DeckVisualSystem, role: DeckPageRole) =>
  role === 'content' ? system.body : system.darkBody;

/** Rehydrate assets without rolling back the deck's current master. */
export function bindDeckVisualSystem(
  input: PresentationJobInput,
  system?: DeckVisualSystem,
): PresentationJobInput {
  if (!system) return input;
  const slots = input.options?.generatedImageSlots;
  return {
    ...input,
    options: {
      ...input.options,
      deckVisualSystem: system,
      ...(Array.isArray(slots)
        ? {
            generatedImageSlots: slots.map((slot: any) => {
              if (!slot?.layout) return slot;
              const box = deckBodyRegion(
                system,
                deckPageRole(input, slot.slideId, Number(slot.slideId?.match(/\d+$/u)?.[0] ?? 1)),
              );
              const r = slot.layout;
              if (
                r.x * 960 >= box.x &&
                r.y * system.height >= box.y &&
                (r.x + r.width) * 960 <= box.x + box.width &&
                (r.y + r.height) * system.height <= box.y + box.height
              )
                return slot;
              const { layout: _layout, ...rest } = slot;
              return rest;
            }),
          }
        : {}),
    },
  };
}

/** Secondary templates contribute geometry only, never independent fonts, chrome, or old slogans. */
export function deckVisualInstructions(
  system: DeckVisualSystem,
  role: DeckPageRole,
  template?: TemplateApplication,
): string {
  const geometry = template?.visual?.designProgram.archetypes.map((a) => ({
    id: a.id,
    roles: a.roles,
    regions: a.regions.map(({ box, role, behavior }) => ({ box, role, behavior })),
  }));
  const measuredLayouts = template?.layouts?.map((layout) => ({
    layoutId: layout.layoutId,
    kind: layout.kind,
    textCapacity: layout.textCapacity,
    evidence: layout.evidence,
  }));
  return `整稿唯一视觉规范，优先于模板旧文字、分镜中的样式描述及来源截图：${JSON.stringify(system)}
当前页角色=${role}。服务端统一绘制背景、页眉、唯一页标题和页码，禁止模型绘制这些部分。出处写入讲者备注；仅有必要的外部引用或数据口径才在相关图旁标注，不能每页添加通用“资料来源”。closing是独立致谢/交流页，呼应封面，不得当成最后一页行动计划。
信息密度以可读的事实为准：带坐标刻度、图例或密集标签的原始数据图优先占满内容区宽度，说明放一条短结论；不能为了旁边三张重复结论卡片而把原图缩成小缩略图。流程页若材料包含具体动作、对象、产出，应把这些事实放入对应步骤的说明或原生行动表，不要只剩四个口号节点、把全部细节藏进备注。普通正文与表格不得重复陈述同一组内容。
只返回内容区 SVG：<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${system.height}"><g data-deck-body="true">内容</g></svg>。
所有内容必须放在 ${JSON.stringify(deckBodyRegion(system, role))} 内，使用全画幅坐标。文字坐标是基线，不是顶边：第一行正文的基线必须≥${deckBodyRegion(system, role).y + 28}，图片和色块顶边必须≥${deckBodyRegion(system, role).y}。保留公式/原始图表/已批准图片，围绕内容选择网格、图文、流程、对比布局；字体统一 ${system.fontFamily}，正文≥24px，原生表格18–24px，短标签≥16px。不要生成书法体、英文字眉、口号、渐变章节条或第二个页面标题。不缩小正文迁就模板密度。可用布局几何：${JSON.stringify(geometry)}。模板实测信息结构（借鉴行列、比重与信息密度，替换为当前材料事实）：${JSON.stringify(measuredLayouts)}`;
}

const closestColor = (value: string, allowed: string[]) => {
  const channels = (color: string) =>
    [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  const input = channels(value);
  return allowed.toSorted((a, b) => {
    const distance = (color: string) =>
      channels(color).reduce((sum, v, i) => sum + (v - input[i]) ** 2, 0);
    return distance(a) - distance(b);
  })[0];
};

/** Chrome is rendered once by code; the model owns only the bounded body. */
export function renderDeckVisualFrame(
  svg: string,
  system: DeckVisualSystem,
  page: { title: string; role: DeckPageRole; order: number; total: number },
): string {
  const document = parseString(svg);
  const root = document.documentElement;
  const body = Array.from(document.getElementsByTagName('g')).find(
    (node) => node.getAttribute('data-deck-body') === 'true',
  );
  if (!body)
    throw new Error(
      'Deck style requires one <g data-deck-body="true"> containing only the approved content area; omit page titles and chrome.',
    );
  for (const node of Array.from(root.getElementsByTagName('g'))) {
    if (!node.hasAttribute('data-scientific-diagram') && !node.hasAttribute('data-formula-latex'))
      continue;
    let inside = false;
    for (let parent = node.parentNode; parent; parent = parent.parentNode)
      if (parent === body) inside = true;
    if (!inside) throw new Error('Required native content must be inside the shared deck body');
  }
  const normalizedTitle = page.title.replaceAll(/[\s·：:，,。.!！]/gu, '');
  for (const node of Array.from(body.getElementsByTagName('text'))) {
    if (node.textContent?.replaceAll(/[\s·：:，,。.!！]/gu, '') === normalizedTitle)
      node.parentNode?.removeChild(node);
  }
  for (const node of Array.from(body.getElementsByTagName('*'))) {
    if (node.tagName === 'text' || node.tagName === 'tspan') {
      node.setAttribute('font-family', system.fontFamily);
      if (node.hasAttribute('style'))
        node.setAttribute(
          'style',
          node.getAttribute('style')!.replaceAll(/font-family\s*:[^;]+;?/giu, ''),
        );
      if (
        page.role !== 'content' &&
        node.getAttribute('fill')?.toUpperCase() !== system.colors.accent
      )
        node.setAttribute('fill', '#FFFFFF');
    }
    for (const attribute of ['fill', 'stroke', 'stop-color']) {
      const value = node.getAttribute(attribute);
      if (value && color.safeParse(value).success && !system.palette.includes(value.toUpperCase()))
        node.setAttribute(attribute, closestColor(value, system.palette));
    }
  }
  const dark = page.role !== 'content';
  const foreground = dark ? '#FFFFFF' : system.colors.primary;
  const titleSize = dark ? 40 : system.typography.title;
  const titleLines: string[] = [];
  let line = '';
  for (const character of page.title) {
    if (line && measureSlideText(line + character, titleSize, system.fontFamily, 'bold') > 864) {
      titleLines.push(line);
      line = '';
    }
    line += character;
  }
  if (line) titleLines.push(line);
  if (titleLines.length > (dark ? 3 : 2))
    throw new Error('Deck title needs a shorter approved outline title');
  const titleStart = page.role === 'closing' ? 230 : dark ? 150 : 88;
  const titleMarkup = titleLines
    .map(
      (text, index) =>
        `<text data-deck-title="true" x="${page.role === 'closing' ? 480 : 48}"${page.role === 'closing' ? ' text-anchor="middle"' : ''} y="${titleStart + index * titleSize * 1.15}" font-family="${system.fontFamily}" font-size="${titleSize}" font-weight="bold" fill="${foreground}">${escapeSvgText(text)}</text>`,
    )
    .join('');
  const defs = Array.from(root.childNodes)
    .filter((node) => node.nodeType === 1 && (node as Element).tagName === 'defs')
    .map(String)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${system.height}" data-deck-style="${system.id}"><rect width="960" height="${system.height}" fill="${dark ? system.colors.primary : system.colors.background}"/><g data-deck-frame="true"><rect x="0" y="0" width="960" height="40" fill="${system.colors.primary}"/><rect x="0" y="40" width="960" height="3" fill="${system.colors.accent}"/><text x="48" y="27" font-family="${system.fontFamily}" font-size="16" fill="#FFFFFF">${escapeSvgText(system.deckLabel)}</text>${titleMarkup}<line x1="48" y1="${system.height - 32}" x2="912" y2="${system.height - 32}" stroke="${system.colors.accent}" stroke-width="1"/><text x="912" y="${system.height - 22}" text-anchor="end" font-family="${system.fontFamily}" font-size="16" fill="${dark ? '#FFFFFF' : system.colors.muted}">${String(page.order).padStart(2, '0')} / ${String(page.total).padStart(2, '0')}</text></g>${defs}${body.toString()}</svg>`;
}

/** Inspect actual painted body pixels, so transformed text cannot intrude into chrome. */
export async function assertDeckBodyFits(
  svg: string,
  system: DeckVisualSystem,
  role: DeckPageRole,
): Promise<void> {
  const document = parseString(svg);
  const root = document.documentElement;
  const body = Array.from(document.getElementsByTagName('g')).find(
    (node) => node.getAttribute('data-deck-body') === 'true',
  );
  if (!body) throw new Error('Missing deck body');
  for (const image of Array.from(body.getElementsByTagName('image'))) {
    const rectangle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    for (const key of ['x', 'y', 'width', 'height', 'transform'])
      if (image.hasAttribute(key)) rectangle.setAttribute(key, image.getAttribute(key)!);
    rectangle.setAttribute('fill', '#000000');
    image.parentNode!.replaceChild(rectangle, image);
  }
  const defs = Array.from(root.childNodes)
    .filter((node) => node.nodeType === 1 && (node as Element).tagName === 'defs')
    .map(String)
    .join('');
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${system.height}">${defs}${body}</svg>`;
  const { data, info } = await sharp(Buffer.from(markup))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const box = deckBodyRegion(system, role);
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (
        x >= box.x - 2 &&
        x <= box.x + box.width + 2 &&
        y >= box.y - 2 &&
        y <= box.y + box.height + 2
      )
        continue;
      if (data[(y * info.width + x) * info.channels + info.channels - 1] > 16)
        throw new Error(
          `Content paints outside the shared deck body at (${x},${y}); fit all content inside ${JSON.stringify(box)}, without drawing a title, header or footer.`,
        );
    }
}

export function assertDeckVisualConsistency(
  plan: PresentationPlan,
  system: DeckVisualSystem,
): void {
  for (const slide of plan.slides) {
    const document = parseString(slide.svg);
    if (document.documentElement.getAttribute('data-deck-style') !== system.id)
      throw new Error(`Slide ${slide.slideId} does not use the shared deck visual system`);
    for (const text of Array.from(document.getElementsByTagName('text')))
      if (text.getAttribute('font-family') !== system.fontFamily)
        throw new Error(`Slide ${slide.slideId} overrides the shared font family`);
  }
}
