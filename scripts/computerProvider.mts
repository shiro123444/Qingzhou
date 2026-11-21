import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import nodePath from 'node:path';

import { DockerComputerDriver, runDocker } from '../src/server/runtime/computer/docker/driver';
import { ComputerProviderJournal } from '../src/server/runtime/computer/docker/journal';
import { createComputerProviderHandler } from '../src/server/runtime/computer/docker/service';

if (process.argv.includes('--check')) {
  console.info('[computer-provider] Modules loaded; no listener, database or container started');
  process.exit(0);
}
const token = process.env.QINGZHOU_COMPUTER_TOKEN ?? '';
if (token.length < 24)
  throw new Error('QINGZHOU_COMPUTER_TOKEN must contain at least 24 characters');
const port = Number(process.env.QINGZHOU_COMPUTER_PORT ?? '8791');
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid computer provider port');
const preflight = await runDocker(
  ['version', '--format', '{{.Server.Version}}'],
  AbortSignal.timeout(5000),
);
if (preflight.code !== 0) throw new Error('Docker engine is unavailable');
const image = await runDocker(
  [
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    process.env.QINGZHOU_COMPUTER_IMAGE ?? 'qingzhou-computer:local',
  ],
  AbortSignal.timeout(5000),
);
const imageId = image.stdout.trim();
if (image.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId))
  throw new Error('Build or install the computer image before starting this provider');
const driver = new DockerComputerDriver(imageId, process.env.QINGZHOU_COMPUTER_NETWORK ?? 'none');
const journal = new ComputerProviderJournal(
  nodePath.resolve(
    process.env.QINGZHOU_COMPUTER_STATE_DIR ?? '.data/computer-provider',
    'receipts.sqlite',
  ),
  driver.binding,
);
const handle = createComputerProviderHandler(journal, driver, token);
const sha = (value: string) => createHash('sha256').update(value).digest();
const server = createServer(async (req, res) => {
  res.on('error', () => undefined);
  if (!timingSafeEqual(sha(req.headers.authorization ?? ''), sha(`Bearer ${token}`))) {
    res.writeHead(401).end();
    return;
  }
  try {
    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk);
      length += buffer.length;
      if (length > 100000) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(buffer);
    }
    const body = Buffer.concat(chunks);
    const response = await handle(
      new Request(`http://computer-provider${req.url}`, {
        method: req.method ?? 'POST',
        headers: {
          'authorization': req.headers.authorization ?? '',
          'content-type': 'application/json',
        },
        ...(req.method === 'POST' ? { body } : {}),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!res.headersSent) res.writeHead(503);
    res.end();
  }
});
server.requestTimeout = 40000;
server.headersTimeout = 10000;
server.maxHeadersCount = 32;
server.listen(port, process.env.QINGZHOU_COMPUTER_BIND ?? '127.0.0.1', () =>
  console.info(
    '[computer-provider] Listening; no computer is created until an authenticated request',
  ),
);
const stop = () => {
  server.close(() => {
    journal.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 35000).unref();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
