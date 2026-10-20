import { register } from '@lobechat/observability-otel/node';

import { version } from '../package.json';

register({ version });

// A new server takes over durable tasks without waiting for the browser to reopen.
if (process.env.CORDIS_PRESENTATION_DATA_DIR) {
  void import('./server/runtime/presentation/default-composition')
    .then(async ({ getDefaultPresentationComposition }) => {
      await getDefaultPresentationComposition().composition?.recoveryReady;
    })
    .catch((error) =>
      console.error('[presentation.recovery] startup failed', {
        code: error?.code ?? 'PRESENTATION_RECOVERY_FAILED',
      }),
    );
}
