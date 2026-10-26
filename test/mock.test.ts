import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse, createServer } from 'node:http';
import { mockChatHandler, parseMockChat, startMockServer } from '../src/mock.js';
import { loadConfig } from '../src/config.js';
import { simulateCrowd } from '../src/simulator.js';
import type { ChatInput } from '../src/commands.js';

test('mock config needs no Twitch values and defaults PORT and broadcaster', () => {
  const config = loadConfig({ MOCK: '1' });
  assert.equal(config.port, 3000);
  assert.equal(config.broadcasterLogin, 'streamer');
  assert.equal(config.mock, true);
  assert.equal(config.clientId, '');
  assert.equal(loadConfig({ MOCK: '1', PORT: '4000', BROADCASTER_LOGIN: 'StReAmEr' }).broadcasterLogin, 'streamer');
  assert.throws(() => loadConfig({ MOCK: '1', PORT: 'oops' }), /PORT/);
  assert.throws(() => loadConfig({ MOCK: '1', BROADCASTER_LOGIN: '@bad' }), /BROADCASTER_LOGIN/);
  assert.throws(() => loadConfig({ MOCK: '0' }), /TWITCH_CLIENT_ID/);
});

function response() {
  const result = { status: 200, body: '' };
  const res = {
    setHeader: () => {},
    writeHead: (status: number) => { result.status = status; return res; },
    end: (body: string) => { result.body = body; },
  };
  return { result, res: res as unknown as ServerResponse };
}
const request = (body: string, method = 'POST', url = '/mock/chat') =>
  Object.assign(Readable.from([Buffer.from(body)]), { method, url }) as unknown as IncomingMessage;

test('mock endpoint accepts valid input and normalizes login/userId', async () => {
  const chats: ChatInput[] = [];
  const handler = mockChatHandler(async chat => { chats.push(chat); });
  const r = response();
  await handler(request(JSON.stringify({ user: 'Viewer01', text: '!pick 2' })), r.res);
  assert.equal(r.result.status, 200);
  assert.deepEqual(chats, [{ userId: 'viewer01', login: 'viewer01', text: '!pick 2' }]);
  assert.deepEqual(JSON.parse(r.result.body), { accepted: true });
  assert.ok(parseMockChat({ user: 'x'.repeat(25), text: 'x'.repeat(500) }));
});

test('mock endpoint rejects invalid users, long text, malformed and oversized bodies', async () => {
  const handler = mockChatHandler(async () => assert.fail('invalid input reached handler'));
  for (const body of [
    ...['bad user', '@viewer', '', 'x'.repeat(26)].map(user => JSON.stringify({ user, text: '!yes' })),
    JSON.stringify({ user: 'viewer', text: 'x'.repeat(501) }),
    JSON.stringify({ user: 42, text: '!yes' }), JSON.stringify({ user: 'viewer', text: null }),
    'null', '[]', '{broken', 'x'.repeat(8193),
  ]) {
    const r = response(); await handler(request(body), r.res);
    assert.equal(r.result.status, 400);
  }
  const missing = response(); await handler(request('{}', 'GET'), missing.res);
  assert.equal(missing.result.status, 404);
  const failed = response();
  await mockChatHandler(async () => { throw new Error('disk error'); })(request('{"user":"viewer","text":"!yes"}'), failed.res);
  assert.equal(failed.result.status, 500);
});

test('mock server binds only to 127.0.0.1 without network in the test', () => {
  let listener: unknown;
  let address: unknown[] = [];
  const server = { listen: (...args: unknown[]) => { address = args; } };
  const factory = ((handler: unknown) => { listener = handler; return server; }) as unknown as typeof createServer;
  assert.equal(startMockServer(3000, async () => {}, factory), server);
  assert.equal(typeof listener, 'function');
  assert.deepEqual(address, [3000, '127.0.0.1']);
});

test('crowd simulator posts a pick then a prediction per viewer with injected delays and fetch', async () => {
  const calls: { user: string; text: string }[] = [];
  const delays: number[] = [];
  await simulateCrowd(20, 3456, async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:3456/mock/chat');
    assert.equal(init?.method, 'POST');
    calls.push(JSON.parse(init!.body as string));
    return new Response('{}');
  }, async ms => { delays.push(ms); }, () => 0.9);
  assert.equal(calls.length, 40);
  assert.equal(delays.length, 40);
  assert.ok(delays.every(ms => ms >= 50 && ms < 300));
  for (let i = 1; i <= 20; i++) {
    assert.deepEqual(calls.filter(call => call.user === `viewer${String(i).padStart(2, '0')}`).map(call => call.text), ['!pick 3', '!no']);
  }
  for (const count of [0, -1, 1.5, NaN, 1001]) await assert.rejects(simulateCrowd(count, 3000), /count/);
  await assert.rejects(simulateCrowd(1, 3000, async () => new Response('', { status: 400 }), async () => {}, () => 0), /HTTP 400/);
});
