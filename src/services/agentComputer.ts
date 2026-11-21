import type { z } from 'zod';

import { lambdaClient } from '@/libs/trpc/client';
import type { CompanionTaskPage, computerHumanCommandSchema } from '@/types/agentComputer';
import type { UiAttention } from '@/types/uiAttention';

export const agentComputerService = {
  tasks: async (agentId: string): Promise<CompanionTaskPage> => {
    const result = await lambdaClient.task.list.query({
      assigneeAgentId: agentId,
      statuses: ['backlog', 'running', 'scheduled', 'paused'],
      limit: 6,
    });
    return {
      total: result.total,
      items: result.data.map((task) => ({
        id: task.id,
        title: task.name || task.identifier,
        status: task.status,
        mode: task.automationMode,
        intervalSeconds: task.heartbeatInterval,
      })),
    };
  },
  startTask: (agentId: string, prompt: string, uiAttention?: UiAttention) =>
    lambdaClient.agentComputer.startTask.mutate({ agentId, prompt, uiAttention }),
  observe: (agentId: string, expectedRevision: number) =>
    lambdaClient.agentComputer.observe.mutate({ agentId, expectedRevision }),
  reconcile: (agentId: string, commandId: string) =>
    lambdaClient.agentComputer.reconcile.mutate({ agentId, commandId }),
  get: (agentId: string) => lambdaClient.agentComputer.get.query({ agentId }),
  manage: (input: {
    agentId: string;
    command: z.infer<typeof computerHumanCommandSchema>;
    requestId: string;
    expectedRevision: number;
  }) => lambdaClient.agentComputer.manage.mutate(input),
};
