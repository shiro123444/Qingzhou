import { lambdaClient } from '@/libs/trpc/client';
import { type HumanInterventionRequest } from '@/services/agentRuntime/type';

export { agentRuntimeClient } from './client';
export * from './type';

class AgentRuntimeService {
  /**
   * Handle human intervention
   */
  async handleHumanIntervention(request: HumanInterventionRequest): Promise<any> {
    return await lambdaClient.aiAgent.processHumanIntervention.mutate({
      action: request.action,
      data: request.data,
      operationId: request.operationId,
      reason: request.reason,
      stepIndex: request.stepIndex ?? 0,
      toolMessageId: request.toolMessageId,
    });
  }
}

export const agentRuntimeService = new AgentRuntimeService();
