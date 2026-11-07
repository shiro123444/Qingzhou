import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';

const require = createRequire(import.meta.url);
require.extensions['.md'] = (module, filename) => {
  module.exports = readFileSync(filename, 'utf8');
};
const { harnessDigest } = require('../packages/agent-runtime/src');
const {
  ownedLearningDirectory,
  withAccountData,
} = require('../src/server/runtime/learning-lifecycle/files');
assert(
  new URL(process.env.DATABASE_URL!).pathname.startsWith('/qingzhou_accept_'),
  'ISOLATED_DATABASE_REQUIRED',
);
assert(process.env.APP_URL === 'http://localhost:3310', 'ISOLATED_APP_REQUIRED');
const caseName = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7) || 'erasure';
assert(/^[a-z0-9-]{1,64}$/u.test(caseName), 'INVALID_CASE_NAME');
const root = path.resolve('.data/acceptance', caseName);
await mkdir(root, { recursive: true, mode: 0o700 });
const preregistration = path.join(root, 'preregistered.json');
await writeFile(
  preregistration,
  JSON.stringify({
    schemaVersion: 1,
    kind: 'disposable fixture account',
    createdAt: new Date().toISOString(),
    modelCalls: 0,
  }),
  { flag: 'wx', mode: 0o600 },
);
const password = randomUUID();
const signup = await fetch('http://localhost:3310/api/auth/sign-up/email', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'origin': 'http://localhost:3310' },
  body: JSON.stringify({
    email: `erase-${randomUUID()}@qingzhou.test`,
    name: 'Erasure Fixture',
    password,
  }),
  signal: AbortSignal.timeout(90000),
});
if (!signup.ok) {
  await writeFile(path.join(root, 'signup-failure.json'), await signup.text(), { mode: 0o600 });
  throw new Error(`SIGNUP_FAILED:${signup.status}`);
}
const account = await signup.json();
const cookie = signup.headers.get('set-cookie')!.split(';')[0];
await writeFile(
  path.join(root, 'account.json'),
  JSON.stringify({ userId: account.user.id, password, cookie }),
  { mode: 0o600 },
);
const key = await harnessDigest({ userId: account.user.id, agentId: 'auth-erasure-fixture' });
const owned = ownedLearningDirectory(account.user.id, process.env.QINGZHOU_HARNESS_DATA_ROOT!, key);
await withAccountData(owned, async () => {
  await mkdir(owned, { recursive: true, mode: 0o700 });
  await writeFile(path.join(owned, 'private.json'), 'private acceptance fixture', { mode: 0o600 });
});
const deletion = await fetch('http://localhost:3310/api/auth/delete-user', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'origin': 'http://localhost:3310', cookie },
  body: JSON.stringify({ password }),
  signal: AbortSignal.timeout(90000),
});
assert(deletion.ok, `AUTHENTICATED_DELETE_FAILED:${deletion.status}`);
assert((await deletion.json()).success);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  assert.equal(
    (await pool.query('SELECT id FROM users WHERE id=$1', [account.user.id])).rows.length,
    0,
  );
} finally {
  await pool.end();
}
const userHash = createHash('sha256').update(account.user.id).digest('hex');
const receiptFile = path.join(
  process.env.QINGZHOU_LEARNING_LIFECYCLE_ROOT!,
  userHash,
  'deleting.json',
);
let receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
for (let i = 0; receipt.status !== 'erased' && i < 60; i++) {
  await delay(1000);
  receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
}
assert.equal(receipt.status, 'erased', 'BACKGROUND_ERASURE_DID_NOT_COMPLETE');
assert(!JSON.stringify(receipt).includes(account.user.id));
assert((await lstat(owned)).isFile());
await assert.rejects(access(path.join(owned, 'private.json')));
await assert.rejects(mkdir(path.join(owned, 'late'), { recursive: true }));
const report = {
  schemaVersion: 1,
  authenticatedEndpoint: '/api/auth/delete-user',
  httpStatus: deletion.status,
  databaseDeleted: true,
  privateFilesErased: true,
  lateWriteFenced: true,
  completionReceiptAnonymous: true,
  modelCalls: 0,
};
await writeFile('.data/acceptance/erase-auth-report.json', JSON.stringify(report, null, 2), {
  mode: 0o600,
});
await rm(path.join(root, 'account.json'));
console.log(JSON.stringify(report));
