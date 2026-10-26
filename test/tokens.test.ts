import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenManager, TokenStore, scopes, type TokenData, type Role } from '../src/tokens.js';
import { config, json, mockFetch } from './helpers.js';

const now = 1_000_000;
const token = { accessToken: 'old', refreshToken: 'refresh+/%=', expiresAt: now + 600_000, userId: 'bot-id' };
const grant = { access_token: 'new', refresh_token: 'rotated', expires_in: 3600 };
const identity = (role: Role = 'bot') => ({
  client_id: config.clientId, login: role === 'bot' ? 'robot' : 'streamer',
  user_id: `${role}-id`, scopes: scopes[role], expires_in: 3600,
});

function setup(responses: Response[], initial: TokenData = { bot: { ...token } }) {
  const mock = mockFetch(responses);
  let data = structuredClone(initial);
  let writes = 0;
  const manager = new TokenManager(config, {
    read: async () => structuredClone(data),
    write: async value => { data = structuredClone(value); writes++; },
  }, mock.fetcher, () => now);
  return { manager, ...mock, data: () => data, writes: () => writes };
}

test('expired user token refreshes with encoded form, validates, and persists rotated refresh token', async () => {
  const s = setup([json(grant), json(identity())], { bot: { ...token, expiresAt: now - 1 }, broadcaster: { ...token } });
  const result = await s.manager.get('bot');
  const body = s.calls[0]!.init!.body as URLSearchParams;
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'refresh+/%=');
  assert.match(body.toString(), /refresh%2B%2F%25%3D/);
  assert.equal(body.get('client_secret'), config.clientSecret);
  assert.equal(result.accessToken, 'new');
  assert.equal(result.expiresAt, now + 3_600_000);
  assert.equal(s.data().bot?.refreshToken, 'rotated');
  assert.equal(s.data().broadcaster?.accessToken, 'old');
  assert.equal(s.calls[1]!.url, 'https://id.twitch.tv/oauth2/validate');
  assert.equal(new Headers(s.calls[1]!.init?.headers).get('Authorization'), 'OAuth new');
});

test('concurrent requests perform a single expired-token refresh', async () => {
  const s = setup([json(grant), json(identity())], { bot: { ...token, expiresAt: 0 } });
  const results = await Promise.all([s.manager.get('bot'), s.manager.get('bot'), s.manager.get('bot')]);
  assert.ok(results.every(value => value.accessToken === 'new'));
  assert.equal(s.calls.length, 2);
});

test('valid tokens are reused, but explicit validation recovers from 401', async () => {
  const s = setup([json({}, 401), json(grant), json(identity())]);
  assert.equal((await s.manager.get('bot')).accessToken, 'old');
  assert.equal(s.calls.length, 0);
  assert.equal((await s.manager.get('bot', false, true)).accessToken, 'new');
  assert.equal(s.calls.length, 3);
});

test('startup/hourly validation checks both users and the app token', async () => {
  const s = setup([json(identity('broadcaster')), json(identity()), json({ client_id: 'client', expires_in: 1000 })], {
    bot: { ...token }, broadcaster: { ...token }, app: { accessToken: 'app', expiresAt: now + 600_000 },
  });
  const users = await s.manager.validateAll();
  assert.equal(users.bot.userId, 'bot-id');
  assert.equal(users.broadcaster.userId, 'broadcaster-id');
  assert.equal(s.calls.length, 3);
  assert.ok(s.calls.every(call => call.url.endsWith('/validate')));
});

test('app tokens use client credentials initially and after invalidation, never refresh_token', async () => {
  const s = setup([
    json({ access_token: 'app1', expires_in: 3600 }), json({ client_id: 'client', expires_in: 3600 }),
    json({ access_token: 'app2', expires_in: 3600 }), json({ client_id: 'client', expires_in: 3600 }),
  ], {});
  assert.equal((await s.manager.get('app')).accessToken, 'app1');
  assert.equal((await s.manager.get('app', true)).accessToken, 'app2');
  for (const index of [0, 2]) assert.equal((s.calls[index]!.init!.body as URLSearchParams).get('grant_type'), 'client_credentials');
});

test('authorization exchanges the code and refuses the wrong account or missing scopes', async () => {
  const s = setup([json(grant), json(identity('broadcaster'))]);
  await s.manager.authorize('broadcaster', 'test-code');
  const body = s.calls[0]!.init!.body as URLSearchParams;
  assert.equal(body.get('code'), 'test-code');
  assert.equal(body.get('redirect_uri'), config.redirectUri);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(s.data().broadcaster?.userId, 'broadcaster-id');
  for (const [validation, pattern] of [
    [{ ...identity(), login: 'wrong' }, /BOT_LOGIN/],
    [{ ...identity(), client_id: 'wrong' }, /TWITCH_CLIENT_ID/],
    [{ ...identity(), scopes: [] }, /user:read:chat, user:write:chat, user:bot/],
  ] as const) {
    const bad = setup([json(grant), json(validation)]);
    await assert.rejects(bad.manager.authorize('bot', 'code'), pattern);
    assert.equal(bad.writes(), 0);
  }
});

test('missing tokens, invalid refreshes and service errors fail clearly without saving bad data', async () => {
  await assert.rejects(setup([], {}).manager.get('bot'), /npm run auth -- bot/);
  await assert.rejects(setup([], { bot: { accessToken: 'old', expiresAt: 0 } }).manager.get('bot'), /refresh token/);
  const revoked = setup([json({ message: 'private upstream content' }, 400)]);
  await assert.rejects(revoked.manager.get('bot', true), /HTTP 400/);
  assert.equal(revoked.writes(), 0);
  assert.equal(revoked.data().bot?.refreshToken, token.refreshToken);
  await assert.rejects(setup([json({}, 503)]).manager.get('bot', false, true), /HTTP 503/);
  await assert.rejects(setup([json({})]).manager.get('bot', true), /invalid token response/);
  await assert.rejects(setup([json(grant), json({}, 401)]).manager.get('bot', true), /invalid/);
});

test('token store handles absence, atomic replacement, private permissions and corrupt files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'race-control-tokens-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'data', 'tokens.json');
  const store = new TokenStore(path);
  assert.deepEqual(await store.read(), {});
  await store.write({ bot: token });
  assert.deepEqual(await store.read(), { bot: token });
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  await store.write({ bot: { ...token, accessToken: 'replacement' } });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).bot.accessToken, 'replacement');
  for (const invalid of ['private-not-json', 'null', '[]', '{"bot":{}}']) {
    await writeFile(path, invalid);
    await assert.rejects(store.read(), /Invalid .data\/tokens.json/);
  }
});
