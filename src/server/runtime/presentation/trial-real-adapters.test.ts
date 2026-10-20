import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import realPage from './__fixtures__/trial-text-overflow.json';
import type { MultimodalChatPort, MultimodalChatResult } from './multimodal-chat-provider';
import {
  anonymizeTrialIds,
  type AnonymousTrialContext,
  trialEditableTexts,
} from './trial-evaluation';
import { createRealTrialAdapters } from './trial-real-adapters';
import type { TrialStageContext } from './trial-runner';
import { inspectTrialTextBounds } from './trial-text-layout';

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="white"/><text x="20" y="60" font-size="32">Course 2026</text></svg>';
const model = {
  providerId: 'test-port',
  model: 'vision',
  configurationDigest: 'a'.repeat(64),
  maxOutputTokens: 100,
  temperature: 0,
};
const reply = (value: unknown): MultimodalChatResult => ({
  id: 'r',
  model: 'vision',
  created: 0,
  choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value) } }],
  usage: { total_tokens: 6 },
});
const score = (label: string) => ({
  label,
  visual: { status: 'passed', evidence: 'No clipping' },
  quality: Object.fromEntries(
    ['readability', 'hierarchy', 'composition', 'styleConsistency'].map((key) => [
      key,
      { score: 3, evidence: 'Pixels are legible' },
    ]),
  ),
});
function fixture() {
  const chat = vi.fn<MultimodalChatPort['chat']>().mockResolvedValue(reply({ svg }));
  const port: MultimodalChatPort = {
    chat,
    providerId: model.providerId,
    manifest: { ...model, displayName: 'Test', supportsVision: true, supportsIdempotency: true },
  };
  const adapters = createRealTrialAdapters({
    version: 'real-v1',
    evaluatorVersion: 'blind-v1',
    planner: { port, configurationDigest: model.configurationDigest },
    observer: { port, configurationDigest: model.configurationDigest },
  });
  const context = {
    allowance: { tokens: 100, costMicros: 5 },
    scope: { userId: 'alice', sessionId: 'trial' },
    signal: new AbortController().signal,
    plan: {
      planId: 'p',
      title: 'Course',
      aspectRatio: '16:9',
      sourceVersionIds: [],
      slides: [{ slideId: 's', order: 1, svg, notes: 'facts' }],
    },
    configurationFingerprint: 'a'.repeat(64),
    workspace: '/unused',
    configuration: {
      sourceAssets: [],
      capsules: [],
      settings: {
        rendererVersion: adapters.rendererVersion,
        executorVersion: adapters.version,
        models: { planner: model },
        recipe: { instructions: 'Layout only' },
      },
    },
  } as unknown as TrialStageContext;
  return { adapters, chat, context };
}
async function evaluationFixture() {
  const h = fixture();
  const rendered = await h.adapters.render(h.context);
  const ctx: AnonymousTrialContext = {
    allowance: { tokens: 100, costMicros: 5 },
    scope: h.context.scope,
    signal: h.context.signal,
    model,
    version: 'blind-v1',
    title: 'Course',
    sourceNotes: 'facts',
    sourceImageRefs: [],
    sourceTexts: trialEditableTexts(svg),
    visualConstraints: 'Academic',
    cases: [
      { label: 'A', svg, notes: 'facts', bytes: rendered.bytes },
      { label: 'B', svg, notes: 'facts', bytes: rendered.bytes },
    ],
  };
  h.chat.mockResolvedValue(reply({ cases: [score('A'), score('B')] }));
  return { ...h, ctx };
}

describe('real SVG / chat trial adapters', () => {
  it('rasterizes an actual SVG and decodes its pixels at the promised width', async () => {
    const h = fixture();
    const result = await h.adapters.render(h.context);
    const image = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(image.info).toMatchObject({ width: 1400, height: 788 });
    expect(new Set(image.data).size).toBeGreaterThan(10);
    expect(h.chat).not.toHaveBeenCalled();
  });
  it.each([
    '<script/>',
    '<s:script xmlns:s="http://www.w3.org/2000/svg"/>',
    '<image xmlns:link="http://www.w3.org/1999/xlink" link:href="file:///etc/passwd"/>',
    '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>',
    '<image href="file:///etc/passwd"/>',
    '<image href="https://example.org/evil.png"/>',
    '<rect onclick="attack()"/>',
    '<style>@import "https://example.org/x";</style>',
  ])('rejects active or external SVG before rendering: %s', async (content) => {
    const h = fixture();
    h.context.plan.slides[0].svg = svg.replace('</svg>', `${content}</svg>`);
    await expect(h.adapters.render(h.context)).rejects.toThrow('TRIAL_UNSAFE_SVG');
  });
  it('uses one real-port probe call, inherits notes and records measured tokens with reserved money', async () => {
    const h = fixture();
    expect(await h.adapters.probe(h.context)).toMatchObject({
      page: { svg, notes: 'facts' },
      usage: { tokens: 6, costMicros: 5, costBasis: 'reserved' },
    });
    expect(h.chat).toHaveBeenCalledOnce();
    expect(h.chat.mock.calls[0][0].max_tokens).toBe(100);
  });
  it('repairs the real overflowing probe before rendering while preserving the source plan', async () => {
    const h = fixture();
    h.context.plan.slides[0].svg = realPage.source.svg;
    h.chat.mockResolvedValue(reply({ svg: realPage.overflowSvg }));
    const output = await h.adapters.probe(h.context);
    expect(inspectTrialTextBounds(output.page.svg).status).toBe('passed');
    expect(trialEditableTexts(output.page.svg)).toEqual(trialEditableTexts(realPage.source.svg));
    expect(h.context.plan.slides[0].svg).toBe(realPage.source.svg);
    expect(h.chat).toHaveBeenCalledOnce();
  });
  it('does not let a model passed verdict waive the real text overflow', async () => {
    const h = await evaluationFixture();
    h.ctx.sourceTexts = trialEditableTexts(realPage.source.svg);
    h.ctx.cases[0].svg = realPage.source.svg;
    h.ctx.cases[1].svg = realPage.overflowSvg;
    for (const entry of h.ctx.cases) {
      const { bytes } = await h.adapters.render({
        ...h.context,
        plan: { ...h.context.plan, slides: [{ ...h.context.plan.slides[0], svg: entry.svg }] },
      });
      entry.bytes = bytes;
    }
    const output = await h.adapters.evaluate(h.ctx);
    expect(output.cases[0].gates.visual.status).toBe('passed');
    expect(output.cases[1].gates.facts.status).toBe('passed');
    expect(output.cases[1].gates.visual.status).toBe('failed');
  });
  it('rejects a model attempt to obtain more room by changing the page canvas', async () => {
    const h = fixture();
    h.chat.mockResolvedValue(reply({ svg: svg.replace('width="960"', 'width="1200"') }));
    await expect(h.adapters.probe(h.context)).rejects.toThrow('TRIAL_CANVAS_MISMATCH');
  });
  it('fails closed when the provider omits usage, without retrying', async () => {
    const h = fixture();
    h.chat.mockResolvedValue({ ...reply({ svg }), usage: undefined });
    await expect(h.adapters.probe(h.context)).rejects.toThrow('TRIAL_USAGE_UNAVAILABLE');
    expect(h.chat).toHaveBeenCalledOnce();
  });
  it('rejects malformed evaluator output without exposing provider text or retrying', async () => {
    const h = await evaluationFixture();
    h.chat.mockResolvedValue(reply({ cases: [{ label: 'A', score: 9 }] }));
    await expect(h.adapters.evaluate(h.ctx)).rejects.toThrow('TRIAL_EVALUATION_INVALID_OUTPUT');
    expect(h.chat).toHaveBeenCalledOnce();
  });
  it('rejects a model binding drift and a requested unsupported seed before calling a provider', async () => {
    const h = fixture();
    h.context.configuration.settings.models.planner = { ...model, seed: 4 };
    await expect(h.adapters.probe(h.context)).rejects.toThrow('TRIAL_MODEL_CONFIGURATION_MISMATCH');
    expect(h.chat).not.toHaveBeenCalled();
  });
  it('evaluates real pixels with anonymous labels, overriding model factual claims with deterministic gates', async () => {
    const h = await evaluationFixture();
    h.ctx.cases[1].svg = svg.replace('2026', '2027');
    const result = await h.adapters.evaluate(h.ctx);
    expect(result.cases[0].gates.facts.status).toBe('passed');
    expect(result.cases[1].gates.facts.status).toBe('failed');
    expect(result.cases[1].gates.editability.status).toBe('failed');
    const prompt = JSON.stringify(h.chat.mock.calls[0][0]);
    expect(prompt).not.toContain('configurationDigest');
    expect(prompt).not.toContain('capsule-');
    expect(prompt).not.toContain('<svg');
    expect(h.chat).toHaveBeenCalledOnce();
  });
  it('compares asset references with the frozen source, independent of anonymous order', async () => {
    const h = await evaluationFixture();
    h.ctx.sourceImageRefs = ['/api/runtime/presentation/artifacts/source'];
    const result = await h.adapters.evaluate(h.ctx);
    expect(result.cases.every((item) => item.gates.assets.status === 'failed')).toBe(true);
  });
  it('rejects duplicate anonymous labels and corrupt rendered bytes', async () => {
    const h = await evaluationFixture();
    h.chat.mockResolvedValue(reply({ cases: [score('A'), score('A')] }));
    await expect(h.adapters.evaluate(h.ctx)).rejects.toThrow('TRIAL_EVALUATION_IDENTITY');
    h.chat.mockResolvedValue(reply({ cases: [score('A'), score('B')] }));
    h.ctx.cases[1].bytes = new Uint8Array([137, 80, 78, 71]);
    await expect(h.adapters.evaluate(h.ctx)).rejects.toThrow();
  });
  it('cancels an active native render without publishing its bytes', async () => {
    const h = fixture();
    const controller = new AbortController();
    h.context.signal = controller.signal;
    const render = h.adapters.render(h.context);
    controller.abort();
    await expect(render).rejects.toThrow('TRIAL_CANCELLED');
  });
  it('makes cancellation prevent provider work', async () => {
    const h = await evaluationFixture();
    const controller = new AbortController();
    controller.abort();
    h.ctx.signal = controller.signal;
    await expect(h.adapters.evaluate(h.ctx)).rejects.toThrow('TRIAL_CANCELLED');
    expect(h.chat).not.toHaveBeenCalled();
  });
  it('keeps blind labeling reproducible while removing source order', () => {
    expect(anonymizeTrialIds(['baseline', 'candidate'], 'seed')).toEqual(
      anonymizeTrialIds(['candidate', 'baseline'], 'seed'),
    );
    expect(trialEditableTexts(svg.replace('Course 2026', 'Course <tspan>2026</tspan>'))).toEqual([
      'Course 2026',
    ]);
  });
});
