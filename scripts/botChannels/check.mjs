import { appUrl } from './config.mjs';

let missing = 0;
for (const key of [
  'APP_URL',
  'DATABASE_URL',
  'REDIS_URL',
  'KEY_VAULTS_SECRET',
  'AUTH_SECRET',
  'CRON_SECRET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_ENDPOINT',
  'S3_BUCKET',
]) {
  const exists = !!process.env[key]?.trim();
  console.log(`${exists ? 'OK' : 'MISSING'} ${key}`);
  if (!exists) missing++;
}
if (process.env.APP_URL) {
  try {
    const url = new URL(appUrl());
    console.log(
      url.protocol === 'https:'
        ? 'OK HTTPS (required for public QQ webhook)'
        : 'INFO HTTP: local gateway mode only',
    );
  } catch {
    console.log('INVALID APP_URL');
    missing++;
  }
}
if (process.env.AGENT_RUNTIME_MODE === 'queue') {
  for (const key of ['QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY']) {
    const exists = !!process.env[key];
    console.log(`${exists ? 'OK' : 'MISSING'} ${key}`);
    if (!exists) missing++;
  }
} else console.log('INFO Local runtime: keep the app and worker running during tests');
console.log(
  'INFO Platform credentials are configured in the agent channel page; this check does not read them',
);
process.exitCode = missing ? 1 : 0;
