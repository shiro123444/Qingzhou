import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { CapabilityCapsule, FileCapabilityCapsuleStore } from './capability-memory';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const identifier = /^[\w-]+$/u;
const read = async (filename: string) => {
  const value = await readFile(filename, 'utf8');
  if (Buffer.byteLength(value) > 2 * 1024 * 1024) throw new Error('Design reference is too large');
  return value;
};

const rules = (text: string): string[] => {
  const result: string[] = [];
  let current = '';
  for (const paragraph of text.replace(/^---\n[\s\S]*?\n---\n/u, '').split(/\n\s*\n/u)) {
    for (let offset = 0; offset < paragraph.length; offset += 1700) {
      const part = paragraph.slice(offset, offset + 1700);
      if (current.length + part.length + 2 > 1700) {
        result.push(current);
        current = '';
      }
      current += (current ? '\n\n' : '') + part;
    }
  }
  if (current) result.push(current);
  if (result.length > 24) throw new Error('Design reference exceeds the capability rule budget');
  return result.filter(Boolean);
};

const styleTerms: Record<string, string> = {
  'academic-research': '学术 研究 论文 答辩',
  'consulting-decision': '汇报 决策 分析 验收 清单 流程',
  'creative-pitch': '创意 提案 品牌 设计',
  'duty-manual': '技术 手册 操作 规范',
  'incident-postmortem': '故障 复盘 原因 可靠性',
  'investor-pitch': '融资 创业 投资',
  'mbb-consulting': '咨询 战略 分析',
  'narrative-keynote': '故事 演讲 叙事',
  'operating-review': '经营 业务 工作 汇报 指标',
  'product-launch': '产品 演示 功能 发布 验收 流程',
  'science-explainer': '科普 原理 解释',
};

function layoutRoles(name: string): NonNullable<CapabilityCapsule['layout']>['roles'] {
  if (/cover|hero|title_slide|statement/u.test(name)) return ['cover'];
  if (/ending|closing/u.test(name)) return ['closing'];
  if (/section|chapter/u.test(name)) return ['section'];
  if (/process|flow|timeline/u.test(name)) return ['process'];
  if (/chart|data|table|kpi/u.test(name)) return ['data'];
  if (/comparison|two_content/u.test(name)) return ['comparison'];
  return ['content'];
}

/** Read only indexed Style specs and Layout prototypes from a deployment-owned checkout.
 * These are reference observations, never user-approved or successfully trialled designs.
 */
export async function importPptMasterDesignLibrary(options: {
  root: string;
  scope: RuntimeScope;
  memory: Pick<FileCapabilityCapsuleStore, 'importReference'>;
}): Promise<CapabilityCapsule[]> {
  const base = path.join(options.root, 'skills', 'ppt-master', 'templates');
  const optionalIndex = async (filename: string) =>
    read(filename).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
  const styleIndex = await optionalIndex(path.join(base, 'styles', 'styles_index.json'));
  const layoutIndex = await optionalIndex(path.join(base, 'layouts', 'layouts_index.json'));
  // Converter-only installations remain usable; a partial library is a configuration error.
  if (!styleIndex && !layoutIndex) return [];
  if (!styleIndex || !layoutIndex) throw new Error('PPT Master design library is incomplete');
  const styles = JSON.parse(styleIndex) as Record<string, { summary: string; keywords: string[] }>;
  const layouts = JSON.parse(layoutIndex) as Record<
    string,
    { summary: string; canvas_format: string }
  >;
  const imported: CapabilityCapsule[] = [];
  for (const [id, entry] of Object.entries(styles)) {
    if (!identifier.test(id)) throw new Error('Invalid Style workspace id');
    const spec = await read(path.join(base, 'styles', id, 'templates', 'design_spec.md'));
    const visualId = /\*\*Preferred Visual Style\*\*:\s*([\w-]+)/u.exec(spec)?.[1];
    const visualGuide = visualId
      ? ((await optionalIndex(
          path.join(options.root, 'skills/ppt-master/references/visual-styles', `${visualId}.md`),
        )) ?? '')
      : '';
    const visualDefaults =
      visualId === 'custom'
        ? (spec.split('## V. Visual System Defaults')[1]?.split(/^## VI\./mu)[0] ?? '')
        : visualGuide;
    const background = /\|\s*background\s*\|\s*#([a-f\d]{6})\s*\|/iu.exec(visualDefaults)?.[1];
    const luminance = background
      ? [0, 2, 4].reduce(
          (sum, offset, i) =>
            sum +
            Number.parseInt(background.slice(offset, offset + 2), 16) * [0.2126, 0.7152, 0.0722][i],
          0,
        )
      : undefined;
    if (!new RegExp(`^style_id: ${id}\\s*$`, 'mu').test(spec) || !/^kind: style\s*$/mu.test(spec))
      throw new Error('Style index and specification disagree');
    imported.push(
      await options.memory.importReference(options.scope, {
        kind: 'style',
        name: `PPT Master · ${id}`,
        source: {
          workspaceKind: 'style',
          workspaceId: id,
          sourceDigest: digest(spec + visualGuide),
          evidencePages: [],
        },
        triggers: [
          id,
          entry.summary.slice(0, 500),
          ...(entry.keywords ?? []).slice(0, 8),
          styleTerms[id] ?? '演示 文稿',
        ],
        palette: [],
        rules: rules(spec + '\n\n' + visualGuide),
        ...(visualId && visualDefaults
          ? {
              designReference: {
                style: {
                  id: visualId,
                  flat: /strictly flat|no shadows|no depth|no drop shadow/iu.test(visualDefaults),
                  sparseDecoration: /omit ornament|near-zero decoration|no ornamental/iu.test(
                    visualDefaults,
                  ),
                  squareCorners: /square corners|sharp geometry|zero corner radius/iu.test(
                    visualDefaults,
                  ),
                  grid: /modular grid|rigorous.*alignment|strict.grid/iu.test(visualDefaults),
                  ...(luminance === undefined
                    ? {}
                    : { background: luminance < 128 ? ('dark' as const) : ('light' as const) }),
                },
              },
            }
          : {}),
      }),
    );
  }
  for (const [id, entry] of Object.entries(layouts)) {
    if (!identifier.test(id)) throw new Error('Invalid Layout workspace id');
    const directory = path.join(base, 'layouts', id, 'templates');
    const spec = await read(path.join(directory, 'design_spec.md'));
    for (const filename of (await readdir(directory))
      .filter((name) => /^[\w-]+\.svg$/u.test(name))
      .sort()) {
      const svg = await read(path.join(directory, filename));
      const root = parseString(svg).documentElement;
      const [x, y, width, height] = (root.getAttribute('viewBox') ?? '')
        .trim()
        .split(/\s+/u)
        .map(Number);
      if (
        x !== 0 ||
        y !== 0 ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
      )
        throw new Error('Layout prototype needs a finite canvas');
      const key = root.getAttribute('data-pptx-layout') || filename.replace(/\.svg$/u, '');
      const name = root.getAttribute('data-pptx-layout-name') || key;
      const regions: NonNullable<CapabilityCapsule['layout']>['regions'] = [];
      const slots: NonNullable<CapabilityCapsule['designReference']>['slots'] = [];
      // Only explicit, thin layout anchors are transferable decoration. Panels,
      // sample charts and master backgrounds are never inferred as accents.
      const accents = Array.from(root.getElementsByTagName('rect'))
        .flatMap((node) => {
          const left = Number(node.getAttribute('x') ?? 0),
            top = Number(node.getAttribute('y') ?? 0);
          const w = Number(node.getAttribute('width')),
            h = Number(node.getAttribute('height'));
          const fill = node.getAttribute('fill') ?? '';
          if (
            node.getAttribute('data-pptx-layer') !== 'layout' ||
            !node.getAttribute('id') ||
            ![left, top, w, h].every(Number.isFinite) ||
            left < 0 ||
            top < 0 ||
            w <= 0 ||
            h <= 0 ||
            left + w > width ||
            top + h > height ||
            Math.max(w / h, h / w) < 8 ||
            !/^#[0-9a-f]{6}$/iu.test(fill)
          )
            return [];
          return [
            {
              id: node.getAttribute('id')!,
              box: { x: left / width, y: top / height, width: w / width, height: h / height },
              fill,
            },
          ];
        })
        .slice(0, 8);
      for (const node of Array.from(root.getElementsByTagName('*'))) {
        if (!node.hasAttribute('data-pptx-placeholder')) continue;
        const bounds = (node.getAttribute('data-pptx-bounds') ?? '').split(/\s+/u).map(Number);
        const [left, top, w, h] = bounds;
        if (
          bounds.length !== 4 ||
          bounds.some((n) => !Number.isFinite(n)) ||
          left < 0 ||
          top < 0 ||
          w <= 0 ||
          h <= 0 ||
          left + w > width + 0.01 ||
          top + h > height + 0.01
        )
          throw new Error('Layout slot is outside its source canvas');
        const type = node.getAttribute('data-pptx-placeholder')!;
        const carrier = Array.from(node.getElementsByTagName('text'))[0];
        const fontSize = (Number(carrier?.getAttribute('font-size')) / width) * 960;
        if (
          ['title', 'subtitle', 'body', 'object', 'table', 'chart', 'picture', 'footer'].includes(
            type,
          )
        )
          slots.push({
            id: node.getAttribute('id') || `${key}-${slots.length}`,
            kind: type as NonNullable<typeof slots>[number]['kind'],
            box: { x: left / width, y: top / height, width: w / width, height: h / height },
            ...(fontSize > 0 && fontSize <= 200 ? { fontSize } : {}),
          });
        regions.push({
          behavior: 'elastic',
          box: { x: left / width, y: top / height, width: w / width, height: h / height },
          role: /title|heading/u.test(type)
            ? 'heading'
            : /picture|image/u.test(type)
              ? 'artwork'
              : 'frame',
          relation: `Native ${type} slot in ${key}; geometry is a reference, not source content.`,
        });
      }
      const page = Number(filename.match(/^\d+/u)?.[0] ?? 1);
      const roles = layoutRoles(key);
      const aspectRatio =
        entry.canvas_format === 'ppt169'
          ? '16:9'
          : entry.canvas_format === 'ppt43'
            ? '4:3'
            : `${width}:${height}`;
      const layout = {
        id: `${id}-${key}`.slice(0, 80),
        familyId: id,
        name,
        roles,
        evidencePages: [page],
        regions: regions.slice(0, 24),
        readingFlow: `Use the source ${name} reading structure; adapt slot count and proportions to the actual content.`,
        whitespace:
          'Preserve deliberate hierarchy and negative space; source placeholder wording and example data are not evidence.',
        compositionRules: [
          `Brand-neutral ${name} geometry. No mandatory header, footer, palette or typeface.`,
          'Slots describe content positions, not visible containers. Never draw a panel or rounded card merely to visualize a slot. Avoid repeating table content in a neighboring conclusion card.',
        ],
        assetPolicy: [
          'Keep factual text, formulas and relationships editable. Do not copy prototype sample data.',
        ],
      };
      imported.push(
        await options.memory.importReference(options.scope, {
          kind: 'layout',
          name: `PPT Master · ${id} · ${name}`,
          source: {
            workspaceKind: 'layout',
            workspaceId: `${id}/${filename}`,
            sourceDigest: digest(spec + svg),
            aspectRatio,
            evidencePages: [page],
          },
          triggers: [
            id,
            key,
            name,
            entry.summary.slice(0, 500),
            roles.includes('process')
              ? '流程 步骤 顺序'
              : roles.includes('data')
                ? '验收 清单 数据 表格'
                : roles.includes('cover')
                  ? '封面 标题 开场'
                  : '内容 演示',
          ],
          palette: [],
          designReference: { slots: slots.slice(0, 24), ...(accents.length ? { accents } : {}) },
          layout,
          rules: [
            ...layout.compositionRules,
            layout.readingFlow,
            layout.whitespace,
            ...layout.assetPolicy,
          ],
        }),
      );
    }
  }
  return imported;
}

export function createPptMasterDesignLibrarySeeder(
  root: string,
  memory: FileCapabilityCapsuleStore,
) {
  const imports = new Map<string, Promise<CapabilityCapsule[]>>();
  return async (scope: RuntimeScope) => {
    const key = scope.userId;
    let task = imports.get(key);
    if (!task) {
      task = importPptMasterDesignLibrary({ root, memory, scope });
      imports.set(key, task);
      task.catch(() => {
        if (imports.get(key) === task) imports.delete(key);
      });
    }
    await task;
  };
}
