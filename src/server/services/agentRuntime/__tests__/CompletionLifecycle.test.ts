// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StepLeaseLostError } from '@/server/modules/AgentRuntime/stepLease';

import { CompletionLifecycle } from '../CompletionLifecycle';
import { hookDispatcher } from '../hooks';
import type { HookDispatchFailure } from '../hooks/HookDispatcher';

const buildLifecycle = () => new CompletionLifecycle({} as any, 'user-1');

describe('CompletionLifecycle.extractErrorMessage', () => {
  it('extracts message from ChatCompletionErrorPayload (InsufficientBudgetForModel)', () => {
    const lifecycle = buildLifecycle();
    const error = {
      _responseBody: { provider: 'lobehub' },
      error: { message: 'Budget exceeded' },
      errorType: 'InsufficientBudgetForModel',
      provider: 'lobehub',
    };

    expect(lifecycle.extractErrorMessage(error)).toBe('Budget exceeded');
  });

  it('extracts message from ChatCompletionErrorPayload (InvalidProviderAPIKey)', () => {
    const lifecycle = buildLifecycle();
    const error = {
      endpoint: 'https://cdn.example.com/v1',
      error: {
        code: '',
        error: { code: '', message: '无效的令牌', type: 'new_api_error' },
        message: '无效的令牌',
        status: 401,
        type: 'new_api_error',
      },
      errorType: 'InvalidProviderAPIKey',
      provider: 'openai',
    };

    expect(lifecycle.extractErrorMessage(error)).toBe('无效的令牌');
  });

  it('extracts message from formatted ChatMessageError with body.error.message', () => {
    const lifecycle = buildLifecycle();
    const error = {
      body: { error: { message: 'Rate limit exceeded' } },
      message: 'InvalidProviderAPIKey',
      type: 'InvalidProviderAPIKey',
    };

    expect(lifecycle.extractErrorMessage(error)).toBe('Rate limit exceeded');
  });

  it('extracts message from ChatMessageError with body.message', () => {
    const lifecycle = buildLifecycle();
    const error = {
      body: { message: 'Something went wrong' },
      message: 'error',
      type: 'InternalServerError',
    };

    expect(lifecycle.extractErrorMessage(error)).toBe('Something went wrong');
  });

  it('falls back to error.message when body is absent', () => {
    const lifecycle = buildLifecycle();
    const error = { message: 'Connection timeout', type: 'NetworkError' };

    expect(lifecycle.extractErrorMessage(error)).toBe('Connection timeout');
  });

  it('falls back to errorType when message is "error"', () => {
    const lifecycle = buildLifecycle();
    const error = { errorType: 'InsufficientBudgetForModel', message: 'error' };

    expect(lifecycle.extractErrorMessage(error)).toBe('InsufficientBudgetForModel');
  });

  it('returns undefined for null/undefined', () => {
    const lifecycle = buildLifecycle();

    expect(lifecycle.extractErrorMessage(null)).toBeUndefined();
    expect(lifecycle.extractErrorMessage(undefined)).toBeUndefined();
  });

  it('never returns [object Object] for nested error objects', () => {
    const lifecycle = buildLifecycle();
    const error = {
      _responseBody: { provider: 'lobehub' },
      error: { message: 'Budget exceeded' },
      errorType: 'InsufficientBudgetForModel',
      provider: 'lobehub',
    };

    const result = lifecycle.extractErrorMessage(error);
    expect(result).not.toBe('[object Object]');
    expect(typeof result).toBe('string');
    expect(result).toBe('Budget exceeded');
  });
});

describe('CompletionLifecycle.dispatchHooks result', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns successful delivery and unregisters terminal hooks', async () => {
    const lifecycle = buildLifecycle();
    vi.spyOn(lifecycle as any, 'persistCompletion').mockResolvedValue(undefined);
    vi.spyOn(hookDispatcher, 'dispatch').mockResolvedValue({ success: true, failures: [] });
    const unregister = vi.spyOn(hookDispatcher, 'unregister');

    await expect(lifecycle.dispatchHooks('op-success', { metadata: {} }, 'done')).resolves.toEqual({
      success: true,
      failures: [],
    });
    expect(unregister).toHaveBeenCalledWith('op-success');
  });

  it('does not dispatch or unregister hooks if the lease is lost during completion persistence', async () => {
    const lifecycle = buildLifecycle();
    let held = true;
    vi.spyOn(lifecycle as any, 'persistCompletion').mockImplementation(async () => {
      held = false;
    });
    const dispatch = vi.spyOn(hookDispatcher, 'dispatch');
    const unregister = vi.spyOn(hookDispatcher, 'unregister');
    const assertStepLease = () => {
      if (!held) throw new StepLeaseLostError();
    };

    await expect(
      lifecycle.dispatchHooks('op-lost', { metadata: {} }, 'done', assertStepLease),
    ).rejects.toBeInstanceOf(StepLeaseLostError);
    expect(dispatch).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
  });

  it('returns completion and error delivery failures without changing the terminal state', async () => {
    const lifecycle = buildLifecycle();
    vi.spyOn(lifecycle as any, 'persistCompletion').mockResolvedValue(undefined);
    const completionFailure: HookDispatchFailure = {
      code: 'QSTASH_PUBLISH_FAILED',
      delivery: 'qstash',
      hookId: 'completion',
      hookType: 'onComplete',
      operationId: 'op-failed',
    };
    const errorFailure: HookDispatchFailure = {
      ...completionFailure,
      hookId: 'error',
      hookType: 'onError',
    };
    const dispatch = vi
      .spyOn(hookDispatcher, 'dispatch')
      .mockResolvedValueOnce({ success: false, failures: [completionFailure] })
      .mockResolvedValueOnce({ success: false, failures: [errorFailure] });
    const unregister = vi.spyOn(hookDispatcher, 'unregister');
    const state = { metadata: {}, status: 'error', stepCount: 2 };

    await expect(lifecycle.dispatchHooks('op-failed', state, 'error')).resolves.toEqual({
      success: false,
      failures: [completionFailure, errorFailure],
    });
    expect(state).toEqual({ metadata: {}, status: 'error', stepCount: 2 });
    expect(dispatch.mock.calls.map(([, type]) => type)).toEqual(['onComplete', 'onError']);
    expect(unregister).toHaveBeenCalledWith('op-failed');
  });
});
