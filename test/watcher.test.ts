import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWatcherConfig, parseHudRegion } from '../src/config.js';
import { Watcher, firstInteger, startWatcher } from '../src/watcher.js';
import { prepareOcr, type Execute } from '../src/ocr.js';
import { calibrate } from '../src/calibrate.js';
import { DareLoop, type Clock } from '../src/dares.js';
import { Ledger, replay, type LedgerEvent, type EventInput } from '../src/ledger.js';

const config = loadWatcherConfig({ WATCHER_SOURCE: 'Test HUD' });
const iso = (n: number) => new Date(n).toISOString();
function setup() {
  const events: LedgerEvent[] = [];
  let now = 40_000;
  const time: Clock = { now: () => now, schedule: () => () => {} };
  const add = (input: EventInput, at = now) => events.push({ ...input, seq: events.length + 1, at: iso(at) });
  add({ agent: 'GameMaster', type: 'dare_opened', data: { dareId: 'd', title: 'Demo', options: ['A', 'B'], target: { stat: 'kills', count: 15 }, voteEndsAt: iso(30_000), dareEndsAt: iso(600_000) } }, 0);
  add({ agent: 'Referee', type: 'vote_locked', data: { dareId: 'd', winner: 1 } }, 30_000);
  const state = () => replay(events);
  const progress = async (dareId: string, delta: number) => { add({ agent: 'Watcher', type: 'progress', data: { dareId, stat: 'kills', delta } }); };
  return { events, add, state, progress, time, setNow: (value: number) => { now = value; } };
}

test('HUD config validates normalized bounds, URL and interval without exposing credentials', () => {
  assert.deepEqual(config.region, [0.85, 0.1, 0.1, 0.1]); assert.equal(config.interval, 2000);
  assert.equal(loadWatcherConfig({}).source, ''); assert.equal(config.obsUrl, 'ws://127.0.0.1:4455');
  assert.deepEqual(parseHudRegion('0, 0, 1, 1'), [0, 0, 1, 1]);
  for (const value of ['', '0,0,1', '0,0,1,1,1', '0,,1,1', '-0.1,0,1,1', '0,0,0,1', '0,0,1,-1', '.9,0,.2,1', '0,.9,1,.2', 'NaN,0,1,1', '0,0,Infinity,1']) assert.throws(() => parseHudRegion(value), /HUD_REGION/);
  for (const WATCHER_MS of ['0', '-1', '1.5', 'Infinity', '2147483648']) assert.throws(() => loadWatcherConfig({ WATCHER_MS }), /WATCHER_MS/);
  for (const OBS_URL of ['bad', 'https://localhost', 'ws://user:secret@localhost']) assert.throws(() => loadWatcherConfig({ OBS_URL }), error => !(error as Error).message.includes('secret'));
});

test('first integer handles noisy text without accepting out-of-range digit fragments', () => {
  for (const [text, expected] of [['®7 82', 7], ['kills: 0', 0], ['999', 999], ['1000 7', 7], ['none', undefined], ['1000', undefined], ['-7', undefined], ['7.5', undefined], ['\n12\n82', 12], ['o', 0], [' O\n', 0], ['Orange', undefined]] as const) assert.equal(firstInteger(text), expected);
});

test('Watcher stability, baseline, increment, rejected jump, decrease and unreadable frames', async () => {
  const s = setup(), logs: string[] = [], paths: string[] = [];
  let reading = '', shots = 0;
  const watcher = new Watcher(config, s.state, s.progress, async source => { assert.equal(source, 'Test HUD'); shots++; return Buffer.from('png'); }, async (path, region) => {
    paths.push(path); assert.deepEqual(region, config.region); assert.equal(await readFile(path, 'utf8'), 'png'); return reading;
  }, s.time, message => logs.push(message));
  const read = async (value: string) => { reading = value; await watcher.read(); };
  await read('7'); assert.equal(s.state().currentDare?.progress, 0);
  await read('7'); await read('8'); assert.equal(s.state().currentDare?.progress, 0);
  await read('unreadable'); await read('®8 82'); assert.equal(s.state().currentDare?.progress, 1);
  await read('8'); assert.equal(s.state().currentDare?.progress, 1);
  await read('30'); await read('30'); await read('30'); assert.equal(logs.length, 1); assert.equal(s.state().currentDare?.progress, 1);
  await read('2'); await read('2'); await read('5'); await read('5');
  assert.equal(s.state().currentDare?.progress, 4);
  assert.equal(s.state().agentStrip.at(-1)?.text, 'HUD: kills 4/15');
  for (const path of paths) await assert.rejects(access(dirname(path)));
  watcher.stop(); await watcher.read(); assert.equal(shots, paths.length);
});

test('Watcher skips inactive dares, never overlaps, discards stale reads, and cleans up errors', async () => {
  const s = setup(); s.events.pop(); // Voting.
  let shots = 0, release!: (png: Buffer) => void;
  const errors: string[] = [], paths: string[] = [];
  const watcher = new Watcher(config, s.state, s.progress, () => { shots++; return new Promise(resolve => { release = resolve; }); }, async path => { paths.push(path); throw new Error('private OCR output'); }, s.time, error => errors.push(error));
  await watcher.read(); assert.equal(shots, 0);
  s.add({ agent: 'Referee', type: 'vote_locked', data: { dareId: 'd', winner: 1 } });
  const first = watcher.read(); await watcher.read(); assert.equal(shots, 1);
  release(Buffer.from('png')); await first;
  const second = watcher.read(); release(Buffer.from('png')); await second;
  assert.equal(errors.length, 1); assert.ok(!errors[0]?.includes('private'));
  for (const path of paths) await assert.rejects(access(dirname(path)));
  s.setNow(600_000); await watcher.read(); assert.equal(shots, 2);
  const stale = setup(); let finish!: (text: string) => void;
  // Synchronize with OCR entry using a promise, without sleeping.
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const late = new Watcher(config, stale.state, stale.progress, async () => Buffer.from('png'), () => { entered(); return new Promise(resolve => { finish = resolve; }); }, stale.time);
  const flight = late.read(); await ready;
  stale.events.length = 0; finish('7'); await flight;
  assert.equal(stale.events.length, 0);
  watcher.stop(); late.stop();
});

test('HUD progress joins the command queue, resolves early, and survives Ledger restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'watcher-ledger-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = await Ledger.open(join(dir, 'ledger.jsonl')), s = setup();
  for (const { seq: _, at, ...event } of s.events) await ledger.append(event, at);
  const loop = new DareLoop(ledger, 'streamer', async () => {}, s.time);
  await loop.recordHud('unknown', 5); await loop.recordHud('d', 6);
  assert.equal(ledger.state.currentDare?.progress, 0);
  await loop.recordHud('d', 5); await loop.recordHud('d', 5);
  await loop.handle({ userId: 'streamer', login: 'streamer', text: '!kill' });
  await loop.recordHud('d', 4);
  assert.equal(ledger.state.currentDare?.success, true);
  await loop.recordHud('d', 1); assert.equal(ledger.state.currentDare?.progress, 15);
  assert.deepEqual((await Ledger.open(join(dir, 'ledger.jsonl'))).state, ledger.state);
  loop.stop();
});

test('OCR builds only when missing/stale, invokes without a shell and with five-second timeout', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'ocr.swift'), binary = join(dir, 'bin', 'ocr'); await writeFile(source, 'source');
  const calls: { file: string; args: string[]; timeout: number }[] = [];
  const execute: Execute = async (file, args, options) => {
    calls.push({ file, args, timeout: options.timeout });
    if (file === 'swiftc') await writeFile(args.at(-1)!, 'binary');
    return { stdout: '7\n' };
  };
  const options = { platform: 'darwin', source, binary, execute };
  const ocr = await prepareOcr(options); assert.ok(ocr);
  assert.equal(await ocr('/tmp/png with spaces.png', [0, 0, 1, 1]), '7\n');
  assert.equal(calls[0]?.file, 'swiftc'); assert.equal(calls[0]?.args[0], '-O');
  assert.deepEqual(calls[1], { file: binary, args: ['/tmp/png with spaces.png', '0', '0', '1', '1'], timeout: 5000 });
  await prepareOcr(options); assert.equal(calls.filter(c => c.file === 'swiftc').length, 1);
  await utimes(source, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
  await prepareOcr(options); assert.equal(calls.filter(c => c.file === 'swiftc').length, 2);
  const logs: string[] = [];
  assert.equal(await prepareOcr({ ...options, platform: 'linux', log: message => logs.push(message) }), undefined);
  assert.equal(logs.length, 1);
  assert.equal(await prepareOcr({ ...options, execute: async () => { throw new Error('compiler detail'); }, log: message => logs.push(message) }), undefined);
  assert.equal(logs.length, 2); assert.ok(!logs[1]?.includes('compiler detail'));
});

test('calibration saves a frame and OCRs full frame and selected region', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'calibrate-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'hud.png'), regions: number[][] = [];
  const result = await calibrate(config, async source => { assert.equal(source, 'Test HUD'); return Buffer.from('png'); }, async (path, region) => {
    assert.equal(path, output); regions.push(region); return regions.length === 1 ? 'TEST HUD 7' : '7';
  }, output);
  assert.deepEqual(result, { full: 'TEST HUD 7', region: '7' }); assert.equal(await readFile(output, 'utf8'), 'png');
  assert.deepEqual(regions, [[0, 0, 1, 1], config.region]);
  await assert.rejects(calibrate({ ...config, source: '' }, async () => Buffer.alloc(0), async () => '', output), /WATCHER_SOURCE/);
});

test('Watcher startup is opt-in and disabled when OCR is unavailable', async () => {
  let prepared = 0;
  const dependencies = { prepare: async () => { prepared++; return undefined; }, connect: () => { throw new Error('must not connect'); }, log: () => {} };
  (await startWatcher({ ...config, source: '' }, () => replay([]), async () => {}, dependencies))(); assert.equal(prepared, 0);
  (await startWatcher(config, () => replay([]), async () => {}, dependencies))(); assert.equal(prepared, 1);
});


test('Watcher startup reports settings, stops OBS and does not expose its password', async () => {
  const logs: string[] = []; let stopped = false;
  const stop = await startWatcher({ ...config, obsPassword: 'private-password' }, () => replay([]), async () => {}, {
    prepare: async () => async () => '0',
    connect: (url, password) => {
      assert.equal(url, config.obsUrl); assert.equal(password, 'private-password');
      return { screenshot: async () => { assert.fail('no frames while idle'); }, stop: () => { stopped = true; } };
    }, log: message => logs.push(message),
  });
  assert.equal(logs.length, 1); assert.match(logs[0]!, /Test HUD.*0.85,0.1,0.1,0.1.*2000ms/);
  assert.ok(!logs[0]?.includes('private-password')); stop(); assert.ok(stopped);
});

test('Watcher schedules at the configured cadence and resets its baseline for a new dare', async () => {
  const s = setup(); let scheduled: (() => void) | undefined, cancelled = false, delay = 0;
  const time: Clock = { now: s.time.now, schedule: (fn, ms) => { scheduled = fn; delay = ms; return () => { cancelled = true; }; } };
  let value = '7';
  const watcher = new Watcher(config, s.state, s.progress, async () => Buffer.from('png'), async () => value, time);
  await watcher.read(); await watcher.read(); value = '8'; await watcher.read(); await watcher.read();
  assert.equal(s.state().currentDare?.progress, 1);
  s.add({ agent: 'Referee', type: 'progress', data: { dareId: 'd', stat: 'kills', delta: 14 } });
  s.add({ agent: 'Referee', type: 'dare_resolved', data: { dareId: 'd', success: true } });
  s.add({ agent: 'GameMaster', type: 'dare_opened', data: { dareId: 'new', title: 'New', options: ['A', 'B'], target: { stat: 'kills', count: 15 }, voteEndsAt: iso(40_000), dareEndsAt: iso(600_000) } });
  s.add({ agent: 'Referee', type: 'vote_locked', data: { dareId: 'new', winner: 1 } });
  value = '10'; await watcher.read(); await watcher.read(); assert.equal(s.state().currentDare?.progress, 0);
  // Schedule in idle state, so no outstanding filesystem work remains on teardown.
  s.events.length = 0; watcher.start(); assert.equal(delay, 2000); assert.ok(scheduled);
  scheduled(); watcher.stop(); assert.ok(cancelled);
});
