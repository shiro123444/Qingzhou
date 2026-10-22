import { lambdaClient } from '@/libs/trpc/client';

export const agentHarnessService = {
  resolveClient: (input: Parameters<typeof lambdaClient.agentHarness.resolveClient.query>[0]) =>
    lambdaClient.agentHarness.resolveClient.query(input),
  get: (agentId: string) => lambdaClient.agentHarness.get.query({ agentId }),
  command: (input: Parameters<typeof lambdaClient.agentHarness.command.mutate>[0]) =>
    lambdaClient.agentHarness.command.mutate(input),
};
