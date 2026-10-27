import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { compilePoints, evaluate, compileRule, auditRule, syntheticContexts, validateRule, defaultCode, rankChanges, type RuleContext, type RuleOutput } from '../src/rules.js';
import { Ledger, replay, type EventInput, type LedgerEvent } from '../src/ledger.js';
import { DareLoop, type Clock } from '../src/dares.js';
import { parseCommand } from '../src/commands.js';
import { toOverlayView } from '../src/overlay.js';

const ctx: RuleContext = { correct: true, yes: true, success: true, overruled: false, yesCount: 1, noCount: 3, target: 3, progress: 3 };
const examples = [
  { ctx, expected: 1 },
  { ctx: { ...ctx, correct: false }, expected: 0 },
  { ctx: { ...ctx, yes: false, success: false }, expected: 1 },
];
const normal: RuleOutput = { code: defaultCode, examples };
const doubled: RuleOutput = { code: 'return ctx.correct ? 2 : 0;', examples: examples.map(e => ({ ...e, expected: e.expected * 2 })) };
const iso = (n: number) => new Date(n).toISOString();
function history() {
  const events: LedgerEvent[] = [];
  const add = (input: EventInput, at = 40_000) => { events.push({ ...structuredClone(input), at: iso(at), seq: events.length + 1 }); };
  add({ agent: 'GameMaster', type: 'dare_opened', data: { dareId: 'd', title: 'Demo', options: ['A', 'B'], target: { stat: 'kills', count: 3 }, voteEndsAt: iso(30_000), dareEndsAt: iso(120_000) } }, 0);
  for (const [userId, yes] of [['private-a', true], ['private-b', false]] as const) add({ agent: 'Chat', type: 'prediction_cast', data: { dareId: 'd', userId, login: userId === 'private-a' ? 'alice' : 'bob', yes } }, 1);
  add({ agent: 'Referee', type: 'vote_locked', data: { dareId: 'd', winner: 1 } }, 30_000);
  add({ agent: 'Referee', type: 'progress', data: { dareId: 'd', stat: 'kills', delta: 3 } });
  add({ agent: 'Referee', type: 'dare_resolved', data: { dareId: 'd', success: true } });
  return { events, add };
}
function propose(h: ReturnType<typeof history>, ruleId = 'rule', output = doubled) {
  h.add({ agent: 'RulesCompiler', type: 'rule_proposed', data: { ruleId, text: 'Double correct calls', ...output } });
  h.add({ agent: 'Auditor', type: 'rule_audited', data: { ruleId, cases: 2304, mismatches: 0 } });
}

test('ban-list rejects every word, preserves word boundaries, and caches compiled rules', () => {
  for (const word of ['this', 'constructor', 'prototype', '__proto__', 'globalThis', 'process', 'require', 'import', 'eval', 'Function', 'while', 'for']) {
    assert.throws(() => compilePoints(`ban-${word}`, `// ${word}\nreturn 1;`), /banned/);
  }
  const code = 'const before = ctx.correct; return before ? 1 : 0;';
  assert.deepEqual(evaluate('safe', code, ctx), { points: 1, valid: true });
  assert.equal(compilePoints('safe', code), compilePoints('safe', code));
});

test('invalid returns, throws, recursion timeouts and dynamic code generation score zero', () => {
  const codes = ['return NaN;', 'return 0.5;', 'return 11;', 'return -11;', 'return "1";', 'throw 1;',
    'ctx.correct = false; return 1;', 'return Math.random();',
    'const f = (() => 0)["con"+"structor"]; return f("return 1")();'];
  for (const [i, code] of codes.entries()) assert.deepEqual(evaluate(`invalid-${i}`, code, ctx), { points: 0, valid: false });
  const recursion = 'const spin = () => { try { return spin(); } catch { return spin(); } }; return spin();';
  assert.throws(() => compilePoints('recursive', recursion).script.runInNewContext({ ctx }, { timeout: 50 }), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' });
  assert.deepEqual(evaluate('recursive', recursion, ctx), { points: 0, valid: false });
  assert.equal(ctx.correct, true);
  assert.equal(evaluate('negative', 'return -10;', ctx).points, -10);
});

test('audit covers deduplicated grid and history, passes matches and reports a single differing case', async () => {
  assert.equal(syntheticContexts().length, 2304);
  const match = await auditRule('audit-match', normal, { ...normal, code: 'return Number(ctx.correct);' }, [ctx, ctx]);
  assert.deepEqual(match, { cases: 2304, mismatches: 0 });
  const special = { ...ctx, target: 99, progress: 98 };
  const different = { ...normal, code: 'return ctx.target === 99 ? -1 : (ctx.correct ? 1 : 0);' };
  const mismatch = await auditRule('audit-different', normal, different, [special, special]);
  assert.equal(mismatch.cases, 2305); assert.equal(mismatch.mismatches, 1);
  assert.deepEqual(mismatch.firstMismatch, { ctx: special, compiler: 1, auditor: -1 });
  await assert.rejects(auditRule('bad-examples', normal, doubled, []), /failed examples/);
  await assert.rejects(auditRule('zero-throw', { code: 'throw 1;', examples: examples.map(e => ({ ...e, expected: 0 })) }, normal, []), /failed examples/);
});

test('parallel independent prompts, schema and temp cleanup use injected runner only', async () => {
  const paths: string[] = [], models: string[] = [], prompts: string[] = [];
  let unblock!: () => void;
  const started = new Promise<void>(resolve => { unblock = resolve; });
  const rule = 'wrong calls lose a point';
  const output = await compileRule(rule, async args => {
    models.push(args[args.indexOf('-m') + 1]!);
    paths.push(args[args.indexOf('-o') + 1]!);
    prompts.push(args.at(-1)!);
    if (models.length === 2) unblock();
    await started; // Would hang if calls were sequential.
    assert.ok(args.includes('--ignore-user-config') && args.includes('--ephemeral') && args.includes('read-only'));
    assert.ok(args[args.indexOf('--output-schema') + 1]?.endsWith('/src/rules.schema.json'));
    await writeFile(args[args.indexOf('-o') + 1]!, JSON.stringify(normal));
  });
  assert.deepEqual(models, ['gpt-6-luna', 'gpt-6-sol']);
  assert.notEqual(prompts[0], prompts[1]);
  for (const prompt of prompts) {
    assert.ok(prompt.includes(rule));
    for (const field of Object.keys(ctx)) assert.ok(prompt.includes(field + ':'));
    assert.ok(!prompt.includes('alice') && !prompt.includes('private-a'));
  }
  assert.deepEqual(output.compiler, normal);
  for (const path of paths) await assert.rejects(access(dirname(path)));
  for (const failure of ['timeout', 'bad-json']) {
    let path = '';
    await assert.rejects(compileRule(rule, async args => {
      path = args[args.indexOf('-o') + 1]!;
      if (failure === 'timeout') throw new Error('secret model error');
      await writeFile(path, '{');
    }), /compilation failed/);
    await assert.rejects(access(dirname(path)));
  }
});

test('strict output validation rejects malformed examples and contracts', () => {
  assert.deepEqual(validateRule(normal), normal);
  for (const value of [null, {}, { ...normal, code: 'x'.repeat(601) }, { ...normal, examples: [] },
    { ...normal, examples: [...examples, ...examples, ...examples] },
    ...[{ ...ctx, login: 'viewer' }, { ...ctx, yes: 1 }, { ...ctx, progress: 0.5 }].map(bad => ({ ...normal, examples: [{ ctx: bad, expected: 1 }, ...examples] })),
    { ...normal, examples: [{ ctx, expected: 11 }, ...examples] }]) assert.throws(() => validateRule(value));
});

test('replay default is unchanged; adoption, overrule and reset retroactively rescore all predictions', () => {
  const h = history();
  const original = replay(h.events);
  assert.deepEqual(Object.values(original.fanScores).map(fan => fan.score), [1, 0]);
  assert.deepEqual(original.ruleContexts.map(c => c.correct), [true, false]);
  assert.ok(original.ruleContexts.every(c => Object.values(c).every(v => typeof v === 'boolean' || Number.isInteger(v))));
  propose(h);
  const pending = replay(h.events);
  assert.deepEqual(Object.values(pending.fanScores).map(fan => fan.score), [1, 0]);
  assert.deepEqual(Object.values(pending.previewScores!).map(fan => fan.score), [2, 0]);
  h.add({ agent: 'Commissioner', type: 'rule_adopted', data: { ruleId: 'rule' } });
  assert.deepEqual(Object.values(replay(h.events).fanScores).map(fan => fan.score), [2, 0]);
  h.add({ agent: 'Commissioner', type: 'overruled', data: { dareId: 'd', success: false, reason: 'HUD' } });
  const overruled = replay(h.events);
  assert.deepEqual(Object.values(overruled.fanScores).map(fan => fan.score), [0, 2]);
  assert.ok(overruled.ruleContexts.every(c => c.overruled));
  h.add({ agent: 'Commissioner', type: 'rule_adopted', data: { ruleId: 'default' } });
  assert.deepEqual(Object.values(replay(h.events).fanScores).map(fan => fan.score), [0, 1]);
  assert.equal(replay(h.events).activeRule, undefined);
  assert.deepEqual(rankChanges(original.fanScores, overruled.fanScores), ['bob 2→1', 'alice 1→2']);
});

function setup(events: LedgerEvent[] = history().events, compile: typeof compileRule = async () => ({ compiler: doubled, auditor: doubled }), at = 40_000) {
  let now = at, delay = 0;
  const replies: string[] = [];
  const ledger = { get state() { return replay(events); }, append: async (input: EventInput, at: string) => { events.push({ ...input, seq: events.length + 1, at }); } };
  const clock: Clock = { now: () => now, schedule: (_, ms) => { delay = ms; return () => {}; } };
  const loop = new DareLoop(ledger, 'StReAmEr', async text => { replies.push(text); }, clock, undefined, undefined, {}, compile);
  return { events, ledger, loop, replies, delay: () => delay,
    chat: (text: string, login = 'streamer') => loop.handle({ userId: login, login, text }),
    advance: async (ms: number) => { now += ms; await loop.start(); },
  };
}
async function completed(s: ReturnType<typeof setup>) {
  for (let i = 0; i < 500 && !s.events.some(e => e.type === 'rule_audited' || e.type === 'rule_failed'); i++) await yieldTurn();
  await s.loop.start();
  assert.ok(s.events.some(e => e.type === 'rule_audited' || e.type === 'rule_failed'));
}

test('approval workflow is nonblocking, permissioned, ignores duplicates and adopts retroactively', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof compileRule>>) => void, calls = 0;
  const s = setup(undefined, () => { calls++; return new Promise(done => { resolve = done; }); });
  await s.chat('!rule double', 'viewer'); assert.equal(calls, 0);
  await s.chat('!rule double'); await s.chat('!rule duplicate'); await s.chat('!ping');
  assert.equal(calls, 1); assert.equal(s.replies.at(-1), 'pong');
  resolve({ compiler: doubled, auditor: doubled }); await completed(s);
  assert.equal(s.ledger.state.pendingRule?.audit?.mismatches, 0);
  assert.match(s.replies.at(-1)!, /Rule ready: double.*2304\/2304.*!adopt or !reject/);
  await s.chat('!rule duplicate'); await s.chat('!adopt', 'viewer'); await s.chat('!reject', 'viewer');
  assert.equal(calls, 1); assert.ok(s.ledger.state.pendingRule);
  await s.chat('!adopt', 'STREAMER');
  assert.equal(s.ledger.state.fanScores['private-a']?.score, 2);
  await s.chat('!rule', 'viewer'); assert.match(s.replies.at(-1)!, /^House rule: double\. !rule <text> to change, !rule reset for default\.$/);
  await s.chat('!rule reset', 'viewer'); assert.ok(s.ledger.state.activeRule);
  await s.chat('!rule reset'); assert.equal(s.ledger.state.fanScores['private-a']?.score, 1);
  await s.chat('!rule.', 'viewer'); assert.match(s.replies.at(-1)!, /^House rule: default \(\+1 per correct call\)\./);
  s.loop.stop();
});

test('reject, expiry/restart and unaudited adoption keep current scores', async () => {
  const h = history(); propose(h);
  const s = setup(h.events); await s.chat('!reject');
  assert.equal(s.ledger.state.pendingRule, undefined);
  assert.equal(s.ledger.state.fanScores['private-a']?.score, 1);
  const pending = history(); propose(pending);
  const restarted = setup(pending.events, undefined, 100_000); await restarted.loop.start();
  assert.equal(restarted.delay(), 60_000);
  await restarted.advance(60_000); await restarted.chat('!adopt');
  assert.equal(restarted.ledger.state.pendingRule, undefined);
  assert.equal(restarted.events.at(-1)?.type, 'rule_expired');
  const stale = history(); propose(stale); const expired = setup(stale.events, undefined, 200_000); await expired.loop.start();
  assert.equal(expired.events.at(-1)?.type, 'rule_expired');
  const unaudited = history(); unaudited.add({ agent: 'RulesCompiler', type: 'rule_proposed', data: { ruleId: 'alone', text: 'double', ...doubled } });
  const noAudit = setup(unaudited.events); await noAudit.chat('!adopt'); assert.equal(noAudit.ledger.state.activeRule, undefined);
  for (const scenario of [s, restarted, expired, noAudit]) scenario.loop.stop();
});

test('compiler errors use fixed reasons, disagreements clear proposal, and reset invalidates late generation', async () => {
  const bad = setup(undefined, async () => { throw new Error('SECRET MODEL OUTPUT'); });
  await bad.chat('!rule double'); await completed(bad);
  assert.ok(!JSON.stringify(bad.events).includes('SECRET'));
  assert.equal(bad.events.at(-1)?.type, 'rule_failed');
  const different = { ...doubled, code: 'return ctx.target === 8 ? -1 : (ctx.correct ? 2 : 0);' };
  const disagree = setup(undefined, async () => ({ compiler: doubled, auditor: different }));
  await disagree.chat('!rule double'); await completed(disagree);
  assert.equal(disagree.ledger.state.pendingRule, undefined);
  assert.match(disagree.replies.at(-1)!, /Auditor disagrees/);
  let finish!: (v: Awaited<ReturnType<typeof compileRule>>) => void;
  const reset = setup(undefined, () => new Promise(resolve => { finish = resolve; }));
  await reset.chat('!rule double'); await reset.chat('!rule reset');
  finish({ compiler: doubled, auditor: doubled }); await yieldTurn(); await reset.loop.start();
  assert.equal(reset.ledger.state.pendingRule, undefined);
  for (const scenario of [bad, disagree, reset]) scenario.loop.stop();
});

test('rule parser length checks and pending/active overlay are private public summaries', () => {
  assert.deepEqual(parseCommand('!rule'), { type: 'ruleShow' });
  for (const text of ['!rule x', '!rule ab', '!rule ' + 'a'.repeat(201)]) assert.equal(parseCommand(text), undefined);
  assert.deepEqual(parseCommand('!rule wrong calls lose a point.'), { type: 'rule', text: 'wrong calls lose a point.' });
  assert.deepEqual(parseCommand('!rule reset'), { type: 'ruleReset' });
  const h = history(); propose(h);
  const pending = toOverlayView(replay(h.events), 41_000);
  assert.equal(pending.pendingRule?.text, 'Double correct calls');
  assert.deepEqual(pending.pendingRule?.before.map(f => f.score), [1, 0]);
  assert.deepEqual(pending.pendingRule?.after.map(f => f.score), [2, 0]);
  assert.deepEqual(pending.pendingRule?.audit, { cases: 2304, mismatches: 0 });
  for (const privateText of ['private-a', 'ruleId', '"code"', 'examples', 'ruleContexts', 'userId']) assert.ok(!JSON.stringify(pending).includes(privateText));
  h.add({ agent: 'Commissioner', type: 'rule_adopted', data: { ruleId: 'rule' } });
  const adopted = toOverlayView(replay(h.events), 41_000);
  assert.equal(adopted.houseRule, 'Double correct calls'); assert.equal(adopted.pendingRule, null);
  assert.deepEqual(adopted.agentStrip.slice(-3).map(e => e.text), ['Rule written: Double correct calls', 'Audit passed 2304/2304', 'Rule adopted']);
});

test('every rule event round-trips after restart, and runtime invalid scoring logs only once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rules-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = history(); propose(h);
  h.add({ agent: 'Commissioner', type: 'rule_adopted', data: { ruleId: 'rule' } });
  propose(h, 'rejected'); h.add({ agent: 'Commissioner', type: 'rule_rejected', data: { ruleId: 'rejected' } });
  propose(h, 'expired'); h.add({ agent: 'Referee', type: 'rule_expired', data: { ruleId: 'expired' } }, 160_000);
  h.add({ agent: 'RulesCompiler', type: 'rule_failed', data: { ruleId: 'failed', text: 'bad', reason: 'failed examples' } });
  const path = join(directory, 'ledger.jsonl'); const ledger = await Ledger.open(path);
  for (const { seq: _, at, ...event } of h.events) await ledger.append(event, at);
  assert.deepEqual((await Ledger.open(path)).state, replay(h.events));
  const log = t.mock.method(console, 'error', () => {});
  const invalid = { ...normal, code: 'return 1.5;' };
  await ledger.append({ agent: 'RulesCompiler', type: 'rule_proposed', data: { ruleId: 'invalid', text: 'bad', ...invalid } }, iso(170_000));
  await ledger.append({ agent: 'Auditor', type: 'rule_audited', data: { ruleId: 'invalid', cases: 1, mismatches: 0 } }, iso(170_000));
  await ledger.append({ agent: 'Commissioner', type: 'rule_adopted', data: { ruleId: 'invalid' } }, iso(170_000));
  assert.equal(ledger.state.fanScores['private-a']?.score, 0);
  assert.equal(ledger.state.fanScores['private-b']?.score, 0);
  assert.equal(log.mock.calls.length, 1);
});

test('underdog and penalty rules replay multiple dares and change standings', () => {
  const h = history();
  h.add({ agent: 'GameMaster', type: 'dare_opened', data: { dareId: 'second', title: 'Again', options: ['A', 'B'], target: { stat: 'kills', count: 3 }, voteEndsAt: iso(230_000), dareEndsAt: iso(320_000) } }, 200_000);
  for (const [userId, login, yes] of [['private-a', 'alice', true], ['private-b', 'bob', false], ['private-c', 'charlie', true]] as const) {
    h.add({ agent: 'Chat', type: 'prediction_cast', data: { dareId: 'second', userId, login, yes } }, 200_001);
  }
  h.add({ agent: 'Referee', type: 'vote_locked', data: { dareId: 'second', winner: 1 } }, 230_000);
  h.add({ agent: 'Referee', type: 'dare_resolved', data: { dareId: 'second', success: false } }, 320_000);
  const before = replay(h.events);
  const underdog = 'return ctx.correct ? ((ctx.yes ? ctx.yesCount < ctx.noCount : ctx.noCount < ctx.yesCount) ? 2 : 1) : 0;';
  h.add({ agent: 'RulesCompiler', type: 'rule_proposed', data: { ruleId: 'underdog', text: 'underdogs score double', code: underdog, examples } }, 330_000);
  h.add({ agent: 'Auditor', type: 'rule_audited', data: { ruleId: 'underdog', cases: 2304, mismatches: 0 } }, 330_000);
  h.add({ agent: 'Commissioner', type: 'rule_adopted', data: { ruleId: 'underdog' } }, 330_000);
  const after = replay(h.events);
  assert.deepEqual(Object.values(after.fanScores).map(f => f.score), [1, 2, 0]);
  assert.deepEqual(rankChanges(before.fanScores, after.fanScores), ['bob 2→1', 'alice 1→2']);
  const penalty = 'return ctx.correct ? 1 : -1;';
  h.add({ agent: 'RulesCompiler', type: 'rule_proposed', data: { ruleId: 'penalty', text: 'wrong calls lose a point', code: penalty, examples } }, 340_000);
  h.add({ agent: 'Auditor', type: 'rule_audited', data: { ruleId: 'penalty', cases: 2304, mismatches: 0 } }, 340_000);
  h.add({ agent: 'Commissioner', type: 'rule_adopted', data: { ruleId: 'penalty' } }, 340_000);
  assert.deepEqual(Object.values(replay(h.events).fanScores).map(f => f.score), [0, 0, -1]);
});

test('generated code cannot reach host constructors through ctx', () => {
  const ctx = { correct: true, yes: true, success: true, overruled: false, yesCount: 1, noCount: 0, target: 3, progress: 3 };
  const escape = "const k = 'constr' + 'uctor'; return ctx[k][k]('return typeof pro' + 'cess')() === 'object' ? 7 : 1;";
  assert.deepEqual(evaluate('escape', escape, ctx), { points: 0, valid: false });
  const viaPrimitive = "const k = 'constr' + 'uctor'; return ctx.target[k][k]('return 7')();";
  assert.deepEqual(evaluate('escape2', viaPrimitive, ctx), { points: 0, valid: false });
});
