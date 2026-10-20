import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PresentationCollaborationInput } from './collaboration-plugin';
import { FilePresentationStorage } from './file-storage';
import { PresentationGenerationPort } from './generation-port';

const scope = { userId: 'owner', sessionId: 'workspace', request: new Request('http://localhost') };

describe('foreground recovery across task executors', () => {
  it.each([false, true])(
    'honours a foreground peer and does not replay it after remote close=%s',
    async (close) => {
      const root = await mkdtemp(path.join(tmpdir(), 'qingzhou-presence-'));
      const target = path.resolve(root);
      if (!target.startsWith(path.join(path.resolve(tmpdir()), 'qingzhou-presence-')))
        throw new Error('Unexpected temporary directory');
      let ready = false;
      let fail!: (error: Error) => void;
      const hook = vi.fn(async (_value: PresentationCollaborationInput) => ({
        action: 'ask' as const,
        category: 'quality' as const,
      }));
      const ports = Array.from({ length: 3 }, (_, index) => {
        const repository = new FilePresentationStorage(root);
        return new PresentationGenerationPort(
          {
            artifactStore: repository,
            repository,
            collaborationHook: hook,
            idFactory: () => 'job',
            capability: {
              execute: vi.fn(async () => {
                if (index !== 0) throw new Error('A passive observer must never execute');
                ready = true;
                return new Promise((_resolve, reject) => {
                  fail = reject;
                });
              }),
              plan: vi.fn(),
            } as never,
            contextFactory: () => ({
              plannerContext: {},
              workerContext: {
                jobId: 'unused',
                workspace: { path: '/tmp', write: vi.fn() },
                convert: vi.fn(),
                qualityCheck: vi.fn(),
              },
            }),
          },
          scope,
        );
      });
      try {
        const [owner, foregroundPeer, backgroundPeer] = ports;
        await owner.createJob({
          title: 'report',
          notebookId: 'n',
          sourceVersionIds: [],
          slideCount: 1,
        });
        await vi.waitFor(() => expect(ready).toBe(true));
        await foregroundPeer.getJob('job');
        await backgroundPeer.getJob('job');
        await foregroundPeer.updatePresence('job', {
          tabId: 'active-tab',
          visible: true,
          focused: true,
        });
        await backgroundPeer.updatePresence('job', {
          tabId: 'idle-tab',
          visible: false,
          focused: false,
        });
        if (close) {
          await backgroundPeer.updatePresence('job', {
            tabId: 'active-tab',
            visible: false,
            focused: false,
          });
          // This writer still caches active-tab=true. Updating a different tab must not replay it.
          await foregroundPeer.updatePresence('job', {
            tabId: 'other-idle-tab',
            visible: false,
            focused: false,
          });
        }
        fail(Object.assign(new Error('Layout needs a decision'), { code: 'PLAN_INVALID' }));
        await vi.waitFor(() => expect(hook).toHaveBeenCalled());
        expect(hook.mock.calls[0][0].foreground).toBe(!close);
        expect((await owner.getJob('job'))?.state).toBe('waiting_input');
      } finally {
        await Promise.all(ports.map((port) => port.dispose()));
        await rm(target, { recursive: true, force: true });
      }
    },
  );
});
