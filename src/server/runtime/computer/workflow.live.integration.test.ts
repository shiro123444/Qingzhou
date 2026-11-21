// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';

import { AgentRuntime, GeneralChatAgent } from '@lobechat/agent-runtime';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MessageModel } from '@/database/models/message';
import { agentRuntimeCheckpoints, agents, topics, users } from '@/database/schemas';
import { AgentComputerService } from '@/server/services/agentComputer';
import { HumanInterventionHandler } from '@/server/services/agentRuntime/HumanInterventionHandler';
import type { ComputerActor } from '@/types/agentComputer';

import { createComputerAgentTools } from './agent-tools';
import { runDocker } from './docker/driver';
import { computerManifest, ComputerToolIdentifier } from './manifest';
import { getComputerProviderRegistration } from './provider';
import { NativeComputerRuntime } from './runtime';

describe.skipIf(process.env.QINGZHOU_COMPUTER_ACCEPTANCE !== '1')(
  'Browser and production HITL live workflow',
  () => {
    const scope = { userId: `workflow-${randomUUID()}`, agentId: `agent-${randomUUID()}` };
    let db: Awaited<ReturnType<typeof getTestDB>>, service: AgentComputerService, resource: string;
    const registration = () => getComputerProviderRegistration()!;
    const runtime = (actor: ComputerActor = 'human') =>
      new NativeComputerRuntime(db, scope, registration(), {
        actor,
        authorize: async () => undefined,
      });
    const html = `<!doctype html><html><body><h1>Computer login fixture</h1><input aria-label="Name" id="name"><button onclick="localStorage.setItem('name',document.getElementById('name').value);document.cookie='signed-in=yes; Max-Age=86400; Path=/';document.getElementById('result').textContent='Signed in: '+localStorage.getItem('name')">Sign in</button><p id="result"></p><input type="range" aria-label="Drag slider" min="0" max="100" value="0" style="width:200px" oninput="document.getElementById('result').textContent='Dragged '+this.value"><script>if(localStorage.getItem('name'))document.getElementById('result').textContent='Signed in: '+localStorage.getItem('name');</script></body></html>`;
    const fixture = async () =>
      expect(
        (
          await runDocker(
            [
              'container',
              'exec',
              '-d',
              resource,
              'node',
              '-e',
              `require('node:http').createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(${JSON.stringify(html)});}).listen(18766,'127.0.0.1');`,
            ],
            AbortSignal.timeout(5000),
          )
        ).code,
      ).toBe(0);
    const observe = async () => {
      const view = await runtime().store.view();
      return (await service.observe(scope.agentId, view.session!.revision)).frame;
    };
    const human = async (input: unknown) => {
      const view = await runtime().store.view();
      return service.manage({
        agentId: scope.agentId,
        command: { kind: 'browser', input },
        expectedRevision: view.session!.revision,
        requestId: randomUUID(),
      });
    };
    beforeAll(async () => {
      if (process.env.TEST_SERVER_DB !== '0' || !process.env.DOCKER_HOST?.startsWith('unix://'))
        throw new Error('ISOLATED_DATABASE_AND_ENGINE_REQUIRED');
      vi.stubEnv('QINGZHOU_COMPUTER_ENABLED', '1');
      vi.stubEnv('AGENT_RUNTIME_MODE', 'native');
      vi.stubEnv('QINGZHOU_COMPUTER_AGENT_POLICY', 'ask');
      db = await getTestDB();
      await db.insert(users).values({ id: scope.userId });
      await db.insert(agents).values({ id: scope.agentId, userId: scope.userId });
      service = new AgentComputerService(db, scope.userId);
      await runtime().execute({ kind: 'ensure' }, 'ensure');
      const session = (await runtime().store.view()).session!;
      resource = `qz-cmp-${createHash('sha256').update(JSON.stringify(session.id)).digest('hex').slice(0, 32)}`;
      await fixture();
    }, 30000);
    afterAll(async () => {
      if (resource) {
        await runDocker(['container', 'rm', '--force', resource], AbortSignal.timeout(10000));
        expect(
          (await runDocker(['volume', 'rm', `${resource}-data`], AbortSignal.timeout(10000))).code,
        ).toBe(0);
      }
      vi.unstubAllEnvs();
    }, 30000);

    it('uses real Chromium frames, click and text input to sign in, preserving the profile across sleep', async () => {
      expect(await observe()).toEqual({ running: false });
      await runtime().execute({ kind: 'control', target: 'human' }, 'take-browser');
      await human({ action: 'start' });
      await human({ action: 'navigate', url: 'http://127.0.0.1:18766/' });
      let frame = await observe();
      if (!frame.running) throw new Error('BROWSER_NOT_RUNNING');
      expect(frame.image.startsWith('/9j/')).toBe(true);
      const field = frame.controls.find((item) => item.name === 'Name')!;
      expect(field).toBeTruthy();
      await human({ action: 'click', x: field.x, y: field.y });
      await human({ action: 'text', text: 'Temporary' });
      await human({ action: 'key', key: 'a', modifiers: 2 });
      await human({ action: 'text', text: 'Acceptance User' });
      const button = frame.controls.find((item) => item.name === 'Sign in')!;
      await human({ action: 'click', x: button.x, y: button.y });
      frame = await observe();
      expect(frame.running && frame.text).toContain('Signed in: Acceptance User');
      const beforeDrag = await observe();
      if (!beforeDrag.running) throw new Error('BROWSER_NOT_RUNNING');
      const slider = beforeDrag.controls.find((item) => item.name === 'Drag slider')!;
      await human({
        action: 'drag',
        x: slider.x - 90,
        y: slider.y,
        endX: slider.x + 90,
        endY: slider.y,
      });
      const afterDrag = await observe();
      expect(afterDrag.running && afterDrag.text).toMatch(/Dragged [1-9]/);
      await runtime().execute({ kind: 'sleep' }, 'sleep-browser');
      await runtime().execute({ kind: 'wake' }, 'wake-browser');
      await fixture();
      await human({ action: 'start' });
      await human({ action: 'navigate', url: 'http://127.0.0.1:18766/' });
      frame = await observe();
      expect(frame.running && frame.text).toContain('Signed in: Acceptance User');
    }, 30000);

    it('revokes old human inputs and frames when control is returned, then allows Agent browser input', async () => {
      const old = (await runtime().store.view()).session!.revision;
      await runtime().execute({ kind: 'control', target: 'agent' }, 'return-browser');
      await expect(
        service.manage({
          agentId: scope.agentId,
          command: { kind: 'browser', input: { action: 'text', text: 'stale' } },
          expectedRevision: old,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'STALE' });
      await expect(service.observe(scope.agentId, old)).rejects.toMatchObject({ code: 'STALE' });
      await runtime('agent').execute(
        { kind: 'browser', input: { action: 'reload' } },
        'agent-reload',
      );
      const frame = await observe();
      expect(frame.running && frame.text).toContain('Signed in: Acceptance User');
    }, 30000);

    it('runs the actual human intervention handler and native tool only after approval, once', async () => {
      const topicId = randomUUID(),
        operationId = randomUUID(),
        toolCallId = randomUUID();
      await db.insert(topics).values({ id: topicId, ...scope });
      const payload = {
        id: toolCallId,
        identifier: ComputerToolIdentifier,
        apiName: 'execute',
        arguments: JSON.stringify({
          command: { kind: 'shell', command: 'printf approved >> /workspace/approved-once' },
        }),
        type: 'builtin' as const,
      };
      const state = AgentRuntime.createInitialState({
        operationId,
        status: 'running',
        metadata: { ...scope, topicId, operationId },
        messages: [
          {
            id: randomUUID(),
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: toolCallId,
                type: 'function',
                function: {
                  name: `${ComputerToolIdentifier}____execute`,
                  arguments: payload.arguments,
                },
              },
            ],
          },
        ],
        toolManifestMap: { [ComputerToolIdentifier]: computerManifest() },
        userInterventionConfig: { approvalMode: 'headless' },
      });
      const agent = new GeneralChatAgent({
        operationId,
        modelRuntimeConfig: { model: 'deepseek-v4.1-flash', provider: 'nexus' },
        mandatoryInterventionTools: [ComputerToolIdentifier],
      });
      expect(
        await agent.runner(
          {
            phase: 'llm_result',
            payload: { hasToolsCalling: true, toolsCalling: [payload], parentMessageId: 'parent' },
          },
          state,
        ),
      ).toMatchObject([{ type: 'request_human_approve' }]);
      const model = new MessageModel(db, scope.userId);
      const toolMessage = await model.create({
        agentId: scope.agentId,
        topicId,
        role: 'tool',
        content: '',
        plugin: payload,
        tool_call_id: toolCallId,
        pluginIntervention: { status: 'pending' },
      });
      state.status = 'waiting_for_human';
      state.pendingToolsCalling = [payload];
      await db.insert(agentRuntimeCheckpoints).values({
        id: operationId,
        userId: scope.userId,
        state,
        metadata: { ...scope, topicId, status: 'waiting_for_human' },
        leaseUntil: new Date(Date.now() + 60000),
        leaseOwner: randomUUID(),
      });
      const tools = createComputerAgentTools({
        ...scope,
        topicId,
        operationId,
        toolCallId,
        serverDB: db,
        computerAllowed: true,
        assertStepLease: () => undefined,
        toolManifestMap: {},
      });
      await expect(tools.execute(JSON.parse(payload.arguments))).rejects.toThrow(
        'AUTHORITY_REQUIRED',
      );
      const handler = new HumanInterventionHandler(db, model);
      const accepted = await handler.validate(state, {
        approvedToolCall: payload,
        toolMessageId: toolMessage.id,
      });
      const resumed = await handler.process(state, accepted);
      expect(resumed.nextContext?.phase).toBe('human_approved_tool');
      await db
        .update(agentRuntimeCheckpoints)
        .set({ state: resumed.newState, metadata: { ...scope, topicId, status: 'running' } })
        .where(eq(agentRuntimeCheckpoints.id, operationId));
      expect((await tools.execute(JSON.parse(payload.arguments))).success).toBe(true);
      expect((await tools.execute(JSON.parse(payload.arguments))).success).toBe(true);
      expect(
        await runtime('agent').execute(
          { kind: 'shell', command: 'cat /workspace/approved-once' },
          'approval-proof',
        ),
      ).toMatchObject({ exitCode: 0, stdout: 'approved' });
    }, 30000);
  },
);
