import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DareLoop, type Clock } from '../src/dares.js';
import { replay, type EventInput, type LedgerEvent } from '../src/ledger.js';
import { parseCommand } from '../src/commands.js';

const iso = (ms: number) => new Date(ms).toISOString();
function setup(initial: LedgerEvent[] = [], startAt = 0) {
  let now = startAt;
  let timer: (() => void) | undefined;
  let delay = 0;
  const events = structuredClone(initial);
  const replies: string[] = [];
  const time: Clock = {
    now: () => now,
    schedule: (callback, ms) => { timer = callback; delay = ms; return () => { timer = undefined; }; },
  };
  const ledger = {
    get state() { return replay(events); },
    append: async (input: EventInput, at: string) => { events.push({ ...structuredClone(input), seq: events.length + 1, at }); },
  };
  const loop = new DareLoop(ledger, 'StReAmEr', async text => { replies.push(text); }, time);
  return {
    loop, events, replies, ledger, delay: () => delay, timer: () => timer,
    chat: (text: string, login = 'streamer', userId = login) => loop.handle({ login, userId, text }),
    advance: async (ms: number) => { now += ms; timer?.(); await loop.start(); },
  };
}

test('command parser preserves replies and parses only valid dare commands', () => {
  assert.deepEqual(parseCommand('!ping'), { type: 'reply', text: 'pong' });
  assert.deepEqual(parseCommand('!race'), { type: 'reply', text: 'Race Control is online.' });
  assert.deepEqual(parseCommand(' !pick 2 '), { type: 'pick', option: 2 });
  assert.deepEqual(parseCommand('!overrule bad HUD reading'), { type: 'overrule', reason: 'bad HUD reading' });
  for (const text of ['!pick 0', '!pick 5', '!pick 2abc', '!overrule ', '!kill now', '!unknown']) assert.equal(parseCommand(text), undefined);
});

test('same handler applies broadcaster permission case-insensitively and ignores out-of-phase commands', async () => {
  const s = setup();
  await s.chat('!kill'); await s.chat('!yes'); await s.chat('!dare', 'viewer');
  assert.equal(s.events.length, 0);
  await s.chat('!dare', 'STREAMER', 'live-twitch-id');
  assert.equal(s.events.length, 1);
  await s.chat('!kill'); await s.chat('!overrule reason'); await s.chat('!dare'); await s.chat('!pick 4', 'viewer');
  assert.equal(s.events.length, 1);
  await s.chat('!pick 3', 'viewer'); await s.chat('!yes', 'viewer');
  assert.equal(s.events.length, 3);
  await s.advance(30_000);
  assert.equal(s.ledger.state.currentDare?.winner, 3);
  assert.equal(s.ledger.state.currentDare?.status, 'running');
  assert.equal(s.delay(), 90_000);
  const before = s.events.length;
  await s.chat('!kill', 'viewer'); await s.chat('!pick 1', 'viewer');
  assert.equal(s.events.length, before);
  await s.chat('!no', 'viewer');
  await Promise.all([s.chat('!kill'), s.chat('!kill'), s.chat('!kill'), s.chat('!kill')]);
  assert.equal(s.ledger.state.currentDare?.progress, 3);
  assert.equal(s.ledger.state.currentDare?.success, true);
  assert.equal(s.timer(), undefined);
  const resolvedCount = s.events.length;
  await s.chat('!yes', 'viewer'); await s.chat('!kill'); await s.chat('!overrule reason', 'viewer');
  assert.equal(s.events.length, resolvedCount);
  await s.chat('!overrule HUD was wrong');
  assert.equal(s.ledger.state.currentDare?.success, false);
  assert.equal(s.ledger.state.fanScores.viewer?.score, 1);
  await s.chat('!dare');
  assert.equal(s.ledger.state.currentDare?.target.count, 15);
  assert.equal(s.delay(), 60_000);
  s.loop.stop();
});

test('restart locks expired vote and resolves expired dare exactly once', async () => {
  const first = setup();
  await first.chat('!dare'); await first.chat('!pick 2', 'viewer'); await first.chat('!no', 'viewer');
  first.loop.stop();
  const restarted = setup(first.events, 40_000);
  await restarted.loop.start();
  assert.equal(restarted.ledger.state.currentDare?.winner, 2);
  assert.equal(restarted.delay(), 80_000);
  await restarted.loop.start();
  assert.equal(restarted.events.filter(e => e.type === 'vote_locked').length, 1);
  restarted.loop.stop();
  const expired = setup(first.events, 130_000);
  await expired.loop.start();
  assert.equal(expired.ledger.state.currentDare?.status, 'resolved');
  assert.equal(expired.ledger.state.currentDare?.success, false);
  assert.equal(expired.ledger.state.fanScores.viewer?.score, 1);
  assert.equal(expired.timer(), undefined);
  await expired.loop.start();
  assert.equal(expired.events.filter(e => e.type === 'dare_resolved').length, 1);
});

test('deadline catches up before incoming progress; stopped loop ignores new work', async () => {
  const s = setup();
  await s.chat('!dare');
  await s.advance(120_000);
  await s.chat('!kill');
  assert.equal(s.ledger.state.currentDare?.success, false);
  assert.equal(s.ledger.state.currentDare?.progress, 0);
  s.loop.stop();
  const count = s.events.length;
  await s.chat('!dare');
  assert.equal(s.events.length, count);
});

test('restart resolves target already reached without a resolution event', async () => {
  const s = setup(); await s.chat('!dare'); await s.advance(30_000);
  const dareId = s.ledger.state.currentDare!.dareId;
  s.events.push({ seq: s.events.length + 1, at: iso(35_000), agent: 'Referee', type: 'progress', data: { dareId, stat: 'kills', delta: 3 } });
  const restarted = setup(s.events, 150_000);
  await restarted.loop.start();
  assert.equal(restarted.ledger.state.currentDare?.success, true);
  s.loop.stop();
});
