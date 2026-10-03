import { resolve } from 'node:path';

import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import type {
  PresentationJobInput,
  PresentationPort,
  PresentationRunner,
} from '../../../../packages/cordis-kernel/src/presentation';
import { PresentationError } from '../../../../packages/cordis-kernel/src/presentation';
import { InMemoryPresentationArtifactStore } from './artifact-store';
import * as contentIntent from './content-intent';
import type { ProductionPresentationProvider } from './production-command';
import {
  PRODUCTION_PRESENTATION_ENV_KEYS,
  type ProductionPresentationEnv,
} from './production-config';
import type {
  PptMasterPortFactoryOptions,
  PptMasterPresentationScope,
  PptMasterProductionPortFactoryOptions,
  PptMasterProductionPresentationCompositionOptions,
} from './production-factory';
import {
  createPptMasterPresentationPortFactory,
  createPptMasterProductionPresentationComposition,
  createPptMasterProductionPresentationPortFactory,
  createProductionPresentationGenerationComposition,
} from './production-factory';

// Spying on an ESM export is impossible, so the module is wrapped while keeping the real one.
vi.mock('./content-intent', async (importOriginal) => {
  const actual = await importOriginal<typeof contentIntent>();
  return {
    ...actual,
    createPresentationContentCompiler: vi.fn(actual.createPresentationContentCompiler),
  };
});

const baseScope = (
  overrides: Partial<PptMasterPresentationScope> = {},
): PptMasterPresentationScope => ({
  userId: 'user-1',
  sessionId: 'session-1',
  serverDB: { handle: 'db-stub' } as unknown,
  request: new Request('https://example.test/api/runtime/presentation/jobs', { method: 'POST' }),
  ...overrides,
});

let runnerSequence = 0;

const makeRunner = (overrides: Partial<PresentationRunner> = {}): PresentationRunner => {
  runnerSequence += 1;
  return {
    id: 'ppt-master-runner',
    spawn: vi.fn(() => {
      throw new Error(`runner must not be invoked by factory assembly (${runnerSequence})`);
    }),
    ...overrides,
  };
};

let jobSequence = 0;

const baseOptions = (
  overrides: Partial<PptMasterPortFactoryOptions> = {},
): PptMasterPortFactoryOptions => {
  jobSequence += 1;
  const sequence = jobSequence;
  return {
    provider: 'ppt-master',
    runner: makeRunner(),
    idFactory: () => `job-${sequence}`,
    now: () => '2026-08-27T00:00:00.000Z',
    workspaceFactory: (jobId: string) => ({
      path: `/ws/${jobId}`,
      cleanup: async () => undefined,
    }),
    buildArgs: () => ['--out', 'deck.pptx'],
    ...overrides,
  };
};

const input: PresentationJobInput = {
  notebookId: 'nb-1',
  sourceVersionIds: ['v-1'],
  title: 'Deck',
};

/** Minimal OOXML-shaped bytes the kernel's PPTX validator accepts. */
const makePptxBytes = (): Uint8Array => {
  const name = '[Content_Types].xml';
  const header = new Uint8Array(30 + name.length + 8);
  header.set([80, 75, 3, 4], 0); // local file header signature
  header[26] = name.length & 255; // file name length (LE)
  header[27] = 0;
  header[28] = 0; // extra field length (LE)
  header[29] = 0;
  header.set(new TextEncoder().encode(name), 30);
  return header;
};

const pptxBytes = makePptxBytes();

/** Deterministic runner: materializes deck.pptx inside whatever workspace it gets. */
const workingRunner = (): PresentationRunner => ({
  id: 'ppt-master-runner',
  spawn: (request) => {
    const artifactPath = `${request.cwd}/deck.pptx`;
    return {
      result: Promise.resolve({
        exitCode: 0,
        stdout: '',
        stderr: '',
        artifacts: [{ path: artifactPath, bytes: pptxBytes, name: 'deck.pptx', type: 'pptx' }],
      }),
      cancel: () => undefined,
    };
  },
});

describe('C-33 PptMaster presentation port production factory', () => {
  it('connects the explicit production provider command seam without spawning during assembly', () => {
    const runner = makeRunner();
    const runnerFactory = vi.fn((_provider: ProductionPresentationProvider) => runner);
    const options: PptMasterProductionPortFactoryOptions = {
      productionProvider: {
        provider: 'ppt-master',
        command: ['node', '/opt/ppt-master/cli.mjs'],
        commandArgs: ['--quiet'],
        runnerId: 'ppt-master-runner',
        allowedRunnerIds: ['ppt-master-runner'],
      },
      runnerFactory,
    };

    const factory = createPptMasterProductionPresentationPortFactory(options);
    expect(runnerFactory).toHaveBeenCalledTimes(1);
    const provider = runnerFactory.mock.calls[0]![0];
    expect(provider.command).toEqual(['node', '/opt/ppt-master/cli.mjs']);
    expect(provider.commandArgs).toEqual(['--quiet']);
    expect(provider.allowedRunnerIds).toEqual(['ppt-master-runner']);
    expect(
      provider.buildArgv({
        operation: 'export',
        jobId: 'artifact-1:export:pptx',
        artifactId: 'artifact-1',
        format: 'pptx',
        workspacePath: '/ws/export-1',
      }),
    ).toContain(resolve('/ws/export-1', 'input.pptx'));

    const binding = factory(baseScope());
    expect(binding.port).toBeDefined();
    expect(runner.spawn).not.toHaveBeenCalled();
  });

  it('keeps a missing production provider as PROVIDER_UNAVAILABLE', () => {
    const runnerFactory = vi.fn(() => makeRunner());
    const factory = createPptMasterProductionPresentationPortFactory({
      productionProvider: {},
      runnerFactory,
    });

    expect(runnerFactory).not.toHaveBeenCalled();
    expect(() => factory(baseScope())).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    );
  });

  it('assembles a port per authenticated scope and echoes the scope verbatim', () => {
    const factory = createPptMasterPresentationPortFactory(baseOptions());
    const scope = baseScope();
    const binding = factory(scope);

    expect(binding.scope).toBe(scope);
    expect(binding.scope.request).toBe(scope.request);
    for (const method of [
      'createJob',
      'getJob',
      'cancelJob',
      'retryJob',
      'getArtifact',
      'readArtifactBytes',
      'exportArtifact',
      'dispose',
    ] as const) {
      expect(typeof binding.port[method]).toBe('function');
    }
  });

  it('keeps scope instances independent: jobs never leak across scopes or re-resolutions', async () => {
    const factory = createPptMasterPresentationPortFactory(
      baseOptions({
        runner: makeRunner({
          spawn: () => {
            throw new Error('provider exploded');
          },
        }),
      }),
    );
    const bindingA = factory(baseScope({ userId: 'user-a', sessionId: 'session-a' }));
    const bindingB = factory(baseScope({ userId: 'user-b', sessionId: 'session-b' }));

    const job = await bindingA.port.createJob(input);

    expect(job.state).toBe('failed'); // stub runner rejects; still scoped and honest
    await expect(bindingA.port.getJob(job.jobId)).resolves.toMatchObject({ jobId: job.jobId });
    await expect(bindingB.port.getJob(job.jobId)).resolves.toBe(null);

    // Assembly-only factory: every resolve is a fresh, independent instance.
    const bindingA2 = factory(baseScope({ userId: 'user-a', sessionId: 'session-a' }));
    await expect(bindingA2.port.getJob(job.jobId)).resolves.toBe(null);
    expect(bindingA2.port).not.toBe(bindingA.port);
  });

  it('honours the explicit runner allow-list and rejects mismatched runners at construction', () => {
    expect(() =>
      createPptMasterPresentationPortFactory(baseOptions({ allowedRunnerIds: ['other-runner'] })),
    ).toThrowError(PresentationError);

    try {
      createPptMasterPresentationPortFactory(baseOptions({ allowedRunnerIds: ['other-runner'] }));
    } catch (error) {
      expect((error as PresentationError).code).toBe('PRESENTATION_RUNNER_NOT_ALLOWED');
    }

    // Matching allow-list (including the kernel-compatible default [runner.id]) is fine.
    expect(() =>
      createPptMasterPresentationPortFactory(
        baseOptions({ allowedRunnerIds: ['ppt-master-runner'] }),
      ),
    ).not.toThrow();
    expect(() => createPptMasterPresentationPortFactory(baseOptions())).not.toThrow();
  });

  it('fails with stable codes when runner/provider/scope configuration is missing or forged', () => {
    // Missing runner → PROVIDER_UNAVAILABLE.
    try {
      createPptMasterPresentationPortFactory({
        provider: 'ppt-master',
      } as PptMasterPortFactoryOptions);
      throw new Error('expected missing runner to throw');
    } catch (error) {
      expect((error as PresentationError).code).toBe('PROVIDER_UNAVAILABLE');
    }

    // Shapeless runner object → PROVIDER_UNAVAILABLE.
    try {
      createPptMasterPresentationPortFactory({
        provider: 'ppt-master',
        runner: { nope: true } as unknown as PresentationRunner,
      });
      throw new Error('expected shapeless runner to throw');
    } catch (error) {
      expect((error as PresentationError).code).toBe('PROVIDER_UNAVAILABLE');
    }

    // Missing provider → PRESENTATION_INVALID.
    try {
      createPptMasterPresentationPortFactory({
        runner: makeRunner(),
      } as PptMasterPortFactoryOptions);
      throw new Error('expected missing provider to throw');
    } catch (error) {
      expect((error as PresentationError).code).toBe('PRESENTATION_INVALID');
      expect((error as PresentationError).path).toBe('provider');
    }

    // Forged scope fields → PRESENTATION_INVALID, per field.
    const factory = createPptMasterPresentationPortFactory(baseOptions());
    for (const broken of [
      baseScope({ userId: '' }),
      baseScope({ sessionId: '  ' }),
      baseScope({ serverDB: undefined }),
      baseScope({ request: 'not-a-request' as unknown as Request }),
    ]) {
      try {
        factory(broken);
        throw new Error('expected scope validation to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(PresentationError);
        expect((error as PresentationError).code).toBe('PRESENTATION_INVALID');
      }
    }
  });

  it('dispose() is idempotent, awaits the injected onDispose once, and stays mirrored on the port', async () => {
    const onDispose = vi.fn(async () => undefined);
    const factory = createPptMasterPresentationPortFactory(baseOptions({ onDispose }));
    const binding = factory(baseScope());

    await binding.dispose();
    await binding.dispose();
    await binding.port.dispose(); // same lifecycle hook, mirrored on the port
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(onDispose).toHaveBeenCalledWith(binding.port, binding.scope);
  });

  it('propagates real provider failures instead of faking ready/completed', async () => {
    const runner = makeRunner({
      spawn: vi.fn(() => {
        throw new Error('provider exploded');
      }),
    });
    const factory = createPptMasterPresentationPortFactory(baseOptions({ runner }));

    const job = await factory(baseScope()).port.createJob(input);

    expect(job.state).toBe('failed');
    expect(job.error).toMatchObject({ code: 'PPT_MASTER_FAILED' });
    expect(job.artifactIds).toBeUndefined();
    expect(runner.spawn).toHaveBeenCalledTimes(1);

    // No artifact can ever be ready without a real run.
    await expect(factory(baseScope()).port.getArtifact('job-1:0')).resolves.toBe(null);
  });

  it('injects workspace/buildArgs explicitly and the factory itself never executes the provider', async () => {
    const buildArgs = vi.fn(() => ['--out', 'deck.pptx']);
    const workspaceFactory = vi.fn((jobId: string) => ({
      path: `/ws/${jobId}`,
      cleanup: async () => undefined,
    }));
    const runner = makeRunner({
      spawn: vi.fn(() => {
        throw new Error('runner reached');
      }),
    });
    const factory = createPptMasterPresentationPortFactory(
      baseOptions({ runner, workspaceFactory, buildArgs }),
    );
    const binding = factory(baseScope());

    // Assembly touched nothing: no spawn, no workspace, no args yet.
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(workspaceFactory).not.toHaveBeenCalled();
    expect(buildArgs).not.toHaveBeenCalled();

    const job = await binding.port.createJob(input);

    // Provider-side resources engage only through port usage, via the
    // explicitly injected hooks, inside the kernel adapter's own flow.
    expect(workspaceFactory).toHaveBeenCalledWith(job.jobId);
    expect(buildArgs).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.jobId, workspacePath: `/ws/${job.jobId}` }),
    );
    expect(runner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'ppt-master',
        shell: false,
        args: ['--out', 'deck.pptx'],
      }),
    );
  });

  it('supports a real artifact flow end-to-end with honest completed/ready states', async () => {
    const factory = createPptMasterPresentationPortFactory(
      baseOptions({
        runner: workingRunner(),
        idFactory: () => 'job-e2e',
        workspaceFactory: (jobId: string) => ({
          path: `/ws/${jobId}`,
          cleanup: async () => undefined,
        }),
      }),
    );

    const port: PresentationPort = factory(baseScope()).port;
    const job = await port.createJob(input);

    expect(job.state).toBe('completed');
    expect(job.artifactIds).toEqual(['job-e2e:0']);
    await expect(port.getArtifact('job-e2e:0')).resolves.toMatchObject({
      status: 'ready',
      type: 'pptx',
      sizeBytes: pptxBytes.byteLength,
    });

    // Export flows through the same runner inside a fresh export workspace and
    // stores the exported artifact under its operation id.
    const exported = await port.exportArtifact('job-e2e:0', 'pptx');
    expect(exported).toMatchObject({
      artifactId: 'job-e2e:0:export:pptx',
      format: 'pptx',
    });
    await expect(port.getArtifact('job-e2e:0:export:pptx')).resolves.toMatchObject({
      status: 'ready',
      type: 'pptx',
    });
  });
});

const productionEnv = {
  [PRODUCTION_PRESENTATION_ENV_KEYS.provider]: 'ppt-master',
  [PRODUCTION_PRESENTATION_ENV_KEYS.command]: JSON.stringify(['node', '/opt/ppt/runner.js']),
  [PRODUCTION_PRESENTATION_ENV_KEYS.commandArgs]: JSON.stringify(['--quiet']),
  [PRODUCTION_PRESENTATION_ENV_KEYS.runnerId]: 'ppt-master-runner',
  [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds]: JSON.stringify(['ppt-master-runner']),
} as const;

const compositionOptions = (
  overrides: Partial<PptMasterProductionPresentationCompositionOptions> = {},
): PptMasterProductionPresentationCompositionOptions => ({
  env: productionEnv,
  runnerFactory: () => makeRunner(),
  ...overrides,
});

describe('C-77 production presentation composition wiring', () => {
  it('loads C-75 configuration, exposes safe readiness, and does not spawn at assembly', () => {
    const runner = makeRunner();
    const runnerFactory = vi.fn(() => runner);
    const workspaceFactory = vi.fn((jobId: string) => ({
      path: `/workspace/${jobId}`,
      cleanup: async () => undefined,
    }));
    const composition = createPptMasterProductionPresentationComposition(
      compositionOptions({ runnerFactory, workspaceFactory }),
    );

    expect(composition.readiness).toMatchObject({
      available: true,
      commandAvailable: true,
      provider: 'ppt-master',
      runnerId: 'ppt-master-runner',
    });
    expect(runnerFactory).toHaveBeenCalledTimes(1);
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(workspaceFactory).not.toHaveBeenCalled();
    expect(composition.portFactory(baseScope()).port).toBeDefined();
  });

  it('keeps missing configuration unavailable and never asks for a runner', () => {
    const runnerFactory = vi.fn(() => makeRunner());
    const composition = createPptMasterProductionPresentationComposition({
      env: {},
      runnerFactory,
    });

    expect(composition.readiness).toMatchObject({
      available: false,
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(runnerFactory).not.toHaveBeenCalled();
    expect(() => composition.portFactory(baseScope())).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    );
  });

  it('preserves C-75 invalid configuration and C-53 runner allow-list errors', () => {
    expect(() =>
      createPptMasterProductionPresentationComposition({
        ...compositionOptions(),
        env: {
          [PRODUCTION_PRESENTATION_ENV_KEYS.provider]: 'ppt-master',
          [PRODUCTION_PRESENTATION_ENV_KEYS.command]: '{',
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRESENTATION_INVALID' }));

    expect(() =>
      createPptMasterProductionPresentationComposition({
        ...compositionOptions(),
        env: {
          ...productionEnv,
          [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds]: JSON.stringify(['other-runner']),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRESENTATION_RUNNER_NOT_ALLOWED' }));
  });

  it('creates independent ports for authenticated scopes without sharing adapter state', async () => {
    const runner = makeRunner({
      spawn: vi.fn(() => {
        throw new Error('fake runner must not complete a provider job');
      }),
    });
    const composition = createPptMasterProductionPresentationComposition(
      compositionOptions({ runnerFactory: () => runner }),
    );
    const bindingA = composition.portFactory(
      baseScope({ userId: 'user-a', sessionId: 'session-a' }),
    );
    const bindingB = composition.portFactory(
      baseScope({ userId: 'user-b', sessionId: 'session-b' }),
    );

    expect(bindingA.port).not.toBe(bindingB.port);
    const jobA = await bindingA.port.createJob(input);

    await expect(bindingA.port.getJob(jobA.jobId)).resolves.toMatchObject({ jobId: jobA.jobId });
    await expect(bindingB.port.getJob(jobA.jobId)).resolves.toBe(null);
  });

  it('accepts an explicit scope/workspace dependency without executing it during composition', () => {
    const workspaceFactory = vi.fn((jobId: string) => ({
      path: `/workspace/${jobId}`,
      cleanup: async () => undefined,
    }));
    const composition = createPptMasterProductionPresentationComposition(
      compositionOptions({ workspaceFactory }),
    );

    composition.portFactory(baseScope({ userId: 'scoped-user', sessionId: 'scoped-session' }));

    expect(workspaceFactory).not.toHaveBeenCalled();
  });
});

describe('createProductionPresentationGenerationComposition (R2-A pipeline)', () => {
  const makeMockChatPort = () => ({
    chat: vi.fn(async (request: any) => ({
      choices: [
        {
          message: {
            content: JSON.stringify(
              request.messages[0].content.startsWith('你是演示内容编译器')
                ? {
                    slides: [1, 2].map((index) => ({
                      slideId: `slide-${index}`,
                      claim: '产品发布会',
                      formulas: [],
                      visualKind: index === 1 ? 'illustration' : 'none',
                      visualReason: '封面视觉和简短要点',
                      visuals:
                        index === 1
                          ? [
                              {
                                id: 'hero-img',
                                kind: 'illustration',
                                brief: '发布会主视觉',
                                required: true,
                              },
                            ]
                          : [],
                    })),
                  }
                : request.messages[0].content.includes('视觉总监')
                  ? { schemaVersion: 1, passed: true, issues: [], summary: '逐页审查通过' }
                  : {
                      aspectRatio: '16:9',
                      planId: 'plan-real-1',
                      slides: [
                        {
                          notes: '封面',
                          order: 1,
                          slideId: 'slide-1',
                          svg: '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><rect width="960" height="540" fill="#0f172a"/><text x="480" y="270" font-size="36" fill="#f8fafc" text-anchor="middle">产品发布会</text><image href="/api/runtime/presentation/artifacts/asset-hero-img" x="650" y="300" width="240" height="180"/></svg>',
                        },
                        {
                          notes: '核心亮点',
                          order: 2,
                          slideId: 'slide-2',
                          svg: '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><rect width="960" height="540" fill="#1e293b"/><text x="100" y="100" font-size="28" fill="#38bdf8">核心亮点</text></svg>',
                        },
                      ],
                      title: '产品发布会',
                    },
            ),
          },
        },
      ],
    })),
    manifest: { model: 'glm-5.3-flash', providerId: 'glm-multimodal' },
  });

  const makeMockImageCapability = () => ({
    generate: vi.fn(async (_scope: unknown, slots: any[]) => ({
      slots: slots.map((s) => ({
        assetRefs: [{ ref: `asset-${s.slotId}` }],
        slideId: s.slideId,
        slotId: s.slotId,
        state: 'ready' as const,
      })),
    })),
  });

  const validPipelineEnv: ProductionPresentationEnv = {
    [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds]: JSON.stringify(['ppt-master-runner']),
    [PRODUCTION_PRESENTATION_ENV_KEYS.command]: JSON.stringify([
      'python3',
      '/opt/ppt-master/run.py',
    ]),
    [PRODUCTION_PRESENTATION_ENV_KEYS.provider]: 'ppt-master',
    [PRODUCTION_PRESENTATION_ENV_KEYS.runnerId]: 'ppt-master-runner',
  };

  it('assembles generation pipeline without side-effects or network calls during construction', () => {
    const chatPort = makeMockChatPort();
    const imageCap = makeMockImageCapability();
    const result = createProductionPresentationGenerationComposition({
      imageGenerationCapability: imageCap as any,
      multimodalChatPort: chatPort as any,
    });

    expect(result.composition).toBeDefined();
    expect(result.readiness).toBeDefined();
    expect(chatPort.chat).not.toHaveBeenCalled();
    expect(imageCap.generate).not.toHaveBeenCalled();
  });

  it('passes one deck image budget to both the content compiler and the asset planner', () => {
    vi.mocked(contentIntent.createPresentationContentCompiler).mockClear();
    createProductionPresentationGenerationComposition({
      env: {
        ...validPipelineEnv,
        [PRODUCTION_PRESENTATION_ENV_KEYS.imageBudget]: '3',
      },
      imageGenerationCapability: makeMockImageCapability() as any,
      multimodalChatPort: makeMockChatPort() as any,
    });
    expect(vi.mocked(contentIntent.createPresentationContentCompiler)).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      { maxRasterVisuals: 3 },
    );

    vi.mocked(contentIntent.createPresentationContentCompiler).mockClear();
    createProductionPresentationGenerationComposition({
      env: validPipelineEnv,
      imageGenerationCapability: makeMockImageCapability() as any,
      multimodalChatPort: makeMockChatPort() as any,
    });
    expect(vi.mocked(contentIntent.createPresentationContentCompiler)).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      {},
    );
  });

  it('runs complete planner -> image provider -> worker -> artifact pipeline end-to-end', async () => {
    const chatPort = makeMockChatPort();
    const imageCap = makeMockImageCapability();
    const scope = baseScope({ userId: 'u-gen', sessionId: 's-gen' });
    const artifactStore = new InMemoryPresentationArtifactStore();
    await artifactStore.put(scope, {
      artifactId: 'asset-hero-img',
      name: 'hero.png',
      type: 'image',
      mimeType: 'image/png',
      bytes: await sharp({ create: { width: 80, height: 60, channels: 3, background: '#2563eb' } })
        .png()
        .toBuffer(),
    });
    const mockWorker = {
      run: vi.fn(async (plan: any, context: any) => {
        const artifacts = [
          {
            artifactId: `${context.jobId}:deck.pptx`,
            bytes: pptxBytes,
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            name: 'deck.pptx',
            type: 'pptx',
          },
          ...plan.slides.map((s: any) => ({
            artifactId: `${context.jobId}:${s.slideId}.svg`,
            bytes: new TextEncoder().encode(s.svg),
            mimeType: 'image/svg+xml',
            name: `${s.slideId}.svg`,
            type: 'svg',
          })),
        ];
        return {
          artifacts,
          jobId: context.jobId,
          planId: plan.planId,
          qualityReport: { passed: true, score: 98 },
        };
      }),
    };

    const { composition, readiness } = createProductionPresentationGenerationComposition({
      artifactStore,
      env: validPipelineEnv,
      imageGenerationCapability: imageCap as any,
      multimodalChatPort: chatPort as any,
      worker: mockWorker,
    });

    expect(readiness.state).toBe('configured');
    const generationPortFactory = composition.generationPortFactory!;
    expect(generationPortFactory).toBeDefined();

    const port = generationPortFactory(scope);

    // Create job with imageSlots
    const created = await port.createJob({
      notebookId: 'nb-prod',
      options: {
        imageSlots: [{ prompt: '发布会主视觉', slideId: 'slide-1', slotId: 'hero-img' }],
      },
      slideCount: 2,
      sourceVersionIds: ['v1'],
      title: '产品发布会',
    });

    expect(created.jobId).toBeTruthy();
    expect(created.state).toBe('queued');

    // Wait for background generation to finish
    await vi.waitFor(async () => {
      const job = await port.getJob(created.jobId);
      expect(job?.state, JSON.stringify(job?.error)).toBe('completed');
    });

    // Check image capability was called with normalized slots
    expect(imageCap.generate).toHaveBeenCalledWith(
      scope,
      [
        expect.objectContaining({
          idempotencyKey: expect.any(String),
          prompt: '发布会主视觉',
          slideId: 'slide-1',
          slotId: 'hero-img',
        }),
      ],
      expect.anything(),
    );

    // Check GLM chatPort was called to plan the presentation
    expect(chatPort.chat).toHaveBeenCalled();

    // Check worker executed and produced artifacts
    expect(mockWorker.run).toHaveBeenCalled();
    expect(mockWorker.run.mock.calls[0][0].slides[0].svg).toContain('data:image/png;base64,');
    expect(mockWorker.run.mock.calls[0][0].slides[0].metadata.visualAssets).toEqual([
      expect.objectContaining({ visualId: 'hero-img', kind: 'illustration', origin: 'generated' }),
    ]);

    // Verify job completed and all artifacts are readable
    const job = await port.getJob(created.jobId);
    expect(job).toMatchObject({
      jobId: created.jobId,
      state: 'completed',
    });
    expect(job?.artifactIds?.length).toBe(4); // image + pptx + 2 slide svgs

    const pptxArtifact = await port.getArtifact(`${created.jobId}:deck.pptx`);
    expect(pptxArtifact).toMatchObject({
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      name: 'deck.pptx',
      status: 'ready',
    });

    await composition.dispose();
  });

  it('fails with PROVIDER_UNAVAILABLE when image slots are requested but image capability is missing', async () => {
    const chatPort = makeMockChatPort();
    const { composition, readiness } = createProductionPresentationGenerationComposition({
      env: validPipelineEnv,
      multimodalChatPort: chatPort as any,
    });

    expect(readiness.state).toBe('configured');
    const port = composition.generationPortFactory!(baseScope());
    const job = await port.createJob({
      notebookId: 'nb-no-img',
      options: {
        imageSlots: [{ prompt: '未配置生图', slideId: 's1', slotId: 'img1' }],
      },
      sourceVersionIds: ['v1'],
      title: '无生图测试',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const failedJob = await port.getJob(job.jobId);
    expect(failedJob).toMatchObject({
      error: expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
      state: 'failed',
    });

    await composition.dispose();
  });

  it('fails-closed with PROVIDER_UNAVAILABLE when runner/provider is missing even if GLM and image are configured', async () => {
    const chatPort = makeMockChatPort();
    const imageCap = makeMockImageCapability();
    const { composition, readiness } = createProductionPresentationGenerationComposition({
      imageGenerationCapability: imageCap as any,
      multimodalChatPort: chatPort as any,
    });

    expect(readiness.state).toBe('unavailable');
    expect(composition.generationPortFactory).toBeUndefined();

    const scope = baseScope({ userId: 'u-fail', sessionId: 's-fail' });
    const req = new Request('https://example.test/api/runtime/presentation/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        notebookId: 'nb-fail',
        sourceVersionIds: ['v-fail'],
        title: '缺 provider 失败测试',
      }),
    });

    const response = await composition.generationHandler(req, scope);
    expect(response.status).toBe(503);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('PROVIDER_UNAVAILABLE');

    await composition.dispose();
  });
});
