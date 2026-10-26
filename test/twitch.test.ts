import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimitQueue } from '../src/queue.js';
import { TwitchApi } from '../src/twitch.js';
import { json, mockFetch } from './helpers.js';
import type { Role } from '../src/tokens.js';

function setup(responses: Response[]) {
  const mock = mockFetch(responses);
  const requested: { role: string; force: boolean }[] = [];
  const logs: string[] = [];
  let now = 0;
  const queue = new RateLimitQueue(() => now, async ms => { now += ms; });
  const api = new TwitchApi('client', 'streamer', 'robot', {
    get: async (role: Role | 'app', force = false) => {
      requested.push({ role, force });
      return { accessToken: `${role}-${force ? 'new' : 'old'}`, expiresAt: 999999 };
    },
  }, queue, mock.fetcher, message => logs.push(message));
  return { api, requested, logs, ...mock };
}

test('subscriptions use the bot user token, condition, version and session ID', async () => {
  const s = setup([json({}, 202)]);
  await s.api.subscribe('session');
  assert.equal(s.calls[0]!.url, 'https://api.twitch.tv/helix/eventsub/subscriptions');
  assert.equal(new Headers(s.calls[0]!.init!.headers).get('Authorization'), 'Bearer bot-old');
  assert.deepEqual(JSON.parse(s.calls[0]!.init!.body as string), {
    type: 'channel.chat.message', version: '1',
    condition: { broadcaster_user_id: 'streamer', user_id: 'robot' },
    transport: { method: 'websocket', session_id: 'session' },
  });
});

test('chat sending uses the app token, bot sender and source-only channel', async () => {
  const s = setup([json({ data: [{ is_sent: true }] })]);
  await s.api.send('pong');
  const call = s.calls[0]!;
  assert.equal(call.url, 'https://api.twitch.tv/helix/chat/messages');
  assert.equal(call.init?.method, 'POST');
  assert.equal(new Headers(call.init?.headers).get('Authorization'), 'Bearer app-old');
  assert.equal(new Headers(call.init?.headers).get('Client-Id'), 'client');
  assert.deepEqual(JSON.parse(call.init!.body as string), { broadcaster_id: 'streamer', sender_id: 'robot', message: 'pong', for_source_only: true });
});

test('HTTP 200 dropped messages clearly log is_sent=false, code, and reason', async () => {
  const s = setup([json({ data: [{ is_sent: false, drop_reason: { code: 'automod_held', message: 'Held for review.' } }] })]);
  await s.api.send('pong');
  assert.match(s.logs[0]!, /is_sent=false.*automod_held.*Held for review/);
});

test('401 renews the proper token and retries once; errors do not loop', async () => {
  const send = setup([json({}, 401), json({ data: [{ is_sent: true }] })]);
  await send.api.send('pong');
  assert.deepEqual(send.requested, [{ role: 'app', force: false }, { role: 'app', force: true }]);
  const sub = setup([json({}, 401), json({}, 202)]);
  await sub.api.subscribe('session');
  assert.deepEqual(sub.requested, [{ role: 'bot', force: false }, { role: 'bot', force: true }]);
  await assert.rejects(setup([json({}, 401), json({}, 401)]).api.send('pong'), /HTTP 401/);
  await assert.rejects(setup([json({}, 403)]).api.subscribe('session'), /HTTP 403/);
  await assert.rejects(setup([json({}, 429)]).api.send('pong'), /HTTP 429/);
  await assert.rejects(setup([json({ data: [] })]).api.send('pong'), /Invalid/);
});
