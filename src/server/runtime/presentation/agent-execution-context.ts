import { AsyncLocalStorage } from 'node:async_hooks';

// Coordinator-owned correlation, never shared deck state or credentials.
const activeJob = new AsyncLocalStorage<string>();

export const currentPresentationAgentJob = (): string | undefined => activeJob.getStore();

export const withPresentationAgentJob = <T>(jobId: string, execute: () => T): T =>
  activeJob.run(jobId, execute);
