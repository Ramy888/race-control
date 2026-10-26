import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorizationUrl, callbackHandler } from '../src/oauth.js';
import { config } from './helpers.js';

function response() {
  const result = { status: 200, body: '', headers: new Map<string, string>() };
  const res = {
    setHeader: (key: string, value: string) => result.headers.set(key, value),
    writeHead: (status: number) => { result.status = status; return res; },
    end: (body: string) => { result.body = body; },
  };
  return { result, res: res as unknown as ServerResponse };
}
const req = (url: string, method = 'GET') => ({ url, method }) as IncomingMessage;

test('authorization URLs use the exact scopes, code flow, state and forced consent', () => {
  const bot = new URL(authorizationUrl(config, 'bot', 'random-state'));
  assert.equal(bot.origin + bot.pathname, 'https://id.twitch.tv/oauth2/authorize');
  assert.equal(bot.searchParams.get('scope'), 'user:read:chat user:write:chat user:bot');
  assert.equal(bot.searchParams.get('response_type'), 'code');
  assert.equal(bot.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(bot.searchParams.get('state'), 'random-state');
  assert.equal(bot.searchParams.get('force_verify'), 'true');
  assert.ok(!bot.href.includes(config.clientSecret));
  assert.equal(new URL(authorizationUrl(config, 'broadcaster', 'state')).searchParams.get('scope'), 'channel:bot');
});

test('callback rejects invalid state/path/method, consumes a code once, and never prints it', async () => {
  const codes: string[] = [];
  let finished = 0;
  const handler = callbackHandler('state', async code => { codes.push(code); }, () => { finished++; });
  for (const [url, method, status] of [
    ['/favicon.ico', 'GET', 404], ['/callback?state=state&code=code', 'POST', 404],
    ['/callback?state=wrong&code=code', 'GET', 400], ['/callback?code=code', 'GET', 400],
    ['http://[invalid', 'GET', 400],
  ] as const) {
    const r = response();
    await handler(req(url, method), r.res);
    assert.equal(r.result.status, status);
  }
  assert.equal(codes.length, 0);
  assert.equal(finished, 0);
  const success = response();
  await handler(req('/callback?state=state&code=private-code'), success.res);
  assert.deepEqual(codes, ['private-code']);
  assert.equal(finished, 1);
  assert.equal(success.result.headers.get('Cache-Control'), 'no-store');
  assert.ok(!success.result.body.includes('private-code'));
  const duplicate = response();
  await handler(req('/callback?state=state&code=private-code'), duplicate.res);
  assert.equal(duplicate.result.status, 409);
});

test('callback handles denial, missing codes and failed exchanges without leaking errors', async () => {
  for (const query of ['error=access_denied', '', 'code=private-code']) {
    let error: Error | undefined;
    const handler = callbackHandler('state', async () => { throw new Error('private-secret'); }, value => { error = value; });
    const r = response();
    await handler(req(`/callback?state=state&${query}`), r.res);
    assert.equal(r.result.status, 400);
    assert.ok(error);
    assert.ok(!error.message.includes('private-secret'));
    assert.ok(!r.result.body.includes('private-secret'));
  }
});
