import type { BrowserFrame, CompanionTaskPage, ComputerView } from '@/types/agentComputer';

const call = async (action: string, input: unknown = {}) => {
  const response = await fetch('/fixture/computer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, input }),
  });
  if (!response.ok) throw new Error('FIXTURE_REQUEST_FAILED');
  return response.json();
};
export const agentComputerService = {
  tasks: async (_agentId: string): Promise<CompanionTaskPage> => call('tasks'),
  get: async (_agentId: string): Promise<ComputerView> => call('get'),
  manage: async (input: unknown): Promise<ComputerView> => call('manage', input),
  observe: async (
    _agentId: string,
    expectedRevision: number,
  ): Promise<{ frame: BrowserFrame; revision: number }> => call('observe', { expectedRevision }),
  reconcile: async (
    agentId: string,
    commandId: string,
  ): Promise<ComputerView & { receiptStatus: 'done' }> => call('reconcile', { agentId, commandId }),
};
