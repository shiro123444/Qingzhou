import { ComputerToolIdentifier } from '@/server/runtime/computer/manifest';
import { isNativeAgentRuntimeEnabled } from '@/server/runtime/tasks/mode';

import type { ServerRuntimeRegistration } from './types';

export const computerRuntime: ServerRuntimeRegistration = {
  identifier: ComputerToolIdentifier,
  factory: async (context) => {
    if (!isNativeAgentRuntimeEnabled()) throw new Error('NATIVE_COMPUTER_REQUIRED');
    const { createComputerAgentTools } = await import('@/server/runtime/computer/agent-tools');
    return createComputerAgentTools(context);
  },
};
