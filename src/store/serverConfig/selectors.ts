import { BUILTIN_PLUGIN_IDS } from '@/config/builtinPlugins';

import { type ServerConfigStore } from './store';

const noPlugins: readonly string[] = [];
export const builtinPluginSelectors = {
  // Wait for bootstrap before activating a plugin. Older servers retain the default profile
  // after their configuration has finished loading.
  enabled: (s: ServerConfigStore): readonly string[] =>
    s.serverConfig.builtinPlugins ?? (s.serverConfigInit ? BUILTIN_PLUGIN_IDS : noPlugins),
  ready: (s: ServerConfigStore) =>
    s.serverConfig.builtinPlugins !== undefined || s.serverConfigInit,
};

export const featureFlagsSelectors = (s: ServerConfigStore) => s.featureFlags;

export const serverConfigSelectors = {
  disableEmailPassword: (s: ServerConfigStore) => s.serverConfig.disableEmailPassword || false,
  enableBusinessFeatures: (s: ServerConfigStore) => s.serverConfig.enableBusinessFeatures || false,
  enableEmailVerification: (s: ServerConfigStore) =>
    s.serverConfig.enableEmailVerification || false,
  enableKlavis: (s: ServerConfigStore) => s.serverConfig.enableKlavis || false,
  enableLobehubSkill: (s: ServerConfigStore) => s.serverConfig.enableLobehubSkill || false,
  enableMagicLink: (s: ServerConfigStore) => s.serverConfig.enableMagicLink || false,
  enableMarketTrustedClient: (s: ServerConfigStore) =>
    s.serverConfig.enableMarketTrustedClient || false,
  enableMcpProxy: (s: ServerConfigStore) => s.serverConfig.enableMcpProxy || false,
  enableUploadFileToServer: (s: ServerConfigStore) => s.serverConfig.enableUploadFileToServer,
  enableVisualUnderstanding: (s: ServerConfigStore) =>
    s.serverConfig.enableVisualUnderstanding || false,
  enabledTelemetryChat: (s: ServerConfigStore) => s.serverConfig.telemetry.langfuse || false,
  isMobile: (s: ServerConfigStore) => s.isMobile || false,
  oAuthSSOProviders: (s: ServerConfigStore) => s.serverConfig.oAuthSSOProviders,
  visualUnderstanding: (s: ServerConfigStore) => s.serverConfig.visualUnderstanding,
};
