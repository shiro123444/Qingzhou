import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors, builtinAgentSelectors } from '@/store/agent/selectors';

/** Read saved selections without overwriting them; PPT shares the real inbox agent. */
export function useJumiChatModel(agentId: string) {
  const inboxId = useAgentStore(builtinAgentSelectors.inboxAgentId);
  const selectionAgentId = agentId === 'ppt-agent' ? (inboxId ?? '') : agentId;
  const model = useAgentStore(agentByIdSelectors.getAgentModelById(selectionAgentId));
  const provider = useAgentStore(agentByIdSelectors.getAgentModelProviderById(selectionAgentId));
  return { model, provider, selectionAgentId };
}
