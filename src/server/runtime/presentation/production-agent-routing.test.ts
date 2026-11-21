import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PresentationJobInput,
  PresentationPlan,
} from '../../../../packages/runtime-contracts/src';
import type { PresentationAgentExecution } from './agent-model-routing';
import { type MultimodalChatPort, MultimodalChatProviderError } from './multimodal-chat-provider';
import { createProductionPresentationGenerationComposition } from './production-factory';
import { FilePresentationTemplateLibrary } from './templates/library';
import type { TemplateVisualProfile } from './templates/visual-types';
import { presentationStoryboardInputFingerprint } from './visual-storyboard';

const scope = { sessionId: 'routing-session', userId: 'routing-user' };
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});
const input: PresentationJobInput = {
  notebookId: 'routing-proof',
  options: { outline: [{ title: '事实复核', keyPoints: ['批准事实保持不变'] }] },
  slideCount: 1,
  sourceVersionIds: [],
  title: '事实复核',
};
const authoredPlan: PresentationPlan = {
  aspectRatio: '16:9',
  planId: 'routing-plan',
  slides: [
    {
      notes: '批准事实保持不变。',
      order: 1,
      slideId: 'slide-1',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="#ffffff"/><text x="60" y="80" font-family="Arial" font-size="32">事实复核</text><text x="60" y="190" font-family="Arial" font-size="24">批准事实保持不变</text></svg>',
    },
  ],
  sourceVersionIds: [],
  title: '事实复核',
};
const content = {
  slides: [
    {
      claim: '事实复核',
      formulas: [],
      slideId: 'slide-1',
      visualKind: 'none',
      visualReason: '编辑文字即可呈现批准事实',
      visuals: [],
    },
  ],
};
const reviewed = { issues: [], passed: true, schemaVersion: 1, summary: '事实和版式通过独立复核' };
const family = {
  artwork: 'No raster artwork',
  composition: 'Editable title over editable body',
  id: 'plain',
  name: 'Plain',
  pages: [1],
  palette: ['#ffffff', '#111111'],
  preserve: ['Left alignment'],
  typography: 'Simple sans serif',
};
const observation = {
  components: [],
  families: [family],
  guidance: 'Preserve editable content and clear spacing.',
  questions: [],
  summary: 'A plain editable source layout.',
};
const makePort = (
  model: string,
  output: () => unknown,
): MultimodalChatPort & { chat: ReturnType<typeof vi.fn<MultimodalChatPort['chat']>> } => ({
  chat: vi.fn<MultimodalChatPort['chat']>(async () => ({
    choices: [{ index: 0, message: { content: JSON.stringify(output()), role: 'assistant' } }],
    created: 1,
    id: `${model}-response`,
    model: `${model}-actual`,
  })),
  manifest: {
    displayName: model,
    model,
    providerId: model,
    supportsIdempotency: true,
    supportsVision: true,
  },
  providerId: model,
});

describe('production presentation specialist routing', () => {
  it.each(['content', 'design'] as const)(
    'does not send a failed explicit %s specialist to another role',
    async (role) => {
      const failure = new MultimodalChatProviderError(
        'CHAT_PAYLOAD_INVALID',
        'Specialist response unavailable',
      );
      const specialist = makePort('specialist', () => ({}));
      specialist.chat.mockRejectedValue(failure);
      const other = makePort('other-role', () => (role === 'content' ? content : authoredPlan));
      const legacyVision = makePort('legacy-vision', () => content);
      const inbox = makePort('inbox', () => content);
      const { composition } = createProductionPresentationGenerationComposition({
        agentChatPorts:
          role === 'content'
            ? { content: specialist, design: other }
            : { content: other, design: specialist },
        multimodalChatPort: inbox,
        visionChatPort: legacyVision,
      });
      try {
        const operation = role === 'content' ? 'presentation.content.compile' : 'presentation.plan';
        await expect(
          composition.atomicRuntime!.invoke(operation, { input }, { scope }),
        ).rejects.toBe(failure);
        expect(specialist.chat).toHaveBeenCalledOnce();
        expect(other.chat).not.toHaveBeenCalled();
        expect(legacyVision.chat).not.toHaveBeenCalled();
        expect(inbox.chat).not.toHaveBeenCalled();
      } finally {
        await composition.dispose();
      }
    },
  );

  it('runs real template observation, content, storyboard, authoring, asset planning and review through independent specialists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ppt-agent-routing-'));
    directories.push(root);
    const library = new FilePresentationTemplateLibrary({ root });
    const source = await library.learnFromPlan(scope, { name: 'Source', plan: authoredPlan });
    const fallback = makePort('unused-inbox', () => {
      throw new Error('A configured specialist must not use the inbox');
    });
    const contentPort = makePort('content-specialist', () => content);
    const designPort = makePort('design-specialist', () => authoredPlan);
    const assetsPort = makePort('assets-specialist', () => ({ intents: [] }));
    const reviewPort = makePort('review-specialist', () => reviewed);
    const referencePort = makePort('reference-specialist', () => observation);
    let story: unknown;
    const planningPort = makePort('planning-specialist', () => story);
    const receipts: PresentationAgentExecution[] = [];
    const { composition } = createProductionPresentationGenerationComposition({
      agentChatPorts: {
        assets: assetsPort,
        content: contentPort,
        design: designPort,
        planning: planningPort,
        reference: referencePort,
        review: reviewPort,
      },
      multimodalChatPort: fallback,
      onAgentExecution: (receipt) => {
        receipts.push(receipt);
      },
      templateLibrary: library,
    });
    try {
      const runtime = composition.atomicRuntime!;
      const visual = await runtime.invoke<TemplateVisualProfile>(
        'presentation.template.analyzeVisual',
        { templateId: source.templateId, versionId: source.versionId },
        { scope },
      );
      expect(visual.model).toBe('reference-specialist-actual');
      expect(visual.pages).toHaveLength(1);
      const template = await library.resolve(scope, {
        templateId: source.templateId,
        versionId: source.versionId,
      });
      const compiled = await runtime.invoke('presentation.content.compile', { input }, { scope });
      const approvedInput = { ...input, options: { ...input.options, contentIntents: compiled } };
      const archetype = template.visual!.designProgram.archetypes[0];
      story = {
        deckRationale: 'Keep one fact legible',
        inputFingerprint: presentationStoryboardInputFingerprint(approvedInput),
        rhythm: ['Plain text'],
        schemaVersion: 1,
        slides: [
          {
            archetypeId: archetype.id,
            assetMode: 'native',
            componentIds: [],
            compositionIntent: 'Title above approved body',
            continuity: 'Keep shared spacing',
            familyId: family.id,
            layoutId: template.layouts[0].layoutId,
            role: archetype.roles[0],
            slideId: 'slide-1',
          },
        ],
        templateId: template.templateId,
        versionId: template.versionId,
      };
      const mapped = await runtime.invoke(
        'presentation.template.mapDeck',
        { jobInput: approvedInput, template },
        { scope },
      );
      expect(mapped).toMatchObject({ slides: [{ slideId: 'slide-1' }] });
      const plan = await runtime.invoke<PresentationPlan>(
        'presentation.plan',
        { input: approvedInput },
        { scope },
      );
      expect(plan.slides[0].svg).toContain('批准事实保持不变');
      await runtime.invoke(
        'presentation.assets.prepare',
        {
          jobInput: approvedInput,
          basePlan: plan,
          revision: {
            content: '保持当前原生文字，不新增素材',
            requestId: 'inspect-assets',
            target: { type: 'deck' },
          },
        },
        { scope, jobId: 'routing-job' },
      );
      const review = await runtime.invoke(
        'presentation.template.reviewDeck',
        { plan, template },
        { scope },
      );
      expect(review).toMatchObject({ passed: true, issues: [] });
      for (const port of [
        contentPort,
        planningPort,
        designPort,
        assetsPort,
        reviewPort,
        referencePort,
      ])
        expect(port.chat).toHaveBeenCalled();
      expect(fallback.chat).not.toHaveBeenCalled();
      expect(new Set(receipts.map(({ role }) => role))).toEqual(
        new Set(['reference', 'content', 'planning', 'design', 'assets', 'review']),
      );
      for (const receipt of receipts) {
        expect(receipt.model).toBe(`${receipt.role}-specialist-actual`);
        expect(receipt.route).toBe('explicit');
        expect(receipt.status).toBe('completed');
      }
      const referenceImages = referencePort.chat.mock.calls[0][0].messages.flatMap(({ content }) =>
        typeof content === 'string' ? [] : content.filter(({ type }) => type === 'image_url'),
      );
      expect(referenceImages.length).toBeGreaterThan(0);
    } finally {
      await composition.dispose();
    }
  });

  it('retains the legacy default model when specialist configuration is absent', async () => {
    const outputs = [content, authoredPlan, reviewed];
    const fallback = makePort('existing-inbox', () => outputs.shift());
    const receipts: PresentationAgentExecution[] = [];
    const { composition } = createProductionPresentationGenerationComposition({
      multimodalChatPort: fallback,
      onAgentExecution: (receipt) => {
        receipts.push(receipt);
      },
    });
    try {
      const runtime = composition.atomicRuntime!;
      const compiled = await runtime.invoke('presentation.content.compile', { input }, { scope });
      const plan = await runtime.invoke<PresentationPlan>(
        'presentation.plan',
        { input: { ...input, options: { ...input.options, contentIntents: compiled } } },
        { scope },
      );
      await expect(
        runtime.invoke('presentation.template.reviewDeck', { plan }, { scope }),
      ).resolves.toMatchObject({ passed: true });
      expect(fallback.chat).toHaveBeenCalledTimes(3);
      expect(receipts.map(({ role }) => role)).toEqual(['content', 'design', 'review']);
      expect(receipts.every(({ model }) => model === 'existing-inbox-actual')).toBe(true);
      expect(receipts.every(({ route }) => route === 'default')).toBe(true);
    } finally {
      await composition.dispose();
    }
  });
});
