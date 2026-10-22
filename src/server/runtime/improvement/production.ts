import path from 'node:path';

import type { HarnessRevision, LearningScope, LearningUsage } from '@lobechat/agent-runtime';
import { LoadedProfile } from '@lobechat/cordis-runtime';
import type { LobeChatDatabase } from '@lobechat/database';

import { LearningBudgetBinding, type LearningBudgetPort } from './budget';
import { DatabaseLearningBudget } from './budget-store';
import { HarnessCoordinator } from './coordinator';
import { LearningMaintenance } from '../learning-lifecycle/maintenance';
import { LearningCommands } from './learning-commands';
import type { HarnessPublicationPort, HarnessSelection, PublicationEvent } from './publication';
import { DatabaseHarnessPublication } from './publication-store';
import { FileHarnessStore } from './store';

declare module '@lobechat/cordis-foundation' {
  interface Context {
    'qingzhou.improvement': HarnessCoordinator;
    'qingzhou.improvement.maintenance': LearningMaintenance;
    'qingzhou.improvement.budgets': LearningBudgetPort;
    'qingzhou.improvement.experiences': LearningCommands;
    'qingzhou.improvement.publications': HarnessPublicationPort;
  }
  interface Events {
    'qingzhou.improvement.published': (event: PublicationEvent) => void | Promise<void>;
  }
}

/** A real Cordis service using the same native profile loader as the execution hosts. */
export function createImprovementHost(root: string, db?: LobeChatDatabase) {
  return new LoadedProfile({
    modules: {
      improvement: {
        plugin: {
          name: 'qingzhou.improvement',
          apply(ctx) {
            const experiences = new LearningCommands();
            ctx.provide('qingzhou.improvement', new HarnessCoordinator(new FileHarnessStore(root)));
            ctx.provide('qingzhou.improvement.experiences', experiences);
            if (db) {
              const publication = new DatabaseHarnessPublication(db, undefined, experiences);
              ctx.provide('qingzhou.improvement.publications', publication);
              ctx.provide('qingzhou.improvement.budgets', new DatabaseLearningBudget(db));
              const maintenance = new LearningMaintenance(db, publication, (event) =>
                ctx.parallel('qingzhou.improvement.published', event),
              );
              ctx.provide('qingzhou.improvement.maintenance', maintenance);
              if (process.env.QINGZHOU_LEARNING_WORKER === '1')
                ctx.effect(() => maintenance.start());
            }
          },
        },
      },
    },
    bundles: { improvement: { entries: [{ id: 'improvement', use: 'improvement' }] } },
    profile: { bundles: ['improvement'] },
  });
}
let host: ReturnType<typeof createImprovementHost> | undefined;
export function captureLearningCommand(input: Parameters<LearningCommands['capture']>[0]) {
  host ??= createImprovementHost(
    process.env.QINGZHOU_HARNESS_DATA_ROOT || path.join(process.cwd(), '.data', 'harness'),
  );
  return host.run((ctx) => ctx.get('qingzhou.improvement.experiences')!.capture(input));
}
const publicationHosts = new WeakMap<LobeChatDatabase, ReturnType<typeof createImprovementHost>>();
export function withLearningBudget<T>(
  db: LobeChatDatabase,
  run: (port: LearningBudgetPort) => Promise<T>,
): Promise<T> {
  let active = publicationHosts.get(db);
  if (!active) {
    active = createImprovementHost(
      process.env.QINGZHOU_HARNESS_DATA_ROOT || path.join(process.cwd(), '.data', 'harness'),
      db,
    );
    publicationHosts.set(db, active);
  }
  return active.run((ctx) => run(ctx.get('qingzhou.improvement.budgets')!));
}
export async function openLearningBudget(
  port: LearningBudgetPort,
  scope: LearningScope,
  rootId: string,
  limit: LearningUsage,
  children: Record<string, LearningUsage>,
) {
  await port.open(scope, rootId, limit);
  const bindings: Record<string, LearningBudgetBinding> = {};
  for (const [childId, childLimit] of Object.entries(children)) {
    const ref = { scope, rootId, childId };
    await port.allocate(ref, childLimit);
    bindings[childId] = new LearningBudgetBinding(port, ref);
  }
  return bindings;
}
export function withHarnessPublication<T>(
  db: LobeChatDatabase,
  run: (
    publication: HarnessPublicationPort,
    flush: (scope: HarnessRevision['scope']) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  let publicationHost = publicationHosts.get(db);
  if (!publicationHost) {
    publicationHost = createImprovementHost(
      process.env.QINGZHOU_HARNESS_DATA_ROOT || path.join(process.cwd(), '.data', 'harness'),
      db,
    );
    publicationHosts.set(db, publicationHost);
  }
  return publicationHost.run((ctx) => {
    const publication = ctx.get('qingzhou.improvement.publications')!;
    return run(publication, (scope) =>
      publication.flushOutbox(scope, (event) =>
        ctx.parallel('qingzhou.improvement.published', event),
      ),
    );
  });
}
export function withHarnessCoordinator<T>(
  run: (coordinator: HarnessCoordinator) => Promise<T>,
): Promise<T> {
  host ??= createImprovementHost(
    process.env.QINGZHOU_HARNESS_DATA_ROOT || path.join(process.cwd(), '.data', 'harness'),
  );
  return host.run((ctx) => run(ctx.get('qingzhou.improvement')!));
}
export async function resolveActiveHarness(
  source: HarnessRevision,
  enabled: boolean,
  db?: LobeChatDatabase,
): Promise<HarnessRevision> {
  return (await selectActiveHarness(source, enabled, db)).revision;
}

export async function selectActiveHarness(
  source: HarnessRevision,
  enabled: boolean,
  db?: LobeChatDatabase,
): Promise<HarnessSelection> {
  let selected: HarnessRevision;
  try {
    selected = await withHarnessCoordinator((coordinator) =>
      coordinator.registerSource(source, enabled),
    );
  } catch (error) {
    // A running experiment must not deny an ordinary user request admission.
    if (
      error instanceof Error &&
      ['HARNESS_BUSY', 'HARNESS_QUOTA_EXCEEDED'].includes(error.message)
    )
      selected = source;
    else throw error;
  }
  return db
    ? withHarnessPublication(db, (publication) => publication.selection(source))
    : { revision: selected };
}

export function withLearningMaintenance<T>(
  db: LobeChatDatabase,
  run: (maintenance: LearningMaintenance) => Promise<T>,
) {
  return withHarnessPublication(db, async () =>
    publicationHosts.get(db)!.run((ctx) => run(ctx.get('qingzhou.improvement.maintenance')!)),
  );
}
