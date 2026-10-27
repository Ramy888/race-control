import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { demoHistory } from '../src/demo-history.js';
import { Ledger, replay, type EventInput } from '../src/ledger.js';
import { rankedFans, rankChanges } from '../src/rules.js';
import recorded from '../web/recorded.json' with { type: 'json' };

const top = (events: ReturnType<typeof demoHistory>) => rankedFans(replay(events).fanScores).slice(0, 5).map(fan => fan.login);
test('sample history is valid on disk and replays three resolved dares with expected standings', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sample-history-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const events = demoHistory(Date.now()), path = join(dir, 'demo.jsonl');
  await writeFile(path, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const state = (await Ledger.open(path)).state;
  assert.deepEqual(state, replay(events)); assert.equal(state.dareCount, 3);
  assert.equal(state.currentDare?.status, 'resolved'); assert.equal(state.currentDare?.overruled, true);
  assert.deepEqual(top(events), ['viewer02', 'viewer01', 'viewer03', 'viewer04', 'viewer06']);
  assert.deepEqual(Object.values(state.fanScores).map(fan => fan.score), [1, 2, 1, 1, 0, 1]);
  for (const event of events) if (event.type === 'prediction_cast') assert.equal(event.data.userId, event.data.login);
});
test('both recorded rules visibly reorder seeded standings after the six-viewer winning auto-play dare', () => {
  const events = demoHistory(0);
  const add = (event: EventInput, at: number) => events.push({ ...event, seq: events.length + 1, at: new Date(at).toISOString() });
  const dareId = 'autoplay';
  add({ agent: 'Commissioner', type: 'dare_opened', data: { dareId, title: 'Auto-play', options: ['Pistol', 'Shotgun'], target: { stat: 'kills', count: 3 }, voteEndsAt: new Date(10000).toISOString(), dareEndsAt: new Date(30000).toISOString() } }, 0);
  for (let i = 1; i <= 6; i++) {
    const login = `viewer0${i}`;
    add({ agent: 'Chat', type: 'prediction_cast', data: { dareId, userId: login, login, yes: i % 2 === 1 } }, 1000);
  }
  add({ agent: 'Referee', type: 'vote_locked', data: { dareId, winner: 1 } }, 10000);
  for (let i = 1; i <= 3; i++) add({ agent: 'Referee', type: 'progress', data: { dareId, stat: 'kills', delta: 1 } }, 10000 + i * 1000);
  add({ agent: 'Referee', type: 'dare_resolved', data: { dareId, success: true } }, 13000);
  const original = replay(events).fanScores;
  assert.deepEqual(top(events), ['viewer01', 'viewer02', 'viewer03', 'viewer04', 'viewer05']);
  for (const [index, rule] of recorded.rules.entries()) {
    const before = events.length, ruleId = `recorded-${index}`;
    add({ agent: 'RulesCompiler', type: 'rule_proposed', data: { ruleId, text: rule.text, code: rule.compiler.code, examples: rule.compiler.examples } }, 14000);
    add({ agent: 'Auditor', type: 'rule_audited', data: { ruleId, ...rule.audit } }, 15000);
    add({ agent: 'Commissioner', type: 'rule_adopted', data: { ruleId } }, 16000);
    assert.ok(rankChanges(original, replay(events).fanScores).length >= 2, rule.text);
    assert.deepEqual(top(events), index === 0 ? ['viewer03', 'viewer02', 'viewer01', 'viewer04', 'viewer06'] : ['viewer03', 'viewer01', 'viewer02', 'viewer04', 'viewer05']);
    events.splice(before);
  }
});
