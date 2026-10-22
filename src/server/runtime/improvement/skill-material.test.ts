// @vitest-environment node
import {
  bindHarnessRun,
  createHarnessRevision,
  resolveHarnessMaterial,
  harnessDigest,
} from '@lobechat/agent-runtime';
import { LoadedProfile } from '@lobechat/cordis-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChatProbePort } from './chat-probe';
import { contextStrategyComposition } from './context-strategy';
import { applyHarnessPatch } from './coordinator';
import {
  createSkillMaterialRegistry,
  rawSkillMaterial,
  sectionedSkillMaterial,
  skillMaterialBinding,
  type SkillMaterialProvider,
} from './skill-material';

const scope = { userId: 'owner', agentId: 'agent' };
const content =
  '---\r\nname: procedure\r\ndescription: Evidence\r\n---\r\nPreamble\r\n# First\r\nKeep this.\r\n```md\r\n# Not a section\r\n```\r\n## Second\r\n</skill>{"fake":"delimiter"} 中文';
const skill = {
  identifier: 'managed-skill:one',
  name: 'procedure',
  description: 'Evidence',
  activated: true,
  content,
  revision: {
    bindingId: 'one',
    scope,
    sourceKind: 'managed-document',
    contentDigest: await harnessDigest(content),
  } as any,
};
const roots: LoadedProfile[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((p) => p.dispose()));
});
function host(registry = createSkillMaterialRegistry(), value = 'skills.sections@1.0.0') {
  const composition = contextStrategyComposition(
    'standard',
    true,
    registry.binding(value),
    registry,
  );
  const profile = new LoadedProfile({
    modules: composition.modules!,
    profile: composition.profile!,
    bundles: { agent: { entries: [] }, ...composition.bundles },
  });
  roots.push(profile);
  return profile;
}
async function revision(binding = skillMaterialBinding(undefined)) {
  return createHarnessRevision(
    scope,
    {
      agentConfig: { systemRole: 'Author instructions' },
      configurationComplete: true,
      modelRuntimeConfig: { model: 'model', provider: 'provider' },
      operationSkillSet: { skills: [skill], enabledPluginIds: [] },
      contextPolicy: { promptStrategy: 'standard', skillMaterial: binding },
    },
    2,
  );
}
describe('versioned skill material provider qualification', () => {
  it('holds a retiring provider until already-started material work drains', async () => {
    const registry = createSkillMaterialRegistry(),
      lease = registry.acquire(registry.binding('skills.sections@1.0.0'));
    const pending = lease.apply([skill]);
    lease.release();
    expect(() => registry.retire('skills.sections@1.0.0')).toThrow('IN_USE');
    await expect(pending).rejects.toThrow('LEASE_CLOSED');
    expect(() => registry.retire('skills.sections@1.0.0')).not.toThrow();
  });
  it('preserves all original characters, fences and source order while changing the actual model representation', async () => {
    const profile = host();
    const result = await profile.run((ctx) => ctx.get('qingzhou.context.skill-material')!([skill]));
    const parsed = JSON.parse(result.skills[0].content!);
    expect(parsed.format).toBe('qingzhou.skill-sections.v1');
    expect(parsed.sections).toHaveLength(3);
    expect(parsed.sections.map((section: any) => section.content).join('')).toBe(content);
    expect(result.receipt).toMatchObject({
      modelCalls: 0,
      binding: { manifest: { effects: 'pure', usage: 'local-bytes' } },
    });
    expect(result.receipt.inputBytes).toBe(new TextEncoder().encode(content).length);
    expect(result.receipt.sources[0].inputDigest).not.toBe(result.receipt.sources[0].outputDigest);
    expect(skill.content).toBe(content);
  });
  it('leaves unactivated, builtin and account skills untouched', async () => {
    const lease = createSkillMaterialRegistry().acquire(skillMaterialBinding(undefined));
    try {
      const skills = [
        { ...skill, activated: false },
        { ...skill, revision: undefined },
      ];
      expect((await lease.apply(skills)).skills).toEqual(skills);
      expect((await lease.apply(skills)).receipt.sources).toEqual([]);
    } finally {
      lease.release();
    }
  });
  it('holds native Profile leases, forbids replacement and retirement in use, and fails explicitly when an old version is missing', async () => {
    const registry = createSkillMaterialRegistry();
    const old = registry.binding('skills.sections@1.0.0');
    const profile = host(registry);
    await profile.ready;
    expect(() => registry.register(sectionedSkillMaterial)).toThrow('DUPLICATE_VERSION');
    expect(() => registry.retire('skills.sections@1.0.0')).toThrow('IN_USE');
    registry.register({
      ...sectionedSkillMaterial,
      manifest: { ...sectionedSkillMaterial.manifest, implementationVersion: '2.0.0' },
      render: () => 'New representation',
    });
    const oldResult = await profile.run((ctx) =>
      ctx.get('qingzhou.context.skill-material')!([skill]),
    );
    expect(JSON.parse(oldResult.skills[0].content!).format).toBe('qingzhou.skill-sections.v1');
    const newer = host(registry, 'skills.sections@2.0.0');
    expect(
      (await newer.run((ctx) => ctx.get('qingzhou.context.skill-material')!([skill]))).skills[0]
        .content,
    ).toBe('New representation');
    await profile.dispose();
    registry.retire('skills.sections@1.0.0');
    const restored = registry.acquire(old);
    await expect(restored.apply([skill])).resolves.toBeDefined();
    restored.release();
    expect(registry.options().some((entry) => entry.value === 'skills.sections@1.0.0')).toBe(false);
    expect(() => registry.candidateBinding('skills.sections@1.0.0')).toThrow('RETIRED');
    expect(() =>
      registry.acquire({ ...old, manifest: { ...old.manifest, implementationVersion: '9.0.0' } }),
    ).toThrow('UNAVAILABLE');
  });
  it.each(['configuration', 'effects', 'contractVersion'] as const)(
    'rejects changed %s instead of trusting a stored manifest',
    (change) => {
      const registry = createSkillMaterialRegistry(),
        binding: any = registry.binding('skills.raw@1.0.0');
      if (change === 'configuration') binding.configuration = { script: 'not executable' };
      else binding.manifest[change] = change === 'effects' ? 'network' : 2;
      expect(() => registry.acquire(binding)).toThrow('CONTRACT');
    },
  );
  it('bounds input/output bytes and cooperates with cancellation before returning materials', async () => {
    const registry = createSkillMaterialRegistry();
    const lease = registry.acquire(registry.binding('skills.sections@1.0.0'));
    const abort = new AbortController();
    abort.abort();
    try {
      await expect(lease.apply([skill], abort.signal)).rejects.toThrow();
      await expect(lease.apply([{ ...skill, content: 'x'.repeat(262145) }])).rejects.toThrow(
        'INPUT_LIMIT',
      );
    } finally {
      lease.release();
    }
    const huge: SkillMaterialProvider = {
      ...rawSkillMaterial,
      manifest: { ...rawSkillMaterial.manifest, id: 'skills.huge' },
      render: () => 'x'.repeat(1048577),
    };
    registry.register(huge);
    const bounded = registry.acquire(registry.binding('skills.huge@1.0.0'));
    try {
      await expect(bounded.apply([skill])).rejects.toThrow('OUTPUT_LIMIT');
    } finally {
      bounded.release();
    }
    await expect(bounded.apply([skill])).rejects.toThrow('LEASE_CLOSED');
  });
  it('compiles the selected representation through the real probe, keeps selection neutral, and records local usage without another model call', async () => {
    const base = await revision(),
      candidate = await applyHarnessPatch(base, {
        baseRevisionId: base.id,
        surface: 'context.skillMaterial',
        value: 'skills.sections@1.0.0',
      });
    const requests: any[] = [];
    const chat = vi.fn(async (payload, options) => {
      requests.push(payload);
      options.callback.onText('Fixture answer');
      return new Response('');
    });
    const port = createChatProbePort({
      model: 'model',
      provider: 'provider',
      runtime: { chat },
      activatedSkillIds: [skill.identifier],
    });
    const invoke = (
      rev: typeof base,
      purpose: 'answer' | 'selection' = 'answer',
      maxInputBytes?: number,
    ) =>
      port.complete({
        revision: rev,
        system: purpose === 'answer' ? 'Author instructions' : 'Compare these answers',
        prompt: 'A representative task',
        maxTokens: 128,
        signal: new AbortController().signal,
        purpose,
        maxInputBytes,
      });
    const baseline = await invoke(base),
      improved = await invoke(candidate);
    await invoke(candidate, 'selection');
    expect(JSON.stringify(requests[0].messages)).not.toContain('qingzhou.skill-sections.v1');
    expect(JSON.stringify(requests[1].messages)).toContain('qingzhou.skill-sections.v1');
    expect(JSON.stringify(requests[1].messages)).toContain('Not a section');
    expect(JSON.stringify(requests[2].messages)).not.toContain('Not a section');
    expect(baseline.materialReceipt?.binding.manifest.id).toBe('skills.raw');
    expect(improved.materialReceipt?.binding.manifest.id).toBe('skills.sections');
    expect(chat).toHaveBeenCalledTimes(3);
    await expect(invoke(candidate, 'answer', 10)).rejects.toThrow();
    expect(chat).toHaveBeenCalledTimes(3);
    const captured = await bindHarnessRun(base, 'existing', {
      agentConfig: base.material.agentConfig,
      promptSegments: [{ kind: 'author', content: 'Author instructions' }],
      contextPolicy: candidate.material.contextPolicy,
    });
    expect((resolveHarnessMaterial(captured).contextPolicy as any).skillMaterial.manifest.id).toBe(
      'skills.raw',
    );
  });
  it('does not dispatch a model request when a provider cancels during material parsing', async () => {
    const registry = createSkillMaterialRegistry(),
      controller = new AbortController();
    registry.register({
      ...rawSkillMaterial,
      manifest: { ...rawSkillMaterial.manifest, id: 'skills.cancel' },
      render: () => {
        controller.abort();
        return 'late';
      },
    });
    const base = await revision(registry.binding('skills.cancel@1.0.0'));
    const chat = vi.fn();
    const port = createChatProbePort({
      model: 'model',
      provider: 'provider',
      runtime: { chat },
      materialRegistry: registry,
      activatedSkillIds: [skill.identifier],
    });
    await expect(
      port.complete({
        system: '',
        prompt: 'task',
        maxTokens: 128,
        revision: base,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(chat).not.toHaveBeenCalled();
    registry.retire('skills.cancel@1.0.0');
  });
});
