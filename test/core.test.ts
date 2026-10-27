import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { routeCommand } from '../src/commands.js';
import { RateLimitQueue } from '../src/queue.js';
import { readJson, request } from '../src/http.js';

const env = {
  TWITCH_CLIENT_ID: 'client', TWITCH_CLIENT_SECRET: 'secret',
  TWITCH_REDIRECT_URI: 'http://localhost:3000/callback',
  BROADCASTER_LOGIN: 'Streamer', BOT_LOGIN: 'Robot', PORT: '3000',
};

test('config names every missing variable without exposing values', () => {
  assert.throws(() => loadConfig({ TWITCH_CLIENT_SECRET: 'private-value' }), error => {
    const message = (error as Error).message;
    for (const key of Object.keys(env).filter(key => key !== 'TWITCH_CLIENT_SECRET')) assert.ok(message.includes(key));
    assert.ok(!message.includes('private-value'));
    return true;
  });
  assert.throws(() => loadConfig({ ...env, BOT_LOGIN: '  ' }), /BOT_LOGIN/);
});

test('config validates port, loopback callback, and logins', () => {
  assert.equal(loadConfig(env).botLogin, 'robot');
  assert.equal(loadConfig(env).port, 3000);
  for (const PORT of ['0', '65536', 'NaN', '3.5']) assert.throws(() => loadConfig({ ...env, PORT }), /PORT/);
  for (const TWITCH_REDIRECT_URI of ['bad', 'https://example.com/callback', 'http://localhost:4000/callback', 'http://localhost:3000/wrong', 'http://localhost:3000/callback?x=1']) {
    assert.throws(() => loadConfig({ ...env, TWITCH_REDIRECT_URI }), /TWITCH_REDIRECT_URI/);
  }
  assert.throws(() => loadConfig({ ...env, BOT_LOGIN: '@robot' }), /BOT_LOGIN/);
});

test('pure command router replies to exact commands and ignores self/unknown chat', () => {
  const route = (text: string, chatter_user_id = 'viewer') => routeCommand({ chatter_user_id, message: { text } }, 'bot');
  assert.equal(route('!ping'), 'pong');
  assert.equal(route('  !race\n'), 'Race Control is online.');
  for (const text of ['hello', '!unknown', '!ping extra', '!PING', '']) assert.equal(route(text), undefined);
  assert.equal(route('!ping', 'bot'), undefined);
});

test('queue serializes 65 messages with at most 20 attempts per rolling 30 seconds', async () => {
  let now = 0;
  const sent: number[] = [];
  const order: number[] = [];
  const queue = new RateLimitQueue(() => now, async ms => { now += ms; });
  await Promise.all(Array.from({ length: 65 }, (_, index) => queue.enqueue(async () => {
    sent.push(now); order.push(index);
    now += 137; // Exercise a sliding window, not only batches at one timestamp.
  })));
  assert.deepEqual(order, Array.from({ length: 65 }, (_, index) => index));
  for (let i = 20; i < sent.length; i++) assert.ok(sent[i]! - sent[i - 20]! >= 30_000);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i]! - sent[i - 1]! >= 1000);
  queue.stop();
});

test('failed sends consume capacity but do not stall the queue; stop rejects new work', async () => {
  let now = 0;
  const queue = new RateLimitQueue(() => now, async ms => { now += ms; });
  const failed = await Promise.allSettled(Array.from({ length: 20 }, () => queue.enqueue(async () => { throw new Error('send failed'); })));
  assert.ok(failed.every(result => result.status === 'rejected'));
  await queue.enqueue(async () => assert.equal(now, 30_000));
  queue.stop();
  await assert.rejects(queue.enqueue(async () => assert.fail('must not send')), /stopped/);
});

test('stop interrupts a waiting queue and prevents pending sends', async () => {
  let waiting!: () => void;
  const started = new Promise<void>(resolve => { waiting = resolve; });
  let now = 0;
  const queue = new RateLimitQueue(() => now, async (ms, signal) => {
    if (ms < 10_000) { now += ms; return; }
    waiting();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  });
  await Promise.all(Array.from({ length: 20 }, () => queue.enqueue(async () => {})));
  const pending = assert.rejects(queue.enqueue(async () => assert.fail()), /stopped/);
  await started;
  queue.stop();
  await pending;
});

test('HTTP helpers sanitize failures and reject malformed JSON', async () => {
  await assert.rejects(request(async () => { throw new Error('secret-value'); }, 'https://example.invalid'), error => {
    assert.ok(!(error as Error).message.includes('secret-value'));
    return true;
  });
  await assert.rejects(readJson(new Response('invalid-private-response')), /invalid JSON/);
  const response = await request(async (_url, init) => {
    assert.ok(init?.signal);
    return new Response('{}');
  }, 'https://example.invalid');
  assert.deepEqual(await readJson(response), {});
});


test('Game Master config defaults and offline switch work in both modes', () => {
  for (const base of [env, { MOCK: '1' }]) {
    assert.equal(loadConfig(base).game, 'Fortnite');
    assert.equal(loadConfig(base).gamemaster, true);
    const config = loadConfig({ ...base, GAME: ' Apex Legends ', GAMEMASTER: 'off' });
    assert.equal(config.game, 'Apex Legends'); assert.equal(config.gamemaster, false);
    assert.equal(config.voteMs, 30_000); assert.equal(config.killMs, 30_000);
  }
});
