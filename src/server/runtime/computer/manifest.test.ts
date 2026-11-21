// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

import { createServerAgentToolsEngine } from '@/server/modules/Mecha/AgentToolsEngine';

import { ComputerToolIdentifier } from './manifest';

afterEach(() => vi.unstubAllEnvs());
function tools(agentMode = true, isBotConversation = false) {
  const engine = createServerAgentToolsEngine(
    { installedPlugins: [], isModelSupportToolUse: () => true },
    {
      agentConfig: { chatConfig: { enableAgentMode: agentMode } },
      model: 'deepseek-v4.1-flash',
      provider: 'nexus',
      isBotConversation,
    },
  );
  return engine.generateTools({ model: 'deepseek-v4.1-flash', provider: 'nexus' });
}
it('advertises actual Computer functions only for enabled native Agent conversations', () => {
  vi.stubEnv('AGENT_RUNTIME_MODE', 'native');
  vi.stubEnv('QINGZHOU_COMPUTER_ENABLED', '1');
  expect(JSON.stringify(tools())).toContain(`${ComputerToolIdentifier}____execute`);
  expect(JSON.stringify(tools(false))).not.toContain(ComputerToolIdentifier);
  expect(JSON.stringify(tools(true, true))).not.toContain(ComputerToolIdentifier);
  vi.stubEnv('QINGZHOU_COMPUTER_ENABLED', '0');
  expect(JSON.stringify(tools())).not.toContain(ComputerToolIdentifier);
  vi.stubEnv('QINGZHOU_COMPUTER_ENABLED', '1');
  vi.stubEnv('AGENT_RUNTIME_MODE', 'local');
  expect(JSON.stringify(tools())).not.toContain(ComputerToolIdentifier);
});
