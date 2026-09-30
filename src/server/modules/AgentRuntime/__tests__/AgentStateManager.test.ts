import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentStateManager } from '../AgentStateManager';
import {
  COMMIT_STEP_LEASE_SCRIPT,
  RELEASE_STEP_LEASE_SCRIPT,
  RENEW_STEP_LEASE_SCRIPT,
  StepLeaseBackendError,
} from '../stepLease';
import { type StepLease } from '../types';

// Mock Redis client
vi.mock('../redis', () => ({
  getAgentRuntimeRedisClient: () => ({
    del: vi.fn(),
    eval: vi.fn(),
    set: vi.fn(),
    expire: vi.fn(),
    get: vi.fn(),
    hgetall: vi.fn(),
    hmset: vi.fn(),
    keys: vi.fn(),
    multi: vi.fn(() => ({
      exec: vi.fn(),
      expire: vi.fn(),
      hmset: vi.fn(),
      lpush: vi.fn(),
      ltrim: vi.fn(),
      setex: vi.fn(),
    })),
    quit: vi.fn(),
    setex: vi.fn(),
  }),
}));

describe('AgentStateManager', () => {
  let stateManager: AgentStateManager;

  beforeEach(() => {
    vi.clearAllMocks();
    stateManager = new AgentStateManager();
  });

  describe('createOperationMetadata', () => {
    it('should create operation metadata successfully', async () => {
      const operationId = 'test-operation-id';
      const data = {
        agentConfig: { test: true },
        modelRuntimeConfig: { model: 'gpt-4' },
        userId: 'user-123',
      };

      await expect(stateManager.createOperationMetadata(operationId, data)).resolves.not.toThrow();
    });
  });

  describe('saveAgentState', () => {
    it('should save agent state successfully', async () => {
      const operationId = 'test-operation-id';
      const state = {
        cost: { total: 100 },
        status: 'done' as const,
        stepCount: 5,
      };

      await expect(stateManager.saveAgentState(operationId, state as any)).resolves.not.toThrow();
    });

    it('should save agent state with running status', async () => {
      const operationId = 'test-operation-id';
      const state = {
        cost: { total: 50 },
        status: 'running' as const,
        stepCount: 3,
      };

      await expect(stateManager.saveAgentState(operationId, state as any)).resolves.not.toThrow();
    });
  });

  describe('saveStepResult', () => {
    it('should save step result successfully when status is done', async () => {
      const operationId = 'test-operation-id';
      const stepResult = {
        executionTime: 1000,
        newState: {
          cost: { total: 200 },
          status: 'done' as const,
          stepCount: 10,
        },
        stepIndex: 10,
      };

      await expect(
        stateManager.saveStepResult(operationId, stepResult as any),
      ).resolves.not.toThrow();
    });

    it('should save step result successfully when status is not done', async () => {
      const operationId = 'test-operation-id';
      const stepResult = {
        executionTime: 500,
        newState: {
          cost: { total: 75 },
          status: 'running' as const,
          stepCount: 3,
        },
        stepIndex: 3,
      };

      await expect(
        stateManager.saveStepResult(operationId, stepResult as any),
      ).resolves.not.toThrow();
    });
  });
  describe('owned step leases', () => {
    const lease: StepLease = { operationId: 'op', ownerToken: 'owner', stepIndex: 2 };
    const state = { cost: { total: 3 }, status: 'running', stepCount: 3 } as any;
    const redis = () => (stateManager as any).redis;

    afterEach(() => vi.useRealTimers());

    it('acquires a unique opaque token using atomic NX/PX and distinguishes contention', async () => {
      redis()
        .set.mockResolvedValueOnce('OK')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('OK');
      const first = await stateManager.acquireStepLease('op', 2);
      expect(first).toEqual({ operationId: 'op', ownerToken: expect.any(String), stepIndex: 2 });
      expect(redis().set).toHaveBeenCalledWith(
        'agent_runtime_step_lock:op:2',
        first!.ownerToken,
        'PX',
        35000,
        'NX',
      );
      expect(await stateManager.acquireStepLease('op', 2)).toBeNull();
      const next = await stateManager.acquireStepLease('op', 2, 10);
      expect(next!.ownerToken).not.toBe(first!.ownerToken);
      expect(redis().set).toHaveBeenLastCalledWith(
        'agent_runtime_step_lock:op:2',
        next!.ownerToken,
        'PX',
        10000,
        'NX',
      );
    });

    it('preserves a replacement owner under concurrent acquisition and stale-worker cleanup', async () => {
      vi.useFakeTimers();
      // Model Redis NX/PX and compare-token script responses. The exact script
      // ownership predicate and commands are asserted separately below.
      const locks = new Map<string, { expiresAt: number; token: string }>();
      redis().set.mockImplementation(
        async (key: string, token: string, _px: string, ttl: number) => {
          const current = locks.get(key);
          if (current && current.expiresAt > Date.now()) return null;
          locks.set(key, { expiresAt: Date.now() + ttl, token });
          return 'OK';
        },
      );
      redis().eval.mockImplementation(
        async (script: string, _count: number, key: string, token: string, ttl?: number) => {
          const current = locks.get(key);
          if (!current || current.expiresAt <= Date.now() || current.token !== token) return 0;
          if (script === RENEW_STEP_LEASE_SCRIPT) current.expiresAt = Date.now() + ttl!;
          else if (script === RELEASE_STEP_LEASE_SCRIPT) locks.delete(key);
          else throw new Error('Unexpected script');
          return 1;
        },
      );
      const claims = await Promise.all(
        Array.from({ length: 20 }, () => stateManager.acquireStepLease('op', 2)),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      const old = claims.find(Boolean)!;
      vi.advanceTimersByTime(35000);
      expect(await stateManager.renewStepLease(old)).toBe(false);
      const current = (await stateManager.acquireStepLease('op', 2))!;
      expect(current.ownerToken).not.toBe(old.ownerToken);
      expect(await stateManager.releaseStepLease(old)).toBe(false);
      expect(await stateManager.renewStepLease(old)).toBe(false);
      expect(await stateManager.acquireStepLease('op', 2)).toBeNull();
      expect(await stateManager.renewStepLease(current)).toBe(true);
      expect(await stateManager.releaseStepLease(current)).toBe(true);
    });

    it('renews and releases with token comparison scripts, never blind DEL', async () => {
      redis()
        .eval.mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);
      expect(await stateManager.renewStepLease(lease, 20)).toBe(true);
      expect(redis().eval).toHaveBeenLastCalledWith(
        RENEW_STEP_LEASE_SCRIPT,
        1,
        'agent_runtime_step_lock:op:2',
        'owner',
        20000,
      );
      expect(await stateManager.renewStepLease(lease)).toBe(false);
      expect(await stateManager.releaseStepLease(lease)).toBe(true);
      expect(redis().eval).toHaveBeenLastCalledWith(
        RELEASE_STEP_LEASE_SCRIPT,
        1,
        'agent_runtime_step_lock:op:2',
        'owner',
      );
      expect(await stateManager.releaseStepLease(lease)).toBe(false);
      expect(redis().del).not.toHaveBeenCalled();
      for (const script of [
        RENEW_STEP_LEASE_SCRIPT,
        RELEASE_STEP_LEASE_SCRIPT,
        COMMIT_STEP_LEASE_SCRIPT,
      ]) {
        expect(script.trim().split('\n')[0]).toBe(
          "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
        );
      }
    });

    it.each(['acquire', 'renew', 'release', 'commit'] as const)(
      'fails closed on %s backend errors',
      async (action) => {
        const cause = new Error('Redis unavailable secret-address');
        redis().set.mockRejectedValue(cause);
        redis().eval.mockRejectedValue(cause);
        const promise =
          action === 'acquire'
            ? stateManager.acquireStepLease('op', 2)
            : action === 'renew'
              ? stateManager.renewStepLease(lease)
              : action === 'release'
                ? stateManager.releaseStepLease(lease)
                : stateManager.saveAgentStateWithLease('op', state, lease);
        await expect(promise).rejects.toBeInstanceOf(StepLeaseBackendError);
        await expect(promise).rejects.toMatchObject({
          message: `Step lease backend failed to ${action}`,
        });
      },
    );

    it.each(['acquire', 'renew', 'release', 'stateCommit', 'resultCommit'] as const)(
      'bounds hung %s calls to 5s and ignores late success',
      async (action) => {
        vi.useFakeTimers();
        let resolve!: (value: number | string) => void;
        const hung = new Promise<number | string>((done) => {
          resolve = done;
        });
        redis().set.mockReturnValue(hung);
        redis().eval.mockReturnValue(hung);
        const completed = vi.fn();
        const pending = (
          action === 'acquire'
            ? stateManager.acquireStepLease('op', 2)
            : action === 'renew'
              ? stateManager.renewStepLease(lease)
              : action === 'release'
                ? stateManager.releaseStepLease(lease)
                : action === 'stateCommit'
                  ? stateManager.saveAgentStateWithLease('op', state, lease)
                  : stateManager.saveStepResultWithLease(
                      'op',
                      { executionTime: 1, newState: state, stepIndex: 2 },
                      lease,
                    )
        ).then(completed);
        const expectedAction = action.endsWith('Commit') ? 'commit' : action;
        const rejected = expect(pending).rejects.toMatchObject({
          message: `Step lease backend failed to ${expectedAction}`,
          name: 'StepLeaseBackendError',
        });
        await vi.advanceTimersByTimeAsync(4999);
        expect(completed).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        expect(vi.getTimerCount()).toBe(0);
        resolve(action === 'acquire' ? 'OK' : 1);
        await Promise.resolve();
        await Promise.resolve();
        expect(completed).not.toHaveBeenCalled();
        await expect(pending).rejects.toBeInstanceOf(StepLeaseBackendError);
      },
    );

    it('commits state and metadata with the owner check in one Lua execution', async () => {
      redis().eval.mockResolvedValue(1);
      expect(await stateManager.saveAgentStateWithLease('op', state, lease)).toBe(true);
      expect(redis().eval).toHaveBeenCalledWith(
        COMMIT_STEP_LEASE_SCRIPT,
        5,
        'agent_runtime_step_lock:op:2',
        'agent_runtime_state:op',
        'agent_runtime_meta:op',
        'agent_runtime_steps:op',
        'agent_runtime_events:op',
        'owner',
        7200,
        JSON.stringify(state),
        expect.any(String),
        'running',
        3,
        3,
        '',
        '',
        2,
        0,
      );
      expect(COMMIT_STEP_LEASE_SCRIPT).toContain("redis.call('HSET', KEYS[3]");
      expect(COMMIT_STEP_LEASE_SCRIPT).toContain(
        'nextStep < previousStep or previousStep > leaseStep + 1',
      );
      expect(COMMIT_STEP_LEASE_SCRIPT).toContain("ARGV[11] == '1' and previousStep ~= leaseStep");
      expect(redis().setex).not.toHaveBeenCalled();
      expect(redis().hmset).not.toHaveBeenCalled();
      redis().eval.mockResolvedValue(0);
      expect(await stateManager.saveAgentStateWithLease('op', state, lease)).toBe(false);
    });

    it('also fences history and events with the step result', async () => {
      redis().eval.mockResolvedValue(1);
      const result = {
        events: [{ type: 'test' }],
        executionTime: 50,
        newState: state,
        stepIndex: 2,
      } as any;
      expect(await stateManager.saveStepResultWithLease('op', result, lease)).toBe(true);
      const args = redis().eval.mock.calls[0];
      expect(JSON.parse(args.at(-4))).toMatchObject({ cost: 3, executionTime: 50, stepIndex: 2 });
      expect(JSON.parse(args.at(-3))).toEqual(result.events);
      expect(redis().multi).not.toHaveBeenCalled();
      redis().eval.mockResolvedValue(0);
      expect(await stateManager.saveStepResultWithLease('op', result, lease)).toBe(false);
    });

    it('rejects mismatched operations and step indices before writing', async () => {
      await expect(stateManager.saveAgentStateWithLease('other', state, lease)).rejects.toThrow(
        'operation mismatch',
      );
      await expect(
        stateManager.saveStepResultWithLease('op', { newState: state, stepIndex: 9 } as any, lease),
      ).rejects.toThrow('index mismatch');
      expect(redis().eval).not.toHaveBeenCalled();
    });

    it.each([0, -1, NaN, Infinity])('rejects invalid TTL %s', async (ttl) => {
      await expect(stateManager.acquireStepLease('op', 2, ttl)).rejects.toBeInstanceOf(RangeError);
      await expect(stateManager.renewStepLease(lease, ttl)).rejects.toBeInstanceOf(RangeError);
      expect(redis().set).not.toHaveBeenCalled();
      expect(redis().eval).not.toHaveBeenCalled();
    });
  });
});
