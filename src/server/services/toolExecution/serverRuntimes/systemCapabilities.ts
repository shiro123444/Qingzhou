import { createHash } from 'node:crypto';

import { AgentModel } from '@/database/models/agent';
import { toolsEnv } from '@/envs/tools';
import { presentationAccountScope } from '@/server/runtime/presentation/account-workspace';
import type { PresentationGenerationPort } from '@/server/runtime/presentation/generation-port';
import { AgentService } from '@/server/services/agent';
import { FileService } from '@/server/services/file';
import { SearchService } from '@/server/services/search';

import { createSystemCapabilityTools } from '../systemCapabilities';
import { SystemCapabilityFileService } from '../systemCapabilityFiles';
import { SystemCapabilityIdentifier } from '../systemCapabilityManifest';
import type { ServerRuntimeRegistration } from './types';

export const systemCapabilitiesRuntime: ServerRuntimeRegistration = {
  identifier: SystemCapabilityIdentifier,
  factory: async (context) => {
    if (!context.userId || !context.serverDB || !context.agentId || !context.topicId)
      throw new Error('Authenticated agent scope required for system capabilities');
    const agent = await new AgentService(context.serverDB, context.userId).getAgentConfig(
      context.agentId,
    );
    if (!agent?.plugins?.includes(SystemCapabilityIdentifier))
      throw new Error('System capabilities are not enabled for this agent');
    const presentationConfigured = !!process.env.CORDIS_PPT_MASTER_ROOT;
    let presentation: Promise<PresentationGenerationPort> | undefined;
    const loadPresentation = () => {
      assertActive();
      presentation ??= import('@/server/runtime/presentation/default-composition')
        .then(({ getDefaultPresentationComposition }) => {
          assertActive();
          const { composition } = getDefaultPresentationComposition();
          const port = composition?.generationPortFactory?.({
            ...presentationAccountScope(context.userId!),
            request: new Request('http://presentation.internal/channel'),
          });
          if (!port)
            throw new Error('Presentation provider unavailable; check the host configuration');
          return port;
        })
        .catch((error) => {
          presentation = undefined;
          throw error;
        });
      return presentation;
    };
    const assertActive = () => {
      context.assertStepLease?.();
      context.signal?.throwIfAborted();
    };
    const accountFiles = new SystemCapabilityFileService(
      context.serverDB,
      context.userId,
      assertActive,
    );
    const search =
      toolsEnv.SEARCH_PROVIDERS || toolsEnv.SEARXNG_URL ? new SearchService() : undefined;
    // TaskService imports the agent executor; discovery must not initialize it either.
    let taskPromise: Promise<SystemCapabilityTaskRuntime> | undefined;
    type SystemCapabilityTaskRuntime = {
      createTask: (args: { name: string; instruction: string }) => Promise<unknown>;
      listTasks: (args: { limit?: number }) => Promise<unknown>;
    };
    const loadTasks = () => {
      assertActive();
      taskPromise ??= import('./task')
        .then(({ taskRuntime }) => {
          assertActive();
          return taskRuntime.factory(context) as SystemCapabilityTaskRuntime;
        })
        .catch((error) => {
          taskPromise = undefined;
          throw error;
        });
      return taskPromise;
    };
    const tasks: SystemCapabilityTaskRuntime = {
      createTask: async (args) => {
        const runtime = await loadTasks();
        assertActive();
        return runtime.createTask(args);
      },
      listTasks: async (args) => {
        const runtime = await loadTasks();
        assertActive();
        return runtime.listTasks(args);
      },
    };
    return createSystemCapabilityTools(context, {
      agents: async () =>
        new AgentModel(context.serverDB!, context.userId!).queryAgents({ limit: 30 }),
      tasks,
      files: {
        inspect: accountFiles.inspectDelivery,
        list: accountFiles.list,
        readText: accountFiles.readText,
        createText: accountFiles.createText,
        rename: accountFiles.rename,
        copy: accountFiles.copy,
        ...(presentationConfigured
          ? {
              importPresentation: async (artifactId: string) => {
                const artifact = await (await loadPresentation()).getRawArtifact(artifactId);
                if (!artifact?.bytes || artifact.status !== 'ready')
                  throw new Error(
                    'Ready presentation artifact not found in the authenticated account',
                  );
                const types: Record<string, { mime: string; extension: string }> = {
                  pptx: {
                    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                    extension: 'pptx',
                  },
                  svg: { mime: 'image/svg+xml', extension: 'svg' },
                  pdf: { mime: 'application/pdf', extension: 'pdf' },
                };
                const type = types[artifact.type];
                if (!type) throw new Error('Presentation artifact type cannot be delivered');
                return accountFiles.save(
                  Buffer.from(artifact.bytes),
                  type.mime,
                  `presentation.${type.extension}`,
                );
              },
            }
          : {}),
      },
      images: {
        render: async (input) => {
          const { renderSemanticPng } = await import('@/server/runtime/presentation/png-renderer');
          assertActive();
          const rendered = await renderSemanticPng(input, context.signal);
          assertActive();
          const hash = createHash('sha256').update(rendered.bytes).digest('hex');
          return {
            ...(await accountFiles.save(rendered.bytes, 'image/png', `${hash}.png`)),
            width: rendered.width,
            height: rendered.height,
            source: rendered.source,
          };
        },
      },
      ...(search
        ? {
            web: {
              search: async ({
                query,
                limit,
                timeRange,
              }: {
                query: string;
                limit: number;
                timeRange?: string;
              }) => {
                assertActive();
                const result = await search.webSearch({ query, searchTimeRange: timeRange });
                assertActive();
                return {
                  query: result.query,
                  resultNumbers: result.resultNumbers,
                  results: result.results.slice(0, limit).map((item) => ({
                    title: item.title,
                    url: item.url,
                    content: item.content?.slice(0, 2000),
                    publishedDate: item.publishedDate,
                  })),
                };
              },
            },
          }
        : {}),
      ...(presentationConfigured ? { loadPresentation } : {}),
      saveSvg: async (svg) => {
        context.assertStepLease?.();
        context.signal?.throwIfAborted();
        const owner = createHash('sha256').update(context.userId!).digest('hex');
        const hash = createHash('sha256').update(svg).digest('hex');
        const result = await new FileService(context.serverDB!, context.userId!).uploadFromBuffer(
          Buffer.from(svg),
          'image/svg+xml',
          `system-capabilities/${owner}/${hash}.svg`,
        );
        return {
          fileId: result.fileId,
          url: result.url,
          mimeType: 'image/svg+xml',
          access: 'Application file link; localhost links are only accessible on the host computer',
        };
      },
    });
  },
};
