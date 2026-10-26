import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, replay, voteWinner, type EventInput, type LedgerEvent } from '../src/ledger.js';

export const iso = (ms: number) => new Date(ms).toISOString();
export const opened: EventInput = { agent: 'GameMaster', type: 'dare_opened', data: {
  dareId: 'demo', title: '3 kills', options: ['SHOTGUN', 'SNIPER', 'KNIFE'], target: { stat: 'kills', count: 3 },
  voteEndsAt: iso(30_000), dareEndsAt: iso(120_000),
} };
export function event(input: EventInput, at = 0, seq = 1): LedgerEvent { return { ...input, at: iso(at), seq }; }
const vote = (userId: string, option: number): EventInput => ({ agent: 'Chat', type: 'vote_cast', data: { dareId: 'demo', userId, login: userId, option } });
const prediction = (userId: string, yes: boolean): EventInput => ({ agent: 'Chat', type: 'prediction_cast', data: { dareId: 'demo', userId, login: userId, yes } });
const lock: EventInput = { agent: 'Referee', type: 'vote_locked', data: { dareId: 'demo', winner: 1 } };
const progress: EventInput = { agent: 'Referee', type: 'progress', data: { dareId: 'demo', stat: 'kills', delta: 3 } };
const resolved: EventInput = { agent: 'Referee', type: 'dare_resolved', data: { dareId: 'demo', success: true } };

test('replay replaces votes, breaks ties by lowest index, and rejects late votes', () => {
  const events = [event(opened), event(vote('a', 3)), event(vote('a', 2)), event(vote('b', 1)), event(lock, 30_000), event(vote('a', 3), 31_000)];
  const before = JSON.stringify(events);
  const state = replay(events);
  assert.deepEqual(state.currentDare?.options.map(option => option.tally), [1, 1, 0]);
  assert.equal(state.currentDare?.winner, 1);
  assert.equal(state.currentDare?.status, 'running');
  assert.equal(JSON.stringify(events), before);
  state.currentDare!.options[0]!.tally = 100;
  assert.equal(replay(events).currentDare!.options[0]!.tally, 1);
  assert.equal(voteWinner([{ title: 'a', tally: 0 }, { title: 'b', tally: 2 }]), 2);
  assert.equal(replay([event(opened), event(vote('late', 2), 30_000), event(lock, 30_000)]).currentDare?.winner, 1);
});

test('early success, replaced predictions and repeated overrules recalculate fan scores', () => {
  const events = [event(opened), event(prediction('a', false)), event(prediction('a', true)), event(prediction('b', false)),
    event(lock, 30_000), event(progress, 40_000), event(resolved, 40_000)];
  const won = replay(events);
  assert.equal(won.currentDare?.progress, 3);
  assert.equal(won.currentDare?.success, true);
  assert.equal(won.currentDare?.status, 'resolved');
  assert.equal(won.fanScores.a?.score, 1);
  assert.equal(won.fanScores.b?.score, 0);
  events.push(event({ agent: 'Commissioner', type: 'overruled', data: { dareId: 'demo', success: false, reason: 'HUD correction' } }, 50_000));
  assert.equal(replay(events).fanScores.a?.score, 0);
  assert.equal(replay(events).fanScores.b?.score, 1);
  events.push(event({ agent: 'Commissioner', type: 'overruled', data: { dareId: 'demo', success: true, reason: 'Reviewed replay' } }, 51_000));
  assert.equal(replay(events).fanScores.a?.score, 1);
  assert.equal(replay(events).fanScores.b?.score, 0);
});

test('timeout fails, late progress and out-of-phase events cannot change the result', () => {
  const events = [event(opened), event(progress, 10_000), event(lock, 30_000), event(resolved, 40_000)];
  assert.equal(replay(events).currentDare?.status, 'running');
  events.push(event(progress, 120_001), event(resolved, 120_002), event(prediction('late', true), 120_003));
  const state = replay(events);
  assert.equal(state.currentDare?.progress, 0);
  assert.equal(state.currentDare?.success, false);
  assert.equal(state.fanScores.late, undefined);
});

test('unknown dare events ignored; scores persist across dares; strip retains last 20', () => {
  const unknown = event({ ...progress, data: { ...progress.data, dareId: 'unknown' } }, 40_000);
  const events = [event(opened), event(prediction('__proto__', true)), event(lock, 30_000), unknown, event(progress, 40_000), event(resolved, 40_000)];
  events.push(event({ ...opened, data: { ...opened.data, dareId: 'second', voteEndsAt: iso(100_000), dareEndsAt: iso(200_000) } }, 50_000));
  for (let i = 0; i < 25; i++) events.push(unknown);
  const state = replay(events);
  assert.equal(state.dareCount, 2);
  assert.equal(state.currentDare?.progress, 0);
  assert.equal(state.fanScores['__proto__']?.score, 1);
  assert.equal(state.lastEvents.length, 20);
});

test('Ledger serializes concurrent appends, round-trips across restarts, and continues sequence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'race-ledger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'ledger.jsonl');
  const ledger = await Ledger.open(path);
  await ledger.append(opened, iso(0));
  await Promise.all([ledger.append(vote('a', 2), iso(100)), ledger.append(vote('a', 3), iso(200))]);
  const restarted = await Ledger.open(path);
  assert.deepEqual(restarted.state, ledger.state);
  await restarted.append(lock, iso(30_000));
  assert.equal(restarted.state.currentDare?.winner, 3);
  const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.seq), [1, 2, 3, 4]);
  assert.deepEqual(records.map(record => record.agent), ['GameMaster', 'Chat', 'Chat', 'Referee']);
  assert.deepEqual((await Ledger.open(path)).state, restarted.state);
  await writeFile(path, '{"seq":');
  await assert.rejects(Ledger.open(path), /incomplete/);
});
