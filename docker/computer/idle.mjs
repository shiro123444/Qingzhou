import { listenBrowser } from './browser-server.mjs';

const stop = await listenBrowser();
const shutdown = () => {
  void stop().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
