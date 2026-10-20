/** Retained until SQL enqueue is confirmed; deliberately independent of runtime-state TTL. */
export const BOT_CALLBACK_INTENT_PREFIX = 'agent_runtime_callback_intent';
export const botCallbackIntentKey = (operationId: string, stepIndex: number) =>
  `${BOT_CALLBACK_INTENT_PREFIX}:${operationId}:${stepIndex}`;

export const BOT_CALLBACK_INTENT_READY_SET = 'agent_runtime_callback_intent_ready';
