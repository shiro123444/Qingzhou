import { canonicalToolName, invokeNativeTool } from '@lobechat/cordis-runtime';
import { type ChatToolPayload, type RuntimeStepContext } from '@lobechat/types';

import { type ChatStore } from '@/store/chat/store';
import { type StoreSetter } from '@/store/types';

import { displayMessageSelectors } from '../../message/selectors';

/**
 * Public API for plugin operations
 * These methods are called by UI components or other business scenarios
 */

type Setter = StoreSetter<ChatStore>;
export const pluginPublicApi = (set: Setter, get: () => ChatStore, _api?: unknown) =>
  new PluginPublicApiActionImpl(set, get, _api);

export class PluginPublicApiActionImpl {
  readonly #get: () => ChatStore;

  constructor(set: Setter, get: () => ChatStore, _api?: unknown) {
    void _api;
    void set;
    this.#get = get;
  }

  reInvokeToolMessage = async (id: string): Promise<void> => {
    const message = displayMessageSelectors.getDisplayMessageById(id)(this.#get());
    if (!message || message.role !== 'tool' || !message.plugin) return;

    // Get operationId from messageOperationMap
    const operationId = this.#get().messageOperationMap[id];
    const context = operationId ? { operationId } : undefined;

    // if there is error content, then clear the error
    if (!!message.pluginError) {
      this.#get().optimisticUpdateMessagePluginError(id, null, context);
    }

    const payload: ChatToolPayload = { ...message.plugin, id: message.tool_call_id! };

    await this.#get().internal_invokeDifferentTypePlugin(id, payload);
  };

  internal_invokeDifferentTypePlugin = async (
    id: string,
    payload: ChatToolPayload,
    stepContext?: RuntimeStepContext,
  ): Promise<any> => {
    // One request owns one native tool generation. The existing adapters retain
    // operation cancellation, message updates, attachments and tool source routing.
    return invokeNativeTool(
      {
        name: canonicalToolName(payload.identifier, payload.apiName),
        execute: async (input) => {
          const resolvedPayload = {
            ...payload,
            arguments: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
          };
          if ((payload.type as string) === 'mcp') {
            return this.#get().invokeMCPTypePlugin(id, resolvedPayload);
          }
          return this.#get().invokeBuiltinTool(id, resolvedPayload, stepContext);
        },
      },
      payload.arguments,
    );
  };
}

export type PluginPublicApiAction = Pick<
  PluginPublicApiActionImpl,
  keyof PluginPublicApiActionImpl
>;
