import { readFile } from 'node:fs/promises';
import dotenv from 'dotenv';

// Local configuration is never logged. Existing process variables take precedence.
const local = {};
for (const file of ['.env', '.env.development', '.env.local', '.env.development.local']) {
  const source = await readFile(file, 'utf8').catch(() => '');
  const parsed = dotenv.parse(source);
  Object.assign(local, parsed);
}
for (const [name, value] of Object.entries(local))
  if (process.env[name] === undefined) process.env[name] = value;
export function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}; configure it locally in .env.development.local`);
  return value;
}
export function appUrl() {
  const url = new URL(required('APP_URL'));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('APP_URL must be an HTTP(S) address without embedded credentials');
  return url.origin;
}
