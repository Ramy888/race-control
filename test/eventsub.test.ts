import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { EVENTSUB_URL, EventSubClient } from '../src/eventsub.js';
import { flush } from './helpers.js';

class FakeSocket extends EventEmitter {
  closed = false;
  terminated = false;
  close() { this.closed = true; this.emit('close', 1000); }
  terminate() { this.terminated = true; this.emit('close', 1006); }
  message(type: string, payload: unknown = {}, extra: Record<string, string> = {}) {
    this.emit('message', JSON.stringify({ metadata: { message_type: type, ...extra }, payload }));
  }
  welcome(id = 'session') {
    this.message('session_welcome', { session: { id, keepalive_timeout_seconds: 10 } });
  }
  chat(text: string, id = 'message', chatter = 'viewer') {
    this.message('notification', { event: { broadcaster_user_id: 'streamer', chatter_user_id: chatter, message: { text } } },
      { subscription_type: 'channel.chat.message', message_id: id });
  }
}

function setup(t: TestContext, subscribe?: (session: string) => Promise<void>) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const subscriptions: string[] = [];
  const sent: string[] = [];
  const logs: string[] = [];
  let fatal = false;
  const client = new EventSubClient({
    botId: 'bot', broadcasterId: 'streamer',
    createSocket: url => { urls.push(url); const socket = new FakeSocket(); sockets.push(socket); return socket; },
    subscribe: subscribe ?? (async id => { subscriptions.push(id); }),
    send: async message => { sent.push(message); },
    log: message => logs.push(message), onFatal: () => { fatal = true; },
  });
  t.after(() => client.stop());
  client.start();
  return { client, sockets, urls, subscriptions, sent, logs, fatal: () => fatal };
}

test('welcome subscribes once; keepalive resets watchdog without sending or subscribing', async t => {
  const s = setup(t);
  assert.deepEqual(s.urls, [EVENTSUB_URL]);
  s.sockets[0]!.welcome();
  await flush();
  s.sockets[0]!.welcome();
  assert.deepEqual(s.subscriptions, ['session']);
  t.mock.timers.tick(9000);
  s.sockets[0]!.message('session_keepalive');
  t.mock.timers.tick(9000);
  assert.equal(s.sockets[0]!.terminated, false);
  assert.equal(s.sent.length, 0);
  t.mock.timers.tick(2001);
  assert.equal(s.sockets[0]!.terminated, true);
  t.mock.timers.tick(1000);
  assert.equal(s.sockets.length, 2);
  s.sockets[1]!.welcome('fresh-session');
  await flush();
  assert.deepEqual(s.subscriptions, ['session', 'fresh-session']);
});

test('notification routes commands, ignores self and unknown events, deduplicates delivery', async t => {
  const s = setup(t);
  const socket = s.sockets[0]!;
  socket.welcome();
  socket.chat('!ping');
  socket.chat('!ping');
  socket.chat('!race', 'race');
  socket.chat('!ping', 'self', 'bot');
  socket.chat('!other', 'other');
  socket.message('notification', {}, { subscription_type: 'channel.follow' });
  socket.emit('message', 'not json');
  await flush();
  assert.deepEqual(s.sent, ['pong', 'Race Control is online.']);
  assert.ok(s.logs.some(log => log.includes('malformed')));
  t.mock.timers.tick(9000);
  socket.chat('!ping', 'later');
  t.mock.timers.tick(9000);
  assert.equal(socket.terminated, false);
});

test('server reconnect uses the exact URL, keeps old socket through welcome, transfers subscriptions', async t => {
  const s = setup(t);
  const old = s.sockets[0]!;
  old.welcome();
  await flush();
  const url = 'wss://eventsub.wss.twitch.tv/ws?session=opaque%2Bvalue';
  old.message('session_reconnect', { session: { reconnect_url: url } });
  assert.deepEqual(s.urls, [EVENTSUB_URL, url]);
  assert.equal(old.closed, false);
  old.chat('!ping', 'during-handoff');
  assert.deepEqual(s.sent, ['pong']);
  s.sockets[1]!.welcome('replacement');
  await flush();
  assert.equal(old.closed, true);
  assert.deepEqual(s.subscriptions, ['session']);
  s.sockets[1]!.chat('!ping', 'during-handoff');
  s.sockets[1]!.chat('!race', 'after-handoff');
  assert.deepEqual(s.sent, ['pong', 'Race Control is online.']);
  t.mock.timers.tick(1000);
  assert.equal(s.sockets.length, 2);
});

test('old socket closing before replacement welcome still allows migration', async t => {
  const s = setup(t);
  s.sockets[0]!.welcome();
  await flush();
  s.sockets[0]!.message('session_reconnect', { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?next=1' } });
  s.sockets[0]!.close();
  s.sockets[1]!.welcome();
  await flush();
  assert.equal(s.subscriptions.length, 1);
  s.sockets[1]!.chat('!ping');
  assert.deepEqual(s.sent, ['pong']);
});

test('unexpected closes/errors retry with exponential backoff; stop cancels retries', t => {
  const s = setup(t);
  s.client.start();
  assert.equal(s.sockets.length, 1);
  s.sockets[0]!.close();
  t.mock.timers.tick(999);
  assert.equal(s.sockets.length, 1);
  t.mock.timers.tick(1);
  assert.equal(s.sockets.length, 2);
  s.sockets[1]!.emit('error');
  t.mock.timers.tick(1999);
  assert.equal(s.sockets.length, 2);
  t.mock.timers.tick(1);
  assert.equal(s.sockets.length, 3);
  s.sockets[2]!.close();
  s.client.stop();
  t.mock.timers.tick(60_000);
  assert.equal(s.sockets.length, 3);
});

test('subscription failures retry and revocation stops with an actionable reason', async t => {
  const s = setup(t, async () => { throw new Error('failed'); });
  s.sockets[0]!.welcome();
  await flush();
  assert.equal(s.sockets[0]!.terminated, true);
  t.mock.timers.tick(1000);
  const socket = s.sockets[1]!;
  socket.message('revocation', { subscription: { type: 'channel.chat.message', status: 'authorization_revoked' } });
  assert.equal(s.fatal(), true);
  assert.ok(s.logs.some(log => log.includes('authorization_revoked')));
  assert.equal(socket.terminated, true);
  t.mock.timers.tick(60_000);
  assert.equal(s.sockets.length, 2);
});

test('missing welcome and failed migration time out and recover on the base URL', async t => {
  const s = setup(t);
  t.mock.timers.tick(16_000);
  assert.equal(s.sockets[0]!.terminated, true);
  t.mock.timers.tick(1000);
  s.sockets[1]!.welcome();
  await flush();
  s.sockets[1]!.message('session_reconnect', { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?next=2' } });
  s.sockets[2]!.emit('error');
  t.mock.timers.tick(1000);
  assert.equal(s.urls.at(-1), EVENTSUB_URL);
  s.sockets.at(-1)!.welcome('recovered');
  await flush();
  assert.deepEqual(s.subscriptions, ['session', 'recovered']);
});

test('live EventSub maps user ID and login into the shared handler and ignores bot messages', async t => {
  const socket = new FakeSocket();
  const chats: unknown[] = [];
  const client = new EventSubClient({
    botId: 'bot', broadcasterId: 'streamer', createSocket: () => socket,
    subscribe: async () => {}, send: async () => assert.fail('shared handler owns replies'),
    onChat: async chat => { chats.push(chat); }, log: () => {},
  });
  t.after(() => client.stop());
  client.start(); socket.welcome();
  for (const chatter_user_id of ['123', 'bot']) {
    socket.message('notification', { event: {
      broadcaster_user_id: 'streamer', chatter_user_id, chatter_user_login: 'StReAmEr', message: { text: '!dare' },
    } }, { subscription_type: 'channel.chat.message', message_id: chatter_user_id });
  }
  await flush();
  assert.deepEqual(chats, [{ userId: '123', login: 'StReAmEr', text: '!dare' }]);
});
