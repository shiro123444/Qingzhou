import { describe, expect, it } from 'vitest';

import {
  fingerprintPresentationAgentModelConfig,
  loadPresentationAgentModelConfig,
  PRESENTATION_AGENT_MODELS_ENV,
  PRESENTATION_AGENT_ROLES,
  type PresentationAgentModelConfig,
} from './agent-model-config';

const load = (value: unknown) =>
  loadPresentationAgentModelConfig({ [PRESENTATION_AGENT_MODELS_ENV]: JSON.stringify(value) });

describe('presentation agent model configuration', () => {
  it('keeps unconfigured deployments compatible without consulting process.env', () => {
    expect(loadPresentationAgentModelConfig()).toEqual({});
    expect(loadPresentationAgentModelConfig({ OTHER_SETTING: 'ignored' })).toEqual({});
    expect(load({})).toEqual({});
  });

  it('supports all role selections and catalog-specific identifiers with optional providers', () => {
    const config = load({
      content: { provider: 'account-provider', model: 'vendor/model-v4.1:fast' },
      planning: { model: 'reasoner@2026-11-17' },
      design: { model: 'vision/model-3+preview' },
      assets: { provider: 'custom.provider', model: 'visual-planner' },
      review: { model: 'independent-reviewer' },
      reference: { model: 'source-observer' },
      diagnosis: { model: 'gpt-debugger' },
    });
    expect(Object.keys(config)).toEqual(PRESENTATION_AGENT_ROLES);
    expect(config.content).toEqual({
      provider: 'account-provider',
      model: 'vendor/model-v4.1:fast',
    });
    expect(config.planning).toEqual({ model: 'reasoner@2026-11-17' });
  });

  it('returns independent deeply frozen selections and canonicalizes boundary whitespace', () => {
    const source = { content: { provider: '  custom  ', model: '  vendor/model  ' } };
    const config = load(source);
    source.content.model = 'other';
    expect(config.content).toEqual({ provider: 'custom', model: 'vendor/model' });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.content)).toBe(true);
    expect(Object.isFrozen(loadPresentationAgentModelConfig())).toBe(true);
  });

  it('rejects non-object mappings, unknown roles and extra fields instead of ignoring them', () => {
    for (const value of [
      null,
      [],
      'model',
      4,
      { author: { model: 'x' } },
      { review: null },
      { review: [] },
      { review: 'x' },
      { review: { model: 'x', apiKey: 'secret' } },
      { review: { model: 'x', baseUrl: 'https://other.test' } },
      JSON.parse('{"__proto__":{"model":"x"}}'),
    ])
      expect(() => load(value)).toThrowError(
        expect.objectContaining({ code: 'PRESENTATION_INVALID' }),
      );
  });

  it('rejects missing, blank, malformed and control-character identifiers', () => {
    for (const selection of [
      {},
      { model: null },
      { model: 42 },
      { model: '' },
      { model: '   ' },
      { model: 'model name' },
      { model: 'model\nname' },
      { model: 'model\u0000name' },
      { model: 'model\u200Bname' },
      { model: 'x', provider: '' },
      { model: 'x', provider: null },
    ])
      expect(() => load({ design: selection })).toThrowError(
        expect.objectContaining({ code: 'PRESENTATION_INVALID' }),
      );
    for (const raw of ['', '  ', '{', 'null', '[]'])
      expect(() =>
        loadPresentationAgentModelConfig({ [PRESENTATION_AGENT_MODELS_ENV]: raw }),
      ).toThrowError(expect.objectContaining({ code: 'PRESENTATION_INVALID' }));
  });

  it('does not expose rejected JSON or credentials in error messages or metadata', () => {
    const sensitive = 'private-value-that-must-not-be-logged';
    for (const raw of [
      `{"${sensitive}":`,
      JSON.stringify({ [sensitive]: { model: 'x' } }),
      JSON.stringify({ review: { model: 'x', [sensitive]: sensitive } }),
    ]) {
      try {
        loadPresentationAgentModelConfig({ [PRESENTATION_AGENT_MODELS_ENV]: raw });
        expect.unreachable('invalid configuration must fail');
      } catch (error) {
        expect(String(error)).not.toContain(sensitive);
        expect(JSON.stringify(error)).not.toContain(sensitive);
        expect((error as Error).cause).toBeUndefined();
      }
    }
  });

  it('fingerprints equivalent route maps equally and changes when a model or provider changes', () => {
    const first = load({
      review: { model: 'vision-review', provider: 'secondary' },
      content: { model: 'text' },
    });
    const reordered = load({
      content: { model: ' text ' },
      review: { provider: 'secondary', model: 'vision-review' },
    });
    const hash = fingerprintPresentationAgentModelConfig(first);
    expect(hash).toMatch(/^[a-f\d]{64}$/u);
    expect(fingerprintPresentationAgentModelConfig(reordered)).toBe(hash);
    for (const config of [
      { ...first, review: { model: 'different', provider: 'secondary' } },
      { ...first, review: { model: 'vision-review', provider: 'primary' } },
      { ...first, design: { model: 'vision-review', provider: 'secondary' } },
      {},
    ])
      expect(fingerprintPresentationAgentModelConfig(config)).not.toBe(hash);
    expect(fingerprintPresentationAgentModelConfig(loadPresentationAgentModelConfig())).toBe(
      fingerprintPresentationAgentModelConfig(load({})),
    );
    expect(() =>
      fingerprintPresentationAgentModelConfig({
        unknown: { model: 'x' },
      } as PresentationAgentModelConfig),
    ).toThrowError(expect.objectContaining({ code: 'PRESENTATION_INVALID' }));
  });
});
