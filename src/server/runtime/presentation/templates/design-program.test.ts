import { expect, it } from 'vitest';

import { compileTemplateDesignProgram, type TemplateDesignProgram } from './design-program';
import { normalizeTemplateVisualProfile, templateVisualNeedsRefresh } from './visual-types';

const source = {
  components: [
    {
      box: { height: 0.3, width: 0.2, x: 0.7, y: 0.6 },
      containsText: false,
      familyId: 'soft',
      id: 'p1-leaf',
      name: 'Leaf',
      page: 1,
      rationale: 'edge decoration',
      role: 'decoration' as const,
      treatment: 'reuse' as const,
    },
  ],
  families: [
    {
      artwork: 'watercolor wash',
      composition: 'left title and lower-right artwork',
      id: 'soft',
      name: 'Soft cover',
      pages: [1],
      palette: ['#88AACC'],
      preserve: ['paper grain'],
      typography: 'large restrained title',
    },
  ],
  guidance: 'keep the calm handmade character',
  summary: 'watercolor lesson',
};

it('keeps model-observed relationships while canonicalizing component identities', () => {
  const base = compileTemplateDesignProgram(source);
  const proposed: TemplateDesignProgram = {
    ...base,
    archetypes: [
      {
        ...base.archetypes[0],
        readingFlow: 'The eye moves from the title into the diagonal leaf gesture.',
        regions: [
          {
            behavior: 'optional',
            box: source.components[0].box,
            componentId: 'leaf',
            relation: 'The leaf grazes the lower-right edge and points back toward the title.',
            role: 'decoration',
          },
        ],
      },
    ],
  };
  const program = compileTemplateDesignProgram(source, proposed);
  expect(program.archetypes[0]).toMatchObject({
    readingFlow: proposed.archetypes[0].readingFlow,
    regions: [
      {
        componentId: 'p1-leaf',
        relation: proposed.archetypes[0].regions[0].relation,
      },
    ],
  });
});

it('upgrades owned visual caches into the current design and learning profile in memory', () => {
  const upgraded = normalizeTemplateVisualProfile({
    ...source,
    analyzedAt: '2026-09-19T00:00:00.000Z',
    model: 'vision',
    pages: [{ height: 788, nativeTextCount: 0, page: 1, ref: 'page-1', width: 1400 }],
    schemaVersion: 2,
    templateId: 'template',
    versionId: 'version',
  });
  expect(upgraded.schemaVersion).toBe(3);
  expect(upgraded.learning.status).toBe('ready');
  expect(upgraded.media).toEqual([]);
  expect(templateVisualNeedsRefresh(upgraded)).toBe(true);
  expect(upgraded.designProgram.archetypes[0]).toMatchObject({
    familyId: 'soft',
    evidencePages: [1],
  });
});

it('splits a header-and-footer family into cover, body, figure and closing signatures', () => {
  const program = compileTemplateDesignProgram({
    components: [
      {
        box: { height: 0.13, width: 1, x: 0, y: 0 },
        containsText: true,
        familyId: 'academic',
        id: 'p4-header',
        name: '顶部通栏',
        page: 4,
        rationale: 'locked title band',
        role: 'heading',
        treatment: 'native',
      },
      {
        box: { height: 0.16, width: 0.96, x: 0.02, y: 0.82 },
        containsText: true,
        familyId: 'academic',
        id: 'p4-footer',
        name: '结论条',
        page: 4,
        rationale: 'closing band',
        role: 'frame',
        treatment: 'native',
      },
    ],
    families: [
      {
        artwork: '学术示意图',
        composition: '通栏标题，底部结论',
        id: 'academic',
        name: '蓝红学术',
        pages: [1, 4, 18],
        palette: ['#2C6EB5', '#B21818'],
        preserve: ['顶部通栏'],
        typography: '白字标题',
      },
    ],
    guidance: '当正文信息量极大时，优先压缩配图垂直高度',
    summary: '学术课件',
  });
  expect(program.archetypes.map((archetype) => archetype.id)).toEqual([
    'archetype-academic-cover',
    'archetype-academic-content',
    'archetype-academic-figure',
    'archetype-academic-closing',
  ]);
  expect(program.archetypes[0].regions[0]).toMatchObject({ behavior: 'locked', role: 'heading' });
  expect(program.archetypes.find((item) => item.id.endsWith('-figure'))?.roles).toEqual([
    'data',
    'comparison',
    'process',
  ]);
  expect(program.invariants.some((rule) => rule.includes('顶部通栏'))).toBe(true);
  expect(program.invariants.some((rule) => /压缩配图/u.test(rule))).toBe(false);
  expect(program.cadence.rules.some((rule) => /压缩配图/u.test(rule))).toBe(false);
  expect(program.cadence.rules.some((rule) => rule.includes('180px'))).toBe(true);
});

it('bounds verbose visual observations instead of rejecting the entire learned template', () => {
  const verbose = '细腻的水彩纸张、暖色晕染与呼吸感留白。'.repeat(160);
  const program = compileTemplateDesignProgram({
    ...source,
    components: source.components.map((component) => ({
      ...component,
      rationale: verbose,
    })),
    families: source.families.map((family) => ({
      ...family,
      artwork: verbose,
      composition: verbose,
      preserve: [verbose],
      typography: verbose,
    })),
    guidance: verbose,
    summary: verbose,
  });

  expect(program.tokens.surface.every((value) => value.length <= 800)).toBe(true);
  expect(program.tokens.artwork.every((value) => value.length <= 800)).toBe(true);
  expect(program.tokens.typography.every((value) => value.length <= 800)).toBe(true);
  expect(program.invariants.every((value) => value.length <= 500)).toBe(true);
  expect(program.archetypes[0].compositionRules.every((value) => value.length <= 500)).toBe(true);
  expect(program.archetypes[0].readingFlow.length).toBeLessThanOrEqual(800);
  expect(program.archetypes[0].whitespace.length).toBeLessThanOrEqual(800);
  expect(program.archetypes[0].assetPolicy[0].length).toBeLessThanOrEqual(500);
});
