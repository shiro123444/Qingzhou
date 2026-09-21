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
