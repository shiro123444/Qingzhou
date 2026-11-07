import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';

const require = createRequire(import.meta.url);
require.extensions['.md'] = (module, filename) => {
  module.exports = readFileSync(filename, 'utf8');
};
const schema =
  require('../packages/database/src/schemas') as typeof import('../packages/database/src/schemas');
const { AiProviderModel } = require('../packages/database/src/models/aiProvider');
const { KeyVaultsGateKeeper } = require('../src/server/modules/KeyVaultsEncrypt');
const { initModelRuntimeFromDB } = require('../src/server/modules/ModelRuntime');
const { readCurrentHarnessSource } = require('../src/server/runtime/improvement/source');
const { createChatProbePort } = require('../src/server/runtime/improvement/chat-probe');
const { FileHarnessStore } = require('../src/server/runtime/improvement/store');
const { HarnessCoordinator } = require('../src/server/runtime/improvement/coordinator');
const {
  DatabaseHarnessPublication,
} = require('../src/server/runtime/improvement/publication-store');
const { DatabaseLearningBudget } = require('../src/server/runtime/improvement/budget-store');
const { LearningBudgetBinding } = require('../src/server/runtime/improvement/budget');
const {
  preparePublication,
  validationDigest,
} = require('../src/server/runtime/improvement/publication');
const { userMutationAuthority } = require('../src/server/runtime/improvement/mutation-authority');
const { bindHarnessRun, resolveHarnessMaterial } = require('../packages/agent-runtime/src');
const database = new URL(process.env.DATABASE_URL!);
assert(database.pathname.startsWith('/qingzhou_accept_'), 'ISOLATED_DATABASE_REQUIRED');
assert(
  process.env.QINGZHOU_HARNESS_DATA_ROOT?.includes('/.data/acceptance/'),
  'ISOLATED_ROOT_REQUIRED',
);
const keepCase = process.argv.includes('--keep-case');
const directory = path.resolve(
  keepCase ? '.data/acceptance/live-keep-repaired' : '.data/acceptance/live',
);
await mkdir(directory, { recursive: true, mode: 0o700 });
assert(
  !require('node:fs').existsSync(path.join(directory, 'preregistered.json')),
  'LIVE_RUN_ALREADY_REGISTERED_NO_AUTOMATIC_RETRY',
);
const fixture = JSON.parse(await readFile('.data/acceptance/account.json', 'utf8'));
const provider = 'deepseek',
  model = 'deepseek-chat',
  apiKey = process.env.DEEPSEEK_API_KEY;
assert(apiKey, 'EXISTING_PROVIDER_CREDENTIAL_REQUIRED');
const pool = new Pool({ connectionString: database.href, max: 3 });
const db = drizzle(pool, { schema });
const agentId = `accept-live-${randomUUID()}`,
  scope = { userId: fixture.userId, agentId };
let tasks = [
  {
    id: 'screening',
    prompt:
      '团队要在 8 周内上线内部报表。A 每周 6 工时、一次迁移 12 工时；B 每周 4 工时、一次迁移 40 工时。可用总预算 65 工时。请给出两方案总工时、约束判断与推荐依据；未知条件请明确说明。',
  },
];
let heldout = [
  {
    id: 'capacity',
    prompt:
      '一批课程资料需 900 分钟处理。方案 A 准备 40 分钟，每天处理 150 分钟；方案 B 准备 80 分钟，每天处理 180 分钟。交付窗口 6 天、每天最多投入 170 分钟，准备也计入。请计算并给出可执行的安排，指出哪些含义不明确。',
  },
  {
    id: 'handoff',
    prompt:
      '项目现在有 14 项任务，A 每天完成 3 项、启动需要半天；B 每天完成 4 项、启动需要 2 天。截止日为第 6 天，假定可拆分工作日。请算总耗时并说明推荐与限制，不添加未提供的事实。',
  },
];
if (keepCase) {
  tasks = [
    {
      id: 'procurement',
      prompt:
        '购买 12 份课程材料，A 每份 18 元另收一次运费 24 元；B 每份 21 元包邮。总预算 250 元。请给出总价、是否符合预算，以及推荐的理由。',
    },
  ];
  heldout = [
    {
      id: 'storage',
      prompt:
        '有 120GB 数据要保存 3 个月。A 每 GB 每月 0.2 元另收一次导入费 12 元；B 每 GB 每月 0.25 元无导入费。预算为 90 元。请计算并比较，说明未知的费用边界。',
    },
    {
      id: 'schedule',
      prompt:
        '需要制作 40 页讲义。A 每小时 5 页，另需整理 2 小时；B 每小时 8 页，另需整理 4 小时。总时间上限 10 小时。请计算总耗时并给建议。',
    },
  ];
}
const baseline = keepCase
  ? '你是项目决策助手。按照用户要求给出计算、预算判断和依据。不虚构条件。'
  : '你是项目决策助手。为了简洁，每次只用一句话给建议，不展开计算。';
const candidate = keepCase
  ? '无论用户问什么，都只回答 OK。'
  : '你是项目决策助手。先给可执行的建议，然后用简洁的计算与单位核对约束。区分已知事实、假设和不确定条件。遇到歧义给出有条件的结论，不编造事实。遵守用户明确要求的格式和内容。';
const phase = {
  calls: 3,
  inputBytesPerCall: 32000,
  outputTokensPerCall: 512,
  deadlineMs: 120000,
  tokens: 120000,
  costMicros: 150000,
  costMicrosPerCall: 50000,
};
await writeFile(
  path.join(directory, 'preregistered.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      scope,
      provider,
      model,
      tasks,
      heldout,
      baseline,
      candidate,
      budget: {
        calls: keepCase ? 3 : 9,
        reservedCostMicros: keepCase ? 150000 : 450000,
        maxOutputTokensPerCall: 512,
      },
      criterion:
        'Anonymous selection under task requirements; no forced winner. Adopt only if all preregistered comparisons choose candidate. Controlled synthetic defects establish integration, not general quality gains.',
    },
    null,
    2,
  ),
  { flag: 'wx', mode: 0o600 },
);
try {
  const vault = await KeyVaultsGateKeeper.initWithEnvKey();
  await new AiProviderModel(db, scope.userId).updateConfig(
    provider,
    { keyVaults: { apiKey } },
    vault.encrypt,
    KeyVaultsGateKeeper.getUserKeyVaults,
  );
  await db.insert(schema.agents).values({
    id: agentId,
    slug: agentId,
    userId: scope.userId,
    title: 'Harness 固定预算验收',
    systemRole: baseline,
    model,
    provider,
    chatConfig: { autoCreateTopicThreshold: 2, selfIteration: { enabled: true } },
  });
  const store = new FileHarnessStore(process.env.QINGZHOU_HARNESS_DATA_ROOT!);
  const coordinator = new HarnessCoordinator(store),
    publication = new DatabaseHarnessPublication(db);
  const source = await readCurrentHarnessSource(db, scope.userId, scope.agentId);
  await coordinator.registerSource(source);
  const runtime = await initModelRuntimeFromDB(db, scope.userId, provider, {
    singleDispatch: true,
  });
  const port = createChatProbePort({ model, provider, runtime, material: source.material });
  const budget = new DatabaseLearningBudget(db);
  const reports: unknown[] = [];
  for (const [index, value] of [candidate].entries()) {
    const experiment = await coordinator.propose(scope, {
      baselineId: source.id,
      patch: { baseRevisionId: source.id, surface: 'chat.systemRole', value },
      tasks,
      heldout,
      budget: phase,
      validationBudget: { ...phase, calls: 6, tokens: 240000, costMicros: 300000 },
    });
    const learningScope = { userId: scope.userId, subject: { kind: 'agent', agentId } },
      rootId = `chat:${experiment.id}`;
    await budget.open(
      learningScope,
      rootId,
      keepCase
        ? { calls: 3, tokens: 120000, costMicros: 150000 }
        : { calls: 9, tokens: 360000, costMicros: 450000 },
    );
    const limits = keepCase
      ? { probe: phase }
      : { probe: phase, validation: { calls: 6, tokens: 240000, costMicros: 300000 } };
    const bindings: Record<string, InstanceType<typeof LearningBudgetBinding>> = {};
    for (const [childId, limit] of Object.entries(limits)) {
      const ref = { scope: learningScope, rootId, childId };
      await budget.allocate(ref, {
        calls: limit.calls,
        tokens: limit.tokens,
        costMicros: limit.costMicros,
      });
      bindings[childId] = new LearningBudgetBinding(budget, ref);
    }
    await store.transaction(scope, async (state: any, save: () => Promise<void>) => {
      state.experiments[experiment.id].budgetRootId = rootId;
      await save();
    });
    const oldRun = await bindHarnessRun(
      (await publication.selection(source)).revision,
      `before-${index}`,
      {
        agentConfig: source.material.agentConfig,
        promptSegments: [{ kind: 'author', content: baseline }],
      },
    );
    const probe = await coordinator.execute(scope, experiment.id, port, {
      learningBudget: bindings.probe,
    });
    let result = probe;
    if (!keepCase && probe.status === 'completed')
      result = await coordinator.execute(scope, experiment.id, port, {
        validate: true,
        learningBudget: bindings.validation,
      });
    await writeFile(
      path.join(directory, `experiment-${index}.json`),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    assert.equal(result.status, 'completed', result.error);
    const head = await publication.read(scope);
    const action = !keepCase && result.validation === 'passed' ? 'adopt' : 'keep';
    const command = {
      action,
      id: randomUUID(),
      experimentId: experiment.id,
      candidateId: experiment.candidateId,
      expectedGeneration: head.generation,
      expectedActiveId: head.active?.id,
      expectedSourceId: source.id,
      expectedSourceGeneration: (source.material.agentConfig as any).generation ?? 0,
      validationDigest: await validationDigest(result),
      reason:
        index === 0
          ? '固定任务匿名验证后选择；未胜出则保留。'
          : '明确保留原方案：候选遗漏计算与约束分析。',
    };
    const proof = await preparePublication(store, scope, command);
    const decision = await publication.commit(
      scope,
      command,
      userMutationAuthority(scope.userId),
      proof,
    );
    const newSelection = await publication.selection(source);
    const newRun = await bindHarnessRun(newSelection.revision, `after-${index}`, {
      agentConfig: source.material.agentConfig,
      promptSegments: [{ kind: 'author', content: baseline }],
    });
    assert.equal((resolveHarnessMaterial(oldRun).agentConfig as any).systemRole, baseline);
    assert.equal(
      (resolveHarnessMaterial(newRun).agentConfig as any).systemRole,
      action === 'adopt' ? candidate : baseline,
    );
    const [unchanged] = await db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.id, agentId), eq(schema.agents.userId, scope.userId)));
    assert.equal(unchanged.systemRole, baseline);
    reports.push({
      experimentId: experiment.id,
      action,
      validation: result.validation,
      comparisons: [...result.comparisons, ...result.validationComparisons].map(
        (c: any) => c.choice,
      ),
      calls: result.attempts.length,
      decision: decision.id,
      originalUnchanged: true,
      oldRunPinned: true,
      newRunRevision: newSelection.revision.id,
    });
    console.log(JSON.stringify(reports.at(-1)));
    if (index === 0 && action === 'adopt') {
      const active = await publication.read(scope);
      await publication.commit(
        scope,
        {
          action: 'rollback',
          id: randomUUID(),
          expectedActiveId: active.active!.id,
          expectedGeneration: active.generation,
          reason: '验证回滚只影响后续运行',
        },
        userMutationAuthority(scope.userId),
      );
      assert.equal((await publication.selection(source)).revision.id, source.id);
      assert.equal((resolveHarnessMaterial(newRun).agentConfig as any).systemRole, candidate);
      // Re-adopt via the same immutable validated proof for the next keep-original transition.
      const rolled = await publication.read(scope);
      await publication.commit(
        scope,
        {
          ...command,
          id: randomUUID(),
          expectedGeneration: rolled.generation,
          expectedActiveId: undefined,
        },
        userMutationAuthority(scope.userId),
        proof,
      );
    }
  }
  // A negative real result is valid evidence. Never force adoption or re-run to obtain a win.
  const report = {
    schemaVersion: 1,
    provider,
    model,
    reports,
    fixedMaximumCalls: keepCase ? 3 : 9,
    adoptionVerified: (reports[0] as any).action === 'adopt',
    rollbackVerified: (reports[0] as any).action === 'adopt',
    validationTier:
      'real model + real AgentRuntime/Cordis context + PostgreSQL publication; synthetic controlled tasks, not general benchmark',
    agentId,
  };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log('REAL_MODEL_ACCEPTANCE_COMPLETED');
} finally {
  await pool.end();
}
