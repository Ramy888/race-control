import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerResponse } from 'node:http';
import { loadConfig } from '../src/config.js';
import { DemoFeed, MockSession, codexAvailable, demoEnvironment, freshDemo } from '../src/demo.js';
import { generateDare } from '../src/gamemaster.js';
import { startLocalServer } from '../src/server.js';
import { DareLoop } from '../src/dares.js';
import { replay, type EventInput, type LedgerEvent } from '../src/ledger.js';

const fallback: typeof generateDare = context => generateDare(context, async () => { throw new Error('missing CLI'); });
const iso = (ms: number) => new Date(ms).toISOString();

test('Ledger path and speed config preserve defaults and reject invalid values', () => {
  const defaults = loadConfig({ MOCK: '1' });
  assert.equal(defaults.ledgerPath, '.data/ledger.jsonl'); assert.equal(defaults.voteMs, 30_000);
  assert.equal(defaults.killMs, 30_000); assert.equal(defaults.minDareMs, 90_000);
  const demo = loadConfig(demoEnvironment({ PORT: '3001', LEDGER_PATH: 'live.jsonl' }));
  assert.equal(demo.port, 3001); assert.equal(demo.ledgerPath, '.data/demo.jsonl'); assert.equal(demo.gamemaster, true);
  assert.equal(demo.voteMs, 10_000); assert.equal(demo.killMs, 6000); assert.equal(demo.minDareMs, 20_000);
  assert.equal(demoEnvironment({}).PORT, '3000');
  for (const key of ['VOTE_SECONDS', 'SECONDS_PER_KILL', 'MIN_DARE_SECONDS']) {
    for (const value of ['', '0', '-1', 'NaN', 'Infinity', '1.5', '601']) assert.throws(() => loadConfig({ MOCK: '1', [key]: value }), new RegExp(key));
  }
  for (const LEDGER_PATH of ['', ' ', 'a\0b']) assert.throws(() => loadConfig({ MOCK: '1', LEDGER_PATH }), /LEDGER_PATH/);
});

test('fresh launcher removes only the fixed demo file; CLI probe is bounded and injectable', async () => {
  let removed = '';
  const env = await freshDemo({ LEDGER_PATH: '.data/ledger.jsonl' }, async path => { removed = String(path); });
  assert.equal(removed, '.data/demo.jsonl'); assert.equal(env.MOCK, '1');
  assert.equal(await codexAvailable(async (file, args, options) => {
    assert.equal(file, 'codex'); assert.deepEqual(args, ['--version']); assert.deepEqual(options, { timeout: 2000 });
  }), true);
  assert.equal(await codexAvailable(async () => { throw new Error('not found'); }), false);
});

test('approval clamps to configured minimum and maximum, while retaining default timing', async () => {
  for (const [env, target, expected] of [
    [{}, 3, 90_000], [{ MIN_DARE_SECONDS: '20', SECONDS_PER_KILL: '6', VOTE_SECONDS: '10' }, 3, 20_000],
    [{ MIN_DARE_SECONDS: '20', SECONDS_PER_KILL: '6' }, 8, 48_000], [{ SECONDS_PER_KILL: '600' }, 15, 600_000],
  ] as const) {
    const config = loadConfig({ MOCK: '1', ...env });
    const events: LedgerEvent[] = [{ seq: 1, at: iso(0), agent: 'GameMaster', type: 'dare_proposed', data: {
      proposalId: 'p', title: 'Demo', options: ['A', 'B'], target: { stat: 'kills', count: target }, stakes: 'Salute', source: 'sample',
    } }];
    const ledger = { get state() { return replay(events); }, append: async (event: EventInput, at: string) => { events.push({ ...event, seq: events.length + 1, at }); } };
    const loop = new DareLoop(ledger, 'streamer', async () => {}, { now: () => 0, schedule: () => () => {} }, undefined, undefined, config);
    await loop.handle({ userId: 'streamer', login: 'streamer', text: '!approve' });
    const dare = ledger.state.currentDare!;
    assert.equal(Date.parse(dare.voteEndsAt), config.voteMs);
    assert.equal(Date.parse(dare.dareEndsAt) - Date.parse(dare.voteEndsAt), expected); loop.stop();
  }
});

test('feed streams both directions, replays missed entries, and closes cleanly', () => {
  const feed = new DemoFeed(); feed.publish('viewer01', '!ping'); feed.publish('Race Control', 'pong');
  const messages: string[] = []; let ended = false;
  const response = Object.assign(new EventEmitter(), { writableLength: 0,
    writeHead: () => {}, write: (text: string) => { messages.push(text); }, end: () => { ended = true; }, destroy: () => {},
  }) as unknown as ServerResponse;
  feed.connect(response, 1); assert.ok(!messages.join('').includes('!ping')); assert.ok(messages.join('').includes('pong'));
  feed.publish('viewer02', '<img src=x>'); assert.ok(messages.at(-1)?.includes('<img src=x>'));
  feed.stop(); assert.equal(ended, true);
});

test('mock demo routes and SSE deliver input/reply; reset empties only demo Ledger and restarts state', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'judge-demo-'));
  const path = join(dir, 'demo.jsonl'), live = join(dir, 'ledger.jsonl'); await writeFile(live, 'LIVE DATA');
  const config = loadConfig({ MOCK: '1', DEMO: '1', LEDGER_PATH: path });
  const session = await MockSession.open(config, false, fallback);
  const local = await startLocalServer(0, session, input => session.handle(input), undefined, undefined, session);
  const address = local.server.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const cancel = new AbortController();
  t.after(async () => { cancel.abort(); session.stop(); local.stop(); await rm(dir, { recursive: true, force: true }); });
  const page = await fetch(url + '/demo'); assert.equal(page.status, 200); assert.match(await page.text(), /Auto-play/);
  assert.deepEqual(await (await fetch(url + '/demo/config')).json(), { broadcaster: 'streamer', canReset: true, codex: false });
  const response = await fetch(url + '/demo/events', { signal: cancel.signal });
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const reader = response.body!.getReader(); let received = '';
  const post = async (text: string) => {
    const response = await fetch(url + '/mock/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'streamer', text }) }); assert.equal(response.status, 200);
  };
  await post('!ping');
  while (!received.includes('pong')) received += new TextDecoder().decode((await reader.read()).value);
  assert.ok(received.includes('"from":"streamer","text":"!ping"')); assert.ok(received.includes('"from":"Race Control","text":"pong"'));
  await session.handle({ userId: 'streamer', login: 'streamer', text: '!rule wrong calls lose a point' });
  while (!received.includes('Codex not available')) received += new TextDecoder().decode((await reader.read()).value);
  // Add a proposal directly through a deterministic pending generator, then approve.
  const proposed = new Promise<void>(resolve => { const off = session.onAppend(() => { if (session.state.proposal) { off(); resolve(); } }); });
  await post('!dare'); await proposed;
  assert.equal(session.state.proposal?.source, 'fallback');
  await post('!approve'); assert.equal(session.state.currentDare?.status, 'voting');
  assert.ok((await readFile(path, 'utf8')).length);
  assert.equal((await fetch(url + '/demo/reset', { method: 'POST' })).status, 200);
  assert.equal(await readFile(path, 'utf8'), ''); assert.equal(session.state.currentDare, undefined);
  assert.equal(await readFile(live, 'utf8'), 'LIVE DATA');
  await post('!ping'); await reader.cancel();
});

test('live routes are absent; ordinary mock cannot reset its Ledger', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'judge-live-'));
  const session = await MockSession.open(loadConfig({ MOCK: '1', LEDGER_PATH: join(dir, 'ledger.jsonl') }), false, fallback);
  const local = await startLocalServer(0, session); // No mock handler means live-only routes.
  t.after(async () => { session.stop(); local.stop(); await rm(dir, { recursive: true, force: true }); });
  const address = local.server.address(); assert.ok(address && typeof address === 'object');
  for (const path of ['/demo', '/demo/config', '/demo/events', '/demo/reset']) {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}${path}`, { method: path.endsWith('reset') ? 'POST' : 'GET' })).status, 404);
  }
  await assert.rejects(session.reset(), /npm run demo/);
});

test('reset cannot resurrect an in-flight Game Master proposal', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'judge-reset-')); let complete!: (value: Awaited<ReturnType<typeof generateDare>>) => void;
  const session = await MockSession.open(loadConfig({ MOCK: '1', DEMO: '1', LEDGER_PATH: join(dir, 'demo.jsonl') }), false,
    () => new Promise(resolve => { complete = resolve; }));
  t.after(async () => { session.stop(); await rm(dir, { recursive: true, force: true }); });
  await session.handle({ userId: 'streamer', login: 'streamer', text: '!dare' });
  await session.reset(); complete(await generateDare({ game: 'Fortnite', previousTitles: [], sampleIndex: 0, enabled: false }));
  await session.handle({ userId: 'streamer', login: 'streamer', text: '!ping' });
  assert.equal(session.state.proposal, undefined); assert.equal(await readFile(join(dir, 'demo.jsonl'), 'utf8'), '');
});
