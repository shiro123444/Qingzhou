import { appUrl, required } from './config.mjs';

try {
  const response = await fetch(`${appUrl()}/api/agent/gateway/start`, {
    method: 'POST',
    body: '{}',
    headers: {
      'Authorization': `Bearer ${required('KEY_VAULTS_SECRET')}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(60_000),
  });
  console.log(
    response.ok
      ? 'Gateway start accepted; check channel status in the app'
      : `Gateway start failed: HTTP ${response.status}`,
  );
  process.exitCode = response.ok ? 0 : 1;
} catch {
  console.error('Gateway unavailable; check local configuration and app availability');
  process.exitCode = 1;
}
