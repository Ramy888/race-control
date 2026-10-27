import { demoHistory, historyNotice } from '../src/demo-history.js';
import { DareLoop, type Clock, type DareLedger } from '../src/dares.js';
import { replay, type LedgerEvent, type EventInput } from '../src/ledger.js';
import { validateDare } from '../src/gamemaster.js';
import { validateRule } from '../src/rules.js';
import { parseCommand } from '../src/commands.js';
import { toOverlayView } from '../src/overlay.js';
import recorded from './recorded.json' with { type: 'json' };
export { auditRule, syntheticContexts, evaluate, compilePoints, rankChanges } from '../src/rules.js';
export { recorded };
export const ruleNotice = 'The hosted demo has 2 recorded rules; run locally with a logged-in Codex CLI to compile any rule.';
export const browserClock: Clock = { now: Date.now, schedule(callback, delay) {
  const timer = setTimeout(callback, delay); return () => clearTimeout(timer);
} };
export class MemoryLedger implements DareLedger {
  readonly events: LedgerEvent[] = [];
  constructor(private readonly changed: () => void = () => {}, events: LedgerEvent[] = []) { this.events.push(...structuredClone(events)); }
  get state() { return replay(this.events); }
  async append(event: EventInput, at: string) {
    this.events.push(structuredClone({ ...event, seq: this.events.length + 1, at })); this.changed();
  }
}
export function recordedProviders(time: Clock = browserClock) {
  let next = 0;
  const thinking = () => new Promise<void>(resolve => { time.schedule(resolve, 1500); });
  return {
    master: async () => {
      await thinking();
      const { model: _, source: __, ...content } = recorded.dares[next++ % recorded.dares.length]!;
      return { ...validateDare(content), source: 'ai' as const };
    },
    compiler: async (text: string) => {
      const rule = recorded.rules.find(rule => rule.text === text.trim().toLowerCase());
      if (!rule) throw new Error(ruleNotice);
      await thinking();
      const { model: _, ...compiler } = rule.compiler, { model: __, ...auditor } = rule.auditor;
      return { compiler: validateRule(compiler), auditor: validateRule(auditor) };
    },
  };
}
export class BrowserSession {
  ledger!: MemoryLedger;
  loop!: DareLoop;
  private readonly views = new Set<(view: ReturnType<typeof toOverlayView>) => void>();
  private readonly feeds = new Set<(message: { from: string; text: string }) => void>();
  readonly config = { broadcaster: 'streamer', canReset: true, codex: false, recorded: true };
  readonly rules = recorded.rules.map(rule => rule.text);
  constructor(private readonly time: Clock = browserClock) { this.reset(); }
  snapshot = () => toOverlayView(this.ledger.state, this.time.now());
  tick = () => { const view = this.snapshot(); for (const listener of this.views) listener(view); };
  onView(listener: (view: ReturnType<typeof toOverlayView>) => void) { this.views.add(listener); listener(this.snapshot()); }
  onFeed(listener: (message: { from: string; text: string }) => void) { this.feeds.add(listener); listener({ from: 'Demo guide', text: historyNotice }); }
  private emit(from: string, text: string) { for (const listener of this.feeds) listener({ from, text }); }
  reset() {
    this.loop?.stop();
    this.ledger = new MemoryLedger(this.tick, demoHistory(this.time.now()));
    const providers = recordedProviders(this.time);
    this.loop = new DareLoop(this.ledger, 'streamer', async text => this.emit('Race Control', text), this.time,
      text => this.emit('Demo guide', text), providers.master,
      { voteMs: 10000, killMs: 6000, minDareMs: 20000 }, providers.compiler);
    void this.loop.start(); this.tick(); this.emit('Demo guide', historyNotice);
  }
  async chat(user: string, text: string) {
    if (!/^[a-zA-Z0-9_]{1,25}$/.test(user) || typeof text !== 'string' || text.length > 500) throw new Error('Invalid chat input');
    this.emit(user, text);
    const command = parseCommand(text);
    if (user.toLowerCase() === 'streamer' && command?.type === 'rule' &&
        !this.rules.includes(command.text.trim().toLowerCase())) { this.emit('Race Control', ruleNotice); return; }
    await this.loop.handle({ login: user.toLowerCase(), userId: user.toLowerCase(), text });
  }
}
