import { describe, expect, it, vi } from 'vitest';

import { BoundedSerialImprovement, type ImprovementStep } from './serial';

const allowance = {
  tokens: 100,
  costMicros: 50,
  proposals: 1,
  probes: 1,
  renders: 3,
  evaluations: 1,
};
const budget = {
  tokens: 200,
  costMicros: 100,
  proposals: 2,
  probes: 2,
  renders: 5,
  evaluations: 2,
};
const step = (
  result: string,
  status: ImprovementStep<string>['status'] = 'completed',
): ImprovementStep<string> => ({
  result,
  status,
  usage: { tokens: 20, costMicros: 10 },
  counts: { proposals: 1, probes: 1, renders: result === 'first' ? 2 : 3, evaluations: 1 },
});
function harness(
  run = vi.fn(async (round: number) => step(round === 1 ? 'first' : 'second')),
  overrides = {},
) {
  const engine = new BoundedSerialImprovement({
    domain: 'presentation',
    budget,
    roundAllowance: allowance,
    incumbent: (result: string) => result,
    run,
    ...overrides,
  });
  return { engine, run };
}
describe('bounded serial improvement protocol', () => {
  it('reserves before effects, reconciles actual use, passes the incumbent and never starts a third round', async () => {
    const progress = vi.fn();
    const h = harness(
      vi.fn(async (round: number, incumbent: string | undefined) => {
        expect(progress).toHaveBeenLastCalledWith(
          round,
          round === 1 ? { tokens: 100, costMicros: 50 } : { tokens: 120, costMicros: 60 },
        );
        expect(incumbent).toBe(round === 1 ? undefined : 'first');
        return step(round === 1 ? 'first' : 'second');
      }),
    );
    expect(await h.engine.run(new AbortController().signal, progress)).toMatchObject({
      status: 'completed',
      selectedRound: 2,
      charged: { tokens: 40, costMicros: 20 },
      counts: { proposals: 2, probes: 2, renders: 5, evaluations: 2 },
    });
    expect(h.run).toHaveBeenCalledTimes(2);
  });
  it.each(['teaching', 'sites'])(
    'supports the %s adapter contract with no domain payload in the coordinator',
    async (domain) => {
      const h = harness(undefined, { domain });
      expect((await h.engine.run(new AbortController().signal)).status).toBe('completed');
    },
  );
  it('retains a completed first round when a settled refinement fails', async () => {
    const h = harness(
      vi.fn(async (round) =>
        step(round === 1 ? 'first' : 'second', round === 1 ? 'completed' : 'failed'),
      ),
    );
    expect(await h.engine.run(new AbortController().signal)).toMatchObject({
      status: 'completed',
      selectedRound: 1,
      rounds: [{ result: 'first' }, { result: 'second' }],
    });
  });
  it('does not repeat a failed initial round', async () => {
    const h = harness(vi.fn(async () => step('first', 'failed')));
    expect((await h.engine.run(new AbortController().signal)).status).toBe('failed');
    expect(h.run).toHaveBeenCalledOnce();
  });
  it.each([
    { tokens: 119 },
    { costMicros: 59 },
    { renders: 4 },
    { proposals: 1 },
    { probes: 1 },
    { evaluations: 1 },
  ])('admits no refinement when the remaining budget cannot cover %j', async (limit) => {
    const h = harness(undefined, { budget: { ...budget, ...limit } });
    expect((await h.engine.run(new AbortController().signal)).status).toBe('budget-exceeded');
    expect(h.run).toHaveBeenCalledOnce();
  });
  it('stops on usage or operation overrun before further effects', async () => {
    for (const malformed of [
      { ...step('first'), usage: { tokens: 101, costMicros: 10 } },
      { ...step('first'), counts: { ...step('first').counts, renders: 4 } },
      { ...step('first'), usage: { tokens: Number.NaN, costMicros: 10 } },
    ]) {
      const h = harness(vi.fn(async () => malformed));
      expect((await h.engine.run(new AbortController().signal)).status).toBe(
        Number.isNaN(malformed.usage.tokens) ? 'failed' : 'budget-exceeded',
      );
      expect(h.run).toHaveBeenCalledOnce();
    }
  });
  it.each(['IMPROVEMENT_CANCELLED', 'IMPROVEMENT_DEADLINE'])(
    'reserves unknown use and drains an uncooperative adapter on %s',
    async (code) => {
      const controller = new AbortController();
      let release!: (value: ImprovementStep<string>) => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const h = harness(
        vi.fn(() => {
          started();
          return new Promise((resolve) => {
            release = resolve;
          });
        }),
      );
      const pending = h.engine.run(controller.signal);
      await ready;
      controller.abort(Object.assign(new Error(code), { code }));
      expect(await pending).toMatchObject({
        status: code.endsWith('DEADLINE') ? 'deadline-exceeded' : 'cancelled',
        charged: { tokens: 100, costMicros: 50 },
        rounds: [],
      });
      let drained = false;
      const drain = h.engine.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      release(step('first'));
      await drain;
      expect(h.run).toHaveBeenCalledOnce();
    },
  );
});
