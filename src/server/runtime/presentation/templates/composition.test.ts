import { describe, expect, it } from 'vitest';

import { composeTemplateApplications } from './composition';
import { compileTemplateDesignProgram } from './design-program';
import type { TemplateApplication } from './types';

const source = (templateId: string): TemplateApplication => {
  const families = [
    {
      id: 'same-family',
      name: templateId,
      pages: [1],
      palette: ['#008866'],
      typography: '大标题',
      composition: '图文双栏',
      artwork: '水彩',
      preserve: ['留白'],
    },
  ];
  const components = [
    {
      id: 'same-component',
      name: '边框',
      page: 1,
      familyId: 'same-family',
      box: { x: 0.05, y: 0.05, width: 0.9, height: 0.1 },
      role: 'frame' as const,
      treatment: 'reuse' as const,
      containsText: false,
      rationale: '无旧文字的纹理框',
    },
  ];
  const analysis = { families, components, summary: '水彩', guidance: '留白' };
  return {
    templateId,
    versionId: 'v1',
    name: templateId,
    layouts: [],
    constraints: {
      aspectRatio: '16:9',
      fontFamilies: [],
      fontSizes: [],
      palette: [],
      spacing: {
        margins: { x: 0.05, y: 0.05, width: 0.05, height: 0.05 },
        horizontalGaps: [],
        verticalGaps: [],
      },
    },
    visual: {
      ...analysis,
      schemaVersion: 3,
      templateId,
      versionId: 'v1',
      pages: [],
      media: [],
      analyzedAt: '2026-10-14',
      model: 'test',
      learning: { status: 'ready', iteration: 1, questions: [], guidanceHistory: [] },
      designProgram: compileTemplateDesignProgram(analysis),
    },
  };
};

describe('owned template composition', () => {
  it('namespaces colliding component and layout identities and preserves extraction provenance', () => {
    const first = source('first');
    const second = source('second');
    const composed = composeTemplateApplications([first, second]);
    const components = composed.application.visual!.components;
    expect(new Set(components.map(({ id }) => id)).size).toBe(2);
    expect(new Set(composed.application.visual!.families.map(({ id }) => id)).size).toBe(2);
    expect(composed.componentSources[components[0].id]).toEqual({
      templateId: 'first',
      versionId: 'v1',
      componentId: 'same-component',
    });
    expect(composed.componentSources[components[1].id]).toEqual({
      templateId: 'second',
      versionId: 'v1',
      componentId: 'same-component',
    });
    expect(composed.application.templateId).toBe('first');
    expect(first.visual!.components[0].id).toBe('same-component');
    expect(composed.application.compositionPolicy?.mode).toBe('capabilities');
    expect(
      composed.application.visual!.families.every(
        (family) => family.palette === first.visual!.families[0].palette,
      ),
    ).toBe(true);
  });

  it('keeps the ordinary single-template application compatible', () => {
    const first = source('first');
    expect(composeTemplateApplications([first]).application).toBe(first);
  });
  it('applies the selected capability family even when all choices come from one template', () => {
    const first = source('first');
    const result = composeTemplateApplications([first], { first: 'same-family' });
    expect(result.application.compositionPolicy?.mode).toBe('capabilities');
    expect(result.application.visual!.families).toHaveLength(1);
    expect(Object.values(result.componentSources)[0].templateId).toBe('first');
  });
  it('binds same-numbered evidence pages to their actual sources and limits invariants to the active style', () => {
    const first = source('first');
    const second = source('second');
    first.visual!.pages = [{ page: 1, ref: 'first-page', width: 100, height: 50, nativeTextCount: 1 }];
    second.visual!.pages = [{ page: 1, ref: 'second-page', width: 100, height: 50, nativeTextCount: 1 }];
    first.visual!.designProgram.invariants = ['Inactive cover brand must not leak'];
    const result = composeTemplateApplications([first, second]);
    expect(result.application.visual!.designProgram.archetypes.some((item) => item.sourcePageRefs?.includes('first-page'))).toBe(true);
    expect(result.application.visual!.designProgram.archetypes.some((item) => item.sourcePageRefs?.includes('second-page'))).toBe(true);
    expect(result.application.visual!.designProgram.invariants).not.toContain('Inactive cover brand must not leak');
  });
});
