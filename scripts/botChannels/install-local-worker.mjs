import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appUrl, required } from './config.mjs';

if (process.platform !== 'darwin') throw new Error('This installer uses macOS LaunchAgents');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(appUrl()).hostname))
  throw new Error('The local worker installer only accepts a loopback APP_URL');
required('CRON_SECRET');
required('KEY_VAULTS_SECRET');
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = path.join(root, '.data/bot-channels');
const label = 'com.qingzhou.local-channel-worker';
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const escape = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
await mkdir(directory, { recursive: true, mode: 0o700 });
await mkdir(path.dirname(plist), { recursive: true });
await writeFile(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(path.join(root, 'scripts/botChannels/worker.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>EnvironmentVariables</key><dict><key>BOT_WORKER_GATEWAY</key><string>1</string><key>BOT_WORKER_STATUS_FILE</key><string>${escape(path.join(directory, 'worker-status.json'))}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${escape(path.join(directory, 'worker.log'))}</string>
<key>StandardErrorPath</key><string>${escape(path.join(directory, 'worker-error.log'))}</string>
</dict></plist>
`,
  { mode: 0o600 },
);
const domain = `gui/${process.getuid()}`;
try {
  execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
} catch {
  /* first installation */
}
execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'pipe' });
console.log(`Installed ${label}. Health: ${path.join(directory, 'worker-status.json')}`);
