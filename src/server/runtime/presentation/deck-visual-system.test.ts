import { describe, expect, it } from 'vitest';

import {
  assertDeckBodyFits,
  assertDeckVisualConsistency,
  createDeckVisualSystem,
  deckPageRole,
  deckVisualInstructions,
  deckVisualSystemSchema,
  renderDeckVisualFrame,
} from './deck-visual-system';

const input = {
  notebookId: 'test',
  title: '武汉商学院2026年工作汇报',
  sourceVersionIds: [],
  aspectRatio: '16:9',
  options: { style: '商务会议' },
};
const system = {
  ...createDeckVisualSystem(input)!,
  schemaVersion: 2 as const,
  fontFamily: 'Microsoft YaHei, Arial',
  headerHeight: 40,
  body: { x: 48, y: 136, width: 864, height: 364 },
  darkBody: { x: 48, y: 320, width: 864, height: 152 },
};
const body =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><g data-deck-body="true"><rect x="48" y="150" width="360" height="200" fill="#abc123"/><text x="72" y="190" font-family="serif" font-size="24" fill="#800080">本页内容</text></g></svg>';

describe('one visual system for the whole deck', () => {
  it('uses the selected gallery contract for every page, even when the outline suggests another style', () => {
    const presets = ['narrative-keynote', 'academic-research', 'technical-deepdive'] as const;
    const systems = presets.map((styleWorkspaceId) =>
      createDeckVisualSystem({
        ...input,
        options: { styleWorkspaceId, style: 'a different style proposed by the planner' },
      })!,
    );
    expect(systems.map((value) => value.styleWorkspaceId)).toEqual(presets);
    expect(new Set(systems.map((value) => value.colors.background)).size).toBe(3);
    expect(new Set(systems.map((value) => value.id)).size).toBe(3);
  });

  it('lets fresh learned designs own their full canvas without repainting fonts, colors or titles', async () => {
    const authored = createDeckVisualSystem(input)!;
    expect(authored.schemaVersion).toBe(3);
    expect(() =>
      deckVisualSystemSchema.parse({ ...authored, fontFamily: 'Arial" onload="alert(1)' }),
    ).toThrow();
    const page = body.replace('y="190"', 'y="90"');
    const svg = renderDeckVisualFrame(page, authored, {
      title: '另一个标题',
      role: 'content',
      order: 2,
      total: 3,
    });
    expect(svg).toContain('font-family="serif"');
    expect(svg).toContain('#800080');
    expect(svg).not.toContain('data-deck-frame');
    expect(svg).not.toContain('另一个标题');
    await expect(assertDeckBodyFits(svg, authored, 'content')).resolves.toBeUndefined();
    await expect(
      assertDeckBodyFits(svg.replace('960 540', '960 720'), authored, 'content'),
    ).rejects.toThrow('canvas');
  });
  it('activates an authored design for learned capabilities and keeps a saved legacy contract intact', () => {
    const learned = createDeckVisualSystem({
      ...input,
      options: {
        learnedCapabilities: { capsules: [{ kind: 'style', name: 'Editorial', rules: [] }] },
      },
    });
    expect(learned?.schemaVersion).toBe(3);
    expect(deckVisualInstructions(learned!, 'cover')).toContain('完整页面');
    expect(createDeckVisualSystem({ ...input, options: { deckVisualSystem: system } })).toEqual(
      system,
    );
  });
  it('renders the approved title exactly once when the model repeats it in the body', () => {
    const svg = renderDeckVisualFrame(body.replace('本页内容', '感谢聆听'), system, {
      title: '感谢聆听',
      role: 'closing',
      order: 18,
      total: 18,
    });
    expect(svg.match(/感谢聆听/gu)).toHaveLength(1);
    expect(svg).toContain('text-anchor="middle"');
    expect(
      deckPageRole(
        {
          ...input,
          slideCount: 18,
          options: {
            outline: Array.from({ length: 18 }, (_, i) => ({
              title: i === 17 ? '感谢聆听 · 敬请指导' : '内容',
            })),
          },
        },
        'slide-18',
        18,
      ),
    ).toBe('closing');
  });
  it('preserves closing roles and removes generic source captions from every master', () => {
    expect(
      deckPageRole(
        {
          ...input,
          options: { visualStoryboard: { slides: [{ slideId: 'slide-18', role: 'closing' }] } },
        },
        'slide-18',
        18,
      ),
    ).toBe('closing');
    const slide = renderDeckVisualFrame(body, system, {
      title: '感谢聆听',
      role: 'closing',
      order: 18,
      total: 18,
    });
    expect(slide).toContain('感谢聆听');
    expect(slide).not.toContain('资料来源');
    const legacy = { ...system, schemaVersion: 1 };
    expect(
      createDeckVisualSystem({ ...input, options: { ...input.options, deckVisualSystem: legacy } })
        ?.schemaVersion,
    ).toBe(2);
  });
  it('renders identical chrome and fonts around different body layouts', async () => {
    const a = renderDeckVisualFrame(body, system, {
      title: '招生结构',
      role: 'content',
      order: 5,
      total: 18,
    });
    const b = renderDeckVisualFrame(body.replace('width="360"', 'width="800"'), system, {
      title: '协同育人',
      role: 'content',
      order: 13,
      total: 18,
    });
    expect(a).not.toContain('serif');
    expect(a).not.toContain('#800080');
    expect(
      a
        .match(/<g data-deck-frame="true">.*?<\/g>/u)?.[0]
        .replace('招生结构', 'TITLE')
        .replace('05 / 18', 'PAGE'),
    ).toBe(
      b
        .match(/<g data-deck-frame="true">.*?<\/g>/u)?.[0]
        .replace('协同育人', 'TITLE')
        .replace('13 / 18', 'PAGE'),
    );
    await expect(assertDeckBodyFits(a, system, 'content')).resolves.toBeUndefined();
    expect(() =>
      assertDeckVisualConsistency(
        {
          slides: [
            { slideId: 'a', svg: a },
            { slideId: 'b', svg: b },
          ],
        } as never,
        system,
      ),
    ).not.toThrow();
  });
  it('rejects transformed body text or an image intruding into the common header', async () => {
    const intrusion = body.replace('y="190"', 'y="90"');
    await expect(assertDeckBodyFits(intrusion, system, 'content')).rejects.toThrow('outside');
    const image = body.replace(
      '</g>',
      '<image href="/api/runtime/presentation/artifacts/owned" x="60" y="90" width="400" height="200"/></g>',
    );
    await expect(assertDeckBodyFits(image, system, 'content')).rejects.toThrow('outside');
  });
  it('exposes secondary layout geometry without copying source slogans or typography', () => {
    const instructions = deckVisualInstructions(system, 'content', {
      visual: {
        designProgram: {
          archetypes: [
            {
              id: 'secondary-layout',
              roles: ['comparison'],
              compositionRules: ['Old source slogan'],
              regions: [
                {
                  box: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 },
                  role: 'frame',
                  behavior: 'elastic',
                  relation: 'Old brand',
                },
              ],
            },
          ],
        },
      },
    } as never);
    expect(instructions).toContain('secondary-layout');
    expect(instructions).not.toContain('Old source');
    expect(instructions).not.toContain('Old brand');
  });
});
