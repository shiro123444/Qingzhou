import { readFile } from 'node:fs/promises';

const token = await readFile('/tmp/qingzhou-browser-token', 'utf8');
const response = await fetch('http://127.0.0.1:9223/', {
  method: 'POST',
  headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
  body: process.argv[2],
  signal: AbortSignal.timeout(25000),
});
if (!response.ok) {
  process.stderr.write('BROWSER_OPERATION_FAILED');
  process.exitCode = 1;
} else process.stdout.write(await response.text());
