import {
  harnessData,
  harnessDigest,
  type SkillMaterialBinding,
  type SkillMaterialManifest,
  type SkillMaterialReceipt,
} from '@lobechat/agent-runtime';
import type { SkillMeta } from '@lobechat/context-engine';

const fail = (code: string) => new Error(`HARNESS_MATERIAL_${code}`);
const bytes = (text: string) => new TextEncoder().encode(text).length;
const key = (m: SkillMaterialManifest) => `${m.id}@${m.implementationVersion}`;
export interface SkillMaterialProvider {
  labelKey: 'harness.materialRaw' | 'harness.materialSections';
  manifest: SkillMaterialManifest;
  render: (source: { identifier: string; content: string }, signal: AbortSignal) => string;
}
export interface SkillMaterialLease {
  apply: (
    skills: SkillMeta[],
    signal?: AbortSignal,
  ) => Promise<{
    skills: SkillMeta[];
    receipt: SkillMaterialReceipt;
  }>;
  release: () => void;
}
/** Trusted registration only. A version cannot be replaced while its key remains registered. */
export class SkillMaterialRegistry {
  private providers = new Map<
    string,
    { provider: SkillMaterialProvider; leases: number; active: number; retired?: boolean }
  >();
  register(provider: SkillMaterialProvider) {
    const m = provider.manifest;
    if (
      !/^[a-z][a-z0-9.-]{0,63}$/u.test(m.id) ||
      !/^\d+\.\d+\.\d+$/u.test(m.implementationVersion) ||
      m.contractVersion !== 1 ||
      m.kind !== 'skill-material' ||
      m.effects !== 'pure' ||
      m.cancellation !== 'cooperative' ||
      m.usage !== 'local-bytes' ||
      m.replay !== 'deterministic' ||
      JSON.stringify(m.surfaces) !== '["context.skillMaterial"]' ||
      JSON.stringify(harnessData(m.configurationSchema)) !==
        JSON.stringify(harnessData({ type: 'object', additionalProperties: false })) ||
      typeof provider.render !== 'function'
    )
      throw fail('CONTRACT');
    if (this.providers.has(key(m))) throw fail('DUPLICATE_VERSION');
    const saved = { ...provider, manifest: structuredClone(m) };
    this.providers.set(key(m), { provider: saved, leases: 0, active: 0 });
  }
  options() {
    return [...this.providers.values()]
      .filter((entry) => !entry.retired)
      .map(({ provider }) => ({
        value: key(provider.manifest),
        labelKey: provider.labelKey,
      }));
  }
  candidateBinding(value: string): SkillMaterialBinding {
    if (this.providers.get(value)?.retired) throw fail('RETIRED');
    return this.binding(value);
  }
  binding(value: string): SkillMaterialBinding {
    const entry = this.providers.get(value);
    if (!entry) throw fail('UNAVAILABLE');
    return { manifest: structuredClone(entry.provider.manifest), configuration: {} };
  }
  acquire(binding: SkillMaterialBinding): SkillMaterialLease {
    const entry = binding?.manifest && this.providers.get(key(binding.manifest));
    if (!entry) throw fail('UNAVAILABLE');
    if (
      JSON.stringify(harnessData(binding)) !==
      JSON.stringify(harnessData(this.binding(key(binding.manifest))))
    )
      throw fail('CONTRACT');
    const pinned = structuredClone(binding);
    entry.leases++;
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          entry.leases--;
        }
      },
      apply: async (skills, signal = new AbortController().signal) => {
        if (released) throw fail('LEASE_CLOSED');
        entry.active++;
        try {
          signal.throwIfAborted();
          const receipt: SkillMaterialReceipt = {
            binding: structuredClone(pinned),
            inputBytes: 0,
            outputBytes: 0,
            modelCalls: 0,
            sources: [],
          };
          const result: SkillMeta[] = [];
          for (const skill of skills) {
            if (released) throw fail('LEASE_CLOSED');
            signal.throwIfAborted();
            // Only the C-qualified, activated immutable managed text enters this contract.
            if (!skill.activated || !skill.revision || skill.content === undefined) {
              result.push(skill);
              continue;
            }
            const source = { identifier: skill.identifier, content: skill.content };
            receipt.inputBytes += bytes(source.content);
            if (receipt.inputBytes > 262144 || receipt.sources.length >= 64)
              throw fail('INPUT_LIMIT');
            const content = entry.provider.render(Object.freeze(source), signal);
            signal.throwIfAborted();
            if (typeof content !== 'string') throw fail('CONTRACT');
            receipt.outputBytes += bytes(content);
            if (receipt.outputBytes > 1048576) throw fail('OUTPUT_LIMIT');
            receipt.sources.push({
              identifier: skill.identifier,
              inputDigest: await harnessDigest(source.content),
              outputDigest: await harnessDigest(content),
            });
            result.push({ ...skill, content });
          }
          signal.throwIfAborted();
          if (released) throw fail('LEASE_CLOSED');
          return { skills: result, receipt };
        } finally {
          entry.active--;
        }
      },
    };
  }
  retire(value: string) {
    const entry = this.providers.get(value);
    if (entry && (entry.leases || entry.active)) throw fail('IN_USE');
    if (entry) entry.retired = true;
  }
}
const manifest = (id: string): SkillMaterialManifest => ({
  id,
  implementationVersion: '1.0.0',
  contractVersion: 1,
  kind: 'skill-material',
  effects: 'pure',
  cancellation: 'cooperative',
  usage: 'local-bytes',
  replay: 'deterministic',
  configurationSchema: { type: 'object', additionalProperties: false },
  surfaces: ['context.skillMaterial'],
});
export const rawSkillMaterial: SkillMaterialProvider = {
  manifest: manifest('skills.raw'),
  labelKey: 'harness.materialRaw',
  render: (source) => source.content,
};
/** Lossless segmentation: fence contents and every original character remain in source order. */
export const sectionedSkillMaterial: SkillMaterialProvider = {
  manifest: manifest('skills.sections'),
  labelKey: 'harness.materialSections',
  render(source, signal) {
    const sections: { content: string }[] = [];
    let chunk = '',
      fence: { character: string; count: number } | undefined;
    for (const line of source.content.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
      signal.throwIfAborted();
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
      if (marker && !fence) fence = { character: marker[0], count: marker.length };
      else if (
        marker &&
        fence &&
        marker[0] === fence.character &&
        marker.length >= fence.count &&
        line.trim() === marker
      )
        fence = undefined;
      if (!fence && /^#{1,6} /u.test(line) && chunk) {
        sections.push({ content: chunk });
        chunk = '';
      }
      chunk += line;
    }
    if (chunk) sections.push({ content: chunk });
    return JSON.stringify({
      format: 'qingzhou.skill-sections.v1',
      identifier: source.identifier,
      sections,
    });
  },
};
export function createSkillMaterialRegistry() {
  const registry = new SkillMaterialRegistry();
  registry.register(rawSkillMaterial);
  registry.register(sectionedSkillMaterial);
  return registry;
}
export const skillMaterialRegistry = createSkillMaterialRegistry();
/** Older revisions have the original raw semantics, never a moving latest alias. */
export const skillMaterialBinding = (policy: unknown): SkillMaterialBinding =>
  (policy as { skillMaterial?: SkillMaterialBinding } | undefined)?.skillMaterial ?? {
    manifest: structuredClone(rawSkillMaterial.manifest),
    configuration: {},
  };
