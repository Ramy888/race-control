import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { alias, buildWeb } from '../web/build.js';
import { demoHistory, historyNotice } from '../src/demo-history.js';
import { randomUUID } from '../web/stubs/crypto.js';
import { setImmediate as yieldTurn } from '../web/stubs/timers.js';
import * as unavailable from '../web/stubs/unavailable.js';
import { Script } from '../web/stubs/vm.js';
import type { Clock } from '../src/dares.js';
import { flush } from './helpers.js';

// Exercise the exact browser alias path, not Node's VM evaluator.
const output = await build({ entryPoints: ['web/session.ts'], bundle: true, write: false,
  platform: 'browser', format: 'esm', alias });
const browser: typeof import('../web/session.js') = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0]!.text).toString('base64'));
class Time implements Clock {
  value = 0;
  timers = new Set<{ at: number; callback: () => void }>();
  now = () => this.value;
  schedule(callback: () => void, delay: number) {
    const item = { at: this.value + delay, callback }; this.timers.add(item);
    return () => { this.timers.delete(item); };
  }
  async advance(ms: number) {
    this.value += ms;
    for (const item of [...this.timers]) if (item.at <= this.value) { this.timers.delete(item); item.callback(); }
    await flush();
  }
}
test('browser stubs: UUID, promise yield, recorded-only VM and unavailable Node operations', async () => {
  assert.match(randomUUID(), /^[a-f0-9-]{36}$/); await yieldTurn();
  for (const stub of Object.values(unavailable)) assert.throws(() => stub(), /not available in the browser demo/i);
  const code = browser.recorded.rules[0]!.compiler.code;
  const source = `Date = undefined; Math.random = undefined; (function points(ctx) { "use strict";\n${code}\n})(ctx)`;
  const date = Date, random = Math.random;
  assert.equal(new Script(source).runInNewContext({ ctx: { correct: false } }), -1);
  assert.equal(Date, date); assert.equal(Math.random, random);
  for (const word of ['this','constructor','prototype','__proto__','globalThis','process','require','import','eval','Function','while','for']) {
    assert.throws(() => browser.compilePoints(`banned-${word}`, `return ${word};`), /banned code/);
  }
  assert.throws(() => new Script(source.replace(code, 'return 8;')), /Only recorded rules/);
});
test('both verbatim recordings audit through the browser evaluator, including session contexts', async () => {
  assert.equal(browser.syntheticContexts().length, 2304);
  for (const [i, rule] of browser.recorded.rules.entries()) {
    const audit = await browser.auditRule(`recorded-${i}`, rule.compiler, rule.auditor, []);
    assert.deepEqual(audit, { cases: 2304, mismatches: 0 });
    const historical = { ...rule.compiler.examples[0]!.ctx, yesCount: 19 };
    const withHistory = await browser.auditRule(`history-${i}`, rule.compiler, rule.auditor, [historical]);
    assert.equal(withHistory.cases, 2305); assert.equal(withHistory.mismatches, 0);
  }
});
test('browser Ledger and real DareLoop: proposal, voting, won, live audit, retroactive adoption and reset', async () => {
  const time = new Time(), session = new browser.BrowserSession(time);
  const messages: string[] = []; session.onFeed(message => messages.push(message.text));
  let updates = 0; session.onView(() => updates++);
  await session.chat('streamer', '!dare');
  assert.equal(Boolean(session.ledger.state.proposal), false);
  await time.advance(1500);
  assert.equal(session.ledger.state.proposal?.title, browser.recorded.dares[0]!.title);
  await session.chat('streamer', '!approve');
  const dare = session.ledger.state.currentDare!;
  assert.equal(Date.parse(dare.voteEndsAt) - time.now(), 10000);
  assert.equal(Date.parse(dare.dareEndsAt) - Date.parse(dare.voteEndsAt), 48000);
  await session.chat('viewer01', '1'); await session.chat('viewer01', '!yes');
  await session.chat('viewer03', '!yes');
  await session.chat('viewer02', 'Choose'); await session.chat('viewer02', '!no');
  await time.advance(10000);
  assert.equal(session.ledger.state.currentDare!.status, 'running');
  for (let i = 0; i < dare.target.count; i++) await session.chat('streamer', '!kill');
  assert.equal(session.ledger.state.currentDare!.success, true);
  assert.equal(session.ledger.state.fanScores.viewer02!.score, 2);
  await session.chat('streamer', '!rule WRONG CALLS LOSE A POINT'); await time.advance(1500);
  assert.equal(session.ledger.state.pendingRule?.audit?.mismatches, 0);
  assert.ok(session.ledger.state.pendingRule!.audit!.cases > 2304);
  await session.chat('streamer', '!adopt');
  assert.equal(session.ledger.state.fanScores.viewer02!.score, 1);
  assert.ok(updates > 10); assert.ok(messages.some(message => message.startsWith('Rule ready:')));
  await session.chat('streamer', '!rule something unrecorded');
  assert.equal(messages.at(-1), browser.ruleNotice);
  assert.equal(session.ledger.state.pendingRule, undefined);
  session.reset(); assert.equal(session.ledger.events.length, demoHistory(0).length);
  assert.equal(session.snapshot().dare?.status, 'resolved');
  assert.equal(messages.at(-1), historyNotice);
  await session.chat('streamer', '!dare'); session.reset(); await time.advance(1500);
  assert.equal(session.ledger.events.length, demoHistory(0).length, 'late generation cannot cross reset');
  assert.equal(new browser.BrowserSession(new Time()).ledger.events.length, demoHistory(0).length);
});
test('recorded master cycles all five dares; compiler rejects unknown rules', async () => {
  const time = new Time(), providers = browser.recordedProviders(time);
  for (let i = 0; i < 6; i++) {
    const pending = providers.master(); await time.advance(1500);
    assert.equal((await pending).title, browser.recorded.dares[i % 5]!.title);
  }
  const pending = providers.compiler('  WRONG CALLS LOSE A POINT  '); await time.advance(1500);
  assert.deepEqual((await pending).compiler.code, browser.recorded.rules[0]!.compiler.code);
  await assert.rejects(providers.compiler('anything else'), /hosted demo has 2 recorded rules/);
});
test('static build reuses pages, preserves recordings and excludes Node runtime references', async () => {
  const recorded = await readFile('web/recorded.json', 'utf8');
  await buildWeb();
  assert.equal(await readFile('web/recorded.json', 'utf8'), recorded);
  const bundle = await readFile('web/dist/bundle.js', 'utf8');
  assert.doesNotMatch(bundle, /child_process|node:fs|require\(/);
  const html = await readFile('web/dist/index.html', 'utf8');
  assert.match(html, /hud-test.html\?embed=1/);
  assert.equal(await readFile('web/dist/hud-test.html', 'utf8'), await readFile('public/hud-test.html', 'utf8'));
  assert.match(html, /src="\.\/bundle.js"/); assert.match(html, /overlay.html\?browser=1/);
  assert.match(html, /Browser playground: the real Race Control code/);
  assert.match(html, /@media\(max-width:1000px\)\{main\{grid-template-columns:1fr\}/);
  assert.match(html, /aspect-ratio:16\/9/); assert.match(html, /overflow-wrap:anywhere/);
  assert.doesNotMatch(html, /innerHTML/);
  assert.equal(await readFile('web/dist/overlay.html', 'utf8'), await readFile('public/overlay.html', 'utf8'));
});
