/** Bounded reflection output, including reasoning and tool-call arguments. */
export const SIGNAL_MAX_OUTPUT_TOKENS = 2048;
export const SIGNAL_MAX_INPUT_BYTES = 131072;
export const SIGNAL_ATTEMPT_LIMIT = {
  calls: 1,
  tokens: SIGNAL_MAX_INPUT_BYTES + SIGNAL_MAX_OUTPUT_TOKENS + 1024,
  costMicros: 50000,
};
