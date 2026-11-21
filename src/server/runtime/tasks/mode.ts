/** Explicit deployment selection, shared by web ingress and independent workers. */
export const isNativeAgentRuntimeEnabled = () => {
  const mode = process.env.AGENT_RUNTIME_MODE;
  if (mode !== undefined && !['local', 'queue', 'native', ''].includes(mode))
    throw new Error('AGENT_RUNTIME_MODE must be local, queue or native');
  return mode === 'native';
};
