import { z } from 'zod';

import {
  type AtomicOperation,
  type AtomicOperationEvent,
  AtomicRuntime,
} from '@/server/runtime/atomic-runtime';
import { presentationAccountScope } from '@/server/runtime/presentation/account-workspace';
import type { PresentationGenerationPort } from '@/server/runtime/presentation/generation-port';
import { semanticBlockSchema } from '@/server/runtime/presentation/semantic-blocks';
import { presentationVectorOperations } from '@/server/runtime/presentation/vector-operations';

import {
  channelExtraOperations,
  type ChannelExtraPorts,
  channelFileOperations,
  type ChannelFilePorts,
} from './systemCapabilityExtras';
import type { ToolExecutionContext } from './types';

export interface SystemCapabilityPorts extends ChannelExtraPorts {
  agents: () => Promise<unknown>;
  files?: ChannelFilePorts;
  presentation?: PresentationGenerationPort;
  presentationUnavailableReason?: string;
  saveSvg: (svg: string) => Promise<unknown>;
  tasks: {
    createTask: (args: { name: string; instruction: string }) => Promise<unknown>;
    listTasks: (args: { limit?: number }) => Promise<unknown>;
  };
}

const assertHeld = (context: ToolExecutionContext) => {
  context.assertStepLease?.();
  context.signal?.throwIfAborted();
};

/** Identity and ports come exclusively from the authenticated tool executor. */
export const createSystemCapabilityTools = (
  context: ToolExecutionContext,
  ports: SystemCapabilityPorts,
) => {
  if (!context.userId || !context.topicId) throw new Error('Authenticated tool scope required');
  const scope = presentationAccountScope(context.userId);

  const withRuntime = async <T>(run: (runtime: AtomicRuntime) => Promise<T>) => {
    assertHeld(context);
    const presentationOperations: AtomicOperation[] = presentationVectorOperations();
    const publicTools = await ports.presentation?.listOperations();
    const extras = publicTools?.tools ?? [];
    for (const tool of extras) {
      if (!['presentation', 'assets', 'skills'].includes(tool.name.split('.')[0])) continue;
      if (presentationOperations.some((operation) => operation.name === tool.name)) continue;
      presentationOperations.push({
        name: tool.name,
        description: tool.description,
        input: z.unknown(), // The existing presentation runtime performs its own schema validation.
        execute: (input) => ports.presentation!.executeOperation(tool.name, input, context.signal),
      });
    }
    if (ports.presentation)
      presentationOperations.push({
        name: 'presentation.create',
        description:
          'Queue a presentation in the same account workspace as the studio. Returns a job ID; queued is not completed.',
        input: z
          .object({
            title: z.string().trim().min(1).max(500),
            prompt: z.string().max(12000),
            slideCount: z.number().int().min(1).max(30).default(5),
          })
          .strict(),
        execute: (input) =>
          ports.presentation!.createJob({
            ...input,
            notebookId: context.topicId!,
            sourceVersionIds: [],
          }),
      });
    const groups = new Map<string, AtomicOperation[]>();
    for (const operation of [...presentationOperations, ...channelExtraOperations(ports)]) {
      const id = operation.name.split('.')[0];
      groups.set(id, [...(groups.get(id) ?? []), operation]);
    }
    const runtime = new AtomicRuntime([
      {
        id: 'system',
        version: '1.0.0',
        operations: [
          {
            name: 'system.agents.list',
            description: 'List agents belonging to the authenticated account.',
            input: z.object({}).strict(),
            execute: ports.agents,
          },
        ],
      },
      {
        id: 'tasks',
        version: '1.0.0',
        operations: [
          {
            name: 'tasks.list',
            description: 'List tasks for the current agent using the existing task service.',
            input: z.object({ limit: z.number().int().min(1).max(50).optional() }).strict(),
            execute: ports.tasks.listTasks,
          },
          {
            name: 'tasks.create',
            description:
              'Create a task in the authenticated account. Does not start autonomous task execution.',
            input: z
              .object({
                name: z.string().trim().min(1).max(200),
                instruction: z.string().trim().min(1).max(10000),
              })
              .strict(),
            execute: ports.tasks.createTask,
          },
        ],
      },
      ...(ports.files
        ? [
            {
              id: 'files',
              version: '1.0.0',
              operations: channelFileOperations(ports.files),
            },
          ]
        : []),
      ...[...groups].map(([id, operations]) => ({ id, version: '1.0.0', operations })),
    ]);
    try {
      return await run(runtime);
    } finally {
      await runtime.dispose();
    }
  };

  return {
    ask: () => ({
      success: false,
      content:
        'This question requires a real user answer through the runner intervention flow; do not auto-answer it.',
    }),
    catalog: (args: { operation?: string; offset?: number } = {}) =>
      withRuntime(async (runtime) => {
        const query = z
          .object({
            operation: z.string().max(150).optional(),
            offset: z.number().int().min(0).default(0),
          })
          .strict()
          .parse(args);
        const tools = await runtime.catalog();
        const publicTools = await ports.presentation?.listOperations();
        const agentTools = Object.entries(context.toolManifestMap)
          .filter(([id]) => id !== 'qingzhou-system-capabilities')
          .sort(([a], [b]) => a.localeCompare(b));
        const nativeOperation = query.operation?.startsWith('agent.')
          ? (() => {
              const [, identifier, ...parts] = query.operation!.split('.');
              const apiName = parts.join('.');
              const manifest = context.toolManifestMap[identifier];
              const api = manifest?.api.find((entry) => entry.name === apiName);
              if (manifest && !apiName && identifier !== 'qingzhou-system-capabilities')
                return {
                  identifier,
                  execution: 'agent-runner',
                  apis: manifest.api.slice(query.offset, query.offset + 12).map((entry) => ({
                    name: `agent.${identifier}.${entry.name}`,
                    description: entry.description?.slice(0, 180),
                  })),
                  nextOffset: query.offset + 12 < manifest.api.length ? query.offset + 12 : null,
                  instruction:
                    'Activate this identifier using lobe-activator.activateTools, then call its native function.',
                };
              return api && identifier !== 'qingzhou-system-capabilities'
                ? {
                    name: query.operation,
                    identifier,
                    apiName,
                    description: api.description,
                    inputSchema: api.parameters,
                    execution: 'agent-runner',
                    instruction:
                      'Activate the tool using lobe-activator.activateTools if needed, then call its native function. Native approval, account and device policy remain enforced. Do not pass this operation to invoke.',
                  }
                : undefined;
            })()
          : undefined;
        return {
          success: true,
          content: JSON.stringify({
            presentationReady: !!ports.presentation,
            pngReady: !!ports.images,
            webReady: !!ports.web,
            ...(!ports.web
              ? {
                  webSetup:
                    'Configure SEARCH_PROVIDERS and its credentials, or SEARXNG_URL, on the host.',
                }
              : {}),
            presentationSetup: ports.presentation
              ? undefined
              : (ports.presentationUnavailableReason ??
                'PPT generation requires CORDIS_PPT_MASTER_ROOT with real checker/converter scripts and CORDIS_PPT_PYTHON; formula and diagram tools are available.'),
            tools: tools
              .filter((tool) => !query.operation || tool.name === query.operation)
              .map(({ name, description, inputSchema }) => ({
                name,
                description,
                ...(query.operation
                  ? {
                      inputSchema:
                        publicTools?.tools.find((tool) => tool.name === name)?.inputSchema ??
                        inputSchema,
                    }
                  : {}),
              })),
            ...(nativeOperation ? { nativeOperation } : {}),
            ...(!query.operation
              ? {
                  agentTools: agentTools
                    .slice(query.offset, query.offset + 12)
                    .map(([identifier, manifest]) => ({
                      identifier,
                      title: manifest.meta?.title ?? identifier,
                      apiCount: manifest.api.length,
                      operationPrefix: `agent.${identifier}`,
                    })),
                  nextOffset: query.offset + 12 < agentTools.length ? query.offset + 12 : null,
                  totalAgentTools: agentTools.length,
                  agentToolExecution:
                    'Discoverable tools use the normal agent runner and activator, preserving their authorization and approval policies.',
                }
              : {}),
          }),
        };
      }),
    invoke: (args: { operation: string; input: string }) =>
      withRuntime(async (runtime) => {
        assertHeld(context);
        const parsed = z
          .object({ operation: z.string().max(150), input: z.string().max(100_000) })
          .strict()
          .parse(args);
        if (!(await runtime.catalog()).some((tool) => tool.name === parsed.operation))
          throw new Error('Capability unavailable; call catalog for supported operations');
        const events: AtomicOperationEvent[] = [];
        const result = await runtime.invoke<unknown>(parsed.operation, JSON.parse(parsed.input), {
          scope,
          signal: context.signal,
          onEvent: (event) => events.push(event),
        });
        assertHeld(context);
        // Studio renderers return a <g> fragment for placement within a slide.
        // A channel download needs its own SVG root and coordinate viewport.
        const svg =
          result && typeof result === 'object' && 'svg' in result && typeof result.svg === 'string'
            ? (() => {
                if (
                  ['presentation.formula.render', 'presentation.diagram.render'].includes(
                    parsed.operation,
                  ) &&
                  'source' in result
                ) {
                  const { rect } = semanticBlockSchema.parse(result.source);
                  return `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}" viewBox="${rect.x} ${rect.y} ${rect.width} ${rect.height}">${result.svg}</svg>`;
                }
                return result.svg;
              })()
            : undefined;
        // SVG is stored as an owned file, never pasted as thousands of characters in WeChat.
        const output =
          svg && result && typeof result === 'object'
            ? {
                artifact: await ports.saveSvg(svg),
                source: 'source' in result ? result.source : undefined,
              }
            : result;
        assertHeld(context);
        const success = !(
          result &&
          typeof result === 'object' &&
          'success' in result &&
          result.success === false
        );
        const fileId =
          output &&
          typeof output === 'object' &&
          'artifact' in output &&
          output.artifact &&
          typeof output.artifact === 'object' &&
          'fileId' in output.artifact
            ? output.artifact.fileId
            : parsed.operation === 'files.deliver' &&
                output &&
                typeof output === 'object' &&
                'fileId' in output
              ? output.fileId
              : undefined;
        return {
          success,
          content: JSON.stringify({ operation: parsed.operation, result: output, events }),
          state: {
            atomicEvents: events,
            ...(success && typeof fileId === 'string' && context.operationId
              ? { botDelivery: { operationId: context.operationId, artifacts: [{ fileId }] } }
              : {}),
          },
        };
      }),
  };
};
