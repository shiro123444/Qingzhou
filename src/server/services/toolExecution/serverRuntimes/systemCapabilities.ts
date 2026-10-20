import { createHash } from 'node:crypto';

import { AgentModel } from '@/database/models/agent';
import { toolsEnv } from '@/envs/tools';
import { presentationAccountScope } from '@/server/runtime/presentation/account-workspace';
import { getDefaultPresentationComposition } from '@/server/runtime/presentation/default-composition';
import { renderSemanticPng } from '@/server/runtime/presentation/png-renderer';
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
    const { composition, error } = getDefaultPresentationComposition();
    const presentation = composition?.generationPortFactory?.({
      ...presentationAccountScope(context.userId),
      request: new Request('http://presentation.internal/channel'),
    });
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
    // TaskService imports the agent executor; resolve it after registry initialization.
    const { taskRuntime } = await import('./task');
    const tasks = await taskRuntime.factory(context);
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
        ...(presentation
          ? {
              importPresentation: async (artifactId: string) => {
                const artifact = await presentation.getRawArtifact(artifactId);
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
      presentation,
      presentationUnavailableReason: error
        ? 'Presentation provider configuration invalid; check the host configuration. System/task and vector capabilities remain available.'
        : undefined,
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
