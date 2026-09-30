import { z } from 'zod';

const designProgramBoxSchema = z
  .object({
    height: z.number().positive().max(1),
    width: z.number().positive().max(1),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict()
  .refine(
    (box) => box.x + box.width <= 1.001 && box.y + box.height <= 1.001,
    'Design-program region must fit inside the reference page',
  );

export const templateDesignProgramSchema = z
  .object({
    archetypes: z
      .array(
        z
          .object({
            assetPolicy: z.array(z.string().min(1).max(500)).max(12),
            compositionRules: z.array(z.string().min(1).max(500)).min(1).max(16),
            evidencePages: z.array(z.number().int().positive()).min(1).max(24),
            familyId: z.string().min(1).max(60),
            header: z
              .object({
                box: designProgramBoxSchema,
                fill: z.string().regex(/^#[a-f\d]{6}$/iu),
                textColor: z.string().regex(/^#[a-f\d]{6}$/iu),
              })
              .strict()
              .optional(),
            id: z.string().regex(/^[\w-]{1,80}$/u),
            name: z.string().min(1).max(100),
            readingFlow: z.string().min(1).max(800),
            regions: z
              .array(
                z
                  .object({
                    behavior: z.enum(['locked', 'elastic', 'optional', 'replace']),
                    box: designProgramBoxSchema,
                    componentId: z.string().max(80).optional(),
                    relation: z.string().min(1).max(500),
                    role: z.enum(['background', 'decoration', 'artwork', 'frame', 'heading']),
                  })
                  .strict(),
              )
              .max(24),
            roles: z
              .array(
                z.enum(['cover', 'section', 'content', 'comparison', 'process', 'data', 'closing']),
              )
              .min(1)
              .max(7),
            whitespace: z.string().min(1).max(800),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    cadence: z
      .object({
        bodyFamilyIds: z.array(z.string().min(1).max(60)).max(12),
        closingFamilyId: z.string().min(1).max(60).optional(),
        openingFamilyId: z.string().min(1).max(60).optional(),
        rules: z.array(z.string().min(1).max(500)).min(1).max(12),
      })
      .strict(),
    flexibilities: z.array(z.string().min(1).max(500)).min(1).max(20),
    invariants: z.array(z.string().min(1).max(500)).min(1).max(20),
    schemaVersion: z.literal(1),
    tokens: z
      .object({
        artwork: z.array(z.string().min(1).max(800)).max(12),
        palette: z.array(z.string().regex(/^#[a-f\d]{6}$/i)).max(16),
        surface: z.array(z.string().min(1).max(800)).max(12),
        typography: z.array(z.string().min(1).max(800)).max(12),
      })
      .strict(),
  })
  .strict();

export type TemplateDesignProgram = z.infer<typeof templateDesignProgramSchema>;

interface ProgramSource {
  readonly components: readonly {
    readonly box: {
      readonly height: number;
      readonly width: number;
      readonly x: number;
      readonly y: number;
    };
    readonly containsText: boolean;
    readonly familyId: string;
    readonly id: string;
    readonly name: string;
    readonly rationale: string;
    /** Source page of the observation; carried through for callers, unused by the compiler. */
    readonly page?: number;
    readonly role: 'background' | 'decoration' | 'artwork' | 'frame' | 'heading';
    readonly treatment: 'reuse' | 'crop' | 'removeBackground' | 'redraw' | 'native';
  }[];
  readonly families: readonly {
    readonly artwork: string;
    readonly composition: string;
    readonly id: string;
    readonly name: string;
    readonly pages: readonly number[];
    readonly palette: readonly string[];
    readonly preserve: readonly string[];
    readonly typography: string;
  }[];
  readonly guidance: string;
  readonly summary: string;
}

const uniq = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** Keep verbose vision-model observations useful without letting one field reject the profile. */
const boundedText = (value: string, maximum: number): string => {
  const normalized = value.trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
};

const boundedTexts = (values: readonly string[], maximum: number): string[] =>
  uniq(values.map((value) => boundedText(value, maximum)).filter(Boolean));

const rolesFor = (
  family: ProgramSource['families'][number],
  firstPage: number,
  lastPage: number,
): TemplateDesignProgram['archetypes'][number]['roles'] => {
  const text = `${family.name} ${family.composition}`.toLowerCase();
  const roles: TemplateDesignProgram['archetypes'][number]['roles'] = [];
  if (family.pages.includes(firstPage)) roles.push('cover');
  if (/section|chapter|divider|过渡|章节/u.test(text)) roles.push('section');
  if (/compare|versus|对比|双栏/u.test(text)) roles.push('comparison');
  if (/process|timeline|流程|步骤|路径/u.test(text)) roles.push('process');
  if (/chart|data|metric|数据|图表|指标/u.test(text)) roles.push('data');
  if (family.pages.includes(lastPage) && lastPage !== firstPage) roles.push('closing');
  if (!roles.length || roles.every((role) => role === 'cover' || role === 'closing')) {
    roles.push('content');
  }
  return uniq(roles);
};

const isHeaderBand = (component: ProgramSource['components'][number]) =>
  component.role === 'heading' &&
  component.box.y <= 0.2 &&
  component.box.width >= 0.75 &&
  component.box.x <= 0.1;

const isFooterBand = (component: ProgramSource['components'][number]) =>
  component.role === 'frame' && component.box.y >= 0.65 && component.box.width >= 0.75;

const signatureId = (familyId: string, suffix: string) =>
  `archetype-${familyId}-${suffix}`.replaceAll(/[^\w-]/gu, '-').slice(0, 80);

const behaviorFor = (
  component: ProgramSource['components'][number],
): TemplateDesignProgram['archetypes'][number]['regions'][number]['behavior'] => {
  if (
    component.containsText ||
    component.treatment === 'redraw' ||
    component.treatment === 'native'
  ) {
    return 'replace';
  }
  if (component.role === 'background') return 'locked';
  if (component.role === 'decoration') return 'optional';
  return 'elastic';
};

const regionFor = (component: ProgramSource['components'][number]) => ({
  behavior:
    component.role === 'heading' && isHeaderBand(component)
      ? ('locked' as const)
      : behaviorFor(component),
  box: component.box,
  componentId: component.id,
  relation: boundedText(
    component.role === 'decoration'
      ? 'Keep its edge relationship and visual direction; scale with nearby content rather than pinning it blindly.'
      : component.rationale || 'Keep the observed relationship to its neighboring content.',
    500,
  ),
  role: component.role,
});

/** One palette can still need several page machines: cover, text, figure, close. */
const layoutSignatures = (
  family: ProgramSource['families'][number],
  components: ProgramSource['components'],
) => {
  const header = components.filter(isHeaderBand);
  const footer = components.filter(isFooterBand);
  if (!header.length) return [];
  const artwork = components.filter((component) => component.role === 'artwork');
  const shared = {
    assetPolicy: boundedTexts(
      [...header, ...footer].map(
        (component) => `${component.name}: ${component.treatment}; ${component.rationale}`,
      ),
      500,
    ).slice(0, 12),
    evidencePages: uniq(family.pages),
    familyId: family.id,
    readingFlow: boundedText(
      family.composition || 'Title band, then the page claim, then the close.',
      800,
    ),
    whitespace: boundedText(
      'The header band stays fixed. Body content and figures use the open field beneath it.',
      800,
    ),
  };
  const signatures: TemplateDesignProgram['archetypes'] = [
    {
      ...shared,
      compositionRules: ['封面只保留锁定通栏、标题和留白，不堆正文卡片。'],
      id: signatureId(family.id, 'cover'),
      name: `${family.name} · 封面`,
      regions: header.map(regionFor),
      roles: ['cover'],
    },
  ];
  if (footer.length)
    signatures.push({
      ...shared,
      compositionRules: ['正文保留锁定通栏和底部结论条。公式保持实测字号，放不下时拆页。'],
      id: signatureId(family.id, 'content'),
      name: `${family.name} · 正文`,
      regions: [...header, ...footer].map(regionFor),
      roles: ['content', 'section'],
    });
  signatures.push({
    ...shared,
    compositionRules: [
      '图解页把可读配图放在主区域，至少 180px。公式过多时公式留在推导页，不要把图压成一条。',
    ],
    id: signatureId(family.id, 'figure'),
    name: `${family.name} · 图解`,
    regions: [...header, ...artwork].map(regionFor).slice(0, 24),
    roles: ['data', 'comparison', 'process'],
  });
  if (footer.length)
    signatures.push({
      ...shared,
      compositionRules: ['收束页保留通栏和结论条，用一张总图或三五个结论，不重复正文密度。'],
      id: signatureId(family.id, 'closing'),
      name: `${family.name} · 收束`,
      regions: [...header, ...footer].map(regionFor),
      roles: ['closing'],
    });
  return signatures;
};

/** Compile observations into a reusable design language instead of a bag of fixed boxes. */
export const compileTemplateDesignProgram = (
  source: ProgramSource,
  proposed?: TemplateDesignProgram,
): TemplateDesignProgram => {
  const observedPages = source.families.flatMap((family) => family.pages);
  const firstPage = Math.min(...observedPages);
  const lastPage = Math.max(...observedPages);
  const orderedFamilies = [...source.families].sort(
    (left, right) => Math.min(...left.pages) - Math.min(...right.pages),
  );
  const opening = orderedFamilies.find((family) => family.pages.includes(firstPage));
  const closing = [...orderedFamilies].reverse().find((family) => family.pages.includes(lastPage));

  const familyArchetypes = orderedFamilies.flatMap((family) => {
    const components = source.components.filter((item) => item.familyId === family.id);
    const signatures = layoutSignatures(family, components);
    const claimed = new Set(signatures.flatMap((signature) => signature.roles));
    const roles = rolesFor(family, firstPage, lastPage).filter((role) => !claimed.has(role));
    if (!roles.length) return [];
    const compositionRules = boundedTexts(
      [
        family.composition || 'Preserve the observed hierarchy and anchor relationships.',
        ...family.preserve,
      ],
      500,
    );
    return {
      assetPolicy: boundedTexts(
        components.map(
          (component) => `${component.name}: ${component.treatment}; ${component.rationale}`,
        ),
        500,
      ).slice(0, 12),
      compositionRules: (compositionRules.length
        ? compositionRules
        : ['Preserve the observed hierarchy and anchor relationships.']
      ).slice(0, 16),
      evidencePages: uniq(family.pages),
      familyId: family.id,
      id: `archetype-${family.id}`.replaceAll(/[^\w-]/gu, '-').slice(0, 80),
      name: family.name,
      readingFlow: boundedText(
        family.composition || 'Follow the observed title, content and artwork anchors.',
        800,
      ),
      regions: components.map(regionFor),
      roles,
      whitespace: boundedText(
        `Preserve the negative-space rhythm described by: ${family.composition || 'the observed reference pages'}`,
        800,
      ),
    };
  });
  const canonical = templateDesignProgramSchema.parse({
    archetypes: [
      ...familyArchetypes,
      ...orderedFamilies.flatMap((family) =>
        layoutSignatures(
          family,
          source.components.filter((item) => item.familyId === family.id),
        ),
      ),
    ].slice(0, 12),
    cadence: {
      bodyFamilyIds: uniq(
        orderedFamilies
          .filter((family) => family.id !== opening?.id && family.id !== closing?.id)
          .map((family) => family.id),
      ),
      ...(closing ? { closingFamilyId: closing.id } : {}),
      ...(opening ? { openingFamilyId: opening.id } : {}),
      rules: [
        'Choose a layout signature by the page job: cover, derivation, figure, or close. Do not reuse one catch-all archetype for every slide.',
        'A required figure keeps at least 180px. When measured formulas do not leave that band, put the formulas and the figure on separate pages.',
        'Repeat the locked header while varying the body. Do not compress a figure to imitate a dense reference page.',
      ],
    },
    flexibilities: [
      'Text and artwork regions may expand within their anchor relationship when content density changes.',
      'Optional decoration may be omitted when it competes with the claim or data.',
      'New artwork may change subject while preserving brushwork, texture, palette and negative space.',
    ],
    invariants: (() => {
      const values = boundedTexts(
        [
          ...(source.components.some(isHeaderBand) ? ['顶部通栏标题栏常驻且高度固定'] : []),
          ...orderedFamilies.flatMap((family) => family.preserve),
          source.guidance,
        ],
        500,
      );
      return (
        values.length
          ? values
          : ['Preserve the observed visual hierarchy and anchor relationships.']
      )
        .filter((rule) => !/压缩配图|优先压缩/u.test(rule))
        .slice(0, 20);
    })(),
    schemaVersion: 1,
    tokens: {
      artwork: boundedTexts(
        orderedFamilies.map((family) => family.artwork),
        800,
      ).slice(0, 12),
      palette: uniq(orderedFamilies.flatMap((family) => family.palette)).slice(0, 16),
      surface: boundedTexts([source.summary, source.guidance], 800).slice(0, 12),
      typography: boundedTexts(
        orderedFamilies.map((family) => family.typography),
        800,
      ).slice(0, 12),
    },
  });
  if (!proposed) return canonical;
  const validFamilyIds = new Set(source.families.map((family) => family.id));
  const proposedByFamily = new Map(
    proposed.archetypes
      .filter((archetype) => validFamilyIds.has(archetype.familyId))
      .map((archetype) => [archetype.familyId, archetype]),
  );
  const resolveComponentId = (familyId: string, id?: string): string | undefined => {
    if (!id) return;
    const matches = source.components.filter(
      (component) =>
        component.familyId === familyId && (component.id === id || component.id.endsWith(`-${id}`)),
    );
    return matches.length === 1 ? matches[0].id : undefined;
  };
  return templateDesignProgramSchema.parse({
    ...canonical,
    archetypes: canonical.archetypes.map((archetype) => {
      const learned = proposedByFamily.get(archetype.familyId);
      if (!learned) return archetype;
      const learnedRegions = learned.regions.map((region) => ({
        ...region,
        ...(region.componentId
          ? { componentId: resolveComponentId(archetype.familyId, region.componentId) }
          : {}),
      }));
      const enrichedRegions = archetype.regions.map((region) => {
        const learnedRegion = learnedRegions.find(
          (candidate) =>
            candidate.componentId === region.componentId ||
            (!candidate.componentId && candidate.role === region.role),
        );
        return learnedRegion
          ? {
              ...region,
              behavior: learnedRegion.behavior,
              relation: learnedRegion.relation,
            }
          : region;
      });
      enrichedRegions.push(
        ...learnedRegions.filter(
          (region) =>
            !region.componentId &&
            !enrichedRegions.some(
              (canonicalRegion) =>
                canonicalRegion.role === region.role &&
                canonicalRegion.relation === region.relation,
            ),
        ),
      );
      return {
        ...archetype,
        ...(() => {
          // A body header must never leak to the cover merely because both share a family.
          const candidates = proposed.archetypes.filter(
            (item) =>
              item.familyId === archetype.familyId &&
              item.header &&
              item.roles.some((role) => archetype.roles.includes(role)) &&
              item.evidencePages.some((page) => archetype.evidencePages.includes(page)),
          );
          const exact = candidates.find((item) => item.id === archetype.id);
          const selected = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
          return selected?.header ? { header: selected.header } : {};
        })(),
        assetPolicy: uniq([...learned.assetPolicy, ...archetype.assetPolicy]).slice(0, 12),
        compositionRules: uniq([...learned.compositionRules, ...archetype.compositionRules]).slice(
          0,
          16,
        ),
        readingFlow: learned.readingFlow,
        regions: enrichedRegions.slice(0, 24),
        roles: (() => {
          const claimed = new Set(
            canonical.archetypes
              .filter(
                (item) =>
                  item.familyId === archetype.familyId &&
                  item.id !== archetype.id &&
                  /-(?:cover|content|figure|closing)$/u.test(item.id),
              )
              .flatMap((item) => item.roles),
          );
          const merged = uniq([...learned.roles, ...archetype.roles]).filter(
            (role) => archetype.roles.includes(role) || !claimed.has(role),
          );
          return merged.length ? merged : archetype.roles;
        })(),
        whitespace: learned.whitespace,
      };
    }),
    cadence: {
      ...canonical.cadence,
      rules: uniq([...proposed.cadence.rules, ...canonical.cadence.rules])
        .filter((rule) => !/压缩配图|优先压缩/u.test(rule))
        .slice(0, 12),
    },
    flexibilities: uniq([...proposed.flexibilities, ...canonical.flexibilities]).slice(0, 20),
    invariants: uniq([...proposed.invariants, ...canonical.invariants]).slice(0, 20),
    tokens: {
      artwork: uniq([...proposed.tokens.artwork, ...canonical.tokens.artwork]).slice(0, 12),
      palette: uniq([...proposed.tokens.palette, ...canonical.tokens.palette]).slice(0, 16),
      surface: uniq([...proposed.tokens.surface, ...canonical.tokens.surface]).slice(0, 12),
      typography: uniq([...proposed.tokens.typography, ...canonical.tokens.typography]).slice(
        0,
        12,
      ),
    },
  });
};
