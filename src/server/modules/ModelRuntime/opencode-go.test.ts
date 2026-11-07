// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CURRENT_VERSION } from '@/const/version';

import { getOpenCodeGoHeaders } from './opencode-go';

const scope = { sessionId: 'private-topic', userId: 'private-user' };

describe('OpenCode Go request identity', () => {
  it.each([
    'https://opencode.ai/inference/go',
    'https://opencode.ai/inference/go/',
    'https://opencode.ai/inference/go/v1',
    'https://opencode.ai/inference/go/v1/chat/completions',
    'https://opencode.ai:443/inference/go/v1',
  ])('identifies only the Go endpoint at %s', (baseURL) => {
    expect(getOpenCodeGoHeaders(baseURL, scope)).toEqual({
      'User-Agent': `Qingzhou/${CURRENT_VERSION}`,
      'x-opencode-session': expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it.each([
    undefined,
    '',
    'invalid',
    'http://opencode.ai/inference/go/v1',
    'https://opencode.ai:8443/inference/go/v1',
    'https://other.example/inference/go/v1',
    'https://opencode.ai.evil.example/inference/go/v1',
    'https://opencode.ai/zen/v1',
    'https://opencode.ai/zen/go/v1',
    'https://opencode.ai/inference/gopher/v1',
    'https://opencode.ai/proxy/inference/go/v1',
    'https://user:password@opencode.ai/inference/go/v1',
  ])('does not change other connections at %s', (baseURL) => {
    expect(getOpenCodeGoHeaders(baseURL, scope)).toEqual({});
  });

  it('keeps the session stable while isolating conversations and users', () => {
    const endpoint = 'https://opencode.ai/inference/go/v1';
    const headers = getOpenCodeGoHeaders(endpoint, scope);
    expect(getOpenCodeGoHeaders(endpoint, { ...scope })).toEqual(headers);
    expect(getOpenCodeGoHeaders(endpoint, { ...scope, sessionId: 'other-topic' })).not.toEqual(
      headers,
    );
    expect(getOpenCodeGoHeaders(endpoint, { ...scope, userId: 'other-user' })).not.toEqual(headers);
    expect(headers['x-opencode-session']).not.toContain(scope.userId);
    expect(headers['x-opencode-session']).not.toContain(scope.sessionId);
    expect(getOpenCodeGoHeaders(endpoint, { userId: 'ab', sessionId: 'c' })).not.toEqual(
      getOpenCodeGoHeaders(endpoint, { userId: 'a', sessionId: 'bc' }),
    );
  });

  it.each([
    { ...scope, userId: '' },
    { ...scope, userId: '  ' },
    { ...scope, sessionId: '' },
    { ...scope, sessionId: '  ' },
  ])('does not create a shared identity from an empty scope %j', (emptyScope) => {
    expect(getOpenCodeGoHeaders('https://opencode.ai/inference/go/v1', emptyScope)).toEqual({});
  });

  it('tolerates an absent scope at runtime without assigning a shared identity', () => {
    expect(
      getOpenCodeGoHeaders(
        'https://opencode.ai/inference/go/v1',
        undefined as unknown as typeof scope,
      ),
    ).toEqual({});
  });
});
