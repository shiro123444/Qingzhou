import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { PresentationPlan, RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { AtomicOperation } from '../atomic-runtime';
import { composeCapabilityPolicy } from './capability-composition';
import { PRESENTATION_CONTENT_BUDGET } from './content-intent';
import { assertPresentationPublishable, inspectPresentationContent } from './content-quality';
import type { PresentationJobRepository } from './file-storage';
import type { TemplateVisualProfile } from './templates';
import { templateDesignProgramSchema } from './templates/design-program';

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const capsuleSchema = z
  .object({
    id: z.string().regex(/^capsule-[a-f\d]{40}$/u),
    schemaVersion: z.literal(1),
    kind: z.enum(['style', 'layout', 'render-recipe']),
    name: z.string().min(1).max(160),
    triggers: z.array(z.string().max(500)).max(12),
    source: z
      .object({
        templateId: z.string().optional(),
        versionId: z.string().optional(),
        planId: z.string().optional(),
        familyId: z.string().optional(),
        archetypeId: z.string().optional(),
        evidencePages: z.array(z.number().int().positive()).max(100),
      })
      .strict(),
    // Typed data, never executable code, tool calls, image refs or source-slide text.
    rules: z.array(z.string().max(1800)).max(24),
    palette: z.array(z.string().regex(/^#[a-f\d]{6}$/iu)).max(10),
    layout: templateDesignProgramSchema.shape.archetypes.element.optional(),
    recipe: z
      .enum([
        'formula-with-explanation',
        'scientific-plot',
        'scientific-graph',
        'scientific-illustration',
        'mixed-scientific',
        'decoration-sticker',
      ])
      .optional(),
    createdAt: z.string(),
  })
  .strict();
export type CapabilityCapsule = z.infer<typeof capsuleSchema>;

/** Only the template atoms actually selected for generated pages have usage evidence. */
export function appliedTemplateCapsuleIds(
  capsules: CapabilityCapsule[],
  plan: PresentationPlan,
): string[] {
  const directions = plan.slides.map(
    (slide) =>
      slide.metadata?.visualDirection as { familyId?: string; archetypeId?: string } | undefined,
  );
  return capsules
    .filter((capsule) =>
      directions.some((direction) =>
        capsule.kind === 'style'
          ? Boolean(capsule.source.familyId && capsule.source.familyId === direction?.familyId)
          : capsule.kind === 'layout' &&
            Boolean(
              capsule.source.archetypeId && capsule.source.archetypeId === direction?.archetypeId,
            ),
      ),
    )
    .map((capsule) => capsule.id);
}
const outcomeSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    planFingerprint: z.string(),
    capsuleIds: z.array(z.string()).max(100),
    result: z.enum(['passed', 'failed', 'accepted', 'rejected']),
    recordedAt: z.string(),
  })
  .strict();
type Outcome = z.infer<typeof outcomeSchema>;
export interface CapabilityMemory {
  candidates?: (scope: RuntimeScope, query: string) => Promise<CapabilityCapsule[]>;
  compose: (
    scope: RuntimeScope,
    ids: string[],
    includeObserved?: boolean,
  ) => Promise<{
    capsules: CapabilityCapsule[];
    composition?: ReturnType<typeof composeCapabilityPolicy>;
    contentBudget: typeof PRESENTATION_CONTENT_BUDGET;
  }>;
  learn: (scope: RuntimeScope, visual: TemplateVisualProfile) => Promise<CapabilityCapsule[]>;
  learnRecipes: (
    scope: RuntimeScope,
    plan: PresentationPlan,
    visual?: TemplateVisualProfile,
  ) => Promise<CapabilityCapsule[]>;
  load: (scope: RuntimeScope, id: string) => Promise<CapabilityCapsule | null>;
  recordOutcome: (
    scope: RuntimeScope,
    input: {
      jobId: string;
      plan: PresentationPlan;
      capsuleIds: string[];
      result: Outcome['result'];
    },
  ) => Promise<Outcome>;
  search: (
    scope: RuntimeScope,
    query: string,
    limit?: number,
    includeObserved?: boolean,
  ) => Promise<CapabilityCapsule[]>;
}

const tokens = (text: string): Set<string> =>
  new Set(
    [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text.toLowerCase())]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment),
  );

const layoutRoleTerms = {
  closing: 'closing 结尾 总结',
  comparison: 'comparison compare 对比 比较 双栏',
  content: 'content 内容 正文',
  cover: 'cover 封面 开场',
  data: 'data chart 数据 图表 指标',
  process: 'process timeline 流程 步骤 时间线',
  section: 'section chapter 章节 过渡',
};

const observedTemplateAtom = (capsule: CapabilityCapsule) =>
  capsule.kind !== 'render-recipe' &&
  Boolean(
    capsule.source.templateId && capsule.source.versionId && capsule.source.evidencePages.length,
  );

/** User-scoped immutable evidence on the same persistent volume as presentations. */
export class FileCapabilityCapsuleStore implements CapabilityMemory {
  constructor(
    private readonly root: string,
    private readonly now = () => new Date().toISOString(),
  ) {}

  private directory(scope: RuntimeScope, kind: 'capsules' | 'outcomes') {
    if (!scope.userId?.trim() || !scope.sessionId?.trim())
      throw new Error('Authenticated memory scope is required');
    return path.join(this.root, hash(scope.userId), kind);
  }

  private async read<T>(filename: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      return schema.parse(JSON.parse(await readFile(filename, 'utf8')));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  private async save(
    scope: RuntimeScope,
    kind: 'capsules' | 'outcomes',
    id: string,
    value: unknown,
  ) {
    const directory = this.directory(scope, kind);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `${hash(id)}.json`);
    // Content-addressed keys make retries idempotent. Atomic rename never exposes partial JSON.
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, filename);
    } finally {
      await unlink(temporary).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
  }

  private async list<T>(
    scope: RuntimeScope,
    kind: 'capsules' | 'outcomes',
    schema: z.ZodType<T>,
  ): Promise<T[]> {
    const directory = this.directory(scope, kind);
    const files = await readdir(directory).catch((error) => {
      if (missing(error)) return [];
      throw error;
    });
    const items = await Promise.all(
      files
        .filter((file) => /^[a-f\d]{64}\.json$/u.test(file))
        .map((file) => this.read(path.join(directory, file), schema)),
    );
    return items.flatMap((item) => (item === null ? [] : [item]));
  }

  async learn(scope: RuntimeScope, visual: TemplateVisualProfile): Promise<CapabilityCapsule[]> {
    if (visual.learning.status !== 'ready') return [];
    const source = { templateId: visual.templateId, versionId: visual.versionId };
    const drafts: Array<Omit<CapabilityCapsule, 'id' | 'schemaVersion' | 'createdAt'>> = [
      ...visual.families.map((family) => ({
        kind: 'style' as const,
        name: family.name,
        source: { ...source, familyId: family.id, evidencePages: family.pages },
        triggers: [family.name, family.artwork.slice(0, 500), family.composition.slice(0, 500)],
        palette: family.palette,
        rules: [family.artwork, family.composition, family.typography, ...family.preserve].filter(
          Boolean,
        ),
      })),
      ...visual.designProgram.archetypes.map((archetype) => ({
        kind: 'layout' as const,
        name: archetype.name,
        source: {
          ...source,
          familyId: archetype.familyId,
          archetypeId: archetype.id,
          evidencePages: archetype.evidencePages,
        },
        triggers: [archetype.name, ...archetype.roles],
        palette: [],
        layout: {
          ...archetype,
          regions: archetype.regions.map(({ componentId: _componentId, ...region }) => region),
        },
        rules: [
          'Template regions are soft visual priors. Measure formulas, scientific diagram legends, generated-image aspect ratios and 24px body text first; reallocate or add a teaching stage instead of copying an undersized reference card.',
          archetype.readingFlow,
          archetype.whitespace,
          ...archetype.compositionRules,
          ...archetype.assetPolicy,
        ]
          .filter(Boolean)
          .slice(0, 24),
      })),
    ];
    const capsules: CapabilityCapsule[] = [];
    for (const draft of drafts) {
      const id = `capsule-${hash(draft).slice(0, 40)}`;
      const existing = await this.read(path.join(this.directory(scope, 'capsules'), `${hash(id)}.json`), capsuleSchema);
      const capsule =
        existing ?? capsuleSchema.parse({ ...draft, id, schemaVersion: 1, createdAt: this.now() });
      if (!existing) await this.save(scope, 'capsules', id, capsule);
      capsules.push(capsule);
    }
    const currentIds = new Set(capsules.map(({ id }) => id));
    for (const previous of await this.list(scope, 'capsules', capsuleSchema)) {
      if (previous.kind === 'render-recipe' || previous.source.templateId !== visual.templateId ||
          previous.source.versionId !== visual.versionId || currentIds.has(previous.id)) continue;
      const file = path.join(this.directory(scope, 'capsules'), `${hash(previous.id)}.json`);
      // Preserve historical evidence; superseded observations leave automatic selection.
      await rename(file, `${file}.retired`).catch((error) => { if (!missing(error)) throw error; });
    }
    return capsules;
  }

  load(scope: RuntimeScope, id: string): Promise<CapabilityCapsule | null> {
    const file = path.join(this.directory(scope, 'capsules'), `${hash(id)}.json`);
    return this.read(file, capsuleSchema).then((current) => current ?? this.read(`${file}.retired`, capsuleSchema));
  }

  async learnRecipes(
    scope: RuntimeScope,
    plan: PresentationPlan,
    visual?: TemplateVisualProfile,
  ): Promise<CapabilityCapsule[]> {
    const recipes = new Map<NonNullable<CapabilityCapsule['recipe']>, number[]>();
    for (const slide of plan.slides) {
      const blocks = slide.metadata?.contentBlocks;
      const visuals = slide.metadata?.visualAssets;
      if (
        Array.isArray(visuals) &&
        visuals.some((v) => v?.kind === 'scientific-illustration' && v.origin === 'generated')
      ) {
        recipes.set('scientific-illustration', [
          ...(recipes.get('scientific-illustration') ?? []),
          slide.order,
        ]);
        if (Array.isArray(blocks) && blocks.length)
          recipes.set('mixed-scientific', [
            ...(recipes.get('mixed-scientific') ?? []),
            slide.order,
          ]);
      }
      if (
        Array.isArray(visuals) &&
        visuals.some(
          // A sticker the server measured as opaque is not a reusable decoration recipe.
          (v) => v?.kind === 'sticker' && v.origin === 'generated' && v.transparency !== 'opaque',
        )
      )
        recipes.set('decoration-sticker', [
          ...(recipes.get('decoration-sticker') ?? []),
          slide.order,
        ]);
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        const recipe =
          block?.kind === 'formula'
            ? 'formula-with-explanation'
            : block?.kind === 'scientific-diagram' && block.spec?.type === 'plot'
              ? 'scientific-plot'
              : block?.kind === 'scientific-diagram' && block.spec?.type === 'graph'
                ? 'scientific-graph'
                : undefined;
        if (recipe) recipes.set(recipe, [...(recipes.get(recipe) ?? []), slide.order]);
      }
    }
    const descriptions = {
      'formula-with-explanation': [
        '数学公式与变量解释',
        '先用formula.measure测量关键公式，再按真实宽高留白；使用formula节点渲染LaTeX，旁列变量含义，完整推导放讲稿。',
      ],
      'scientific-plot': [
        '科研坐标曲线与算法比较',
        '使用scientific-diagram/plot，给出坐标范围、函数或数据点、单位和来源；示意数据显式标记。',
      ],
      'scientific-graph': [
        '科研流程与因果关系图',
        '使用scientific-diagram/graph，以命名节点和有方向的边表达关系，简短标签配合讲稿解释。',
      ],
      'scientific-illustration': [
        '生成式科研插图',
        '用Image生成定性科研插图，明确对象、部件和关系；通过真实像素复核，不以印象图代替机制；标注AI示意非实测，论文原图保留出处。',
      ],
      'mixed-scientific': [
        '科研插图与公式精确图混排',
        '按内容块组合Image科研插图、预先测量的公式和确定性矢量图；稳定visualId用于单独重绘，验收真实资产嵌入、留白与语义正确性。',
      ],
      'decoration-sticker': [
        '装饰贴纸与表情式点缀',
        '用 kind:"sticker" 生成孤立装饰主体，不带文字与整幅背景；服务端强制透明抠图并小尺寸落位到安全角落，评审只看白底方块、越界与遮挡正文。',
      ],
    };
    const capsules: CapabilityCapsule[] = [];
    for (const [recipe, evidencePages] of recipes) {
      const [name, rule] = descriptions[recipe];
      const draft = {
        kind: 'render-recipe',
        name,
        recipe,
        triggers: [name, recipe],
        rules: [rule],
        palette: [],
        source: {
          ...(visual ? { templateId: visual.templateId, versionId: visual.versionId } : {}),
          planId: plan.planId,
          evidencePages: [...new Set(evidencePages)],
        },
      };
      const id = `capsule-${hash(draft).slice(0, 40)}`;
      const capsule =
        (await this.load(scope, id)) ??
        capsuleSchema.parse({ ...draft, id, schemaVersion: 1, createdAt: this.now() });
      await this.save(scope, 'capsules', id, capsule);
      capsules.push(capsule);
    }
    return capsules;
  }

  private async promoted(scope: RuntimeScope, evidence?: Outcome[]) {
    const outcomes = [...(evidence ?? (await this.list(scope, 'outcomes', outcomeSchema)))].sort(
      (a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id),
    );
    const active = new Set<string>();
    const rejected = new Set<string>();
    for (const outcome of outcomes)
      for (const id of outcome.capsuleIds) {
        if (outcome.result === 'rejected') {
          rejected.add(id);
          active.delete(id);
        }
        if (outcome.result === 'accepted') {
          rejected.delete(id);
          active.add(id);
        }
        if (outcome.result === 'passed' && !rejected.has(id)) active.add(id);
        // Failed uses remain evidence; never promote an unverified candidate.
      }
    return { active, rejected };
  }

  private async rankedCandidates(scope: RuntimeScope, query: string, includeObserved = false) {
    const outcomes = await this.list(scope, 'outcomes', outcomeSchema);
    const { active, rejected } = await this.promoted(scope, outcomes);
    const reliability = new Map<string, number>();
    for (const outcome of outcomes)
      for (const id of outcome.capsuleIds)
        reliability.set(
          id,
          (reliability.get(id) ?? 0) +
            ({ accepted: 3, passed: 1, failed: -2, rejected: -3 } as const)[outcome.result],
        );
    const terms = tokens(query);
    const scored = (await this.list(scope, 'capsules', capsuleSchema))
      .filter(
        (capsule) =>
          active.has(capsule.id) ||
          (includeObserved && !rejected.has(capsule.id) && observedTemplateAtom(capsule)),
      )
      .map((capsule) => {
        const words = tokens(
          [
            capsule.name,
            ...capsule.triggers,
            ...(capsule.layout?.roles.map((role) => layoutRoleTerms[role]) ?? []),
          ].join(' '),
        );
        return {
          capsule,
          score: [...terms].filter((term) => words.has(term)).length,
          reliability: Math.max(-5, Math.min(5, reliability.get(capsule.id) ?? 0)),
          verified: Number(active.has(capsule.id)),
        };
      });
    return scored
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.verified - a.verified ||
          b.reliability - a.reliability ||
          a.capsule.id.localeCompare(b.capsule.id),
      );
  }

  async candidates(scope: RuntimeScope, query: string) {
    const ranked = await this.rankedCandidates(scope, query, true);
    return ['style', 'layout', 'render-recipe'].flatMap((kind) =>
      ranked
        .filter(({ capsule }) => capsule.kind === kind)
        .slice(0, 8)
        .map(({ capsule }) => capsule),
    );
  }

  async search(
    scope: RuntimeScope,
    query: string,
    limit = 6,
    includeObserved = false,
  ): Promise<CapabilityCapsule[]> {
    const candidates = await this.rankedCandidates(scope, query, includeObserved);
    const selected: CapabilityCapsule[] = [];
    const kinds = new Set<CapabilityCapsule['kind']>();
    // Reserve space for complementary skills before filling the remaining ranked slots.
    for (const candidate of candidates) {
      if (selected.length >= Math.max(1, Math.min(limit, 6))) break;
      if (kinds.has(candidate.capsule.kind)) continue;
      selected.push(candidate.capsule);
      kinds.add(candidate.capsule.kind);
    }
    const sourceIds = new Set(selected.map((capsule) => capsule.source.templateId));
    for (const newSourceOnly of [true, false])
      for (const candidate of candidates) {
        if (selected.length >= Math.max(1, Math.min(limit, 6))) break;
        if (candidate.capsule.kind === 'style' || selected.includes(candidate.capsule)) continue;
        if (newSourceOnly && sourceIds.has(candidate.capsule.source.templateId)) continue;
        selected.push(candidate.capsule);
        sourceIds.add(candidate.capsule.source.templateId);
      }
    return selected;
  }

  async compose(scope: RuntimeScope, ids: string[], includeObserved = false) {
    if (ids.length > 6 || new Set(ids).size !== ids.length)
      throw new Error('Compose up to six distinct capabilities');
    const { active, rejected } = await this.promoted(scope);
    const available = new Set((await this.list(scope, 'capsules', capsuleSchema)).map(({ id }) => id));
    const capsules = await Promise.all(ids.map((id) => this.load(scope, id)));
    if (
      capsules.some(
        (capsule) =>
          !capsule ||
          !available.has(capsule.id) ||
          (!active.has(capsule.id) &&
            !(includeObserved && !rejected.has(capsule.id) && observedTemplateAtom(capsule))),
      )
    )
      throw new Error('Only owned, verified capabilities can be composed');
    return {
      capsules: capsules as CapabilityCapsule[],
      observedCapabilityIds: capsules
        .filter((capsule) => capsule && !active.has(capsule.id))
        .map((capsule) => capsule!.id),
      composition: composeCapabilityPolicy(capsules as CapabilityCapsule[]),
      contentBudget: PRESENTATION_CONTENT_BUDGET,
    };
  }

  async recordOutcome(
    scope: RuntimeScope,
    input: {
      jobId: string;
      plan: PresentationPlan;
      capsuleIds: string[];
      result: Outcome['result'];
    },
  ): Promise<Outcome> {
    if (input.result === 'passed' || input.result === 'accepted') {
      assertPresentationPublishable(input.plan);
      const visual = input.plan.designSpec?.templateVisualReview as
        { final?: { passed?: boolean } } | undefined;
      if (!visual?.final?.passed || !inspectPresentationContent(input.plan).passed)
        throw new Error('Promotion requires both visual and semantic quality evidence');
    }
    for (const id of input.capsuleIds)
      if (!(await this.load(scope, id)))
        throw new Error('Capability is unavailable in this account');
    const fingerprint = hash(input.plan.slides.map((slide) => [slide.slideId, slide.svg]));
    const id = hash([input.jobId, fingerprint, input.capsuleIds, input.result]);
    const existing = await this.read(
      path.join(this.directory(scope, 'outcomes'), `${hash(id)}.json`),
      outcomeSchema,
    );
    if (existing) return existing;
    const outcome = outcomeSchema.parse({
      id,
      jobId: input.jobId,
      planFingerprint: fingerprint,
      capsuleIds: input.capsuleIds,
      result: input.result,
      recordedAt: this.now(),
    });
    await this.save(scope, 'outcomes', id, outcome);
    return outcome;
  }
}

export function capabilityMemoryOperations(
  memory: CapabilityMemory,
  repository?: PresentationJobRepository,
): AtomicOperation[] {
  const recordFeedback = async (
    jobId: string,
    result: 'accepted' | 'rejected',
    scope: RuntimeScope,
  ) => {
    const job = await repository?.getJob(scope, jobId);
    if (job?.job.state !== 'completed' || !job.plan)
      throw new Error('A completed owned job is required');
    const capsuleIds = z.array(z.string()).parse(job.plan.designSpec?.learnedCapabilityIds ?? []);
    return memory.recordOutcome(scope, { jobId, plan: job.plan, capsuleIds, result });
  };
  return [
    {
      name: 'presentation.memory.search',
      description:
        'Retrieve verified learning from earlier presentations in this account; match task, style or teaching intent.',
      agent: { contexts: ['presentation.intake', 'skills'], maxCalls: 3 },
      input: z
        .object({
          query: z.string().min(1).max(2000),
          limit: z.number().int().min(1).max(6).optional(),
          includeObserved: z.boolean().optional(),
        })
        .strict(),
      execute: ({ query, limit, includeObserved }, ctx) =>
        memory.search(ctx.scope, query, limit, includeObserved),
    },
    {
      name: 'presentation.memory.load',
      description: 'Inspect an owned immutable capability and its source evidence.',
      agent: { contexts: ['presentation.intake', 'skills'], maxCalls: 6 },
      input: z.object({ id: z.string().min(1).max(100) }).strict(),
      execute: ({ id }, ctx) => memory.load(ctx.scope, id),
    },
    {
      name: 'presentation.memory.compose',
      description:
        'Compose verified atoms across templates: one style anchor, task-specific layouts and rendering recipes. Current task and content budgets take precedence; record only actual per-page use.',
      agent: { contexts: ['presentation.intake', 'skills'], maxCalls: 2 },
      input: z
        .object({ ids: z.array(z.string()).max(6), includeObserved: z.boolean().optional() })
        .strict(),
      execute: ({ ids, includeObserved }, ctx) => memory.compose(ctx.scope, ids, includeObserved),
    },
    ...(repository
      ? [
          {
            name: 'presentation.memory.recordOutcome',
            description:
              'Record explicit user acceptance or rejection of learning used by an owned completed job.',
            input: z
              .object({ jobId: z.string().min(1), feedback: z.enum(['accepted', 'rejected']) })
              .strict(),
            execute: (
              { jobId, feedback }: { jobId: string; feedback: 'accepted' | 'rejected' },
              ctx: Parameters<AtomicOperation['execute']>[1],
            ) => recordFeedback(jobId, feedback, ctx.scope),
          } as AtomicOperation,
          {
            name: 'presentation.memory.promote',
            description:
              'Promote learning after explicit user acceptance of an owned completed presentation; verified visual and semantic evidence is required.',
            input: z.object({ jobId: z.string().min(1) }).strict(),
            execute: (
              { jobId }: { jobId: string },
              ctx: Parameters<AtomicOperation['execute']>[1],
            ) => recordFeedback(jobId, 'accepted', ctx.scope),
          } as AtomicOperation,
        ]
      : []),
  ];
}
